// SookraBot match logic.
//
// Latency rule: when an auction opens, the bid goes out synchronously from a
// precomputed 26-letter value table (onAuctionOpen), with no dictionary work
// before the reducer call. Everything heavy (valuation, word choice, bid
// refinement, precomputing the table for "rack + the letter now on auction")
// runs afterwards in deferred setImmediate turns, so a message announcing the
// next auction is never queued behind it.
//
// It talks to the database only through the narrow ConnLike interface, so the
// whole loop can be driven by a fake connection in tests. Every entry point
// is wrapped: an exception is logged once and the bot keeps playing.

import {
  type Counts,
  type Valuation,
  WordIndex,
  LEAVE_W7,
  LETTER_VALUE,
  countsKey,
  countsOf,
  letterIndex,
  valuate,
  wordReward,
} from "./engine.js";
import {
  type AuctionKind,
  type BidDecision,
  type Opponent,
  type Policy,
  type PricePoint,
  type SimStrategy,
  DEFAULT_POLICY,
  alphaFor,
  auctionsPerMatch,
  chooseWords,
  decideBid,
  flushLeadMs,
  sevenCompleterMask,
  shouldFlush,
} from "./strategy.js";
import {
  BAG_COUNTS,
  PoolTracker,
  hashSeed,
  lookaheadDelta,
  lookaheadLambda,
  mulberry32,
  multiLookDelta,
  poolWeights,
} from "./pool.js";
import { scaledEmpirical } from "./empirical.js";

/** Starting rack size when match_state does not carry one (game.ts STARTING_RACK_SIZE). */
const DEFAULT_RACK_SIZE = 5;

type Tagged = { tag: string };
type Micros = { microsSinceUnixEpoch: bigint };

export interface MatchStateRow {
  id: bigint;
  status: Tagged;
  currentAuctionId: bigint | undefined;
  bagTotal: number;
  auctionType: Tagged;
  auctionDurationMs: bigint;
  startingRackSize?: number;
}
export interface AuctionRow {
  id: bigint;
  matchId: bigint;
  letter: string;
  status: Tagged;
  /** Server open and close times; compared with the local clock only for logging. */
  opensAt?: Micros;
  closesAt?: Micros;
}
export interface ParticipantRow {
  matchId: bigint;
  botId: bigint;
  balance: bigint;
  score: bigint;
}
export interface HoldingRow {
  matchId: bigint;
  letter: string;
  count: number;
}
export interface BotRow {
  name: string;
  isSimulated: boolean;
  strategy: Tagged;
}
export interface AuctionResultRow {
  auctionId: bigint;
  matchId: bigint;
  letter: string;
  winnerBotId: bigint | undefined;
  paid: bigint;
}

export interface ConnLike {
  db: {
    matchState: { id: { find(id: bigint): MatchStateRow | null | undefined } };
    auction: { id: { find(id: bigint): AuctionRow | null | undefined } };
    matchParticipant: {
      iter(): Iterable<ParticipantRow>;
      /** Client-side btree indexes (used when present, verified once per match). */
      mpByMatch?: { filter(matchId: bigint): Iterable<ParticipantRow> };
      mpByBot?: { filter(botId: bigint): Iterable<ParticipantRow> };
    };
    myRack: { iter(): Iterable<HoldingRow> };
    bot: { id: { find(id: bigint): BotRow | null | undefined } };
  };
  reducers: {
    submitBid(args: { auctionId: bigint; amount: bigint }): Promise<unknown>;
    submitWord(args: { matchId: bigint; word: string }): Promise<unknown>;
  };
}

export interface Logger {
  log(msg: string): void;
  warn(msg: string): void;
}

/** A word the server refuses this many times in a match is not submitted again. */
export const MAX_WORD_FAILURES = 3;
/** A bid the server refuses this many times (other than for lateness) is not re-sent. */
export const MAX_BID_FAILURES = 3;
/** After a transport failure (disconnect), wait this long before submitting words again. */
export const TRANSPORT_BACKOFF_MS = 1000;
/**
 * A word call still unanswered past the word-call deadline on the connection
 * it went out on means that connection is unhealthy although events still
 * arrive: the bot asks for a new one (onStuck). Its reservation is kept
 * meanwhile (expiring it on time alone could submit the same letters twice);
 * the new connection's rack settles it. This is the deadline while the
 * server answers promptly; it adapts to a slow one (SookraBot.wordDeadlineMs).
 */
export const PENDING_CALL_DEADLINE_MS = 5000;
/** The word-call deadline never grows past this. */
export const PENDING_CALL_DEADLINE_MAX_MS = 60_000;
/** Word calls (answered, or reported overdue) the word-call deadline looks back over. */
export const WORD_LATENCY_WINDOW = 8;
/** Log a valuation slower than this. */
export const SLOW_VALUATION_MS = 50;
/** Valuation tables kept per match (current rack, rack + letter on auction, flush variants). */
export const VAL_CACHE_MAX = 8;
/**
 * Cold-start provisional value when no table exists yet for the rack (first
 * auction of a match): this share of the measured 7-tile marginal value.
 * The refined bid follows within milliseconds.
 */
export const STATIC_DELTA_SCALE = 0.5;
/** Process-lifetime bookkeeping caps (oldest entries are evicted first). */
export const MAX_WARN_KEYS = 256;
export const MAX_VERIFIED_MATCHES = 256;

interface PendingWord {
  word: string;
  counts: Counts;
  reward: number;
  /** The connection the call went out on. */
  conn: ConnLike;
  at: number;
  /** When it was sent or last reported overdue: it is reported again every word-call deadline. */
  checkedAt: number;
}

interface MatchModel {
  vals: Map<string, Valuation>;
  latest: Valuation | null;
  /** Last amount sent per auction (dedupe). */
  lastBid: Map<string, number>;
  /** Last amount the server accepted per auction. */
  confirmed: Map<string, number>;
  bidFailures: Map<string, number>;
  sentAny: Set<string>;
  /** Auctions the server has told us are closed (no more bids are sent). */
  closed: Set<string>;
  /** Auctions where a send's outcome is unknown (UnknownCallResultError). */
  uncertain: Set<string>;
  /** Bid sends awaiting an answer, per auction. */
  inflight: Map<string, number>;
  bidInfo: Map<string, { delta: number; bagTotal: number; reason: string; source: string }>;
  skipLogged: Set<string>;
  recvAt: Map<string, { wall: number; mono: number }>;
  pending: Map<number, PendingWord>;
  nextPendingId: number;
  wordFailures: Map<string, number>;
  wordBackoffUntil: number;
  submitted: number;
  announced: boolean;
  firstBids: number;
  lateFirst: number;
  lateReplace: number;
  margins: number[];
  recvLags: number[];
  /** Unseen-pool bookkeeping (pool.ts); fed only while LOOKAHEAD_WEIGHT is on. */
  pool: PoolTracker;
  /** Multi-letter lookahead values (MLOOK_M), by auction, rack and alpha. */
  mlook: Map<string, number>;
  /** Duel rival bids seen this match (SPITE_ALPHA): exact when we won (its bid set our price), else a lower bound. */
  rivalBids: { face: number; bid: number }[];
}

function newModel(): MatchModel {
  return {
    vals: new Map(),
    latest: null,
    lastBid: new Map(),
    confirmed: new Map(),
    bidFailures: new Map(),
    sentAny: new Set(),
    closed: new Set(),
    uncertain: new Set(),
    inflight: new Map(),
    bidInfo: new Map(),
    skipLogged: new Set(),
    recvAt: new Map(),
    pending: new Map(),
    nextPendingId: 1,
    wordFailures: new Map(),
    wordBackoffUntil: 0,
    submitted: 0,
    announced: false,
    firstBids: 0,
    lateFirst: 0,
    lateReplace: 0,
    margins: [],
    recvLags: [],
    pool: new PoolTracker(),
    mlook: new Map(),
    rivalBids: [],
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The call never reached the server or its outcome is unknown (SDK DisconnectedError / UnknownCallResultError). */
export function isTransportError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return name === "DisconnectedError" || name === "UnknownCallResultError";
}

/** The server refused a bid because its auction had already closed. */
export function isLateBidError(err: unknown): boolean {
  return /auction closed|window expired/i.test(errMsg(err));
}

function microsToMs(t: Micros | undefined): number | undefined {
  return t === undefined ? undefined : Number(t.microsSinceUnixEpoch) / 1000;
}

/** Drop the oldest-inserted entries until the collection is within `max`. */
function evictOldest(c: Map<string, unknown> | Set<string>, max: number) {
  while (c.size > max) {
    const oldest = c.keys().next().value;
    if (oldest === undefined) break;
    c.delete(oldest);
  }
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export class SookraBot {
  myBotId: bigint | null = null;
  /** False while disconnected: no decisions on a stale cache (index.ts toggles it). */
  online = true;
  /** Called with one record per auction result in our matches (for an offline log). */
  onRecord: ((rec: Record<string, unknown>) => void) | null = null;
  /**
   * Called with the connection a word call has gone unanswered on for the
   * word-call deadline (wordDeadlineMs; again each deadline while that
   * lasts); index.ts has the supervisor replace that connection.
   */
  onStuck: ((conn: ConnLike, reason: string) => void) | null = null;
  readonly models = new Map<string, MatchModel>();
  readonly fpHistory: PricePoint[] = [];
  private readonly scheduled = new Set<string>();
  private readonly precomputeScheduled = new Set<string>();
  private readonly lastWarn = new Map<string, number>();
  private readonly indexVerified = new Set<string>();
  private useIndex = true;
  /**
   * How long each of the last WORD_LATENCY_WINDOW word calls took to be
   * answered (accepted or refused); a call reported overdue counts with how
   * long it had waited by then. Kept across connections: it measures the server.
   */
  private readonly wordLatencies: number[] = [];
  /**
   * Per valuation table, the letters that complete a 7+ word on its rack
   * (sevenCompleterMask), set when the table is made and only while
   * COMPLETE7_PREMIUM is on, so the bid on an auction's open stays a lookup.
   */
  private readonly sevenMasks = new WeakMap<Valuation, number>();
  /** EMP_DEAD_SCALE's table (empirical.ts), or undefined while that knob is off. */
  private readonly deadValue: Float64Array | undefined;

  /**
   * `policy` holds every tuning constant this bot plays with (strategy.ts);
   * the live bot uses DEFAULT_POLICY, and the self-play harness passes a
   * variant's here, the one place a variant reaches the bot.
   */
  constructor(
    private readonly index: WordIndex,
    private readonly name: string,
    private readonly out: Logger = console,
    private readonly now: () => number = Date.now,
    readonly policy: Policy = DEFAULT_POLICY,
  ) {
    this.deadValue = policy.EMP_DEAD_SCALE > 0 ? scaledEmpirical(policy.EMP_DEAD_SCALE) : undefined;
  }

  /** The fixed flush rule (FLUSH_LEAD_MS), which valuation alpha and the precomputed tables follow. */
  private flushAt(bagTotal: number, durationMs: number): boolean {
    return shouldFlush(bagTotal, durationMs, this.policy.FLUSH_LEAD_MS);
  }

  // ---- logging ----

  private log(msg: string) {
    this.out.log(`[${this.name}] ${msg}`);
  }

  /** One line per distinct failure, at most every 10 s. */
  warn(label: string, err: unknown) {
    const msg = errMsg(err);
    const key = `${label}|${msg}`;
    const t = this.now();
    if (t - (this.lastWarn.get(key) ?? -Infinity) < 10_000) return;
    this.lastWarn.delete(key);
    this.lastWarn.set(key, t);
    evictOldest(this.lastWarn, MAX_WARN_KEYS);
    this.out.warn(`[${this.name}] ${label}: ${msg}`);
  }

  private guard(label: string, fn: () => void) {
    try {
      fn();
    } catch (err) {
      this.warn(label, err);
    }
  }

  // ---- reads ----

  private modelFor(matchId: bigint): MatchModel {
    const key = String(matchId);
    let m = this.models.get(key);
    if (!m) {
      m = newModel();
      this.models.set(key, m);
    }
    return m;
  }

  /**
   * Every participant row of one match: the client btree index when present,
   * else a scan. The first lookup for each match also scans and compares; on
   * any disagreement or error the index is never used again.
   */
  seatRows(conn: ConnLike, matchId: bigint): ParticipantRow[] {
    const scan = (): ParticipantRow[] => {
      const out: ParticipantRow[] = [];
      for (const p of conn.db.matchParticipant.iter()) if (p.matchId === matchId) out.push(p);
      return out;
    };
    const idx = this.useIndex ? conn.db.matchParticipant.mpByMatch : undefined;
    if (!idx) return scan();
    let rows: ParticipantRow[];
    try {
      rows = [...idx.filter(matchId)];
    } catch (err) {
      this.useIndex = false;
      this.warn("participant index disabled", err);
      return scan();
    }
    const key = String(matchId);
    if (!this.indexVerified.has(key)) {
      const scanned = scan();
      const sig = (rs: ParticipantRow[]) =>
        rs.map((p) => `${p.botId}:${p.balance}:${p.score}`).sort().join(",");
      if (sig(rows) !== sig(scanned)) {
        this.useIndex = false;
        this.log(`participant index disagrees with a scan for m${matchId}; scanning from now on`);
        return scanned;
      }
      this.indexVerified.add(key);
      evictOldest(this.indexVerified, MAX_VERIFIED_MATCHES);
    }
    return rows;
  }

  myParticipant(conn: ConnLike, matchId: bigint): ParticipantRow | undefined {
    if (this.myBotId === null) return undefined;
    return this.seatRows(conn, matchId).find((p) => p.botId === this.myBotId);
  }

  /** Matches this bot is seated in that are still running. */
  runningMatches(conn: ConnLike): bigint[] {
    const out: bigint[] = [];
    if (this.myBotId === null) return out;
    let rows: Iterable<ParticipantRow> = conn.db.matchParticipant.iter();
    const byBot = this.useIndex ? conn.db.matchParticipant.mpByBot : undefined;
    if (byBot) {
      try {
        rows = [...byBot.filter(this.myBotId)];
      } catch {
        rows = conn.db.matchParticipant.iter();
      }
    }
    for (const p of rows) {
      if (p.botId !== this.myBotId) continue;
      if (conn.db.matchState.id.find(p.matchId)?.status.tag === "Running") out.push(p.matchId);
    }
    return out;
  }

  private rackCounts(conn: ConnLike, matchId: bigint): Counts {
    const counts = new Int32Array(26);
    for (const h of conn.db.myRack.iter()) {
      if (h.matchId !== matchId) continue;
      const i = letterIndex(h.letter);
      if (i >= 0) counts[i] += h.count;
    }
    return counts;
  }

  /**
   * Rack minus letters of words still in flight. A reservation lasts until
   * its reducer call settles (ack, refusal, or the SDK failing in-flight
   * calls when the connection drops), or until the bot is online on a newer
   * connection (checkPending); elapsed time alone proves nothing.
   */
  private effectiveCounts(model: MatchModel, raw: Counts): Counts {
    const out = new Int32Array(raw);
    for (const p of model.pending.values()) {
      for (let i = 0; i < 26; i++) out[i] = Math.max(0, out[i] - p.counts[i]);
    }
    return out;
  }

  private opponentsFrom(conn: ConnLike, rows: ParticipantRow[]): Opponent[] {
    const out: Opponent[] = [];
    for (const p of rows) {
      if (p.botId === this.myBotId) continue;
      const bot = conn.db.bot.id.find(p.botId);
      const tag = bot?.strategy.tag;
      const isSim =
        bot?.isSimulated === true &&
        (tag === "Cheapskate" || tag === "ValueBidder" || tag === "Aggressive");
      out.push({
        isSim,
        strategy: isSim ? (tag as SimStrategy) : undefined,
        balance: Number(p.balance),
      });
    }
    return out;
  }

  opponents(conn: ConnLike, matchId: bigint): Opponent[] {
    return this.opponentsFrom(conn, this.seatRows(conn, matchId));
  }

  private valuation(model: MatchModel, counts: Counts, alpha: number): Valuation {
    const key = `${countsKey(counts)}|${alpha}`;
    const hit = model.vals.get(key);
    if (hit) {
      model.vals.delete(key);
      model.vals.set(key, hit);
      return hit;
    }
    const v = valuate(this.index, counts, alpha, "leave", this.policy.EXACT_VALUE_NODES, this.deadValue);
    if (v.ms > SLOW_VALUATION_MS) {
      this.log(`slow valuation: ${v.ms.toFixed(1)} ms for ${v.rackKey.length} tiles`);
    }
    // valuate packs with keepWeight alpha (its "leave" mode), so the mask counts the same packing.
    if (this.policy.COMPLETE7_PREMIUM !== 1) this.sevenMasks.set(v, sevenCompleterMask(this.index, v.cands, counts, v.alpha));
    model.vals.set(key, v);
    while (model.vals.size > VAL_CACHE_MAX) {
      const oldest = model.vals.keys().next().value;
      if (oldest === undefined) break;
      model.vals.delete(oldest);
    }
    model.latest = v;
    return v;
  }

  /**
   * Table lookup only: never touches the dictionary. `val` is the table the
   * delta comes from when it values exactly this rack ("table", "table-alpha").
   */
  lookupDelta(
    matchId: bigint,
    counts: Counts,
    alpha: number,
    letter: string,
  ): { delta: number; source: string; val?: Valuation } {
    const model = this.modelFor(matchId);
    const li = letterIndex(letter);
    if (li < 0) return { delta: 0, source: "bad-letter" };
    const rk = countsKey(counts);
    const exact = model.vals.get(`${rk}|${alpha}`);
    if (exact) return { delta: exact.delta[li], source: "table", val: exact };
    for (const v of model.vals.values()) {
      if (v.rackKey === rk) return { delta: v.delta[li], source: "table-alpha", val: v };
    }
    if (model.latest) return { delta: model.latest.delta[li], source: "stale" };
    return { delta: STATIC_DELTA_SCALE * (LEAVE_W7[letter] ?? 0), source: "static" };
  }

  // ---- events ----

  /**
   * Latency-critical: called synchronously from the auction insert callback.
   * Sends the bid from a precomputed table, then defers everything else.
   */
  onAuctionOpen(conn: ConnLike, a: AuctionRow) {
    const recvWall = this.now();
    const recvMono = performance.now();
    this.guard(`auction open a${a.id}`, () => {
      if (!this.online || this.myBotId === null || a.status.tag !== "Open") return;
      const m = conn.db.matchState.id.find(a.matchId);
      if (!m || m.status.tag !== "Running") return;
      const rows = this.seatRows(conn, a.matchId);
      const me = rows.find((p) => p.botId === this.myBotId);
      if (!me) return;
      const model = this.modelFor(a.matchId);
      model.recvAt.set(String(a.id), { wall: recvWall, mono: recvMono });
      const opensMs = microsToMs(a.opensAt);
      if (opensMs !== undefined) model.recvLags.push(recvWall - opensMs);
      const bagTotal = Number(m.bagTotal);
      const alpha = alphaFor(this.flushAt(bagTotal, Number(m.auctionDurationMs)), this.policy, bagTotal);
      const counts = this.effectiveCounts(model, this.rackCounts(conn, a.matchId));
      const { delta, source, val } = this.lookupDelta(a.matchId, counts, alpha, a.letter);
      this.placeBid(conn, model, m, a, Number(me.balance), delta, bagTotal, source, this.opponentsFrom(conn, rows), val);
      // After the bid: pool bookkeeping for the lookahead (off by default).
      if (this.policy.LOOKAHEAD_WEIGHT > 0) {
        model.pool.noteAuction(String(a.id), letterIndex(a.letter));
        if (!model.pool.startDecided) {
          const apm = auctionsPerMatch(rows.length, m.startingRackSize ?? DEFAULT_RACK_SIZE);
          model.pool.noteStart(bagTotal === apm - 1 ? this.rackCounts(conn, a.matchId) : null);
        }
      }
    });
    this.scheduleRefresh(conn, a.matchId);
  }

  /** Coalesce bursts of row callbacks into one refresh after the current message. */
  scheduleRefresh(conn: ConnLike, matchId: bigint) {
    const key = String(matchId);
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    setImmediate(() => {
      this.scheduled.delete(key);
      this.guard(`refresh m${key}`, () => this.refresh(conn, matchId));
    });
  }

  /**
   * While an auction runs, the only rack changes before the next one are
   * winning this letter or not (plus our own plays). Precompute both tables,
   * each in its own turn, so the next bid is a lookup.
   */
  private schedulePrecompute(conn: ConnLike, matchId: bigint, letter: string, bagTotal: number, durationMs: number) {
    if (bagTotal <= 0) return;
    const key = String(matchId);
    if (this.precomputeScheduled.has(key)) return;
    this.precomputeScheduled.add(key);
    const nextAlpha = alphaFor(this.flushAt(bagTotal - 1, durationMs), this.policy, bagTotal - 1);
    const step = (withLetter: boolean) => () =>
      this.guard(`precompute m${key}`, () => {
        if (!this.online) return;
        const model = this.models.get(key);
        if (!model) return;
        const counts = this.effectiveCounts(model, this.rackCounts(conn, matchId));
        const li = letterIndex(letter);
        if (withLetter && li >= 0) counts[li]++;
        this.valuation(model, counts, nextAlpha);
      });
    setImmediate(() => {
      this.precomputeScheduled.delete(key);
      step(true)();
      setImmediate(step(false));
    });
  }

  /**
   * Re-check every running match (covers missed events and failed plays),
   * and drop models of matches that are no longer running, in case their
   * end event was missed (each model can hold several valuation tables).
   */
  tick(conn: ConnLike) {
    this.guard("tick", () => {
      if (!this.online) return;
      this.checkPending(conn);
      if (!this.online) return; // a stuck call just paused the bot for a new connection
      for (const id of this.runningMatches(conn)) this.scheduleRefresh(conn, id);
      for (const key of [...this.models.keys()]) {
        const m = conn.db.matchState.id.find(BigInt(key));
        if (!m || m.status.tag !== "Running") this.onMatchEnded(conn, BigInt(key));
      }
    });
  }

  /**
   * How long a word call may go unanswered on its connection before the bot
   * asks for a new one: twice the slowest of the last WORD_LATENCY_WINDOW
   * calls, within PENDING_CALL_DEADLINE_MS..PENDING_CALL_DEADLINE_MAX_MS. A
   * fixed deadline replaces a working connection on every play once the
   * server takes longer than it to answer, and each replacement loses the
   * late answer, a refusal included (the SDK fails the call as
   * UnknownCallResultError, which never counts toward MAX_WORD_FAILURES). A
   * report therefore at least doubles the deadline (up to the cap), and it is
   * back at the base once each of the last WORD_LATENCY_WINDOW calls was
   * answered within half of the base.
   */
  wordDeadlineMs(): number {
    let slowest = 0;
    for (const ms of this.wordLatencies) slowest = Math.max(slowest, ms);
    return Math.min(PENDING_CALL_DEADLINE_MAX_MS, Math.max(PENDING_CALL_DEADLINE_MS, 2 * slowest));
  }

  private noteWordLatency(ms: number) {
    this.wordLatencies.push(ms);
    while (this.wordLatencies.length > WORD_LATENCY_WINDOW) this.wordLatencies.shift();
  }

  /**
   * Word calls still unanswered; `conn` is the connection the bot acts on
   * (tick runs only while it is online, so its subscription is applied).
   * A call sent on an earlier connection is settled by this one: the rack
   * now comes from the server, and letters still in it mean the play did not
   * happen, so its reservation is released. A call on `conn` itself that is
   * overdue keeps its reservation, and the bot asks for a new connection.
   */
  private checkPending(conn: ConnLike) {
    const t = this.now();
    const deadline = this.wordDeadlineMs();
    let overdue: string | null = null;
    for (const [key, model] of this.models) {
      for (const [id, p] of model.pending) {
        if (p.conn !== conn) {
          model.pending.delete(id);
          this.log(`m${key}: play '${p.word}' unanswered when its connection was replaced; the rack decides`);
          continue;
        }
        if (t - p.checkedAt > deadline) {
          p.checkedAt = t;
          // Its answer, if one ever comes, takes at least this long: the next deadline is longer.
          this.noteWordLatency(t - p.at);
          overdue ??= `m${key}: play '${p.word}' unanswered for ${t - p.at} ms (deadline ${deadline} ms)`;
        }
      }
    }
    if (overdue === null) return;
    this.out.warn(`[${this.name}] ${overdue}; asking for a new connection`);
    this.onStuck?.(conn, overdue);
  }

  onAuctionResult(conn: ConnLike, r: AuctionResultRow) {
    this.guard("auction result", () => {
      if (this.myBotId === null) return;
      const m = conn.db.matchState.id.find(r.matchId);
      const winner = r.winnerBotId;
      if (m?.auctionType.tag === "FirstPrice" && winner !== undefined && winner !== this.myBotId) {
        const bot = conn.db.bot.id.find(winner);
        if (bot && !bot.isSimulated) {
          this.fpHistory.push({ face: LETTER_VALUE[r.letter] ?? 1, paid: Number(r.paid) });
          if (this.fpHistory.length > 26 * this.policy.FP_HISTORY_MAX) this.fpHistory.shift();
        }
      }
      const model = this.models.get(String(r.matchId));
      if (!model) return;
      const mine = model.lastBid.get(String(r.auctionId));
      if (this.policy.SPITE_ALPHA > 0 && m?.auctionType.tag === "Vickrey" && winner !== undefined) {
        // Vickrey: when we win, the price is the rival's bid; when it wins, its bid was at least ours.
        const face = LETTER_VALUE[r.letter] ?? 1;
        if (winner === this.myBotId) model.rivalBids.push({ face, bid: Number(r.paid) });
        else if (mine !== undefined && mine > 0) model.rivalBids.push({ face, bid: mine });
        if (model.rivalBids.length > 60) model.rivalBids.shift();
      }
      const who = winner === undefined ? "nobody" : winner === this.myBotId ? "US" : `bot ${winner}`;
      this.log(
        `m${r.matchId} a${r.auctionId} '${r.letter}' -> ${who} paid ${r.paid}` +
          (mine !== undefined ? ` (our bid ${mine})` : ""),
      );
      if (this.onRecord) {
        const balances: Record<string, number> = {};
        const scores: Record<string, number> = {};
        for (const p of this.seatRows(conn, r.matchId)) {
          balances[String(p.botId)] = Number(p.balance);
          scores[String(p.botId)] = Number(p.score);
        }
        const info = model.bidInfo.get(String(r.auctionId));
        this.onRecord({
          t: this.now(),
          match: String(r.matchId),
          auction: String(r.auctionId),
          letter: r.letter,
          type: m?.auctionType.tag,
          winner: winner === undefined ? null : String(winner),
          paid: Number(r.paid),
          ourBid: mine ?? 0,
          delta: info?.delta ?? null,
          bagTotal: info?.bagTotal ?? null,
          reason: info?.reason ?? null,
          source: info?.source ?? null,
          balances,
          scores,
        });
      }
    });
  }

  /** Per-match bid timing counters (also logged at match end). */
  lateStats(matchId: bigint) {
    const m = this.models.get(String(matchId));
    return m
      ? { firstBids: m.firstBids, lateFirst: m.lateFirst, lateReplace: m.lateReplace, margins: [...m.margins] }
      : undefined;
  }

  onMatchEnded(conn: ConnLike, matchId: bigint) {
    this.guard("match end", () => {
      const key = String(matchId);
      const model = this.models.get(key);
      const rows = this.seatRows(conn, matchId);
      const me = rows.find((p) => p.botId === this.myBotId);
      if (me) {
        const scores = rows.map((p) => p.score);
        const rank = 1 + scores.filter((s) => s > me.score).length;
        const late = model
          ? `, bids ${model.firstBids}, late ${model.lateFirst} (${
              model.firstBids ? ((100 * model.lateFirst) / model.firstBids).toFixed(1) : "0.0"
            }%), late replacements ${model.lateReplace}, margin median ${median(model.margins)?.toFixed(0) ?? "?"} ms` +
            ` min ${model.margins.length ? Math.min(...model.margins).toFixed(0) : "?"} ms, recv lag median ${
              median(model.recvLags)?.toFixed(0) ?? "?"
            } ms`
          : "";
        this.log(
          `m${key} ended: score ${me.score}, rank ${rank}/${scores.length}, ` +
            `best ${scores.reduce((a, b) => (b > a ? b : a), 0n)}, words ${model?.submitted ?? 0}${late}`,
        );
      }
      this.models.delete(key);
      this.indexVerified.delete(key);
    });
  }

  // ---- the decision loop ----

  private logMatchStart(conn: ConnLike, m: MatchStateRow, rows: ParticipantRow[]) {
    const opps = this.opponentsFrom(conn, rows);
    const sims = opps.filter((o) => o.isSim).length;
    this.log(
      `m${m.id} start: ${opps.length + 1} bots (${opps.length - sims} real rivals, ${sims} sims), ` +
        `${m.auctionType.tag}, auction ${m.auctionDurationMs} ms, rack ${m.startingRackSize ?? "?"}, bag ${m.bagTotal}`,
    );
  }

  /** Deferred work: value the rack, play any words due, refine the bid, precompute the next table. */
  refresh(conn: ConnLike, matchId: bigint) {
    if (!this.online || this.myBotId === null) return;
    const m = conn.db.matchState.id.find(matchId);
    if (!m || m.status.tag !== "Running") return;
    const rows = this.seatRows(conn, matchId);
    const me = rows.find((p) => p.botId === this.myBotId);
    if (!me) return;
    const model = this.modelFor(matchId);
    if (!model.announced) {
      model.announced = true;
      this.logMatchStart(conn, m, rows);
    }
    const row = m.currentAuctionId !== undefined ? conn.db.auction.id.find(m.currentAuctionId) : undefined;
    const open = row && row.status.tag === "Open" && row.matchId === matchId ? row : undefined;
    const bagTotal = Number(m.bagTotal);
    const durationMs = Number(m.auctionDurationMs);
    // Valuation keeps the fixed flush rule (so precomputed tables match); only word
    // plays move earlier when this match has seen a network stall (flushLeadMs).
    const flush = open !== undefined && this.flushAt(bagTotal, durationMs);
    const flushWords =
      open !== undefined && (flush || shouldFlush(bagTotal, durationMs, flushLeadMs(model.recvLags, this.policy)));
    const alpha = alphaFor(flush, this.policy, bagTotal);
    const balance = Number(me.balance);

    let counts = this.effectiveCounts(model, this.rackCounts(conn, matchId));
    let val: Valuation | null = null;
    try {
      val = this.valuation(model, counts, alpha);
    } catch (err) {
      this.warn("valuation", err);
    }

    // Words before the refined bid: a cashed word or a flush changes the rack the bid is valued on.
    if (val) {
      let played = 0;
      try {
        played = this.playWords(conn, matchId, model, counts, val, balance, flushWords, bagTotal);
      } catch (err) {
        this.warn("word choice", err);
      }
      if (played > 0) {
        counts = this.effectiveCounts(model, this.rackCounts(conn, matchId));
        try {
          val = this.valuation(model, counts, alpha);
        } catch (err) {
          this.warn("valuation", err);
          val = null;
        }
      }
    }

    // Without a valuation, keep whatever bid is already live rather than withdraw it.
    if (open && val) {
      const li = letterIndex(open.letter);
      let delta = li >= 0 ? val.delta[li] : 0;
      let source = "table";
      if (li >= 0 && this.lookaheadOn(conn, m, rows)) {
        const looked = this.lookahead(model, counts, val, open, li, bagTotal, alpha);
        if (looked !== null) {
          delta = looked;
          source = "table+look";
        }
      }
      this.placeBid(
        conn, model, m, open, balance, delta, bagTotal, source,
        this.opponentsFrom(conn, rows), val,
      );
      this.schedulePrecompute(conn, matchId, open.letter, bagTotal, durationMs);
    }
  }

  /** The lookahead is on (LOOKAHEAD_WEIGHT) and this table passes its gate (Vickrey, LOOKAHEAD_MIN_REAL_RIVALS). */
  private lookaheadOn(conn: ConnLike, m: MatchStateRow, rows: ParticipantRow[]): boolean {
    const p = this.policy;
    if (!(p.LOOKAHEAD_WEIGHT > 0)) return false;
    if (p.LOOKAHEAD_MIN_REAL_RIVALS <= 0) return true;
    // FP_LOOKAHEAD (finals knob, on since 18b3203; 0 restores 9f1faba) opens the same gate at first-price tables.
    const typeOk = m.auctionType.tag === "Vickrey" || (p.FP_LOOKAHEAD > 0 && m.auctionType.tag === "FirstPrice");
    if (!typeOk) return false;
    return this.opponentsFrom(conn, rows).filter((o) => !o.isSim).length >= p.LOOKAHEAD_MIN_REAL_RIVALS;
  }

  /**
   * One-step lookahead value of the letter on auction (pool.ts), or null when
   * it does not apply (no future auctions, or the valuation of rack + letter
   * failed). Values rack + letter at the same alpha (the next precompute
   * usually finds it cached).
   */
  private lookahead(
    model: MatchModel,
    counts: Counts,
    val: Valuation,
    open: AuctionRow,
    li: number,
    bagTotal: number,
    alpha: number,
  ): number | null {
    model.pool.noteAuction(String(open.id), li);
    const multi = this.multiLookahead(model, counts, val, open, li, bagTotal, alpha);
    if (multi !== null) return multi;
    const lambda = lookaheadLambda(this.policy.LOOKAHEAD_WEIGHT, bagTotal, this.policy.LOOKAHEAD_HORIZON);
    if (lambda <= 0) return null;
    const withX = new Int32Array(counts);
    withX[li]++;
    let vx: Valuation;
    try {
      vx = this.valuation(model, withX, alpha);
    } catch (err) {
      this.warn("lookahead valuation", err);
      return null;
    }
    const w = poolWeights(this.policy.LOOKAHEAD_POOL > 0 ? model.pool.unseen() : null);
    return lookaheadDelta(val, vx, li, w, lambda);
  }

  /**
   * Multi-letter lookahead value of the letter on auction (MLOOK_M, pool.ts
   * multiLookDelta), or null when it is off, m < 2, or it failed (the one-step
   * lookahead then applies). Computed once per auction, rack and alpha, from
   * a sample seed of the same three, so a replay draws the same samples.
   */
  private multiLookahead(
    model: MatchModel,
    counts: Counts,
    val: Valuation,
    open: AuctionRow,
    li: number,
    bagTotal: number,
    alpha: number,
  ): number | null {
    const p = this.policy;
    if (!(p.MLOOK_M > 0)) return null;
    const m = Math.min(p.MLOOK_M, Math.floor(bagTotal * p.MLOOK_RATE));
    if (!(m >= 2)) return null;
    const key = `${open.id}|${countsKey(counts)}|${alpha}`;
    const hit = model.mlook.get(key);
    if (hit !== undefined) return hit;
    let tilt: Float64Array | undefined;
    if (p.MLOOK_TILT > 0) {
      let mean = 0;
      for (let e = 0; e < 26; e++) mean += val.delta[e];
      mean /= 26;
      tilt = new Float64Array(26);
      for (let e = 0; e < 26; e++) tilt[e] = mean > 0 ? (Math.max(0, val.delta[e]) / mean) ** p.MLOOK_TILT : 1;
    }
    let d: number;
    try {
      d = multiLookDelta(
        this.index, counts, li, p.LOOKAHEAD_POOL > 0 ? model.pool.unseen() : BAG_COUNTS, m, p.MLOOK_SAMPLES,
        alpha * p.MLOOK_ALPHA_SCALE, mulberry32(hashSeed(key)), tilt,
      );
    } catch (err) {
      this.warn("multi-letter lookahead", err);
      return null;
    }
    if (!Number.isFinite(d)) return null;
    d *= p.MLOOK_SCALE;
    model.mlook.set(key, d);
    while (model.mlook.size > 64) {
      const oldest = model.mlook.keys().next().value;
      if (oldest === undefined) break;
      model.mlook.delete(oldest);
    }
    return d;
  }

  private playWords(
    conn: ConnLike,
    matchId: bigint,
    model: MatchModel,
    counts: Counts,
    val: Valuation,
    balance: number,
    flush: boolean,
    bagTotal?: number,
  ): number {
    if (this.index.size === 0) return 0;
    if (this.now() < model.wordBackoffUntil) return 0;
    // Plays still in flight do not hold up new ones: their letters are
    // already out of `counts`, and their rewards count as landed, so a broke
    // bot does not cash a liquidity word that a pending reward makes needless.
    let pendingReward = 0;
    for (const p of model.pending.values()) pendingReward += p.reward;
    const words = chooseWords(this.index, {
      counts,
      cands: val.cands,
      myBalance: balance + pendingReward,
      flush,
      alpha: val.alpha,
      realRivals: this.opponents(conn, matchId).filter((o) => !o.isSim).length,
      bagTotal,
      policy: this.policy,
    }).filter((w) => (model.wordFailures.get(w) ?? 0) < MAX_WORD_FAILURES);
    for (const w of words) this.submitWord(conn, matchId, model, w, flush);
    return words.length;
  }

  private submitWord(conn: ConnLike, matchId: bigint, model: MatchModel, word: string, flush: boolean) {
    const id = model.nextPendingId++;
    const at = this.now();
    model.pending.set(id, { word, counts: countsOf(word), reward: wordReward(word), conn, at, checkedAt: at });
    model.submitted++;
    this.log(`m${matchId}: play '${word}' (+${wordReward(word)}${flush ? ", flush" : ""})`);
    let p: Promise<unknown>;
    try {
      p = conn.reducers.submitWord({ matchId, word });
    } catch (err) {
      model.pending.delete(id);
      model.submitted--;
      this.warn(`play '${word}'`, err);
      return;
    }
    p.then(
      () => this.noteWordLatency(this.now() - at),
      (err: unknown) => {
        model.submitted--;
        if (isTransportError(err)) {
          // Not the word's fault: back off and retry after reconnecting.
          model.wordBackoffUntil = this.now() + TRANSPORT_BACKOFF_MS;
          this.warn(`play '${word}' (transport)`, err);
        } else {
          this.noteWordLatency(this.now() - at);
          model.wordFailures.set(word, (model.wordFailures.get(word) ?? 0) + 1);
          this.out.warn(`[${this.name}] m${matchId}: play '${word}' refused: ${errMsg(err)}`);
        }
      },
    ).finally(() => {
      model.pending.delete(id);
      this.scheduleRefresh(conn, matchId);
    });
  }

  private placeBid(
    conn: ConnLike,
    model: MatchModel,
    m: MatchStateRow,
    auction: AuctionRow,
    balance: number,
    delta: number,
    bagTotal: number,
    source: string,
    opponents: Opponent[],
    val?: Valuation,
  ) {
    const key = String(auction.id);
    // What the round 2 levers read about this letter on this rack, only while they are on
    // (`val`: the table of exactly this rack the delta comes from, else nothing is known).
    const extras: { completes7?: boolean; leaveAlpha?: number; rivalBidHint?: number } = {};
    if (this.policy.SPITE_ALPHA > 0) {
      // The duel rival's predicted bid on this letter: the median of its bids seen on letters of the same face.
      const face = LETTER_VALUE[auction.letter] ?? 1;
      const same = model.rivalBids.filter((b) => b.face === face).map((b) => b.bid).sort((a, b) => a - b);
      if (same.length >= this.policy.SPITE_MIN_OBS) extras.rivalBidHint = same[Math.floor((same.length - 1) / 2)];
    }
    if (val !== undefined) {
      const li = letterIndex(auction.letter);
      const mask = this.policy.COMPLETE7_PREMIUM !== 1 ? this.sevenMasks.get(val) : undefined;
      if (mask !== undefined && li >= 0) extras.completes7 = ((mask >>> li) & 1) === 1;
      if (this.policy.DEAD_KAPPA_SCALE !== 1 || this.policy.DEAD_LATE_BAG > 0) extras.leaveAlpha = val.alpha;
    }
    let decision: BidDecision;
    try {
      decision = decideBid({
        letter: auction.letter,
        delta,
        bagTotal,
        auctionType: (m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey") as AuctionKind,
        myBalance: balance,
        opponents,
        fpHistory: this.fpHistory,
        auctionsPerMatch: auctionsPerMatch(opponents.length + 1, m.startingRackSize ?? DEFAULT_RACK_SIZE),
        policy: this.policy,
        ...extras,
      });
    } catch (err) {
      this.warn("decideBid", err);
      return; // keep any live bid
    }
    const amount = Number.isFinite(decision.amount) ? Math.max(0, Math.floor(decision.amount)) : 0;
    model.bidInfo.set(key, { delta, bagTotal, reason: decision.reason, source });
    const prev = model.lastBid.get(key);
    if (model.uncertain.has(key)) {
      // A send's outcome is unknown (ack lost): the server may hold any of our
      // amounts, so send the desired one, even an unchanged amount or a 0
      // withdrawal, unless an attempt is already in flight.
      if ((model.inflight.get(key) ?? 0) > 0) return;
    } else {
      if (prev === amount) return;
      if (prev === undefined && amount === 0) {
        if (!model.skipLogged.has(key)) {
          model.skipLogged.add(key);
          this.log(`m${m.id} a${key} '${auction.letter}' bag ${bagTotal}: no bid (${decision.reason}, ${source})`);
        }
        return;
      }
    }
    if (model.closed.has(key)) return;
    if ((model.bidFailures.get(key) ?? 0) >= MAX_BID_FAILURES) return;
    const hadLive = (model.confirmed.get(key) ?? 0) > 0;
    const firstSend = !model.sentAny.has(key);
    model.sentAny.add(key);
    if (firstSend) model.firstBids++;
    model.lastBid.set(key, amount);

    let p: Promise<unknown>;
    try {
      p = conn.reducers.submitBid({ auctionId: auction.id, amount: BigInt(amount) });
    } catch (err) {
      model.lastBid.delete(key);
      this.warn(`bid on a${key}`, err);
      return;
    }
    model.inflight.set(key, (model.inflight.get(key) ?? 0) + 1);
    // Timing, measured after the reducer call has been issued.
    const sendWall = this.now();
    const recv = model.recvAt.get(key);
    const closeMs = microsToMs(auction.closesAt);
    const opensMs = microsToMs(auction.opensAt);
    const left = closeMs !== undefined ? closeMs - sendWall : undefined;
    if (firstSend && left !== undefined) model.margins.push(left);
    const timing = [
      recv ? `sent ${(performance.now() - recv.mono).toFixed(1)} ms after recv` : "",
      recv && opensMs !== undefined ? `recv ${Math.round(recv.wall - opensMs)} ms after open` : "",
      left !== undefined ? `${Math.round(left)} ms left` : "",
    ]
      .filter(Boolean)
      .join(", ");
    this.log(
      `m${m.id} a${key} '${auction.letter}' bag ${bagTotal}: bid ${amount} (value ${delta.toFixed(2)}, ` +
        `${decision.reason}, ${source}${prev !== undefined ? `, was ${prev}` : ""}${timing ? `; ${timing}` : ""})`,
    );
    p.then(() => {
      model.confirmed.set(key, amount);
      model.uncertain.delete(key);
    })
      .catch((err: unknown) => {
        const late = isLateBidError(err);
        if (late) {
          // Count each auction once: a missed auction (no bid of ours live) or a late replacement.
          if (!model.closed.has(key)) {
            if (hadLive || (model.confirmed.get(key) ?? 0) > 0) model.lateReplace++;
            else model.lateFirst++;
          }
          model.closed.add(key);
        } else if (err instanceof Error && err.name === "UnknownCallResultError") {
          // It may or may not have run: re-send the desired amount once reconnected.
          model.uncertain.add(key);
        } else if (model.lastBid.get(key) === amount) {
          // Not live on the server: forget it so a later refresh re-sends.
          const live = model.confirmed.get(key);
          if (live === undefined) model.lastBid.delete(key);
          else model.lastBid.set(key, live);
          if (!isTransportError(err)) model.bidFailures.set(key, (model.bidFailures.get(key) ?? 0) + 1);
        }
        this.out.warn(
          `[${this.name}] m${m.id} a${key}: bid ${amount} refused: ${errMsg(err)}` +
            (late ? (hadLive ? " (earlier bid stands)" : " (auction missed)") : ""),
        );
      })
      .finally(() => {
        model.inflight.set(key, Math.max(0, (model.inflight.get(key) ?? 1) - 1));
      });
  }
}
