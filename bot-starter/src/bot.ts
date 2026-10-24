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
  type PricePoint,
  type SimStrategy,
  FP_HISTORY_MAX,
  alphaFor,
  chooseWords,
  decideBid,
  shouldFlush,
} from "./strategy.js";

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

  constructor(
    private readonly index: WordIndex,
    private readonly name: string,
    private readonly out: Logger = console,
    private readonly now: () => number = Date.now,
  ) {}

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
    const v = valuate(this.index, counts, alpha);
    if (v.ms > SLOW_VALUATION_MS) {
      this.log(`slow valuation: ${v.ms.toFixed(1)} ms for ${v.rackKey.length} tiles`);
    }
    model.vals.set(key, v);
    while (model.vals.size > VAL_CACHE_MAX) {
      const oldest = model.vals.keys().next().value;
      if (oldest === undefined) break;
      model.vals.delete(oldest);
    }
    model.latest = v;
    return v;
  }

  /** Table lookup only: never touches the dictionary. */
  lookupDelta(matchId: bigint, counts: Counts, alpha: number, letter: string): { delta: number; source: string } {
    const model = this.modelFor(matchId);
    const li = letterIndex(letter);
    if (li < 0) return { delta: 0, source: "bad-letter" };
    const rk = countsKey(counts);
    const exact = model.vals.get(`${rk}|${alpha}`);
    if (exact) return { delta: exact.delta[li], source: "table" };
    for (const v of model.vals.values()) {
      if (v.rackKey === rk) return { delta: v.delta[li], source: "table-alpha" };
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
      const alpha = alphaFor(shouldFlush(bagTotal, Number(m.auctionDurationMs)));
      const counts = this.effectiveCounts(model, this.rackCounts(conn, a.matchId));
      const { delta, source } = this.lookupDelta(a.matchId, counts, alpha, a.letter);
      this.placeBid(conn, model, m, a, Number(me.balance), delta, bagTotal, source, this.opponentsFrom(conn, rows));
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
    const nextAlpha = alphaFor(shouldFlush(bagTotal - 1, durationMs));
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
          if (this.fpHistory.length > 26 * FP_HISTORY_MAX) this.fpHistory.shift();
        }
      }
      const model = this.models.get(String(r.matchId));
      if (!model) return;
      const mine = model.lastBid.get(String(r.auctionId));
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
    const flush = open !== undefined && shouldFlush(bagTotal, durationMs);
    const alpha = alphaFor(flush);
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
        played = this.playWords(conn, matchId, model, counts, val, balance, flush);
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
      this.placeBid(
        conn, model, m, open, balance, li >= 0 ? val.delta[li] : 0, bagTotal, "table",
        this.opponentsFrom(conn, rows),
      );
      this.schedulePrecompute(conn, matchId, open.letter, bagTotal, durationMs);
    }
  }

  private playWords(
    conn: ConnLike,
    matchId: bigint,
    model: MatchModel,
    counts: Counts,
    val: Valuation,
    balance: number,
    flush: boolean,
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
  ) {
    const key = String(auction.id);
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
