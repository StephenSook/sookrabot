// Offline self-play: runs the real SookraBot (bot.ts and strategy.ts, exactly
// as the live bot runs them) through simulated matches against module-exact
// sims, starter clones, fitted models of the real rivals
// (fixtures/rival-models.json) and other SookraBot instances.
//
//   npx tsx src/selfplay.ts compare <field> <matches> <seed> <variant>... [--shard=i/n] [--rows=file.jsonl] [--trace]
//   npx tsx src/selfplay.ts merge <rows.jsonl>... [--expect=<matches>]
//   npx tsx src/selfplay.ts [sims|starters] [matches] [seed]
//   npx tsx src/selfplay.ts validate [matches] [seed]
//   npx tsx src/selfplay.ts validate4 [matches] [seed] [rho|-] [v4c|v4]
//   npx tsx src/selfplay.ts validate5 [matches] [seed] [rho|-] [v5k|v5c|v5] [mod+mod...]
//   npx tsx src/selfplay.ts list
//
// GitHub Actions runs compare in parallel shards (.github/workflows/selfplay.yml)
// and validate4 or validate5 once per rho (.github/workflows/calibrate.yml);
// bot-starter/scripts/selfplay_aggregate.py merges and summarizes their output.
//
// Variants. "head" is the live bot: DEFAULT_POLICY. Any other variant names
// strategy.ts constants to override, NAME=value joined by "+", for example
// PACED_KAPPA=4.5+PACE_MIN=0.6 (names are the constants' own, any case; list
// prints them with their values). The variant's policy reaches the bot only
// through the SookraBot constructor, and bot.ts passes it to every strategy.ts
// call, so a variant runs the live code with those constants changed and
// nothing else; the harness never wraps or replaces a SookraBot method.
//
// Fields: <name>[@<rho>][,fp][,shade=<s>][,warm]. @rho gives every fitted rival
// rack awareness rho (see RivalModel.rho); ,fp plays first-price auctions (the
// winner pays its own bid; Vickrey otherwise); ,shade=s multiplies every fitted
// rival's bid by s, rounded half to even (the fits come from Vickrey matches, so
// under first price s < 1 models rivals shading their bids); ,warm (with fp)
// starts each SookraBot with the price history of a burn-in match of the same
// field, as the live bot carries it between first-price matches (without it
// the history starts empty, as in a session's first first-price match).
// arN (N 2 to 8) is the focal bot plus N - 1 drawn -ar rivals: the 3-game
// final is a duel, the elimination bracket runs one table from the cut down to
// 3 bots, and a Swiss round seats tables of about the match size.
//
// compare runs every variant of the focal SookraBot (seat 0) on the same deals
// with common random numbers: per match, the bag order, each sim's jitter, each
// fitted rival's bid noise and the tie-break priorities come from their own
// seeded streams, so variants differ only through their own decisions and what
// those change downstream. Match i's seed is mix(seed, i) whatever the shard, so
// --shard=i/n (0 <= i < n) runs matches floor(i*N/n) to floor((i+1)*N/n) - 1 of
// the N, and merging the shards' rows gives exactly the unsharded run. Output:
// one JSON line per variant, with paired differences against the first variant
// listed (mean, standard error and t over matches). --rows appends one JSON line
// per variant and match as each match finishes; merge recomputes the summaries
// from any set of rows files (duplicates of identical rows are dropped,
// conflicting ones refused) and with --expect=N refuses an incomplete set.
// Every row carries a hash of the bot, harness, rival and wordlist sources, and
// merge refuses rows from different code. --trace prints the focal bot's own log
// lines (every bid with its reason, every word) to stderr.
//
// Rules mirrored from spacetimedb/src/game.ts: 98-tile bag, 5-tile hidden
// racks, balance 100, one letter per auction (98 - 5 x seats auctions),
// Vickrey (second price, 1 when alone) or first price, random ties, unbid
// letters discarded, sims bid on every letter with jitter -2..2 and play their
// longest 3+ word right after a win, a real bot cannot use the final letter
// (the match ends when it closes). Timing is idealized: every bot's bid and
// word plays land before each auction closes. Each SookraBot seat gets the
// events the live bot gets from index.ts (onAuctionOpen, the deferred turns
// its refreshes run in, onAuctionResult, onMatchEnded) and TURNS turns per
// auction, or more while it is still playing words (extraTurns counts those).
// Each match starts a fresh SookraBot (,warm aside, see above).
//
// Fitted rivals (rival_sim.py FittedRival, from public match data): bids
// sample an isotonic survival curve per letter-value class and clock block
// (dev-voices: a lognormal fit), 0 on the final letter. LetterShark plays
// its best 7+ word whenever one exists and flushes its rack when the final
// auction opens; code and bot play their best word with a logistic
// probability in its reward after each auction (up to 4 per gap) and flush
// in the last 3 auctions. Clock blocks count auctions still to come, so a
// 2-seat duel (88 auctions) keeps the endgame where a 68-auction match has it.
// Entries named -v2 (and Yezi, tinytung, slow-n-dumb) were refitted by
// rival_refit.py on a later snapshot (matches up to 161): code-v2 and bot-v2
// from match 127 on, the newer bots on all their matches; -ar entries on the
// live all-real 6-bot matches m147 to m190. Known gap: against these rivals
// the harness is optimistic for SookraBot (pad-code2: 153 vs code-v2 115; live
// m127 and m129 to m132: 101 vs code 208), so trust paired differences more
// than levels.
//
// Entries named -v4 and -v4c were refitted on the v4 snapshot (393 matches,
// 2026-10-24 06:00 UTC; all-real 6-seat matches only, each rival over its
// latest stable range, rival_refit_v4.py and rival_refit_v4b.py). Each carries
// its bid-likelihood rack awareness as rho (0.1 to 0.4; field@rho overrides
// it). -v4c entries add a separate survival curve for letters that complete a
// 7+ word on the rival's rack (complete7) and the word policy with the best
// likelihood (minLen: the hazard step only plays words of that length or more;
// sharkLen: words of that length or more are cashed first); -v4 entries are the
// same fits without those. The -v4 fields use -v4c unless named -v4base.
// Known gap (validate4, 30 matches): the fitted top rivals score 20 to 35
// points below their live level (they turn fewer letters into 7+ words), so
// levels are optimistic for SookraBot; trust paired differences, check a
// result in ar6-top-mixed too, and calibrate rho with validate4.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuctionResultRow,
  type AuctionRow,
  type BotRow,
  type ConnLike,
  type HoldingRow,
  type Logger,
  type MatchStateRow,
  type ParticipantRow,
  SookraBot,
} from "./bot.js";
import { type Counts, LETTER_VALUE, WordIndex, countsKey, countsOf, letterIndex, valuate, wordReward } from "./engine.js";
import {
  type AuctionKind,
  type Policy,
  type PricePoint,
  type SimStrategy,
  DEFAULT_POLICY,
  LEAVE_ALPHA,
  maxSimBid,
} from "./strategy.js";

const BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2,
  N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
};
const BAG_TILES = Object.values(BAG).reduce((a, b) => a + b, 0);
const RACK = 5;
const START_BALANCE = 100;
const SIMS: [string, SimStrategy][] = [
  ["Cheapo", "Cheapskate"], ["Valor", "ValueBidder"], ["Brutus", "Aggressive"],
  ["Hagrid", "ValueBidder"], ["Maverick", "Aggressive"], ["Snippet", "Cheapskate"],
];
/** setImmediate turns given to the SookraBot seats per auction (bid, refresh, word acks, precompute). */
const TURNS = 6;
/** Further turns at most, while a SookraBot keeps playing words (each play consumes 2+ tiles). */
const MAX_EXTRA_TURNS = 64;
const MATCH = 1n;
const WORDLIST = new URL("../../spacetimedb/wordlist.txt", import.meta.url);

// ---- random streams ----

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit hash of a list of integers (seeds the per-purpose streams). */
function mix(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
  }
  return h >>> 0;
}

const STREAM = { bag: 1, sims: 2, ties: 3, field: 4, warm: 5, rivalBid: 100, rivalWord: 200 } as const;

/** Python round(): halves go to the even neighbour (rival_sim.py bids use it). */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// ---- fitted rivals ----

interface SurvivalBid {
  kind: "survival";
  beta: number;
  /** Per "vclass|block": [[x, S(x)], ...] at each grid point where S changes. */
  cells: Record<string, [number, number][]>;
}
interface LognormalBid {
  kind: "lognormal";
  a0: number;
  a1: number;
  g: number[];
  s: number;
  p0_v1: number;
  p0_v2plus: number;
  beta: number;
}
interface RivalModel {
  botId: number;
  policy: "shark" | "hazard" | "shark-noflush";
  hazard: { c0: number; c1: number } | null;
  bid: SurvivalBid | LognormalBid;
  /** Robustness option: clock blocks by auction index (1-50, 51-58, 59-63, 64+) instead of auctions left. */
  blocksByIndex?: boolean;
  /**
   * Rack awareness, 0..1 (0 or absent: rack-blind, exactly the fitted model). The survival
   * draw u becomes 1 - Phi(rho x zq + sqrt(1 - rho^2) x e), e = PhiInv(1 - u), where zq is
   * the normal score of the letter's rank, by marginal value to the rival's own rack
   * (engine valuation, alpha LEAVE_ALPHA), among the letters of its value class weighted by
   * bag counts. The marginal bid distribution is kept; the rival bids high on the letters it needs.
   */
  rho?: number;
  /**
   * Optional (-v4c entries): survival runs at balance 100, pooled over value classes and clock
   * blocks, for letters that complete a 7+ word on the rival's rack (the rack alone spells none,
   * rack + letter spells one). Such a bid is drawn from these runs without the rack-rank copula;
   * every other bid from cells. Live Chinese Dante wins 61% of such auctions (86 of 142) against 25%
   * of the rest (539 of 2140; rival_refit_v4b.py).
   */
  complete7?: [number, number][];
  /** Hazard policy only (-v4c entries): the hazard step plays words of at least this many letters (default 2). */
  minLen?: number;
  /** Hazard policy only (-v4c entries): every word of at least this many letters is cashed before the hazard step. */
  sharkLen?: number;
}

/** Standard normal CDF (erfc via Numerical Recipes' Chebyshev fit, |error| < 1.2e-7). */
function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const r =
    t *
    Math.exp(
      -x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return z >= 0 ? 1 - 0.5 * r : 0.5 * r;
}

/** Inverse standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9), p clamped to (1e-9, 1 - 1e-9). */
function normInv(p: number): number {
  const q0 = Math.min(1 - 1e-9, Math.max(1e-9, p));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (q0 < lo) {
    const q = Math.sqrt(-2 * Math.log(q0));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (q0 > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - q0));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = q0 - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Letters of each value class (VCLASS keys), for the rack-aware rank. */
const CLASS_LETTERS: Record<string, string[]> = {};
for (const c of Object.keys(LETTER_VALUE)) (CLASS_LETTERS[VCLASSOF(c)] ??= []).push(c);
function VCLASSOF(c: string): string {
  const v = LETTER_VALUE[c];
  return v === 1 ? "v1" : v === 2 ? "v2" : v === 3 ? "v3" : v === 4 ? "v4" : "v5+";
}

const RIVALS: Record<string, RivalModel> = JSON.parse(
  fs.readFileSync(new URL("./fixtures/rival-models.json", import.meta.url), "utf8"),
).rivals;

const VCLASS: Record<number, string> = { 1: "v1", 2: "v2", 3: "v3", 4: "v4", 5: "v5+", 8: "v5+", 10: "v5+" };

/** Clock block by auctions still to come (idx 1-50, 51-58, 59-63, 64-67 of a 68-auction match). */
function blockOf(bagLeft: number): number {
  return bagLeft >= 18 ? 0 : bagLeft >= 10 ? 1 : bagLeft >= 5 ? 2 : 3;
}

/**
 * A fitted rival's bid. Always draws three numbers so its noise stream stays aligned across variants.
 * `completes`: the letter completes a 7+ word on the rival's rack (used only by models with complete7).
 */
function rivalBid(
  m: RivalModel, rng: Rng, letter: string, bagLeft: number, balance: number, auctions = 0, rankQ = 0.5,
  completes = false,
): number {
  const u1 = rng();
  const u2 = rng();
  const u3 = rng();
  if (bagLeft <= 0) return 0;
  const v = LETTER_VALUE[letter];
  const idx = auctions - bagLeft;
  const blk = m.blocksByIndex ? (idx <= 50 ? 0 : idx <= 58 ? 1 : idx <= 63 ? 2 : 3) : blockOf(bagLeft);
  const b = m.bid;
  if (b.kind === "survival") {
    let u = u1;
    const c7 = completes && m.complete7 !== undefined;
    const rho = c7 ? 0 : m.rho ?? 0;
    if (rho > 0) {
      const z = rho * normInv(Math.min(0.98, Math.max(0.02, rankQ))) + Math.sqrt(1 - rho * rho) * normInv(1 - u1);
      u = 1 - normCdf(z);
    }
    let x = 200;
    for (const [rx, s] of c7 ? m.complete7! : b.cells[`${VCLASS[v]}|${blk}`]) {
      if (s < u) {
        x = rx;
        break;
      }
    }
    if (x <= 0) return 0;
    const amt = roundHalfEven(x * (Math.max(balance, 1) / 100) ** b.beta);
    return Math.max(0, Math.min(amt, balance));
  }
  if (u1 < (v === 1 ? b.p0_v1 : b.p0_v2plus)) return 0;
  const z = Math.sqrt(-2 * Math.log(1 - u2)) * Math.cos(2 * Math.PI * u3);
  const mu = b.a0 + b.a1 * Math.log(v) + b.g[blk] + b.beta * Math.log(Math.max(balance, 1) / 100);
  return Math.max(0, Math.min(roundHalfEven(Math.exp(mu + b.s * z)), balance));
}

// ---- seats and the simulated server ----

type SeatSpec =
  | { kind: "sookra"; name: string; policy: Policy }
  | { kind: "sim"; name: string; strategy: SimStrategy }
  | { kind: "starter"; name: string }
  | { kind: "fitted"; name: string; model: RivalModel };

interface Seat {
  id: bigint;
  spec: SeatSpec;
  rack: Map<string, number>;
  balance: number;
  score: number;
  won: number;
  paid: number;
  words: number;
  firstWord: number | null;
  /** Auctions (not the final) opened with this seat under 10 coins. */
  poor: number;
  midBalance: number | null;
  bid: { auctionId: bigint; amount: number } | null;
  /** Word plays this seat has submitted (SookraBot seats: tells the settle loop it is still playing). */
  wordCalls: number;
  bidRng: Rng;
  wordRng: Rng;
  bot?: SookraBot;
  /** Rack-aware fitted rivals: marginal values per rack key, this match only. */
  valCache?: Map<string, Float64Array>;
  /** Fitted rivals with complete7: sevenCompleters per rack key, this match only. */
  c7Cache?: Map<string, number>;
  /** The five starting tiles, sorted (validate5 packing measures). */
  startRack: string;
  /** Letters won this match, per letter index (validate5 packing measures). */
  wonLetters: Counts;
  /** Words of 7+ letters played. */
  sevens: number;
}

/**
 * Mid-rank of the letter among its value class, by marginal value to this seat's rack,
 * each letter weighted by its bag count (0..1; 0.5 when every letter in the class is worth the same).
 */
function rackRank(index: WordIndex, seat: Seat, letter: string): number {
  const counts = countsOf(seat.rack);
  const key = countsKey(counts);
  seat.valCache ??= new Map();
  let delta = seat.valCache.get(key);
  if (!delta) {
    delta = valuate(index, counts, LEAVE_ALPHA).delta;
    seat.valCache.set(key, delta);
  }
  const d = delta[letterIndex(letter)];
  let below = 0;
  let equal = 0;
  let total = 0;
  for (const c of CLASS_LETTERS[VCLASSOF(letter)]) {
    const w = BAG[c];
    const dc = delta[letterIndex(c)];
    total += w;
    if (dc < d - 1e-9) below += w;
    else if (dc <= d + 1e-9) equal += w;
  }
  return (below + 0.5 * equal) / total;
}

/**
 * Bit i set when letter i completes a 7+ word on this rack: the rack alone spells no 7+ word and the
 * rack plus that letter spells one (0 when the rack already spells one). One scan with one extra tile
 * answers all 26 letters (WordIndex.scan tags each key that needs exactly one more tile with its letter).
 */
export function sevenCompleters(index: WordIndex, counts: Counts): number {
  const cands = index.scan(counts, true);
  let mask = 0;
  for (let i = 0; i < cands.n; i++) {
    if (index.len[cands.keys[i]] < 7) continue;
    const e = cands.extra[i];
    if (e === -1) return 0;
    mask |= 1 << e;
  }
  return mask >>> 0;
}

/** Whether `letter` completes a 7+ word on this seat's rack (cached per rack for the match). */
function completes7(index: WordIndex, seat: Seat, letter: string): boolean {
  const counts = countsOf(seat.rack);
  const key = countsKey(counts);
  seat.c7Cache ??= new Map();
  let mask = seat.c7Cache.get(key);
  if (mask === undefined) {
    mask = sevenCompleters(index, counts);
    seat.c7Cache.set(key, mask);
  }
  return ((mask >>> letterIndex(letter)) & 1) === 1;
}

class Table {
  matchState: MatchStateRow;
  auction: AuctionRow | null = null;
  /** Auctions closed so far. */
  closed = 0;
  constructor(
    readonly index: WordIndex,
    readonly seats: Seat[],
    readonly botRows: Map<bigint, BotRow>,
    readonly auctions: number,
    auctionType: AuctionKind,
  ) {
    this.matchState = {
      id: MATCH,
      status: { tag: "Running" },
      currentAuctionId: undefined,
      bagTotal: auctions,
      auctionType: { tag: auctionType },
      auctionDurationMs: 1000n,
      startingRackSize: RACK,
    };
  }

  /** The ConnLike one SookraBot seat sees: shared public tables, its own rack and reducers. */
  connFor(seat: Seat): ConnLike {
    return {
      db: {
        matchState: { id: { find: (id: bigint) => (id === MATCH ? this.matchState : undefined) } },
        auction: { id: { find: (id: bigint) => (this.auction && this.auction.id === id ? this.auction : undefined) } },
        matchParticipant: {
          iter: (): Iterable<ParticipantRow> =>
            this.seats.map((s) => ({ matchId: MATCH, botId: s.id, balance: BigInt(s.balance), score: BigInt(s.score) })),
        },
        myRack: {
          iter: (): Iterable<HoldingRow> =>
            [...seat.rack].filter(([, n]) => n > 0).map(([letter, count]) => ({ matchId: MATCH, letter, count })),
        },
        bot: { id: { find: (id: bigint) => this.botRows.get(id) } },
      },
      reducers: {
        submitBid: (a: { auctionId: bigint; amount: bigint }): Promise<unknown> => {
          const amt = Number(a.amount);
          if (!this.auction || this.auction.id !== a.auctionId || this.auction.status.tag !== "Open") {
            return Promise.reject(new Error("Auction closed"));
          }
          if (amt < 0 || amt > seat.balance) return Promise.reject(new Error("Insufficient balance"));
          seat.bid = { auctionId: a.auctionId, amount: amt };
          return Promise.resolve();
        },
        submitWord: (a: { matchId: bigint; word: string }): Promise<unknown> => {
          seat.wordCalls++;
          if (this.matchState.status.tag !== "Running") return Promise.reject(new Error("Match not running"));
          if (!this.spend(seat, a.word)) return Promise.reject(new Error(`Not enough letters for ${a.word}`));
          return Promise.resolve();
        },
      },
    };
  }

  spend(seat: Seat, word: string): boolean {
    const need = countsOf(word);
    for (let i = 0; i < 26; i++) {
      if ((seat.rack.get(String.fromCharCode(65 + i)) ?? 0) < need[i]) return false;
    }
    for (const c of word) seat.rack.set(c, seat.rack.get(c)! - 1);
    const r = wordReward(word);
    seat.balance += r;
    seat.score += r;
    seat.words++;
    if (word.length >= 7) seat.sevens++;
    if (seat.firstWord === null) seat.firstWord = this.closed;
    return true;
  }

  playKey(seat: Seat, k: number) {
    if (!this.spend(seat, this.index.words[k])) throw new Error(`rival cannot spell ${this.index.words[k]}`);
  }
}

/** Longest word of at least minLen letters, lexicographically first among those (game.ts findBestPlayable). */
function longestWord(index: WordIndex, rack: Map<string, number>, minLen: number): string | null {
  const counts = countsOf(rack);
  const cands = index.scan(counts, false);
  let best: string | null = null;
  for (let i = 0; i < cands.n; i++) {
    const w = index.words[cands.keys[i]];
    if (w.length < minLen) continue;
    if (!best || w.length > best.length || (w.length === best.length && w < best)) best = w;
  }
  return best;
}

/** Fitted rival word policy, called after each close, at the start, and when the final auction opens. */
function rivalAct(table: Table, seat: Seat, m: RivalModel, bagLeft: number, final: boolean) {
  const index = table.index;
  const counts = countsOf(seat.rack);
  const cands = index.scan(counts, false);
  const flush = () => {
    for (const k of index.pack(cands, counts, -1).keys) table.playKey(seat, k);
  };
  const sevens = () => {
    for (;;) {
      const k = index.bestKey(cands, counts, 7);
      if (k < 0) return;
      table.playKey(seat, k);
      index.consume(counts, k);
    }
  };
  if (m.policy !== "hazard") {
    if (final && m.policy === "shark") flush();
    else sevens();
    return;
  }
  if (final || bagLeft <= 2) {
    flush();
    return;
  }
  if (m.sharkLen !== undefined) {
    for (;;) {
      const k = index.bestKey(cands, counts, m.sharkLen);
      if (k < 0) break;
      table.playKey(seat, k);
      index.consume(counts, k);
    }
  }
  for (let i = 0; i < 4; i++) {
    const k = index.bestKey(cands, counts, m.minLen ?? 2);
    if (k < 0) return;
    const p = 1 / (1 + Math.exp(-(m.hazard!.c0 + m.hazard!.c1 * index.reward[k])));
    if (!(seat.wordRng() < p)) return;
    table.playKey(seat, k);
    index.consume(counts, k);
  }
}

const turn = () => new Promise<void>((r) => setImmediate(r));
const QUIET = { log: () => {}, warn: () => {} };

export interface SeatResult {
  name: string;
  kind: SeatSpec["kind"];
  score: number;
  balance: number;
  won: number;
  paid: number;
  words: number;
  firstWord: number | null;
  poor: number;
  midBalance: number | null;
  /** Tiles left unplayed when the match ended (the final letter included). */
  endRack: number;
  /** Words of 7+ letters played. */
  sevens: number;
  /** The five starting tiles, sorted. */
  startRack: string;
  /** Every letter won, sorted. */
  wonLetters: string;
}

/** How a match is played: the auction rule and the fitted rivals' bid scale. */
export interface MatchEnv {
  auction: AuctionKind;
  /** Every fitted rival's bid times this, rounded half to even (1: as fitted). */
  shade: number;
}
export const VICKREY: MatchEnv = { auction: "Vickrey", shade: 1 };

export interface MatchResult {
  seats: SeatResult[];
  /** Turns run past TURNS because a SookraBot seat was still playing words (0: the fixed window sufficed). */
  extraTurns: number;
  /** Each SookraBot seat's first-price price history at the end (null for other seats). */
  fpHistory: (PricePoint[] | null)[];
}

/** Optional extras for one match: the focal bot's log, and price histories to start SookraBot seats with. */
export interface MatchOpts {
  focalLog?: Logger;
  fpHistory?: readonly (readonly PricePoint[] | null)[];
}

/**
 * What the winner pays (game.ts closeAuction): under first price its own bid; under Vickrey the best
 * other positive bid, or AUCTION_RESERVE (1) when nobody else bid.
 */
export function pricePaid(auction: AuctionKind, top: number, otherBids: number[]): number {
  if (auction === "FirstPrice") return top;
  let second = 0;
  let others = 0;
  for (const a of otherBids) {
    if (a <= 0) continue;
    others++;
    second = Math.max(second, a);
  }
  return others > 0 ? second : Math.min(1, top);
}

/** The game constants this harness plays by, for the check against spacetimedb/src. */
export const RULES = { BAG, RACK, START_BALANCE } as const;

/** One SookraBot seat: the class index.ts runs, with this seat's policy (DEFAULT_POLICY for head). */
function makeBot(index: WordIndex, seat: Seat, policy: Policy, log: Logger): SookraBot {
  const bot = new SookraBot(index, seat.spec.name, log, Date.now, policy);
  bot.myBotId = seat.id;
  return bot;
}

export async function playMatch(
  index: WordIndex, specs: SeatSpec[], matchSeed: number, env: MatchEnv = VICKREY, opts: MatchOpts = {},
): Promise<MatchResult> {
  const n = specs.length;
  const auctions = BAG_TILES - RACK * n;
  const bagRng = mulberry32(mix(matchSeed, STREAM.bag));
  const simRng = mulberry32(mix(matchSeed, STREAM.sims));
  const tieRng = mulberry32(mix(matchSeed, STREAM.ties));
  const bag: string[] = [];
  for (const [c, k] of Object.entries(BAG)) for (let i = 0; i < k; i++) bag.push(c);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(bagRng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  let next = 0;
  const seats: Seat[] = specs.map((spec, i) => ({
    id: BigInt(i + 1),
    spec,
    rack: new Map(),
    balance: START_BALANCE,
    score: 0,
    won: 0,
    paid: 0,
    words: 0,
    firstWord: null,
    poor: 0,
    midBalance: null,
    bid: null,
    wordCalls: 0,
    bidRng: mulberry32(mix(matchSeed, STREAM.rivalBid + i)),
    wordRng: mulberry32(mix(matchSeed, STREAM.rivalWord + i)),
    startRack: "",
    wonLetters: new Int32Array(26),
    sevens: 0,
  }));
  const botRows = new Map<bigint, BotRow>();
  for (const s of seats) {
    botRows.set(
      s.id,
      s.spec.kind === "sim"
        ? { name: s.spec.name, isSimulated: true, strategy: { tag: s.spec.strategy } }
        : { name: s.spec.name, isSimulated: false, strategy: { tag: "Human" } },
    );
  }
  for (const s of seats) {
    const start: string[] = [];
    for (let i = 0; i < RACK; i++) {
      const c = bag[next++];
      s.rack.set(c, (s.rack.get(c) ?? 0) + 1);
      start.push(c);
    }
    s.startRack = start.sort().join("");
  }
  const table = new Table(index, seats, botRows, auctions, env.auction);
  seats.forEach((s, i) => {
    if (s.spec.kind !== "sookra") return;
    s.bot = makeBot(index, s, s.spec.policy, (i === 0 && opts.focalLog) || QUIET);
    const warm = opts.fpHistory?.[i];
    if (warm) s.bot.fpHistory.push(...warm);
  });
  const starterPlay = (s: Seat) => {
    for (;;) {
      const w = longestWord(index, s.rack, 2);
      if (!w || !table.spend(s, w)) return;
    }
  };
  for (const s of seats) {
    if (s.spec.kind === "starter") starterPlay(s);
    else if (s.spec.kind === "fitted") rivalAct(table, s, s.spec.model, auctions, false);
  }

  const conns = new Map<bigint, ConnLike>();
  for (const s of seats) if (s.bot) conns.set(s.id, table.connFor(s));
  const botWordCalls = () => seats.reduce((a, s) => a + (s.bot ? s.wordCalls : 0), 0);
  let extraTurns = 0;
  let auctionId = 1000n;
  for (let k = 1; k <= auctions; k++) {
    const letter = bag[next++];
    const bagLeft = auctions - k;
    const final = bagLeft === 0;
    auctionId++;
    if (final) {
      for (const s of seats) if (s.spec.kind === "fitted") rivalAct(table, s, s.spec.model, 0, true);
    }
    for (const s of seats) {
      if (!final && s.balance < 10) s.poor++;
      if (bagLeft === Math.floor(auctions / 2)) s.midBalance = s.balance;
    }
    table.auction = { id: auctionId, matchId: MATCH, letter, status: { tag: "Open" } };
    table.matchState = { ...table.matchState, bagTotal: bagLeft, currentAuctionId: auctionId };
    const amounts = new Map<Seat, number>();
    for (const s of seats) {
      const spec = s.spec;
      if (spec.kind === "sim") {
        const jitter = Math.floor(simRng() * 5) - 2;
        const value = LETTER_VALUE[letter];
        const st = spec.strategy;
        const base = st === "Cheapskate" ? value - 1 : st === "ValueBidder" ? value : value + ("AEIOU".includes(letter) ? 4 : 2);
        const amt = Math.max(Math.min(Math.max(base + jitter, 1), s.balance), 0);
        if (amt > maxSimBid(st, letter, s.balance)) throw new Error("sim bid above model max");
        amounts.set(s, amt);
      } else if (spec.kind === "starter") {
        const value = LETTER_VALUE[letter];
        const want = (s.rack.get(letter) ?? 0) === 0 ? value + 2 : Math.max(1, value);
        amounts.set(s, Math.min(want, Math.max(0, s.balance)));
      } else if (spec.kind === "fitted") {
        const m = spec.model;
        const c7 = m.complete7 !== undefined && bagLeft > 0 && completes7(index, s, letter);
        // The rack rank only feeds the copula, which a complete7 bid does not use.
        const q = !c7 && (m.rho ?? 0) > 0 && bagLeft > 0 ? rackRank(index, s, letter) : 0.5;
        let amt = rivalBid(m, s.bidRng, letter, bagLeft, s.balance, auctions, q, c7);
        if (env.shade !== 1 && amt > 0) amt = Math.max(0, Math.min(roundHalfEven(amt * env.shade), s.balance));
        amounts.set(s, amt);
      }
    }
    const open = table.auction;
    for (const s of seats) if (s.bot) s.bot.onAuctionOpen(conns.get(s.id)!, open);
    if (conns.size > 0) {
      // TURNS turns, then one more for as long as a word play went out on the last
      // one: its acknowledgement schedules a refresh the live bot runs before the close.
      let calls = botWordCalls();
      for (let t = 1; ; t++) {
        await turn();
        const played = botWordCalls() !== calls;
        calls = botWordCalls();
        if (t >= TURNS) {
          if (!played || t >= TURNS + MAX_EXTRA_TURNS) break;
          extraTurns++;
        }
      }
    }
    for (const s of seats) {
      if (s.bot) amounts.set(s, s.bid && s.bid.auctionId === auctionId ? s.bid.amount : 0);
    }
    const prio = seats.map(() => tieRng());
    let w = -1;
    for (let i = 0; i < n; i++) {
      const a = amounts.get(seats[i])!;
      if (a <= 0) continue;
      if (w < 0 || a > amounts.get(seats[w])! || (a === amounts.get(seats[w])! && prio[i] > prio[w])) w = i;
    }
    table.auction = { ...open, status: { tag: "Closed" } };
    table.closed++;
    let paid = 0;
    if (w >= 0) {
      paid = pricePaid(env.auction, amounts.get(seats[w])!, seats.filter((_, i) => i !== w).map((s) => amounts.get(s)!));
      const ws = seats[w];
      if (ws.balance >= paid) {
        ws.balance -= paid;
        ws.paid += paid;
        ws.won++;
        ws.wonLetters[letterIndex(letter)]++;
        ws.rack.set(letter, (ws.rack.get(letter) ?? 0) + 1);
        if (ws.spec.kind === "sim") {
          const word = longestWord(index, ws.rack, 3);
          if (word) table.spend(ws, word);
        }
      }
    }
    const result: AuctionResultRow = {
      auctionId,
      matchId: MATCH,
      letter,
      winnerBotId: w >= 0 ? seats[w].id : undefined,
      paid: BigInt(paid),
    };
    for (const s of seats) if (s.bot) s.bot.onAuctionResult(conns.get(s.id)!, result);
    if (!final) {
      for (const s of seats) {
        if (s.spec.kind === "starter") starterPlay(s);
        else if (s.spec.kind === "fitted") rivalAct(table, s, s.spec.model, bagLeft, false);
      }
    }
  }
  table.matchState = { ...table.matchState, status: { tag: "Ended" }, currentAuctionId: undefined };
  for (const s of seats) if (s.bot) s.bot.onMatchEnded(conns.get(s.id)!, MATCH);
  return {
    extraTurns,
    fpHistory: seats.map((s) => (s.bot ? [...s.bot.fpHistory] : null)),
    seats: seats.map((s) => ({
      name: s.spec.name,
      kind: s.spec.kind,
      score: s.score,
      balance: s.balance,
      won: s.won,
      paid: s.paid,
      words: s.words,
      firstWord: s.firstWord,
      poor: s.poor,
      midBalance: s.midBalance,
      endRack: [...s.rack.values()].reduce((a, b) => a + b, 0),
      sevens: s.sevens,
      startRack: s.startRack,
      wonLetters: [...s.wonLetters].map((k, i) => String.fromCharCode(65 + i).repeat(k)).join(""),
    })),
  };
}

// ---- variants: strategy.ts constants overridden by name ----

export type PolicyKey = keyof Policy;
export const POLICY_KEYS = Object.keys(DEFAULT_POLICY) as PolicyKey[];
/** Knobs that count tiles, auctions, milliseconds, rivals, observations or coins of a cap: whole numbers only. */
const INTEGER_KEYS: ReadonlySet<PolicyKey> = new Set<PolicyKey>([
  "ENDGAME_AUCTIONS", "CASH_MIN_LEN", "HOLD_MIN_REAL_RIVALS", "LIQUIDITY_MIN_LEN", "LIQUIDITY_FALLBACK_MIN_LEN",
  "LIQUIDITY_TOP_K", "FLUSH_LEAD_MS", "FP_HISTORY_MAX", "FP_MIN_OBS", "BROKE_RIVAL_MAX_BID", "DUEL_MAX_OPPONENTS",
  "DUEL_RESERVE_WINDOW",
]);

export interface Variant {
  name: string;
  /** The constants this variant changes (empty for head). */
  overrides: Partial<Record<PolicyKey, number>>;
  /** DEFAULT_POLICY with the overrides applied: what the variant's SookraBot plays with. */
  policy: Policy;
}

/** "head", or NAME=value parts joined by "+", each NAME a strategy.ts constant (any case). */
export function parseVariant(name: string): Variant {
  if (name === "head") return { name, overrides: {}, policy: DEFAULT_POLICY };
  const overrides: Partial<Record<PolicyKey, number>> = {};
  for (const part of name.split("+")) {
    const m = /^([A-Za-z][A-Za-z0-9_]*)=([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/.exec(part);
    if (!m) {
      throw new Error(
        `variant part "${part}" is not NAME=number: name a strategy.ts constant, e.g. PACED_KAPPA=4.5+PACE_MIN=0.6 ` +
          `(the kappa:, pace:, cashlen:, liq:, liqp:, vom:, early: and hooked forms were retired; see list)`,
      );
    }
    const key = m[1].toUpperCase() as PolicyKey;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_POLICY, key)) {
      throw new Error(`unknown knob ${m[1]} in variant ${name}; knobs: ${POLICY_KEYS.join(", ")}`);
    }
    if (Object.prototype.hasOwnProperty.call(overrides, key)) throw new Error(`${key} is set twice in variant ${name}`);
    const value = Number(m[2]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a finite number >= 0, got ${m[2]}`);
    if (INTEGER_KEYS.has(key) && !Number.isInteger(value)) throw new Error(`${key} counts whole units, got ${m[2]}`);
    if (key === "FP_QUANTILE" && !(value > 0 && value <= 1)) throw new Error(`FP_QUANTILE must be in (0, 1], got ${m[2]}`);
    overrides[key] = value;
  }
  return { name, overrides, policy: Object.freeze({ ...DEFAULT_POLICY, ...overrides }) };
}

// ---- fields ----

const sookra = (name: string, policy: Policy): SeatSpec => ({ kind: "sookra", name, policy });
function fitted(name: string): SeatSpec {
  const model = RIVALS[name];
  if (!model) throw new Error(`no rival model ${name} in fixtures/rival-models.json`);
  return { kind: "fitted", name, model };
}
function randomSims(rnd: Rng, k: number): SeatSpec[] {
  const pool = [...SIMS];
  const out: SeatSpec[] = [];
  for (let i = 0; i < k; i++) {
    const [name, strategy] = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    out.push({ kind: "sim", name, strategy });
  }
  return out;
}

const HEAD = DEFAULT_POLICY;
/** The live bot before it held words at all-real tables (build A): cashes every 7+ word as it forms. */
const CASH7: Policy = Object.freeze({ ...DEFAULT_POLICY, HOLD_MIN_REAL_RIVALS: 99 });

/** A rival's v4 fixture entry: -v4c (complete7 bids, likelihood-chosen word policy) or -v4 (without them). */
const v4 = (name: string, entries: "v4c" | "v4" = "v4c") => `${name}-${entries}`;
const v4Pool = (pool: readonly (readonly [string, number])[], entries: "v4c" | "v4" = "v4c"): [string, number][] =>
  pool.map(([name, w]): [string, number] => [v4(name, entries), w]);
/**
 * Rivals with v4 fits and how many of the 91 live all-real 6-seat tables m300 to m390 each sat at
 * (the Swiss round 1 draw and validate4). Left out though fitted: Doppio (no seat there) and
 * slow-n-dumb (4 seats; its fit stops at m301).
 */
const V4_TABLES: [string, number][] = [
  ["LetterShark", 43], ["LUCENT", 41], ["Yezi", 39], ["scrabbler", 38], ["keanu", 37], ["podzemski", 36],
  ["cashu", 34], ["Dante", 32], ["code", 31], ["MagnusBot", 31], ["TileShark", 30], ["james", 27],
  ["SkyScrabble", 25], ["tinytung", 18], ["bot", 13],
];
/**
 * The strongest rivals with v4 fits, by live all-real place over m300 to m390 (james 2.00, Chinese
 * Dante 2.12, YeziShanYang 2.54, keanu_reeves 2.65, LetterShark 2.65, cashu 2.97, code 3.42; SookraBot 3.06).
 */
const V4_STRONGEST = ["james", "Dante", "Yezi", "keanu", "LetterShark", "cashu", "code"];

// ---- v5 rivals: refits on the 2026-10-24 10:52 UTC snapshot, and their calibration ----

/**
 * Rival model modifiers, by name (validate5 mods, and V5_CALIBRATION). Each maps a fitted model to a
 * changed copy; "+" joins several, applied left to right.
 */
export const RIVAL_MODS: Record<string, { about: string; apply: (m: RivalModel, x: number) => RivalModel; arg?: boolean }> = {
  shark: {
    about: "every rival plays the shark word policy: each 7+ word cashed as it forms, the rack flushed when the final auction opens",
    apply: (m) => ({ ...m, policy: "shark", minLen: undefined, sharkLen: undefined }),
  },
  minlen: {
    about: "minlen=N: a hazard rival's hazard step only plays words of N+ letters (no shorter word before the flush)",
    apply: (m, x) => (m.policy === "hazard" ? { ...m, minLen: Math.max(m.minLen ?? 2, x) } : m),
    arg: true,
  },
  noc7: {
    about: "no complete7 bids: every bid from the regular cells",
    apply: (m) => ({ ...m, complete7: undefined }),
  },
  bidx: {
    about: "bidx=s: every survival bid (cells and complete7) times s before the balance scaling",
    apply: (m, x) => {
      if (m.bid.kind !== "survival") return m;
      const scale = (runs: [number, number][]): [number, number][] => runs.map(([rx, s]): [number, number] => [rx * x, s]);
      const cells = Object.fromEntries(Object.entries(m.bid.cells).map(([k, runs]) => [k, scale(runs)]));
      return { ...m, bid: { ...m.bid, cells }, ...(m.complete7 ? { complete7: scale(m.complete7) } : {}) };
    },
    arg: true,
  },
};

/** "a+b=1.5+..." into its checked parts ("" or "-": none). */
export function parseRivalMods(text: string): string[] {
  if (text === "" || text === "-") return [];
  const out: string[] = [];
  for (const part of text.split("+")) {
    const m = /^([a-z0-9]+)(?:=((?:\d+\.?\d*|\.\d+)))?$/.exec(part);
    const mod = m ? RIVAL_MODS[m[1]] : undefined;
    if (!m || !mod) throw new Error(`rival modifier "${part}": one of ${Object.keys(RIVAL_MODS).join(", ")} (name or name=value)`);
    if (Boolean(mod.arg) !== (m[2] !== undefined)) throw new Error(`rival modifier "${part}": ${mod.about}`);
    if (m[2] !== undefined && !(Number(m[2]) > 0)) throw new Error(`rival modifier "${part}": the value must be > 0`);
    out.push(part);
  }
  return out;
}

export function applyRivalMods(model: RivalModel, mods: readonly string[]): RivalModel {
  let m = model;
  for (const part of mods) {
    const [name, value] = part.split("=");
    m = RIVAL_MODS[name].apply(m, value === undefined ? NaN : Number(value));
  }
  return m;
}

/**
 * The current top bots with v5 fits, strongest first by live all-real place over each one's fitted range
 * (postturing 2.34, guesser 2.46, Chinese Dante 2.54, Doppio 2.58, Nijello 2.59, Vickey 2.61,
 * LetterSharkPro 2.72, Ally 2.76, atlas 2.79, marcellinus 2.95, Cashu 3.05; SookraBot 3.50).
 */
export const V5_TOP = [
  "postturing", "guesser", "Dante", "Doppio", "Nijello", "Vickey", "LetterSharkPro", "Ally", "atlas", "marcellinus", "Cashu",
];
export type V5Entries = "v5" | "v5c" | "v5k";
const V5_ENTRIES: readonly V5Entries[] = ["v5", "v5c", "v5k"];
/**
 * The calibration of the v5 rivals: what turns a -v5c entry into its -v5k model (validate5 with entries
 * v5k, and the v5 fields). mods: RIVAL_MODS applied to every rival; rho: replaces each rival's fitted
 * rack awareness (absent: keep it).
 */
export const V5_CALIBRATION: { mods: string; rho?: number } = { mods: "" };

/** A v5 rival's model: its -v5 or -v5c fixture entry, or for v5k its -v5c entry calibrated (V5_CALIBRATION). */
function v5Model(stem: string, entries: V5Entries): RivalModel {
  const base = RIVALS[`${stem}-${entries === "v5k" ? "v5c" : entries}`];
  if (!base) throw new Error(`no rival model ${stem}-${entries === "v5k" ? "v5c" : entries} in fixtures/rival-models.json`);
  if (entries !== "v5k") return base;
  const m = applyRivalMods(base, parseRivalMods(V5_CALIBRATION.mods));
  return V5_CALIBRATION.rho === undefined ? m : { ...m, rho: V5_CALIBRATION.rho };
}

/** A calibrated v5 rival's seat (name <stem>-v5k). */
function v5k(stem: string): SeatSpec {
  return { kind: "fitted", name: `${stem}-v5k`, model: v5Model(stem, "v5k") };
}

const FIELDS: Record<string, { about: string; seats: (focal: SeatSpec, rnd: Rng) => SeatSpec[] }> = {
  sims: { about: "focal + 5 random sims", seats: (f, r) => [f, ...randomSims(r, 5)] },
  starters: {
    about: "focal + 5 starter clones",
    seats: (f) => [f, ...[0, 1, 2, 3, 4].map((i): SeatSpec => ({ kind: "starter", name: `Starter${i}` }))],
  },
  "duel-ls": { about: "2-bot duel vs LetterShark (88 auctions)", seats: (f) => [f, fitted("LetterShark")] },
  "duel-code": { about: "2-bot duel vs code (88 auctions)", seats: (f) => [f, fitted("code")] },
  t4: { about: "focal, LetterShark, code, bot", seats: (f) => [f, fitted("LetterShark"), fitted("code"), fitted("bot")] },
  t5: {
    about: "focal, LetterShark, code, HEAD SookraBot, bot",
    seats: (f) => [f, fitted("LetterShark"), fitted("code"), sookra("SookraHead", HEAD), fitted("bot")],
  },
  t6: {
    about: "focal, LetterShark, code, HEAD SookraBot, bot, dev-voices",
    seats: (f) => [f, fitted("LetterShark"), fitted("code"), sookra("SookraHead", HEAD), fitted("bot"), fitted("dev-voices")],
  },
  "pad-ls": { about: "focal, LetterShark + 4 random sims", seats: (f, r) => [f, fitted("LetterShark"), ...randomSims(r, 4)] },
  "pad-ls-code": {
    about: "focal, LetterShark, code + 3 random sims",
    seats: (f, r) => [f, fitted("LetterShark"), fitted("code"), ...randomSims(r, 3)],
  },
  "pad-code": { about: "focal, code + 4 random sims (live m127, m129 to m132)", seats: (f, r) => [f, fitted("code"), ...randomSims(r, 4)] },
  // Rivals refitted on matches up to 161 (code-v2 and bot-v2: from match 127; the new bots: all their matches).
  "pad-code2": { about: "focal, code-v2 + 4 random sims (live m127, m129 to m132)", seats: (f, r) => [f, fitted("code-v2"), ...randomSims(r, 4)] },
  "duel-code2": { about: "2-bot duel vs code-v2", seats: (f) => [f, fitted("code-v2")] },
  "duel-yezi": { about: "2-bot duel vs YeziShanYang", seats: (f) => [f, fitted("Yezi")] },
  live4: { about: "focal, code-v2, Yezi, bot-v2", seats: (f) => [f, fitted("code-v2"), fitted("Yezi"), fitted("bot-v2")] },
  live6: {
    about: "focal, code-v2, Yezi, tinytung, bot-v2, dev-voices-v2 (live m147 to m158)",
    seats: (f) => [f, fitted("code-v2"), fitted("Yezi"), fitted("tinytung"), fitted("bot-v2"), fitted("dev-voices-v2")],
  },
  // Value-bidding rivals: the current SookraBot as the opponent.
  "duel-head": { about: "2-bot duel vs a HEAD SookraBot", seats: (f) => [f, sookra("SookraHead", HEAD)] },
  mix5: {
    about: "focal, HEAD SookraBot, code-v2, Yezi, LetterShark",
    seats: (f) => [f, sookra("SookraHead", HEAD), fitted("code-v2"), fitted("Yezi"), fitted("LetterShark")],
  },
  // Robustness: LetterShark keying its endgame on the auction index, so in an 88-auction duel it bids
  // its late-game amounts from auction 51 on (37 auctions early) instead of over the last 17.
  "duel-ls-idx": {
    about: "2-bot duel vs LetterShark with clock blocks by auction index",
    seats: (f) => [f, { kind: "fitted", name: "LetterShark", model: { ...RIVALS.LetterShark, blocksByIndex: true } }],
  },
  // All-real tables, the tournament shape (no sims). Rivals refitted on the live all-real 6-bot
  // matches m147 to m190 (suffix -ar). ar6 draws 5 of the 7 active rivals per match, weighted by
  // how often each sat at those tables; ar6-top-ar is the five most frequent (named ar6-top before
  // the v4 fits; ar6-top is now the five strongest -v4c rivals, below).
  ar6: { about: "focal + 5 of 7 active real rivals (-ar fits), drawn by live table frequency", seats: (f, r) => [f, ...drawRivals(r, 5)] },
  "ar6-top-ar": {
    about: "focal, Yezi-ar, code-ar, bot-ar, tinytung-ar, dev-voices-ar (the old ar6-top)",
    seats: (f) => [f, ...["Yezi-ar", "code-ar", "bot-ar", "tinytung-ar", "dev-voices-ar"].map(fitted)],
  },
  "ar6-head": {
    about: "focal, a HEAD SookraBot + 4 drawn -ar rivals (one value-bidding rival)",
    seats: (f, r) => [f, sookra("SookraHead", HEAD), ...drawRivals(r, 4)],
  },
  "duel-yezi-ar": { about: "2-bot duel vs Yezi-ar", seats: (f) => [f, fitted("Yezi-ar")] },
  "duel-code-ar": { about: "2-bot duel vs code-ar", seats: (f) => [f, fitted("code-ar")] },
  "duel-bot-ar": { about: "2-bot duel vs bot-ar", seats: (f) => [f, fitted("bot-ar")] },
  "duel-tinytung-ar": { about: "2-bot duel vs tinytung-ar", seats: (f) => [f, fitted("tinytung-ar")] },
  // The v4 fits (see the header), -v4c entries unless the field ends in -v4base. The tournament's
  // shape: Swiss round 1 draws its tables (ar6-v4), later rounds seat the leaders together
  // (ar6-top), the bracket runs one table from the cut down to 3 bots (arN-top, arN-topdraw), and
  // the final is a 3-game duel (duel-*-v4). The loops below add arN-v4, arN-top and arN-topdraw.
  // Robustness: the fitted top rivals score below their live level, so ar6-top-mixed gives two seats
  // to value-bidding SookraBots (HEAD, and a cash-7 one, the live bot before holding words).
  "ar6-top-mixed": {
    about: "focal, a HEAD SookraBot, a cash-7 SookraBot (HOLD_MIN_REAL_RIVALS=99), james-v4c, Dante-v4c, Yezi-v4c",
    seats: (f) => [f, sookra("SookraHead", HEAD), sookra("SookraCash7", CASH7), ...V4_STRONGEST.slice(0, 3).map((n) => fitted(v4(n)))],
  },
  "ar6-v4base": {
    about: "ar6-v4 with the -v4 entries (no complete7 bids, every hazard rival on minLen 2)",
    seats: (f, r) => [f, ...drawFrom(r, v4Pool(V4_TABLES, "v4"), 5)],
  },
  "ar6-top-v4base": {
    about: `ar6-top with the -v4 entries: ${V4_STRONGEST.slice(0, 5).map((n) => v4(n, "v4")).join(", ")}`,
    seats: (f) => [f, ...V4_STRONGEST.slice(0, 5).map((n) => fitted(v4(n, "v4")))],
  },
};
// All-real tables of every size: arN is the focal bot + N - 1 drawn -ar rivals (BAG_TILES - 5N auctions).
// The final is a duel (ar2); bracket tables shrink from the cut to 3 bots; a Swiss round seats
// tables of about the match size, 10 or 11 entrants at match size 6 one table (tournament.ts tableSizes).
for (let size = 2; size <= 8; size++) {
  FIELDS[`ar${size}`] ??= {
    about: `focal + ${size - 1} drawn -ar rival${size > 2 ? "s" : ""} (${BAG_TILES - RACK * size} auctions)`,
    seats: (f, r) => [f, ...drawRivals(r, size - 1)],
  };
}
/** Adds a field, refusing to replace one (a silently redefined name would change old commands' meaning). */
function addField(name: string, about: string, seats: (focal: SeatSpec, rnd: Rng) => SeatSpec[]) {
  if (FIELDS[name]) throw new Error(`field ${name} is defined twice`);
  FIELDS[name] = { about, seats };
}
for (let size = 2; size <= 8; size++) {
  addField(
    `ar${size}-v4`,
    `focal + ${size - 1} -v4c rival${size > 2 ? "s" : ""} drawn by m300 to m390 table frequency (${BAG_TILES - RACK * size} auctions)`,
    (f, r) => [f, ...drawFrom(r, v4Pool(V4_TABLES), size - 1)],
  );
}
for (let size = 3; size <= 8; size++) {
  const names = V4_STRONGEST.slice(0, size - 1).map((n) => v4(n));
  addField(`ar${size}-top`, `focal + the ${size - 1} strongest: ${names.join(", ")}`, (f) => [f, ...names.map(fitted)]);
}
for (const size of [3, 4]) {
  const top6 = V4_STRONGEST.slice(0, 6);
  addField(
    `ar${size}-topdraw`,
    `focal + ${size - 1} drawn equally from the six strongest -v4c rivals (${top6.join(", ")})`,
    (f, r) => [f, ...drawFrom(r, v4Pool(top6.map((n): [string, number] => [n, 1])), size - 1)],
  );
}
for (const [short, name] of [
  ["james", "james"], ["dante", "Dante"], ["yezi", "Yezi"], ["keanu", "keanu"],
  ["ls", "LetterShark"], ["cashu", "cashu"], ["code", "code"], ["doppio", "Doppio"],
] as const) {
  addField(`duel-${short}-v4`, `2-bot duel vs ${v4(name)} (88 auctions; the final)`, (f) => [f, fitted(v4(name))]);
}
/** Every field name, in list order. */
export const FIELD_NAMES: readonly string[] = Object.freeze(Object.keys(FIELDS));

/** Seat names of a field's match with match seed `ms`, focal bot first (for checks; the focal plays HEAD). */
export function fieldSeatNames(fieldText: string, ms: number): string[] {
  return fieldSeats(parseField(fieldText), HEAD, ms).map((s) => s.name);
}

/** Active all-real rivals and how many of the 44 live all-real tables (m147 to m190) each sat at. */
const AR_POOL: [string, number][] = [
  ["Yezi-ar", 38], ["code-ar", 40], ["bot-ar", 24], ["tinytung-ar", 35],
  ["dev-voices-ar", 33], ["slow-n-dumb-ar", 32], ["podzemski-ar", 13],
];

/** k distinct rivals from AR_POOL, each draw proportional to the remaining weights. */
function drawRivals(rnd: Rng, k: number): SeatSpec[] {
  return drawFrom(rnd, AR_POOL, k);
}

/** k distinct rivals from a weighted pool of fixture entries, each draw proportional to the remaining weights. */
function drawFrom(rnd: Rng, weighted: readonly (readonly [string, number])[], k: number): SeatSpec[] {
  const pool = [...weighted];
  const out: SeatSpec[] = [];
  for (let i = 0; i < k; i++) {
    const total = pool.reduce((s, [, w]) => s + w, 0);
    let u = rnd() * total;
    let j = 0;
    while (j < pool.length - 1 && u >= pool[j][1]) u -= pool[j++][1];
    out.push(fitted(pool.splice(j, 1)[0][0]));
  }
  return out;
}

export interface FieldSpec {
  /** As written on the command line; rows and summaries carry it. */
  name: string;
  base: string;
  rho?: number;
  env: MatchEnv;
  /**
   * First price only: before each match, play a burn-in match of the same field and variant
   * (seed mix(match seed, 5)) and start every SookraBot seat with the price history it ends with,
   * as the live bot carries its history from one first-price match to the next.
   */
  warm: boolean;
}

/** "<name>[@<rho>][,fp][,vickrey][,shade=<s>][,warm]" (see the header). */
export function parseField(text: string): FieldSpec {
  const [head, ...mods] = text.split(",");
  const [base, rhoText, ...extra] = head.split("@");
  if (!FIELDS[base]) throw new Error(`unknown field ${base} (try: list)`);
  if (extra.length > 0) throw new Error(`field ${text}: one @rho at most`);
  let rho: number | undefined;
  if (rhoText !== undefined) {
    rho = Number(rhoText);
    if (rhoText === "" || !(rho >= 0 && rho < 1)) throw new Error(`rho must be in [0, 1): ${rhoText}`);
  }
  let auction: AuctionKind = "Vickrey";
  let shade = 1;
  let warm = false;
  for (const mod of mods) {
    if (mod === "fp") auction = "FirstPrice";
    else if (mod === "vickrey") auction = "Vickrey";
    else if (mod === "warm") warm = true;
    else if (mod.startsWith("shade=")) {
      shade = Number(mod.slice("shade=".length));
      if (mod === "shade=" || !(shade > 0 && Number.isFinite(shade))) throw new Error(`shade must be a number > 0: ${mod}`);
    } else throw new Error(`unknown field modifier ${mod} in ${text} (fp, vickrey, shade=<s>, warm)`);
  }
  if (warm && auction !== "FirstPrice") throw new Error(`field ${text}: warm carries first-price history; add fp`);
  return { name: text, base, rho, env: { auction, shade }, warm };
}

/** The seats of match `ms` of this field, with the focal SookraBot playing `policy`. */
function fieldSeats(field: FieldSpec, policy: Policy, ms: number): SeatSpec[] {
  const specs = FIELDS[field.base].seats(sookra("SookraBot", policy), mulberry32(mix(ms, STREAM.field)));
  const rho = field.rho;
  return rho === undefined ? specs : specs.map((s) => (s.kind === "fitted" ? { ...s, model: { ...s.model, rho } } : s));
}

// ---- statistics ----

function meanSe(xs: number[]): { mean: number; se: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { mean: +mean.toFixed(3), se: +(sd / Math.sqrt(n)).toFixed(3) };
}

/** Paired difference: mean, standard error and t (null when every difference is the same). */
function pairedDiff(xs: number[]): { mean: number; se: number; t: number | null } {
  const { mean, se } = meanSe(xs);
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  const exactSe = sd / Math.sqrt(n);
  return { mean, se, t: exactSe > 0 ? +(m / exactSe).toFixed(2) : null };
}

interface FocalRow {
  i: number;
  score: number;
  best: number;
  margin: number;
  win: number;
  swiss: number;
  last: number;
  ls: number | null;
  lsMargin: number | null;
  won: number;
  paid: number;
  balance: number;
  words: number;
  firstWord: number | null;
  poor: number;
  midBalance: number | null;
  endRack: number;
}

function focalRow(i: number, res: SeatResult[]): FocalRow {
  const me = res[0];
  const others = res.slice(1);
  const best = Math.max(...others.map((o) => o.score));
  const place = others.filter((o) => o.score > me.score).length;
  const ls = res.find((r) => r.name === "LetterShark");
  return {
    i,
    score: me.score,
    best,
    margin: me.score - best,
    win: me.score >= best ? 1 : 0,
    swiss: res.length - place,
    last: me.score <= Math.min(...others.map((o) => o.score)) ? 1 : 0,
    ls: ls ? ls.score : null,
    lsMargin: ls ? me.score - ls.score : null,
    won: me.won,
    paid: me.paid,
    balance: me.balance,
    words: me.words,
    firstWord: me.firstWord,
    poor: me.poor,
    midBalance: me.midBalance,
    endRack: me.endRack,
  };
}

/** One line of --rows: a variant's result in one match. */
export interface Row extends FocalRow {
  field: string;
  auction: AuctionKind;
  seats: number;
  seed: number;
  variant: string;
  /** Hash of the bot, harness, rival and wordlist sources that produced it. */
  code: string;
  extraTurns: number;
  /** Wall time of this match, ms (left out when rows are compared). */
  ms: number;
  others: { name: string; kind: string; score: number; won: number; paid: number; balance: number; midBalance: number | null }[];
}

const DIFF_KEYS: (keyof FocalRow)[] = ["score", "margin", "win", "swiss", "last"];

/** One summary per variant (in first-appearance order) of rows from one field and seed. */
export function summarize(rows: Row[]): Record<string, unknown>[] {
  const byVariant = new Map<string, Row[]>();
  for (const r of rows) {
    let list = byVariant.get(r.variant);
    if (!list) byVariant.set(r.variant, (list = []));
    list.push(r);
  }
  const names = [...byVariant.keys()];
  for (const list of byVariant.values()) list.sort((a, b) => a.i - b.i);
  const ids = byVariant.get(names[0])!.map((r) => r.i).join(",");
  for (const name of names) {
    if (byVariant.get(name)!.map((r) => r.i).join(",") !== ids) {
      throw new Error(`variants ${names[0]} and ${name} cover different matches; paired differences need the same ones`);
    }
  }
  const hasLs = rows.every((r) => r.ls !== null);
  const keys: (keyof FocalRow)[] = ["score", "margin", "win", "swiss", ...(hasLs ? (["lsMargin"] as const) : [])];
  const pick = (rs: Row[], key: keyof FocalRow) => rs.map((r) => Number(r[key] ?? 0));
  const avg = (xs: number[]) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  const first = byVariant.get(names[0])!;
  const secs = +(rows.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1);
  return names.map((name, v) => {
    const rs = byVariant.get(name)!;
    const r0 = rs[0];
    const out: Record<string, unknown> = {
      field: r0.field, auction: r0.auction, seats: r0.seats, variant: name,
      overrides: parseVariant(name).overrides, n: rs.length, seed: r0.seed,
    };
    for (const k of keys) out[k] = meanSe(pick(rs, k));
    if (hasLs) {
      out.ls = avg(pick(rs, "ls"));
      out.lsWinRate = avg(rs.map((r) => (r.lsMargin! >= 0 ? 1 : 0)));
    }
    out.last = avg(pick(rs, "last"));
    for (const k of ["won", "paid", "balance", "words", "poor", "endRack"] as const) out[k] = avg(pick(rs, k));
    const fw = rs.map((r) => r.firstWord).filter((x): x is number => x !== null).sort((a, b) => a - b);
    out.firstWordMedian = fw.length ? fw[Math.floor(fw.length / 2)] : null;
    out.midBalance = avg(rs.map((r) => r.midBalance ?? 0));
    const rivals = new Map<string, number[]>();
    for (const r of rs) {
      for (const o of r.others) {
        const key = o.kind === "sim" ? "sims" : o.name;
        const acc = rivals.get(key) ?? [0, 0, 0, 0, 0, 0];
        [o.score, o.won, o.paid, o.balance, o.midBalance ?? 0, 1].forEach((x, j) => (acc[j] += x));
        rivals.set(key, acc);
      }
    }
    out.rivals = Object.fromEntries(
      [...rivals].map(([key, a]) => [
        key,
        { score: +(a[0] / a[5]).toFixed(1), won: +(a[1] / a[5]).toFixed(1), paid: +(a[2] / a[5]).toFixed(1), balance: +(a[3] / a[5]).toFixed(1), midBalance: +(a[4] / a[5]).toFixed(1) },
      ]),
    );
    if (v > 0) {
      const diff: Record<string, unknown> = {};
      for (const k of [...new Set([...DIFF_KEYS, ...keys])]) {
        const a = pick(rs, k);
        const b = pick(first, k);
        diff[k] = pairedDiff(a.map((x, i) => x - b[i]));
      }
      diff.identical = rs.filter((r, i) => sameMatch(r, first[i])).length;
      out.vsFirst = diff;
    }
    out.extraTurns = rs.reduce((a, r) => a + r.extraTurns, 0);
    out.msPerMatch = Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length);
    out.secs = secs;
    out.code = r0.code;
    return out;
  });
}

/** Whether two rows of one match agree on every focal and rival result (the variant name, ms and code aside). */
function sameMatch(a: Row, b: Row): boolean {
  const strip = (r: Row) => JSON.stringify({ ...r, variant: "", ms: 0, code: "" });
  return strip(a) === strip(b);
}

function loadIndex(): WordIndex {
  return WordIndex.fromWords(fs.readFileSync(WORDLIST, "utf8").split("\n"));
}

/** sha256 (first 12 hex) of everything a self-play result depends on. */
function codeHash(): string {
  const h = crypto.createHash("sha256");
  for (const f of ["bot.ts", "strategy.ts", "engine.ts", "selfplay.ts", "fixtures/rival-models.json"]) {
    h.update(f);
    h.update(fs.readFileSync(new URL(`./${f}`, import.meta.url)));
  }
  h.update(fs.readFileSync(WORDLIST));
  return h.digest("hex").slice(0, 12);
}

// ---- modes ----

async function legacy(field: "sims" | "starters", n: number, seed: number) {
  const index = loadIndex();
  const t0 = performance.now();
  const scores: number[] = [];
  let wins = 0;
  let best = 0;
  let endBal = 0;
  for (let i = 0; i < n; i++) {
    const ms = mix(seed, i);
    const specs = FIELDS[field].seats(sookra("SookraBot", HEAD), mulberry32(mix(ms, STREAM.field)));
    const r = focalRow(i, (await playMatch(index, specs, ms)).seats);
    scores.push(r.score);
    best += r.best;
    endBal += r.balance;
    wins += r.win;
  }
  const { mean } = meanSe(scores);
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  console.log(
    JSON.stringify({
      field, n, seed,
      me_mean: +mean.toFixed(2), me_sd: +sd.toFixed(2),
      best_other_mean: +(best / n).toFixed(2), win_rate: +(wins / n).toFixed(3),
      end_balance_mean: +(endBal / n).toFixed(1), secs: +((performance.now() - t0) / 1000).toFixed(1),
    }),
  );
}

/** Matches lo..hi-1 of n for shard "i/n" (0 <= i < count): contiguous blocks, every match in exactly one. */
export function shardRange(n: number, shard: string | undefined): [number, number] {
  if (shard === undefined) return [0, n];
  const m = /^(\d+)\/(\d+)$/.exec(shard);
  const i = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!(count >= 1 && i >= 0 && i < count)) throw new Error(`--shard=${shard}: want i/n with 0 <= i < n`);
  return [Math.floor((i * n) / count), Math.floor(((i + 1) * n) / count)];
}

export async function compare(
  fieldText: string, n: number, seed: number, names: string[],
  opts: { rowsPath?: string; shard?: string; quiet?: boolean; trace?: (line: string) => void } = {},
): Promise<Row[]> {
  const field = parseField(fieldText);
  if (!(Number.isInteger(n) && n > 0)) throw new Error(`matches must be a whole number > 0, got ${n}`);
  if (!Number.isInteger(seed)) throw new Error(`seed must be a whole number, got ${seed}`);
  if (names.length === 0) throw new Error("name at least one variant");
  if (new Set(names).size !== names.length) throw new Error("a variant is listed twice");
  const variants = names.map(parseVariant);
  const [lo, hi] = shardRange(n, opts.shard);
  const index = loadIndex();
  const code = codeHash();
  const rows: Row[] = [];
  for (let i = lo; i < hi; i++) {
    const ms = mix(seed, i);
    const matchRows: Row[] = [];
    for (const variant of variants) {
      const t0 = performance.now();
      let fpHistory: (PricePoint[] | null)[] | undefined;
      if (field.warm) {
        const burn = mix(ms, STREAM.warm);
        fpHistory = (await playMatch(index, fieldSeats(field, variant.policy, burn), burn, field.env)).fpHistory;
      }
      const trace = opts.trace;
      const focalLog: Logger | undefined = trace
        ? { log: (msg) => trace(`[${i} ${variant.name}] ${msg}`), warn: (msg) => trace(`[${i} ${variant.name}] WARN ${msg}`) }
        : undefined;
      const res = await playMatch(index, fieldSeats(field, variant.policy, ms), ms, field.env, { focalLog, fpHistory });
      const wall = performance.now() - t0;
      matchRows.push({
        field: field.name, auction: field.env.auction, seats: res.seats.length, seed, variant: variant.name, code,
        ...focalRow(i, res.seats),
        extraTurns: res.extraTurns,
        ms: Math.round(wall),
        others: res.seats.slice(1).map((o) => ({
          name: o.name, kind: o.kind, score: o.score, won: o.won, paid: o.paid, balance: o.balance, midBalance: o.midBalance,
        })),
      });
    }
    if (opts.rowsPath) fs.appendFileSync(opts.rowsPath, matchRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    rows.push(...matchRows);
  }
  if (!opts.quiet && rows.length > 0) {
    for (const s of summarize(rows)) {
      console.log(JSON.stringify(opts.shard ? { ...s, shard: opts.shard, matches: [lo, hi - 1] } : s));
    }
  }
  return rows;
}

/** Rows from several files, grouped by field and seed, with identical duplicates dropped. */
export function readRows(paths: string[]): Map<string, Row[]> {
  const groups = new Map<string, Map<string, Row>>();
  for (const p of paths) {
    const lines = fs.readFileSync(p, "utf8").split("\n");
    lines.forEach((line, ln) => {
      if (line.trim() === "") return;
      let r: Row;
      try {
        r = JSON.parse(line);
      } catch {
        throw new Error(`${p}:${ln + 1}: not JSON (a truncated last line means the run was cut off)`);
      }
      if (typeof r.variant !== "string" || !Number.isInteger(r.i) || typeof r.field !== "string" || !Array.isArray(r.others)) {
        throw new Error(`${p}:${ln + 1}: not a self-play row`);
      }
      const g = `${r.field}|${r.seed}`;
      let rows = groups.get(g);
      if (!rows) groups.set(g, (rows = new Map()));
      const key = `${r.variant}|${r.i}`;
      const had = rows.get(key);
      if (had) {
        if (!sameMatch(had, r) || had.code !== r.code) throw new Error(`${p}:${ln + 1}: ${key} of ${g} differs from an earlier row`);
        return;
      }
      rows.set(key, r);
    });
  }
  const out = new Map<string, Row[]>();
  for (const [g, rows] of groups) {
    const list = [...rows.values()];
    const codes = new Set(list.map((r) => r.code));
    if (codes.size > 1) throw new Error(`${g}: rows from different code (${[...codes].join(", ")})`);
    out.set(g, list);
  }
  return out;
}

function merge(paths: string[], expect?: number) {
  if (paths.length === 0) throw new Error("name at least one rows file");
  for (const [g, rows] of readRows(paths)) {
    if (expect !== undefined) {
      const byVariant = new Map<string, Set<number>>();
      for (const r of rows) {
        let ids = byVariant.get(r.variant);
        if (!ids) byVariant.set(r.variant, (ids = new Set()));
        ids.add(r.i);
      }
      for (const [variant, ids] of byVariant) {
        const missing: number[] = [];
        for (let i = 0; i < expect; i++) if (!ids.has(i)) missing.push(i);
        const extra = [...ids].filter((i) => i >= expect);
        if (missing.length || extra.length) {
          throw new Error(`${g} ${variant}: ${missing.length} of ${expect} matches missing (first ${missing.slice(0, 5).join(", ")}), ${extra.length} beyond`);
        }
      }
    }
    for (const s of summarize(rows)) console.log(JSON.stringify(s));
  }
}

/** Fitted rivals against sims only, to compare with rival_sim.py's closed-loop validation. */
async function validate(n: number, seed: number) {
  const index = loadIndex();
  const plans: [string, string[]][] = [
    ["LetterShark vs 5 sims", ["LetterShark"]],
    ["code vs 5 sims", ["code"]],
    ["bot vs 5 sims", ["bot"]],
    ["LetterShark + bot vs 4 sims", ["LetterShark", "bot"]],
    ["LetterShark + code vs 4 sims", ["LetterShark", "code"]],
  ];
  for (const [title, names] of plans) {
    const acc = new Map<string, SeatResult[]>();
    for (let i = 0; i < n; i++) {
      const ms = mix(seed, i, title.length);
      const specs = [...names.map(fitted), ...randomSims(mulberry32(mix(ms, STREAM.field)), 6 - names.length)];
      for (const r of (await playMatch(index, specs, ms)).seats) {
        if (r.kind !== "fitted") continue;
        if (!acc.has(r.name)) acc.set(r.name, []);
        acc.get(r.name)!.push(r);
      }
    }
    for (const [name, rs] of acc) {
      const sum = (k: keyof SeatResult) => rs.reduce((a, r) => a + Number(r[k] ?? 0), 0);
      const fw = rs.map((r) => r.firstWord).filter((x): x is number => x !== null).sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          title, name, n,
          score: +(sum("score") / n).toFixed(1),
          won: +(sum("won") / n).toFixed(1),
          price: +(sum("paid") / sum("won")).toFixed(2),
          final_bal: +(sum("balance") / n).toFixed(1),
          first_word_median: fw.length ? fw[Math.floor(fw.length / 2)] : null,
        }),
      );
    }
  }
}

/** A v4 rival's live numbers over its fit's range (fixtures/rival-live-v4.json, from rival_refit_v4.py). */
interface LiveObs {
  score: number;
  won: number;
  paid: number;
  final_balance: number;
  n_words: number;
  place: number;
}

/**
 * v4 rivals only, six to a table drawn by m300 to m390 table frequency (the live casual tables, with
 * SookraBot's seat given to one more rival): per rival, the simulated mean score, place, win rate,
 * letters won, coins paid, final balance and words, beside the live numbers its fit came from. `rho`
 * replaces every rival's fitted rack awareness (undefined keeps each entry's own). One summary per
 * rival, strongest live place first; calibrate by picking the rho whose simulated rivals match live.
 */
export async function validate4(
  n: number, seed: number, rho?: number, entries: "v4c" | "v4" = "v4c",
): Promise<Record<string, unknown>[]> {
  if (!(Number.isInteger(n) && n > 0)) throw new Error(`matches must be a whole number > 0, got ${n}`);
  if (!Number.isInteger(seed)) throw new Error(`seed must be a whole number, got ${seed}`);
  if (rho !== undefined && !(rho >= 0 && rho < 1)) throw new Error(`rho must be in [0, 1) or "-", got ${rho}`);
  if (entries !== "v4c" && entries !== "v4") throw new Error(`entries must be v4c or v4, got ${entries}`);
  const live: Record<string, LiveObs> = JSON.parse(
    fs.readFileSync(new URL("./fixtures/rival-live-v4.json", import.meta.url), "utf8"),
  ).rivals;
  const index = loadIndex();
  const pool = v4Pool(V4_TABLES, entries);
  const acc = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const ms = mix(seed, i, 4);
    const specs = drawFrom(mulberry32(mix(ms, STREAM.field)), pool, 6).map((s) =>
      rho !== undefined && s.kind === "fitted" ? { ...s, model: { ...s.model, rho } } : s,
    );
    const seats = (await playMatch(index, specs, ms)).seats;
    for (const r of seats) {
      const ahead = seats.filter((o) => o.score > r.score).length;
      const a = acc.get(r.name) ?? [0, 0, 0, 0, 0, 0, 0, 0];
      [r.score, ahead + 1, ahead === 0 ? 1 : 0, r.won, r.paid, r.balance, r.words, 1].forEach((x, j) => (a[j] += x));
      acc.set(r.name, a);
    }
  }
  const r1 = (x: number) => +x.toFixed(1);
  const r2 = (x: number) => +x.toFixed(2);
  const out = [...acc].map(([name, a]) => {
    const m = a[7];
    const stem = name.replace(/-v4c?$/, "");
    const obs = live[stem];
    const sim = {
      score: r1(a[0] / m), place: r2(a[1] / m), win: r2(a[2] / m), won: r1(a[3] / m),
      paid: r1(a[4] / m), final_balance: r1(a[5] / m), words: r2(a[6] / m),
    };
    return {
      kind: "validate4", rival: name, entries, rho: rho ?? RIVALS[name].rho ?? 0, rhoFitted: rho === undefined,
      matches: n, seed, seats: m, sim,
      live: obs
        ? { score: obs.score, place: obs.place, won: obs.won, paid: obs.paid, final_balance: obs.final_balance, words: obs.n_words }
        : null,
      simMinusLive: obs ? { score: r1(sim.score - obs.score), place: r2(sim.place - obs.place), won: r1(sim.won - obs.won) } : null,
    };
  });
  out.sort((x, y) => (x.live?.place ?? 9) - (y.live?.place ?? 9) || x.rival.localeCompare(y.rival));
  return out;
}

/** A v5 rival's live numbers over its fit's range (fixtures/rival-live-v5.json, rival_live_v5.py). */
interface LiveV5 {
  bot: number;
  name: string;
  range: [number, number];
  matches: number;
  score: number;
  place: number;
  win: number;
  won: number;
  paid: number;
  final_balance: number;
  n_words: number;
  sevens: number;
  eights: number;
  used: number;
  end_rack: number;
  /** Greedy pack value of the letters won (every word that fits, best reward first). */
  pack_won: number;
  /** Greedy pack value of the starting rack plus the letters won (matches with a known starting rack). */
  pack_all: number | null;
  /** Letters won per match by face value: 1, 2, 3, 4, 5+ points. */
  won_by_class: number[];
}
interface LiveV5File {
  rivals: Record<string, LiveV5>;
  /** Live all-real tables from m1000 on: [match id, stem x 6]. */
  tables: (number | string)[][];
}
let liveV5Cache: LiveV5File | undefined;
function liveV5(): LiveV5File {
  liveV5Cache ??= JSON.parse(fs.readFileSync(new URL("./fixtures/rival-live-v5.json", import.meta.url), "utf8")) as LiveV5File;
  return liveV5Cache;
}

/** Greedy pack value of a set of tiles (every word that fits, best reward first): rival_v5_metrics.py's measure. */
function packValue(index: WordIndex, letters: string): number {
  const counts = countsOf(letters);
  return index.pack(index.scan(counts, false), counts, -1, 0).total;
}

/**
 * The live tables of fixtures/rival-live-v5.json replayed with the v5 fits: match i seats the six bots of
 * table i mod 288 (every all-real table from m1000 on whose bots all have fits; SookraBot's seat is its own
 * fit, SookraBot-v5), so each rival meets the opponents it met live. Per rival, the simulated score, place,
 * win rate, letters won, coins paid, final balance, words, 7+ words, tiles used and left, and the packing
 * measures (greedy pack value of the letters won, and of the starting rack plus the letters won), beside
 * its live numbers over its fitted range. `entries`: v5 (the existing format), v5c (complete7 bids and the
 * likelihood-chosen word policies) or v5k (v5c with the calibration, V5_CALIBRATION). `rho` replaces every
 * rival's rack awareness; `mods` are rival model modifiers (RIVAL_MODS) applied to every seat.
 */
export async function validate5(
  n: number, seed: number, rho?: number, entries: V5Entries = "v5c", mods = "",
): Promise<Record<string, unknown>[]> {
  if (!(Number.isInteger(n) && n > 0)) throw new Error(`matches must be a whole number > 0, got ${n}`);
  if (!Number.isInteger(seed)) throw new Error(`seed must be a whole number, got ${seed}`);
  if (rho !== undefined && !(rho >= 0 && rho < 1)) throw new Error(`rho must be in [0, 1) or "-", got ${rho}`);
  if (!V5_ENTRIES.includes(entries)) throw new Error(`entries must be one of ${V5_ENTRIES.join(", ")}, got ${entries}`);
  const modList = parseRivalMods(mods);
  const { rivals: live, tables } = liveV5();
  const index = loadIndex();
  const acc = new Map<string, number[]>();
  const models = new Map<string, RivalModel>();
  for (let i = 0; i < n; i++) {
    const stems = tables[i % tables.length].slice(1) as string[];
    const specs = stems.map((stem): SeatSpec => {
      let model = models.get(stem);
      if (!model) {
        model = applyRivalMods(v5Model(stem, entries), modList);
        if (rho !== undefined) model = { ...model, rho };
        models.set(stem, model);
      }
      return { kind: "fitted", name: stem, model };
    });
    const seats = (await playMatch(index, specs, mix(seed, i, 5))).seats;
    for (const r of seats) {
      const ahead = seats.filter((o) => o.score > r.score).length;
      const a = acc.get(r.name) ?? Array<number>(18).fill(0);
      [
        r.score, ahead + 1, ahead === 0 ? 1 : 0, r.won, r.paid, r.balance, r.words, r.sevens, RACK + r.won - r.endRack,
        r.endRack, packValue(index, r.wonLetters), packValue(index, r.startRack + r.wonLetters), 1,
      ].forEach((x, j) => (a[j] += x));
      for (const c of r.wonLetters) a[13 + Math.min(LETTER_VALUE[c], 5) - 1]++;
      acc.set(r.name, a);
    }
  }
  const r1 = (x: number) => +x.toFixed(1);
  const r2 = (x: number) => +x.toFixed(2);
  const label = (rho === undefined ? "fitted" : `rho ${rho}`) + (modList.length ? ` ${modList.join("+")}` : "");
  const out = [...acc].map(([stem, a]) => {
    const m = a[12];
    const obs = live[stem];
    const sim = {
      score: r1(a[0] / m), place: r2(a[1] / m), win: r2(a[2] / m), won: r1(a[3] / m), paid: r1(a[4] / m),
      final_balance: r1(a[5] / m), words: r2(a[6] / m), sevens: r2(a[7] / m), used: r1(a[8] / m), end_rack: r1(a[9] / m),
      pack_won: r1(a[10] / m), pack_all: r1(a[11] / m), score_over_pack_all: r2(a[0] / a[11]),
      won_by_class: a.slice(13, 18).map((x) => r2(x / m)),
    };
    return {
      kind: "validate5", rival: `${stem}-${entries}`, stem, entries, top: V5_TOP.includes(stem),
      rho: rho ?? models.get(stem)!.rho ?? 0, rhoFitted: rho === undefined, mods: modList.join("+"), label,
      matches: n, seed, seats: m, sim,
      live: {
        score: obs.score, place: obs.place, win: obs.win, won: obs.won, paid: obs.paid, final_balance: obs.final_balance,
        words: obs.n_words, sevens: obs.sevens, used: obs.used, end_rack: obs.end_rack, pack_won: obs.pack_won,
        pack_all: obs.pack_all, won_by_class: obs.won_by_class, matches: obs.matches,
      },
      simMinusLive: {
        score: r1(sim.score - obs.score), place: r2(sim.place - obs.place), won: r1(sim.won - obs.won),
        sevens: r2(sim.sevens - obs.sevens), pack_won: r1(sim.pack_won - obs.pack_won),
      },
    };
  });
  out.sort((x, y) => x.live.place - y.live.place || x.stem.localeCompare(y.stem));
  return out;
}

function list() {
  for (const [k, f] of Object.entries(FIELDS)) console.log(`${k.padEnd(16)} ${f.about}`);
  console.log("field modifiers: <field>[@<rho>][,fp][,vickrey][,shade=<s>][,warm]   e.g. ar6@0.9,fp,shade=0.8,warm");
  console.log("variants: head, or NAME=value joined by +, NAME one of (default):");
  for (const k of POLICY_KEYS) console.log(`  ${k.padEnd(28)} ${DEFAULT_POLICY[k]}${INTEGER_KEYS.has(k) ? "  (whole number)" : ""}`);
  console.log("rival modifiers (validate5 [matches] [seed] [rho|-] [v5k|v5c|v5] [mod+mod...]):");
  for (const [k, m] of Object.entries(RIVAL_MODS)) console.log(`  ${k.padEnd(10)} ${m.about}`);
  console.log(`v5k calibration: ${JSON.stringify(V5_CALIBRATION)}`);
}

async function main() {
  const [mode = "sims", ...args] = process.argv.slice(2);
  const opts = args.filter((a) => a.startsWith("--"));
  const pos = args.filter((a) => !a.startsWith("--"));
  const opt = (name: string) => opts.find((o) => o.startsWith(`--${name}=`))?.slice(name.length + 3);
  const known = new Set(["rows", "shard", "expect"]);
  for (const o of opts) {
    if (o === "--trace") continue;
    const name = /^--([a-z]+)=/.exec(o)?.[1];
    if (!name || !known.has(name)) {
      throw new Error(`unknown option ${o} (--rows=<file>, --shard=i/n, --trace, --expect=<matches>)`);
    }
  }
  if (mode === "sims" || mode === "starters") {
    await legacy(mode, Number(pos[0] ?? 50), Number(pos[1] ?? 1));
  } else if (mode === "compare") {
    if (pos.length < 4) throw new Error("usage: compare <field> <matches> <seed> <variant>... [--shard=i/n] [--rows=file] [--trace]");
    await compare(pos[0], Number(pos[1]), Number(pos[2]), pos.slice(3), {
      rowsPath: opt("rows"),
      shard: opt("shard"),
      trace: opts.includes("--trace") ? (line) => process.stderr.write(`${line}\n`) : undefined,
    });
  } else if (mode === "merge") {
    const expect = opt("expect");
    if (expect !== undefined && !(Number.isInteger(Number(expect)) && Number(expect) > 0)) throw new Error(`--expect=${expect}`);
    merge(pos, expect === undefined ? undefined : Number(expect));
  } else if (mode === "validate") {
    await validate(Number(pos[0] ?? 300), Number(pos[1] ?? 1));
  } else if (mode === "validate4") {
    const rho = pos[2] === undefined || pos[2] === "-" ? undefined : Number(pos[2]);
    const entries = (pos[3] ?? "v4c").replace(/^-/, "");
    for (const s of await validate4(Number(pos[0] ?? 200), Number(pos[1] ?? 1), rho, entries as "v4c" | "v4")) {
      console.log(JSON.stringify(s));
    }
  } else if (mode === "validate5") {
    const rho = pos[2] === undefined || pos[2] === "-" ? undefined : Number(pos[2]);
    const entries = (pos[3] ?? "v5c").replace(/^-/, "") as V5Entries;
    for (const s of await validate5(Number(pos[0] ?? 288), Number(pos[1] ?? 1), rho, entries, pos[4] ?? "")) {
      console.log(JSON.stringify(s));
    }
  } else if (mode === "list") {
    list();
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
}

// Run only as a script (tests import this module).
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url) || invoked === fileURLToPath(import.meta.url).replace(/\.ts$/, "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
