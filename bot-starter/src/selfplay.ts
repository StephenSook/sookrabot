// Offline self-play: runs the real SookraBot class (bot.ts, unchanged)
// through simulated matches against module-exact sims, starter clones,
// fitted models of the real rivals (fixtures/rival-models.json) and other
// SookraBot instances.
//
//   npx tsx src/selfplay.ts [sims|starters] [matches] [seed]
//   npx tsx src/selfplay.ts compare <field> <matches> <seed> <variant>... [--rows=file.jsonl]
//   npx tsx src/selfplay.ts validate [matches] [seed]
//   npx tsx src/selfplay.ts list
//
// Rules mirrored from spacetimedb/src/game.ts: 98-tile bag, 5-tile hidden
// racks, balance 100, one letter per auction (98 - 5 x seats auctions),
// Vickrey (second price, 1 when alone, random ties), unbid letters
// discarded, sims bid on every letter with jitter -2..2 and play their
// longest 3+ word right after a win, a real bot cannot use the final letter
// (the match ends when it closes). Timing is idealized: every bot's bid and
// word plays land before each auction closes.
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
// from match 127 on, the newer bots on all their matches. Known gap: these
// bids do not depend on the rival's own rack, and against them the harness
// is optimistic for SookraBot (pad-code2: 153 vs code-v2 115; live m127 and
// m129 to m132: 101 vs code 208), so trust paired differences more than levels.
//
// compare runs every variant of the focal SookraBot (seat 0) on the same
// deals with common random numbers: per match, the bag order, each sim's
// jitter, each fitted rival's bid noise and the tie-break priorities come
// from their own seeded streams, so variants differ only through their own
// decisions and what those change downstream. Output: one JSON line per
// variant, with paired differences against the first variant listed (mean
// and standard error over matches). Variants are harness-only prototypes:
// they wrap two SookraBot methods per instance (the bid gets a scaled
// marginal value, so floor(kappa x delta) uses the variant's kappa; the
// word choice is replaced) and never touch strategy.ts.

import * as fs from "node:fs";
import {
  type AuctionRow,
  type BotRow,
  type ConnLike,
  type HoldingRow,
  type MatchStateRow,
  type ParticipantRow,
  MAX_WORD_FAILURES,
  SookraBot,
} from "./bot.js";
import {
  type Candidates,
  type Counts,
  type Valuation,
  LETTER_VALUE,
  WordIndex,
  countsOf,
  packValue,
  wordReward,
} from "./engine.js";
import {
  type Opponent,
  type SimStrategy,
  type WordInput,
  CASH_MIN_LEN,
  ENDGAME_AUCTIONS,
  ENDGAME_KAPPA_BOOST,
  KAPPA,
  LEAVE_ALPHA,
  LIQUIDITY_FALLBACK_MIN_LEN,
  LIQUIDITY_FLOOR,
  LIQUIDITY_MIN_LEN,
  LIQUIDITY_TOP_K,
  kappaFor,
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
const MATCH = 1n;

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

const STREAM = { bag: 1, sims: 2, ties: 3, field: 4, rivalBid: 100, rivalWord: 200 } as const;

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
}

const RIVALS: Record<string, RivalModel> = JSON.parse(
  fs.readFileSync(new URL("./fixtures/rival-models.json", import.meta.url), "utf8"),
).rivals;

const VCLASS: Record<number, string> = { 1: "v1", 2: "v2", 3: "v3", 4: "v4", 5: "v5+", 8: "v5+", 10: "v5+" };

/** Clock block by auctions still to come (idx 1-50, 51-58, 59-63, 64-67 of a 68-auction match). */
function blockOf(bagLeft: number): number {
  return bagLeft >= 18 ? 0 : bagLeft >= 10 ? 1 : bagLeft >= 5 ? 2 : 3;
}

/** A fitted rival's bid. Always draws three numbers so its noise stream stays aligned across variants. */
function rivalBid(m: RivalModel, rng: Rng, letter: string, bagLeft: number, balance: number, auctions = 0): number {
  const u1 = rng();
  const u2 = rng();
  const u3 = rng();
  if (bagLeft <= 0) return 0;
  const v = LETTER_VALUE[letter];
  const idx = auctions - bagLeft;
  const blk = m.blocksByIndex ? (idx <= 50 ? 0 : idx <= 58 ? 1 : idx <= 63 ? 2 : 3) : blockOf(bagLeft);
  const b = m.bid;
  if (b.kind === "survival") {
    let x = 200;
    for (const [rx, s] of b.cells[`${VCLASS[v]}|${blk}`]) {
      if (s < u1) {
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
  | { kind: "sookra"; name: string; variant: Variant }
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
  bidRng: Rng;
  wordRng: Rng;
  bot?: SookraBot;
}

interface PublicStats {
  /** Price paid in every closed auction that had a winner, oldest first. */
  prices: number[];
  /** Auctions closed so far. */
  closed: number;
  wins: Map<bigint, number>;
}

class Table {
  matchState: MatchStateRow;
  auction: AuctionRow | null = null;
  stats: PublicStats = { prices: [], closed: 0, wins: new Map() };
  constructor(
    readonly index: WordIndex,
    readonly seats: Seat[],
    readonly botRows: Map<bigint, BotRow>,
    readonly auctions: number,
  ) {
    this.matchState = {
      id: MATCH,
      status: { tag: "Running" },
      currentAuctionId: undefined,
      bagTotal: auctions,
      auctionType: { tag: "Vickrey" },
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
    if (seat.firstWord === null) seat.firstWord = this.stats.closed;
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
  for (let i = 0; i < 4; i++) {
    const k = index.bestKey(cands, counts, 2);
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
}

async function playMatch(index: WordIndex, specs: SeatSpec[], matchSeed: number): Promise<SeatResult[]> {
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
    bidRng: mulberry32(mix(matchSeed, STREAM.rivalBid + i)),
    wordRng: mulberry32(mix(matchSeed, STREAM.rivalWord + i)),
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
    for (let i = 0; i < RACK; i++) {
      const c = bag[next++];
      s.rack.set(c, (s.rack.get(c) ?? 0) + 1);
    }
  }
  const table = new Table(index, seats, botRows, auctions);
  for (const s of seats) {
    if (s.spec.kind === "sookra") s.bot = makeBot(index, table, s, s.spec.variant);
  }
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
        amounts.set(s, rivalBid(spec.model, s.bidRng, letter, bagLeft, s.balance, auctions));
      }
    }
    const open = table.auction;
    for (const s of seats) if (s.bot) s.bot.onAuctionOpen(conns.get(s.id)!, open);
    if (conns.size > 0) for (let i = 0; i < TURNS; i++) await turn();
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
    table.stats.closed++;
    if (w >= 0) {
      const top = amounts.get(seats[w])!;
      let second = 0;
      let others = 0;
      for (let i = 0; i < n; i++) {
        const a = amounts.get(seats[i])!;
        if (i === w || a <= 0) continue;
        others++;
        second = Math.max(second, a);
      }
      const paid = others > 0 ? second : Math.min(1, top);
      const ws = seats[w];
      if (ws.balance >= paid) {
        ws.balance -= paid;
        ws.paid += paid;
        ws.won++;
        ws.rack.set(letter, (ws.rack.get(letter) ?? 0) + 1);
        table.stats.prices.push(paid);
        table.stats.wins.set(ws.id, (table.stats.wins.get(ws.id) ?? 0) + 1);
        if (ws.spec.kind === "sim") {
          const word = longestWord(index, ws.rack, 3);
          if (word) table.spend(ws, word);
        }
      }
    }
    if (!final) {
      for (const s of seats) {
        if (s.spec.kind === "starter") starterPlay(s);
        else if (s.spec.kind === "fitted") rivalAct(table, s, s.spec.model, bagLeft, false);
      }
    }
  }
  table.matchState = { ...table.matchState, status: { tag: "Ended" }, currentAuctionId: undefined };
  return seats.map((s) => ({
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
  }));
}

// ---- policy variants (harness-only prototypes) ----

interface BidCtx {
  bagTotal: number;
  balance: number;
  seats: number;
  auctions: number;
}
interface WordCtx extends BidCtx {
  prices: number[];
  closed: number;
  myWins: number;
}
interface WordCfg {
  /** Liquidity floor: below it (after cashing 7+ words) one liquidity word is cashed. */
  floor: (c: WordCtx) => number;
  /** Minimum lengths tried in order for the liquidity word (HEAD: 5 then 2). */
  minLens: number[];
  /** Value-of-money extra cashing. */
  vom?: { l0: number; ah: number; maxExtra: number };
}
export interface Variant {
  name: string;
  /** Absolute kappa for this auction; the bid hook scales the marginal value by kappa / kappaFor(bagTotal). */
  kappa?: (c: BidCtx) => number;
  words?: WordCfg;
}

/** The two SookraBot methods a variant wraps (private in bot.ts; reached through this view). */
interface BotHooks {
  placeBid(
    conn: ConnLike, model: unknown, m: MatchStateRow, auction: AuctionRow, balance: number,
    delta: number, bagTotal: number, source: string, opponents: Opponent[],
  ): void;
  playWords(
    conn: ConnLike, matchId: bigint, model: WordModel, counts: Counts, val: Valuation,
    balance: number, flush: boolean,
  ): number;
  submitWord(conn: ConnLike, matchId: bigint, model: WordModel, word: string, flush: boolean): void;
  now(): number;
}
interface WordModel {
  wordBackoffUntil: number;
  pending: Map<number, unknown>;
  wordFailures: Map<string, number>;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Balance per remaining auction relative to the starting rate (100 coins over the whole match). */
function paceRatio(c: BidCtx): number {
  return c.balance / (c.bagTotal + 1) / (START_BALANCE / c.auctions);
}

function makeBot(index: WordIndex, table: Table, seat: Seat, variant: Variant): SookraBot {
  const bot = new SookraBot(index, seat.spec.name, QUIET);
  bot.myBotId = seat.id;
  const hooks = bot as unknown as BotHooks;
  const proto = SookraBot.prototype as unknown as BotHooks;
  const seatsN = table.seats.length;
  const kappa = variant.kappa;
  if (kappa) {
    hooks.placeBid = (conn, model, m, auction, balance, delta, bagTotal, source, opponents) => {
      const simsOnly = opponents.length > 0 && opponents.every((o) => o.isSim);
      const scale =
        simsOnly || bagTotal <= 0
          ? 1
          : kappa({ bagTotal, balance, seats: seatsN, auctions: table.auctions }) / kappaFor(bagTotal);
      proto.placeBid.call(hooks, conn, model, m, auction, balance, delta * scale, bagTotal, source, opponents);
    };
  }
  const words = variant.words;
  if (words) {
    // Mirrors SookraBot.playWords with the variant's word choice in place of chooseWords.
    hooks.playWords = (conn, matchId, model, counts, val, balance, flush) => {
      if (index.size === 0) return 0;
      if (hooks.now() < model.wordBackoffUntil) return 0;
      if (!flush && model.pending.size > 0) return 0;
      const ctx: WordCtx = {
        bagTotal: Number(conn.db.matchState.id.find(matchId)?.bagTotal ?? 0),
        balance,
        seats: seatsN,
        auctions: table.auctions,
        prices: table.stats.prices,
        closed: table.stats.closed,
        myWins: table.stats.wins.get(seat.id) ?? 0,
      };
      const chosen = variantWords(
        index, { counts, cands: val.cands, myBalance: balance, flush, alpha: val.alpha }, words, ctx,
      ).filter((w) => (model.wordFailures.get(w) ?? 0) < MAX_WORD_FAILURES);
      for (const w of chosen) hooks.submitWord(conn, matchId, model, w, flush);
      return chosen.length;
    };
  }
  return bot;
}

/** strategy.ts liquidityWord with the floor and the minimum lengths as parameters. */
function liquidityPick(
  index: WordIndex, cands: Candidates, rem: Counts, balance: number, alpha: number, floor: number, minLens: number[],
): number {
  for (const minLen of minLens) {
    const top: number[] = [];
    for (let i = 0; i < cands.n && top.length < LIQUIDITY_TOP_K; i++) {
      if (cands.extra[i] !== -1) continue;
      const k = cands.keys[i];
      if (index.len[k] >= minLen && index.fits(k, rem)) top.push(k);
    }
    if (top.length === 0) continue;
    const need = floor - balance;
    let eligible = top.filter((k) => index.reward[k] >= need);
    if (eligible.length === 0) eligible = [top[0]];
    let best = -1;
    let bestScore = -Infinity;
    for (const k of eligible) {
      const rest = new Int32Array(rem);
      index.consume(rest, k);
      const score = index.reward[k] + packValue(index.pack(cands, rest, -1, alpha), alpha);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    return best;
  }
  return -1;
}

/** Candidate words examined per value-of-money step (best-paying first). */
const VOM_TOP_K = 48;

/**
 * strategy.ts chooseWords with a variable liquidity floor, plus optional
 * value-of-money cashing: with lambda = l0 x max(0, 1 - pace ratio) points
 * per coin, cash the word w maximizing (1 + lambda) x reward(w) + V(rack - w)
 * - V(rack) while that gain is positive, where V is the packing value with
 * hoard weight ah (only words paying more than ah x their tiles' leave value
 * are packed; other tiles count ah x leave), at most maxExtra words.
 */
function variantWords(index: WordIndex, input: WordInput, cfg: WordCfg, ctx: WordCtx): string[] {
  if (input.flush) {
    return index.pack(input.cands, input.counts, -1).keys.map((k) => index.words[k]);
  }
  const rem = new Int32Array(input.counts);
  const out: string[] = [];
  let balance = input.myBalance;
  const take = (k: number) => {
    out.push(index.words[k]);
    balance += index.reward[k];
    index.consume(rem, k);
  };
  for (;;) {
    const k = index.bestKey(input.cands, rem, CASH_MIN_LEN);
    if (k < 0) break;
    take(k);
  }
  const floor = cfg.floor(ctx);
  if (balance < floor) {
    const k = liquidityPick(index, input.cands, rem, balance, input.alpha ?? LEAVE_ALPHA, floor, cfg.minLens);
    if (k >= 0) take(k);
  }
  if (cfg.vom) {
    const { l0, ah, maxExtra } = cfg.vom;
    for (let step = 0; step < maxExtra; step++) {
      const lambda = l0 * Math.max(0, 1 - paceRatio({ ...ctx, balance }));
      if (!(lambda > 0)) break;
      const v0 = packValue(index.pack(input.cands, rem, -1, ah), ah);
      let best = -1;
      let bestGain = 0;
      let seen = 0;
      for (let i = 0; i < input.cands.n && seen < VOM_TOP_K; i++) {
        if (input.cands.extra[i] !== -1) continue;
        const k = input.cands.keys[i];
        if (index.len[k] < 2 || !index.fits(k, rem)) continue;
        seen++;
        const rest = new Int32Array(rem);
        index.consume(rest, k);
        const gain = (1 + lambda) * index.reward[k] + packValue(index.pack(input.cands, rest, -1, ah), ah) - v0;
        if (gain > bestGain) {
          bestGain = gain;
          best = k;
        }
      }
      if (best < 0) break;
      take(best);
    }
  }
  return out;
}

const HEAD_WORDS: WordCfg = {
  floor: () => LIQUIDITY_FLOOR,
  minLens: [LIQUIDITY_MIN_LEN, LIQUIDITY_FALLBACK_MIN_LEN],
};
const headKappa = (c: BidCtx) => kappaFor(c.bagTotal);
const boosted = (k: number) => (c: BidCtx) => (c.bagTotal < ENDGAME_AUCTIONS ? ENDGAME_KAPPA_BOOST : 1) * k;

/**
 * Variant grammar: parts joined by "+", each "name:arg:arg...":
 *   head                   current policy, no hooks
 *   hooked                 hooks installed with the HEAD logic (must equal head exactly)
 *   kappa:K                kappa K (still doubled in the last ENDGAME_AUCTIONS auctions)
 *   pace:G[:LO[:HI[:K0[:B]]]]  budget pacing: K0 x clamp(paceRatio^G, LO, HI), x B in the last
 *                          ENDGAME_AUCTIONS auctions (defaults 0.5, 3, KAPPA, ENDGAME_KAPPA_BOOST);
 *                          paceRatio = (balance / auctions left incl. this one) / (100 / auctions per match)
 *   liq:C[:CAP[:MIN[:FB]]] liquidity floor max(15, min(CAP, C x auctions left incl. this one)),
 *                          liquidity word of MIN+ letters, else FB+ (FB 0: none); defaults 60, 5, 2
 *   liqp:Q[:CAP]           floor max(15, min(CAP, Q x mean price so far x expected share x auctions left)),
 *                          share = max(1/seats, own wins / closed auctions); defaults 1, 80
 *   vom:L0[:AH[:MAX]]      value-of-money extra cashing (variantWords); defaults AH 0.7, MAX 2
 */
export function parseVariant(name: string): Variant {
  const v: Variant = { name };
  if (name === "head") return v;
  let words: WordCfg | undefined;
  const wordsCfg = () => (words ??= { ...HEAD_WORDS });
  for (const part of name.split("+")) {
    const [kind, ...rest] = part.split(":");
    const a = rest.map(Number);
    if (a.some((x) => !Number.isFinite(x))) throw new Error(`bad number in variant part ${part}`);
    if (kind === "hooked") {
      v.kappa = headKappa;
      wordsCfg();
    } else if (kind === "kappa") {
      v.kappa = boosted(a[0]);
    } else if (kind === "pace") {
      const [g, lo = 0.5, hi = 3, k0 = KAPPA, boost = ENDGAME_KAPPA_BOOST] = a;
      v.kappa = (c) => (c.bagTotal < ENDGAME_AUCTIONS ? boost : 1) * k0 * clamp(paceRatio(c) ** g, lo, hi);
    } else if (kind === "liq") {
      const [c, cap = 60, minLen = LIQUIDITY_MIN_LEN, fb = LIQUIDITY_FALLBACK_MIN_LEN] = a;
      const w = wordsCfg();
      w.floor = (x) => Math.max(LIQUIDITY_FLOOR, Math.min(cap, c * (x.bagTotal + 1)));
      w.minLens = fb > 0 ? [minLen, fb] : [minLen];
    } else if (kind === "liqp") {
      const [q = 1, cap = 80] = a;
      wordsCfg().floor = (x) => {
        const mean = x.prices.length ? x.prices.reduce((s, p) => s + p, 0) / x.prices.length : 7;
        const share = Math.max(1 / x.seats, x.closed > 0 ? x.myWins / x.closed : 0);
        return Math.max(LIQUIDITY_FLOOR, Math.min(cap, q * mean * share * (x.bagTotal + 1)));
      };
    } else if (kind === "vom") {
      const [l0, ah = 0.7, max = 2] = a;
      wordsCfg().vom = { l0, ah, maxExtra: max };
    } else {
      throw new Error(`unknown variant part ${part}`);
    }
  }
  if (words) v.words = words;
  return v;
}

// ---- fields ----

const HEAD: Variant = { name: "head" };
const sookra = (name: string, variant: Variant): SeatSpec => ({ kind: "sookra", name, variant });
const fitted = (name: string): SeatSpec => ({ kind: "fitted", name, model: RIVALS[name] });
function randomSims(rnd: Rng, k: number): SeatSpec[] {
  const pool = [...SIMS];
  const out: SeatSpec[] = [];
  for (let i = 0; i < k; i++) {
    const [name, strategy] = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    out.push({ kind: "sim", name, strategy });
  }
  return out;
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
};

// ---- statistics ----

function meanSe(xs: number[]): { mean: number; se: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { mean: +mean.toFixed(3), se: +(sd / Math.sqrt(n)).toFixed(3) };
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

function loadIndex(): WordIndex {
  const words = fs.readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8").split("\n");
  return WordIndex.fromWords(words);
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
    const r = focalRow(i, await playMatch(index, specs, ms));
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

async function compare(field: string, n: number, seed: number, names: string[], rowsPath?: string) {
  const f = FIELDS[field];
  if (!f) throw new Error(`unknown field ${field} (try: list)`);
  if (names.length === 0) throw new Error("name at least one variant");
  const variants = names.map(parseVariant);
  const index = loadIndex();
  const rows: FocalRow[][] = variants.map(() => []);
  /** Per variant, per rival seat name: summed score, letters won, coins paid, end and mid balance, matches. */
  const others: Map<string, number[]>[] = variants.map(() => new Map());
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const ms = mix(seed, i);
    for (let v = 0; v < variants.length; v++) {
      const specs = f.seats(sookra("SookraBot", variants[v]), mulberry32(mix(ms, STREAM.field)));
      const res = await playMatch(index, specs, ms);
      rows[v].push(focalRow(i, res));
      for (const r of res.slice(1)) {
        const name = r.kind === "sim" ? "sims" : r.name;
        const acc = others[v].get(name) ?? [0, 0, 0, 0, 0, 0];
        [r.score, r.won, r.paid, r.balance, r.midBalance ?? 0, 1].forEach((x, j) => (acc[j] += x));
        others[v].set(name, acc);
      }
    }
  }
  if (rowsPath) {
    const lines = variants.flatMap((v, j) => rows[j].map((r) => JSON.stringify({ field, seed, variant: v.name, ...r })));
    fs.appendFileSync(rowsPath, lines.join("\n") + "\n");
  }
  const secs = +((performance.now() - t0) / 1000).toFixed(1);
  const pick = (rs: FocalRow[], key: keyof FocalRow) => rs.map((r) => Number(r[key] ?? 0));
  const avg = (xs: number[]) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  const hasLs = rows[0][0].ls !== null;
  const keys: (keyof FocalRow)[] = ["score", "margin", "win", "swiss", ...(hasLs ? (["lsMargin"] as const) : [])];
  for (let v = 0; v < variants.length; v++) {
    const rs = rows[v];
    const out: Record<string, unknown> = { field, variant: variants[v].name, n, seed };
    for (const k of keys) out[k] = meanSe(pick(rs, k));
    if (hasLs) out.ls = avg(pick(rs, "ls"));
    out.lsWinRate = hasLs ? avg(rs.map((r) => (r.lsMargin! >= 0 ? 1 : 0))) : undefined;
    out.last = avg(pick(rs, "last"));
    for (const k of ["won", "paid", "balance", "words", "poor", "endRack"] as const) out[k] = avg(pick(rs, k));
    const fw = rs.map((r) => r.firstWord).filter((x): x is number => x !== null).sort((a, b) => a - b);
    out.firstWordMedian = fw.length ? fw[Math.floor(fw.length / 2)] : null;
    out.midBalance = avg(rs.map((r) => r.midBalance ?? 0));
    out.rivals = Object.fromEntries(
      [...others[v]].map(([name, a]) => [
        name,
        { score: +(a[0] / a[5]).toFixed(1), won: +(a[1] / a[5]).toFixed(1), paid: +(a[2] / a[5]).toFixed(1), balance: +(a[3] / a[5]).toFixed(1), midBalance: +(a[4] / a[5]).toFixed(1) },
      ]),
    );
    if (v > 0) {
      const diff: Record<string, unknown> = {};
      for (const k of keys) {
        const a = pick(rs, k);
        const b = pick(rows[0], k);
        diff[k] = meanSe(a.map((x, i) => x - b[i]));
      }
      out.vsFirst = diff;
    }
    out.secs = secs;
    console.log(JSON.stringify(out));
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
      for (const r of await playMatch(index, specs, ms)) {
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

async function main() {
  const [mode = "sims", ...args] = process.argv.slice(2);
  const opts = args.filter((a) => a.startsWith("--"));
  const pos = args.filter((a) => !a.startsWith("--"));
  if (mode === "sims" || mode === "starters") {
    await legacy(mode, Number(pos[0] ?? 50), Number(pos[1] ?? 1));
  } else if (mode === "compare") {
    const rows = opts.find((o) => o.startsWith("--rows="))?.slice("--rows=".length);
    await compare(pos[0], Number(pos[1] ?? 400), Number(pos[2] ?? 1), pos.slice(3), rows);
  } else if (mode === "validate") {
    await validate(Number(pos[0] ?? 300), Number(pos[1] ?? 1));
  } else if (mode === "list") {
    for (const [k, f] of Object.entries(FIELDS)) console.log(`${k.padEnd(12)} ${f.about}`);
    console.log("variants: see parseVariant (head, hooked, kappa:K, pace:G, liq:C, liqp:Q, vom:L0, joined by +)");
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
