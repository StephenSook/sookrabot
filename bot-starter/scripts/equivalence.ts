// Equivalence of this checkout's bot against a reference build of it: bids,
// word choices and flushes, on seeded random inputs and in whole simulated
// matches. Made to show that knobs left off play exactly as the live build.
//
//   ref=$(mktemp -d); for f in engine strategy bot; do
//     git show <commit>:bot-starter/src/$f.ts > "$ref/$f.ts"; done
//   npx tsx scripts/equivalence.ts "$ref" [--bids=N] [--words=N] [--matches=N]
//     [--seed=S] [--shard=i/n] [--policy=<variant>] [--expect=same|differ]
//
// The reference directory holds that commit's engine.ts, strategy.ts and
// bot.ts (they import only each other). Checks, each on its own seeded stream:
//  1. decideBid on random bid inputs (every letter, values including the exact
//     leave floor, all bag positions, balances including odd ones, 0 to 7
//     rivals, real and sims, Vickrey and first price, price histories, known
//     and unknown match lengths): the amount and the reason string.
//  2. chooseWords on random racks of 1 to 22 tiles (balances, flushing or
//     not, leave weight, real rivals, bag positions), and the flush rules:
//     flushLeadMs on random lag series (stalls, skew, NaN), shouldFlush,
//     alphaFor, plus the bid helpers (kappaFor, paceMultiplier, pacedKappa,
//     earlyScale, duelReserve, maxSimBid, auctionsPerMatch, liquidityWord).
//  3. Two whole SookraBots (the reference class and this checkout's), each on
//     its own fake server, play the same simulated matches in lockstep: same
//     bag, rivals and sims, Vickrey or first price, 250 or 1000 ms auctions,
//     receive lags with stalls. After every auction the reducer calls each
//     made (bids with amounts, word plays) must be equal; a match stops at its
//     first difference.
// In 1 and 2 this checkout also gets the inputs only it reads (completes7,
// leaveAlpha, bagTotal, policy) with random values: a knob that is off must
// ignore them. --policy plays this checkout with a selfplay.ts variant
// (default head, DEFAULT_POLICY). --expect=same (default) exits 0 only with no
// difference and every check exercised (bids above 0, words, flush plays);
// --expect=differ (a control) exits 0 only when some difference is found.
// --shard=i/n plays matches floor(i*N/n) to floor((i+1)*N/n) - 1 of the N and
// runs checks 1 and 2 only in the shard holding match 0 (--matches=0: checks 1
// and 2 alone; --bids=0 or --words=0 skips that part). --trace prints the
// reference bot's log lines (bids with reasons, words) to stderr.
// .github/workflows/verify.yml runs the suite, the type check, this check
// against the live build and its controls on GitHub Actions.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as curBot from "../src/bot.js";
import * as curEngine from "../src/engine.js";
import { RULES, parseVariant, pricePaid, shardRange } from "../src/selfplay.js";
import * as cur from "../src/strategy.js";

type Strategy = typeof cur;
type Engine = typeof curEngine;
type BotModule = typeof curBot;
type Policy = cur.Policy;
type Rng = () => number;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SIMS = ["Cheapskate", "ValueBidder", "Aggressive"] as const;
const ME = 9n;
const MATCH = 1n;

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
const mix = (...xs: number[]) => xs.reduce((h, x) => Math.imul(h ^ (x >>> 0), 0x9e3779b1) >>> 0, 0x2545f491);
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opt = new Map<string, string>();
  let trace = false;
  for (const a of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (m) opt.set(m[1], m[2]);
    else if (a === "--trace") trace = true;
    else if (a.startsWith("--")) throw new Error(`option ${a} needs a value (--name=value)`);
    else pos.push(a);
  }
  if (pos.length !== 1) {
    throw new Error(
      "usage: equivalence.ts <refDir> [--bids=N] [--words=N] [--matches=N] [--seed=S] [--shard=i/n] [--policy=v] [--expect=same|differ]",
    );
  }
  for (const k of opt.keys()) {
    if (!["bids", "words", "matches", "seed", "shard", "policy", "expect"].includes(k)) throw new Error(`unknown option --${k}`);
  }
  const num = (k: string, d: number) => {
    const v = opt.get(k);
    if (v === undefined) return d;
    if (!/^\d+$/.test(v)) throw new Error(`--${k} must be a whole number, got ${v}`);
    return Number(v);
  };
  const expect = opt.get("expect") ?? "same";
  if (expect !== "same" && expect !== "differ") throw new Error(`--expect is same or differ, got ${expect}`);
  return {
    refDir: path.resolve(pos[0]),
    bids: num("bids", 20000),
    words: num("words", 3000),
    matches: num("matches", 40),
    seed: num("seed", 1),
    shard: opt.get("shard"),
    variant: opt.get("policy") ?? "head",
    expect,
    trace,
  };
}

interface Tally {
  compared: number;
  differ: number;
  /** Comparisons with a non-trivial result (a bid above 0, a word list that is not empty, and so on). */
  nonTrivial: number;
  first: string[];
}
const tally = (): Tally => ({ compared: 0, differ: 0, nonTrivial: 0, first: [] });
function note(t: Tally, same: boolean, nonTrivial: boolean, what: () => string) {
  t.compared++;
  if (nonTrivial) t.nonTrivial++;
  if (!same) {
    t.differ++;
    if (t.first.length < 5) t.first.push(what());
  }
}

// ---- 1. decideBid ----

function randomBalance(r: Rng): number {
  const u = r();
  if (u < 0.02) return pick(r, [NaN, Infinity, -5, -0.5]);
  if (u < 0.08) return r() * 300; // fractional
  if (u < 0.2) return int(r, 0, 3);
  return int(r, 0, 300);
}

function randomBidInput(r: Rng) {
  const letter = r() < 0.01 ? pick(r, ["?", "", "AB", "a"]) : LETTERS[int(r, 0, 25)];
  const nOpp = pick(r, [0, 1, 1, 1, 2, 2, 3, 4, 5, 5, 5, 5, 6, 7]);
  const opponents = Array.from({ length: nOpp }, () => {
    const u = r();
    if (u < 0.3) return { isSim: true, strategy: pick(r, SIMS), balance: randomBalance(r) };
    if (u < 0.33) return { isSim: true, balance: randomBalance(r) }; // a sim of unknown strategy
    return { isSim: false, balance: randomBalance(r) };
  });
  const u = r();
  const auctionsPerMatch = u < 0.15 ? undefined : u < 0.85 ? cur.auctionsPerMatch(nOpp + 1, 5) : int(r, 0, 100);
  const horizon = auctionsPerMatch !== undefined && auctionsPerMatch > 0 ? auctionsPerMatch : 90;
  const bagTotal = r() < 0.03 ? pick(r, [0, -1, NaN, 0.5]) : int(r, 0, horizon - 1);
  const alpha = pick(r, [0.35, 0.35, 0.35, 0, 0.2, 0.5]);
  const w7 = curEngine.LEAVE_W7[letter] ?? 0;
  const v = r();
  // A quarter of the values sit exactly on the leave floor (what valuate gives a dead letter).
  const delta = v < 0.25 ? alpha * w7 : v < 0.3 ? pick(r, [0, -1, NaN, Infinity, 1e-12]) : v < 0.9 ? r() * 15 : r() * 60;
  const fpHistory =
    r() < 0.5
      ? undefined
      : Array.from({ length: int(r, 0, 60) }, () => ({ face: pick(r, [1, 1, 1, 2, 3, 4, 5, 8, 10]), paid: int(r, 0, 45) }));
  const auctionType: "FirstPrice" | "Vickrey" = r() < 0.3 ? "FirstPrice" : "Vickrey";
  const myBalance = randomBalance(r);
  const extras = {
    completes7: r() < 0.3 ? true : r() < 0.5 ? false : undefined,
    leaveAlpha: r() < 0.7 ? alpha : undefined,
  };
  return { base: { letter, delta, bagTotal, auctionType, myBalance, opponents, fpHistory, auctionsPerMatch }, extras };
}

function checkBids(n: number, seed: number, ref: Strategy, policy: Policy | undefined): Tally {
  const t = tally();
  const r = mulberry32(mix(seed, 1));
  for (let i = 0; i < n; i++) {
    const { base, extras } = randomBidInput(r);
    const a = ref.decideBid(base);
    const withPolicy = r() < 0.5 || policy !== undefined;
    const b = cur.decideBid({ ...base, ...extras, ...(withPolicy ? { policy: policy ?? cur.DEFAULT_POLICY } : {}) });
    // Object.is: a NaN amount (an opponent with a NaN balance) equals a NaN amount.
    note(t, Object.is(a.amount, b.amount) && a.reason === b.reason, a.amount > 0 || b.amount > 0, () =>
      `${JSON.stringify({ ...base, ...extras })}: ref ${a.amount} (${a.reason}), now ${b.amount} (${b.reason})`,
    );
  }
  return t;
}

// ---- 2. chooseWords, the flush rules and the helpers ----

const BAG_TILES: string[] = Object.entries(RULES.BAG).flatMap(([c, k]) => Array<string>(k).fill(c));

function randomRack(r: Rng): string {
  const tiles = [...BAG_TILES];
  const n = pick(r, [1, 2, 3, 4, 5, 6, 7, 7, 8, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22]);
  let rack = "";
  for (let i = 0; i < n; i++) rack += tiles.splice(int(r, 0, tiles.length - 1), 1)[0];
  return rack;
}

interface Indexes {
  refEngine: Engine;
  refIdx: curEngine.WordIndex;
  curIdx: curEngine.WordIndex;
}

function checkWords(n: number, seed: number, ref: Strategy, ix: Indexes, policy: Policy | undefined) {
  const words = tally();
  const flushWords = tally();
  const r = mulberry32(mix(seed, 2));
  for (let i = 0; i < n; i++) {
    const rack = randomRack(r);
    const flush = r() < 0.2;
    const input = {
      myBalance: r() < 0.08 ? pick(r, [-5, NaN, 0, 14.5]) : r() < 0.35 ? int(r, 0, 20) : int(r, 0, 160),
      flush,
      alpha: pick(r, [undefined, 0.35, 0.35, 0, 0.2]),
      realRivals: pick(r, [undefined, 0, 1, 1, 2, 3, 5, 5, 7]),
    };
    // Bag positions a match has, and ones it never has (an off knob must not read them either).
    const u2 = r();
    const bagTotal = u2 < 0.2 ? undefined : u2 < 0.26 ? pick(r, [999, 1000, NaN, Infinity, -1, 0.5, 98]) : int(r, 0, 87);
    const rc = ix.refEngine.countsOf(rack);
    const cc = curEngine.countsOf(rack);
    const a = ref.chooseWords(ix.refIdx, { ...input, counts: rc, cands: ix.refIdx.scan(rc, true) });
    const withPolicy = r() < 0.5 || policy !== undefined;
    const b = cur.chooseWords(ix.curIdx, {
      ...input, counts: cc, cands: ix.curIdx.scan(cc, true), bagTotal,
      ...(withPolicy ? { policy: policy ?? cur.DEFAULT_POLICY } : {}),
    });
    note(flush ? flushWords : words, JSON.stringify(a) === JSON.stringify(b), a.length > 0 || b.length > 0, () =>
      `${rack} ${JSON.stringify({ ...input, bagTotal })}: ref ${JSON.stringify(a)}, now ${JSON.stringify(b)}`,
    );
  }
  return { words, flushWords };
}

function checkFlushAndHelpers(n: number, seed: number, ref: Strategy, ix: Indexes, policy: Policy | undefined) {
  const flush = tally();
  const helpers = tally();
  const r = mulberry32(mix(seed, 3));
  const p = policy ?? cur.DEFAULT_POLICY;
  const same = (x: unknown, y: unknown) => Object.is(x, y);
  for (let i = 0; i < n; i++) {
    // Receive lags: mostly small, some stalls, sometimes a clock skew, the odd non-number.
    const skew = r() < 0.2 ? int(r, -2000, 2000) : 0;
    const lags = Array.from({ length: int(r, 0, 70) }, () => {
      const u = r();
      if (u < 0.01) return pick(r, [NaN, Infinity, -Infinity]);
      if (u < 0.06) return skew + int(r, 800, 9000);
      return skew + int(r, 0, 120);
    });
    const la = ref.flushLeadMs(lags);
    const lb = cur.flushLeadMs(lags, p);
    note(flush, la === lb, la !== ref.FLUSH_LEAD_MS, () => `flushLeadMs ${JSON.stringify(lags)}: ref ${la}, now ${lb}`);
    const bagTotal = r() < 0.05 ? pick(r, [-1, 0]) : int(r, 0, 87);
    const ms = pick(r, [1000, 1000, 250, 500, 0, -1]);
    const lead = r() < 0.5 ? undefined : pick(r, [la, 3000, 12000, 0]);
    // As bot.ts calls it: the policy's lead for the fixed rule, flushLeadMs's for word plays.
    const fa = lead === undefined ? ref.shouldFlush(bagTotal, ms) : ref.shouldFlush(bagTotal, ms, lead);
    const fb = cur.shouldFlush(bagTotal, ms, lead ?? p.FLUSH_LEAD_MS);
    note(flush, fa === fb, fa, () => `shouldFlush(${bagTotal}, ${ms}, ${lead}): ref ${fa}, now ${fb}`);
    const fl = r() < 0.3;
    const aa = ref.alphaFor(fl);
    const u3 = r();
    const ab = cur.alphaFor(fl, p, u3 < 0.7 ? int(r, 0, 87) : u3 < 0.85 ? pick(r, [NaN, 999, -1, 0.5, Infinity]) : undefined);
    note(flush, aa === ab, aa > 0, () => `alphaFor(${fl}): ref ${aa}, now ${ab}`);
    // The bid helpers at random points, called as valueBid calls them.
    const bal = randomBalance(r);
    const auctions = r() < 0.1 ? undefined : pick(r, [68, 73, 78, 83, 88, 63, 58]);
    const bt = int(r, 0, 87);
    const minPace = r() < 0.5 ? undefined : pick(r, [0.5, 0.75, 1]);
    const realRivals = int(r, 0, 7);
    const seats = int(r, 1, 9);
    const letter = LETTERS[int(r, 0, 25)];
    const strat = pick(r, SIMS);
    const simBal = Math.max(0, Math.floor(bal) || 0);
    const pairs: [string, number, number][] = [
      ["kappaFor", ref.kappaFor(bt), cur.kappaFor(bt, undefined, p)],
      ["kappaFor(base 4)", ref.kappaFor(bt, 4), cur.kappaFor(bt, 4, p)],
      [
        "paceMultiplier",
        minPace === undefined ? ref.paceMultiplier(bal, bt, auctions) : ref.paceMultiplier(bal, bt, auctions, minPace),
        cur.paceMultiplier(bal, bt, auctions, minPace, p),
      ],
      [
        "pacedKappa",
        minPace === undefined ? ref.pacedKappa(bt, bal, auctions) : ref.pacedKappa(bt, bal, auctions, minPace),
        cur.pacedKappa(bt, bal, auctions, minPace, p),
      ],
      [
        "earlyScale",
        ref.earlyScale(bt, auctions ?? 68, realRivals),
        cur.earlyScale(bt, auctions ?? 68, realRivals, p.EARLY_AUCTIONS, p.EARLY_KAPPA_SCALE, p.EARLY_MIN_REAL_RIVALS),
      ],
      ["duelReserve", ref.duelReserve(realRivals, bt), cur.duelReserve(realRivals, bt, p)],
      ["auctionsPerMatch", ref.auctionsPerMatch(seats, 5), cur.auctionsPerMatch(seats, 5)],
      ["maxSimBid", ref.maxSimBid(strat, letter, simBal), cur.maxSimBid(strat, letter, simBal)],
    ];
    for (const [name, x, y] of pairs) note(helpers, same(x, y), x !== 1 && x !== 0, () => `${name}: ref ${x}, now ${y}`);
    if (i % 8 === 0) {
      // liquidityWord on a random rack, as chooseWords calls it.
      const rack = randomRack(r);
      const rc = ix.refEngine.countsOf(rack);
      const cc = curEngine.countsOf(rack);
      const b2 = int(r, 0, 30);
      const alpha = pick(r, [0.35, 0, 0.2]);
      const ka = ref.liquidityWord(ix.refIdx, ix.refIdx.scan(rc, true), rc, b2, alpha);
      const kb = cur.liquidityWord(ix.curIdx, ix.curIdx.scan(cc, true), cc, b2, alpha, p);
      const wa = ka >= 0 ? ix.refIdx.words[ka] : null;
      const wb = kb >= 0 ? ix.curIdx.words[kb] : null;
      note(helpers, wa === wb, wa !== null, () => `liquidityWord ${rack} ${b2} ${alpha}: ref ${wa}, now ${wb}`);
    }
  }
  return { flush, helpers };
}

// ---- 3. whole bots in lockstep ----

type AuctionRow = curBot.AuctionRow;
type AuctionResultRow = curBot.AuctionResultRow;
type MatchStateRow = curBot.MatchStateRow;
type ParticipantRow = curBot.ParticipantRow;
type BotRow = curBot.BotRow;

/** A fake server for one bot: the module's reducers as the bot sees them, every call logged in order. */
class Server {
  match: MatchStateRow;
  auctions = new Map<bigint, AuctionRow>();
  participants: ParticipantRow[] = [];
  rack = new Map<string, number>();
  bots = new Map<bigint, BotRow>();
  live = new Map<bigint, bigint>();
  calls: string[] = [];
  bidCalls = 0;
  wordCalls = 0;
  flushWordCalls = 0;
  /** Bids refused "Auction window expired" (sent after the auction's close time, as after a stall). */
  lateBids = 0;
  /** Set by the driver while the bot plays its end-of-match flush (for the counts only). */
  flushing = false;

  constructor(
    auctionType: "Vickrey" | "FirstPrice",
    durationMs: number,
    /** The server's clock, ms (the driver's simulated time). */
    private readonly clock: () => number,
  ) {
    this.match = {
      id: MATCH, status: { tag: "Running" }, currentAuctionId: undefined, bagTotal: 0,
      auctionType: { tag: auctionType }, auctionDurationMs: BigInt(durationMs), startingRackSize: 5,
    };
  }

  db = {
    matchState: { id: { find: (id: bigint) => (id === MATCH ? this.match : undefined) } },
    auction: { id: { find: (id: bigint) => this.auctions.get(id) } },
    matchParticipant: { iter: () => this.participants.values() },
    myRack: {
      iter: () =>
        [...this.rack].filter(([, n]) => n > 0).map(([letter, count]) => ({ matchId: MATCH, letter, count })).values(),
    },
    bot: { id: { find: (id: bigint) => this.bots.get(id) } },
  };

  // As spacetimedb/src/index.ts submitBid and submitWord check them.
  reducers = {
    submitBid: (a: { auctionId: bigint; amount: bigint }): Promise<unknown> => {
      this.calls.push(`bid a${a.auctionId} ${a.amount}`);
      this.bidCalls++;
      if (a.amount < 0n) return Promise.reject(new Error("Bid must be non-negative"));
      const row = this.auctions.get(a.auctionId);
      if (!row) return Promise.reject(new Error("Unknown auction"));
      if (row.status.tag !== "Open") return Promise.reject(new Error("Auction closed"));
      if (BigInt(this.clock()) * 1000n >= row.closesAt!.microsSinceUnixEpoch) {
        this.lateBids++;
        return Promise.reject(new Error("Auction window expired"));
      }
      if (a.amount > this.me().balance) return Promise.reject(new Error("Insufficient balance"));
      if (a.amount === 0n) this.live.delete(a.auctionId);
      else this.live.set(a.auctionId, a.amount);
      return Promise.resolve();
    },
    // The module runs a play when the call reaches it, and its update and answer reach the bot together a
    // turn later: until then the bot's cache still holds the letters (the bot reserves them meanwhile).
    submitWord: (a: { matchId: bigint; word: string }): Promise<unknown> => {
      this.calls.push(`word ${a.word}`);
      this.wordCalls++;
      if (this.flushing) this.flushWordCalls++;
      return new Promise((resolve, reject) =>
        setImmediate(() => {
          if (this.match.status.tag !== "Running") return reject(new Error("Match not running"));
          const need = curEngine.countsOf(a.word);
          for (let i = 0; i < 26; i++) {
            if ((this.rack.get(LETTERS[i]) ?? 0) < need[i]) return reject(new Error(`Not enough letters for ${a.word}`));
          }
          for (const c of a.word) this.rack.set(c, (this.rack.get(c) ?? 0) - 1);
          const reward = BigInt(curEngine.wordReward(a.word));
          this.me().balance += reward;
          this.me().score += reward;
          this.onCacheChange?.(); // index.ts: rack and balance updates schedule a refresh
          resolve(undefined);
        }),
      );
    },
  };
  /** Called when the bot's own rows change outside a driver transaction (a word play landing). */
  onCacheChange: (() => void) | null = null;

  me(): ParticipantRow {
    return this.participants.find((p) => p.botId === ME)!;
  }
  seat(id: bigint): ParticipantRow {
    return this.participants.find((p) => p.botId === id)!;
  }
}

interface BotLike {
  myBotId: bigint | null;
  online: boolean;
  onAuctionOpen(conn: Server, a: AuctionRow): void;
  onAuctionResult(conn: Server, r: AuctionResultRow): void;
  onMatchEnded(conn: Server, matchId: bigint): void;
  scheduleRefresh(conn: Server, matchId: bigint): void;
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Lets deferred work (refreshes, word plays landing a turn later, precomputes: chains of a few turns) run
 * until neither server sees a new call for 20 turns. False when that never happened within 4000 turns.
 */
async function settle(servers: Server[]): Promise<boolean> {
  let quiet = 0;
  let last = servers.map((s) => s.calls.length).join(",");
  for (let i = 0; i < 4000; i++) {
    await turn();
    const now = servers.map((s) => s.calls.length).join(",");
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    if (quiet >= 20) return true;
  }
  return false;
}

interface MatchResult {
  auctions: number;
  differ: string | null;
  bids: number;
  words: number;
  flushWords: number;
  lateBids: number;
}

/**
 * One simulated match, the same for both bots: rivals, sims, bag, lags and tie-breaks come from `seed`
 * alone. As in the module (game.ts closeAuction), an auction closes at its close time and in the same
 * transaction the next one opens, or after the last one the match ends: the bots get the result and the
 * open (or the end) together (index.ts callbacks: result, then the open with its bid from the
 * precomputed table or onMatchEnded, then the refresh a rack or balance update schedules), and only then
 * run deferred work. A bot receives each open `lag` ms after it opened; a bid sent at or after the close
 * time is refused "Auction window expired", as after a stall. A word play lands a turn after it is sent.
 * The two servers' reducer calls are compared after every auction (the last one's comparison covers the
 * match end); a server that never goes quiet counts as a difference. Simulated time moves only between
 * transactions, so this compares decisions, not how long the bots take to make them.
 */
async function lockstepMatch(
  seed: number, ix: Indexes, refBot: BotModule, policy: Policy | undefined, trace: boolean,
): Promise<MatchResult> {
  const r = mulberry32(seed);
  const seats = pick(r, [2, 2, 3, 4, 5, 6, 6, 6, 6, 7, 8]);
  const auctionType = r() < 0.25 ? "FirstPrice" : "Vickrey";
  const durationMs = r() < 0.3 ? 250 : 1000;
  const stallRate = r() < 0.3 ? 0.04 : 0;
  const quiet = { log: () => {}, warn: () => {} };
  // --trace: the reference bot's own log lines (every bid with its reason, every word) on stderr.
  const traced = { log: (m: string) => console.error(`[${seed}] ${m}`), warn: (m: string) => console.error(`[${seed}] WARN ${m}`) };
  let clock = 1_700_000_000_000 + int(r, 0, 1_000_000);
  const now = () => clock;
  const bots: BotLike[] = [
    new refBot.SookraBot(ix.refIdx, "SookraBot", trace ? traced : quiet, now) as unknown as BotLike,
    new curBot.SookraBot(ix.curIdx, "SookraBot", quiet, now, policy) as unknown as BotLike,
  ];
  const servers = [new Server(auctionType, durationMs, now), new Server(auctionType, durationMs, now)];
  servers.forEach((s, j) => (s.onCacheChange = () => bots[j].scheduleRefresh(s, MATCH)));
  // Rivals: real bots (random bidders, rich or frugal, that cash words now and then) and sims (the module's rule).
  const rivals = Array.from({ length: seats - 1 }, (_, i) => ({
    id: BigInt(20 + i), sim: r() < 0.3, strategy: pick(r, SIMS), style: r(),
  }));
  const bag = [...BAG_TILES];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  let next = 0;
  for (const s of servers) {
    s.bots.set(ME, { name: "SookraBot", isSimulated: false, strategy: { tag: "Human" } });
    s.participants.push({ matchId: MATCH, botId: ME, balance: BigInt(RULES.START_BALANCE), score: 0n });
    for (const v of rivals) {
      s.bots.set(v.id, { name: `R${v.id}`, isSimulated: v.sim, strategy: { tag: v.sim ? v.strategy : "Human" } });
      s.participants.push({ matchId: MATCH, botId: v.id, balance: BigInt(RULES.START_BALANCE), score: 0n });
    }
  }
  for (let k = 0; k < RULES.RACK; k++) {
    const c = bag[next++];
    for (const s of servers) s.rack.set(c, (s.rack.get(c) ?? 0) + 1);
  }
  next += RULES.RACK * (seats - 1); // the rivals' starting racks
  for (const b of bots) {
    b.myBotId = ME;
    b.online = true;
  }
  const auctions = bag.length - RULES.RACK * seats;
  const letters = bag.slice(next, next + auctions);
  const recvLags: number[] = [];
  let opensMs = clock;

  /** Opens auction i on both servers at `opensMs`; the bots receive it `lag` ms later (the clock moves there). */
  const openAuction = (i: number): AuctionRow[] => {
    const id = BigInt(1000 + i);
    const bagTotal = auctions - 1 - i;
    const lag = r() < stallRate ? int(r, 1500, 5000) : int(r, 0, 90);
    clock = Math.max(clock, opensMs + lag);
    // The bot's receive lag (bot.ts recvLags) and so the flush it plays: the fixed rule or the stall-aware lead.
    recvLags.push(clock - opensMs);
    const flushing =
      cur.shouldFlush(bagTotal, durationMs) || cur.shouldFlush(bagTotal, durationMs, cur.flushLeadMs(recvLags));
    return servers.map((s) => {
      s.match.bagTotal = bagTotal;
      s.match.currentAuctionId = id;
      s.flushing = flushing;
      const row: AuctionRow = {
        id, matchId: MATCH, letter: letters[i], status: { tag: "Open" },
        opensAt: { microsSinceUnixEpoch: BigInt(opensMs) * 1000n },
        closesAt: { microsSinceUnixEpoch: BigInt(opensMs + durationMs) * 1000n },
      };
      s.auctions.set(id, row);
      return row;
    });
  };

  /** Closes auction i on both servers at its close time (rival bids drawn the same way whatever the bots did). */
  const closeAuction = (i: number): AuctionResultRow[] => {
    const id = BigInt(1000 + i);
    const letter = letters[i];
    opensMs += durationMs; // the close time, and the next auction's open
    clock = Math.max(clock, opensMs);
    const face = curEngine.LETTER_VALUE[letter] ?? 1;
    const rivalBids = rivals.map((v) => {
      const u = r();
      const w = r();
      if (v.sim) {
        const base = v.strategy === "Cheapskate" ? face - 1 : v.strategy === "ValueBidder" ? face : face + ("AEIOU".includes(letter) ? 4 : 2);
        return Math.max(base + Math.floor(u * 5) - 2, 1);
      }
      return u < 0.25 + 0.3 * v.style ? 0 : Math.floor(w * (8 + 4 * face) * (0.5 + v.style));
    });
    const prio = Array.from({ length: seats }, () => r());
    const cash = rivals.map(() => (r() < 0.08 ? int(r, 8, 45) : 0));
    return servers.map((s) => {
      const mine = Number(s.live.get(id) ?? 0n);
      const balances = [Number(s.me().balance), ...rivals.map((v) => Number(s.seat(v.id).balance))];
      const amounts = [Math.min(mine, balances[0]), ...rivalBids.map((b, j) => Math.min(b, balances[j + 1]))];
      let w = -1;
      for (let j = 0; j < amounts.length; j++) {
        if (amounts[j] <= 0) continue;
        if (w < 0 || amounts[j] > amounts[w] || (amounts[j] === amounts[w] && prio[j] > prio[w])) w = j;
      }
      let paid = 0;
      if (w >= 0) {
        paid = pricePaid(auctionType, amounts[w], amounts.filter((_, j) => j !== w));
        const row = w === 0 ? s.me() : s.seat(rivals[w - 1].id);
        row.balance -= BigInt(paid);
        if (w === 0) s.rack.set(letter, (s.rack.get(letter) ?? 0) + 1);
      }
      rivals.forEach((v, j) => {
        if (cash[j] > 0 && !v.sim) {
          s.seat(v.id).balance += BigInt(cash[j]);
          s.seat(v.id).score += BigInt(cash[j]);
        }
      });
      s.auctions.set(id, { ...s.auctions.get(id)!, status: { tag: "Closed" } });
      s.match.currentAuctionId = undefined;
      s.live.delete(id);
      return {
        auctionId: id, matchId: MATCH, letter, paid: BigInt(paid),
        winnerBotId: w < 0 ? undefined : w === 0 ? ME : rivals[w - 1].id,
      };
    });
  };

  const counts = (): Omit<MatchResult, "auctions" | "differ"> => {
    const [a] = servers;
    return { bids: a.bidCalls, words: a.wordCalls, flushWords: a.flushWordCalls, lateBids: a.lateBids };
  };
  /** A description of the first call where the two servers differ, or null. */
  const compare = (where: string): string | null => {
    const [a, b] = servers;
    if (a.calls.length === b.calls.length && a.calls.every((c, j) => c === b.calls[j])) return null;
    let j = 0;
    while (j < a.calls.length && a.calls[j] === b.calls[j]) j++;
    return `match seed ${seed} (${seats} seats, ${auctionType}, ${durationMs} ms), ${where}: ` +
      `ref ${JSON.stringify(a.calls.slice(j, j + 4))}, now ${JSON.stringify(b.calls.slice(j, j + 4))}`;
  };

  const step = async (where: string): Promise<string | null> =>
    (await settle(servers)) ? compare(where) : `match seed ${seed}, ${where}: the bots never went quiet`;

  const first = openAuction(0);
  bots.forEach((b, j) => b.onAuctionOpen(servers[j], first[j]));
  let differ = await step(`auction 0 (bag ${auctions - 1}, ${letters[0]})`);
  if (differ) return { auctions: 1, differ, ...counts() };
  for (let i = 0; i < auctions; i++) {
    const results = closeAuction(i);
    const last = i + 1 === auctions;
    const opened = last ? null : openAuction(i + 1);
    if (last) for (const s of servers) s.match.status = { tag: "Ended" };
    bots.forEach((b, j) => {
      b.onAuctionResult(servers[j], results[j]);
      if (opened) b.onAuctionOpen(servers[j], opened[j]);
      else b.onMatchEnded(servers[j], MATCH); // index.ts: the match state turning Ended
      b.scheduleRefresh(servers[j], MATCH); // index.ts: rack and balance updates schedule a refresh
    });
    const where = opened ? `, auction ${i + 1} open (${letters[i + 1]})` : ", match ended";
    differ = await step(`after auction ${i} (${letters[i]})${where}`);
    if (differ) return { auctions: i + 1, differ, ...counts() };
  }
  return { auctions, differ: null, ...counts() };
}

// ---- main ----

async function main() {
  const o = parseArgs(process.argv.slice(2));
  for (const f of ["engine.ts", "strategy.ts", "bot.ts"]) {
    if (!fs.existsSync(path.join(o.refDir, f))) throw new Error(`${o.refDir} has no ${f}`);
  }
  const load = (f: string) => import(pathToFileURL(path.join(o.refDir, f)).href);
  const refEngine = (await load("engine.ts")) as Engine;
  const ref = (await load("strategy.ts")) as Strategy;
  const refBot = (await load("bot.ts")) as BotModule;
  const policy = o.variant === "head" ? undefined : parseVariant(o.variant).policy;
  const lines = fs.readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8").split("\n");
  const ix: Indexes = { refEngine, refIdx: refEngine.WordIndex.fromWords(lines), curIdx: curEngine.WordIndex.fromWords(lines) };
  const [lo, hi] = o.matches > 0 ? shardRange(o.matches, o.shard) : [0, 0];
  const out: Record<string, unknown> = { ref: o.refDir, variant: o.variant, seed: o.seed, shard: o.shard ?? "0/1", expect: o.expect };
  const all: Tally[] = [];
  // Checks 1 and 2 run in the shard that holds match 0 (all of them with --matches=0); 0 skips one.
  if (lo === 0 && o.bids > 0) {
    const bids = checkBids(o.bids, o.seed, ref, policy);
    const { flush, helpers } = checkFlushAndHelpers(Math.max(1, Math.floor(o.bids / 4)), o.seed, ref, ix, policy);
    Object.assign(out, { bids, flushRules: flush, helpers });
    all.push(bids, flush, helpers);
  }
  if (lo === 0 && o.words > 0) {
    const { words, flushWords } = checkWords(o.words, o.seed, ref, ix, policy);
    Object.assign(out, { words, flushWords });
    all.push(words, flushWords);
  }
  const bots = tally();
  let auctions = 0;
  let bidCalls = 0;
  let wordCalls = 0;
  let flushWordCalls = 0;
  let lateBids = 0;
  for (let m = lo; m < hi; m++) {
    const res = await lockstepMatch(mix(o.seed, 7, m), ix, refBot, policy, o.trace);
    auctions += res.auctions;
    bidCalls += res.bids;
    wordCalls += res.words;
    flushWordCalls += res.flushWords;
    lateBids += res.lateBids;
    note(bots, res.differ === null, res.words > 0, () => res.differ!);
  }
  out.bots = { matches: hi - lo, auctions, bidCalls, wordCalls, flushWordCalls, lateBids, ...bots };
  if (hi > lo) all.push(bots);
  const differ = all.reduce((s, t) => s + t.differ, 0);
  // Not vacuous: every check ran and saw non-trivial results (bids above 0, words played, plays in the flush
  // window, and from 20 matches on bids refused after a stall).
  const exercised =
    all.length > 0 &&
    all.every((t) => t.compared > 0 && t.nonTrivial > 0) &&
    (hi === lo || (bidCalls > 0 && wordCalls > 0 && flushWordCalls > 0 && (hi - lo < 20 || lateBids > 0)));
  out.differ = differ;
  out.exercised = exercised;
  console.log(JSON.stringify(out, null, 1));
  const ok = o.expect === "same" ? differ === 0 && exercised : differ > 0;
  console.log(ok ? `OK: expect ${o.expect}, ${differ} differ` : `FAIL: expect ${o.expect}, ${differ} differ, exercised ${exercised}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 2;
});
