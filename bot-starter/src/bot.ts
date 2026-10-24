// SookraBot match logic: keeps a per-match model, values the rack after every
// change, bids from the 26-letter table, hoards, and flushes at the end.
//
// It talks to the database only through the narrow ConnLike interface, so the
// whole loop can be driven by a fake connection in tests. Every entry point
// is wrapped: an exception is logged once and the bot keeps playing.

import {
  type Counts,
  type Valuation,
  WordIndex,
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
  /** Server close time; compared with the local clock only for logging. */
  closesAt?: { microsSinceUnixEpoch: bigint };
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
    matchParticipant: { iter(): Iterable<ParticipantRow> };
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

/** In-flight words stop counting against the rack after this long. */
export const PENDING_TTL_MS = 3000;
/** A word refused this many times in a match is not submitted again. */
export const MAX_WORD_FAILURES = 3;
/** Log a valuation slower than this. */
export const SLOW_VALUATION_MS = 50;

interface PendingWord {
  counts: Counts;
  at: number;
}

interface MatchModel {
  valuation: Valuation | null;
  lastBid: Map<string, number>;
  /** Value and remaining auctions when the last bid on each auction was decided. */
  bidInfo: Map<string, { delta: number; bagTotal: number; reason: string }>;
  skipLogged: Set<string>;
  pending: Map<number, PendingWord>;
  nextPendingId: number;
  wordFailures: Map<string, number>;
  submitted: number;
  announced: boolean;
}

function newModel(): MatchModel {
  return {
    valuation: null,
    lastBid: new Map(),
    bidInfo: new Map(),
    skipLogged: new Set(),
    pending: new Map(),
    nextPendingId: 1,
    wordFailures: new Map(),
    submitted: 0,
    announced: false,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SookraBot {
  myBotId: bigint | null = null;
  /** Called with one record per auction result in our matches (for an offline log). */
  onRecord: ((rec: Record<string, unknown>) => void) | null = null;
  readonly models = new Map<string, MatchModel>();
  readonly fpHistory: PricePoint[] = [];
  private readonly scheduled = new Set<string>();
  private readonly lastWarn = new Map<string, number>();

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
    this.lastWarn.set(key, t);
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

  myParticipant(conn: ConnLike, matchId: bigint): ParticipantRow | undefined {
    if (this.myBotId === null) return undefined;
    for (const p of conn.db.matchParticipant.iter()) {
      if (p.matchId === matchId && p.botId === this.myBotId) return p;
    }
    return undefined;
  }

  /** Matches this bot is seated in that are still running. */
  runningMatches(conn: ConnLike): bigint[] {
    const out: bigint[] = [];
    if (this.myBotId === null) return out;
    for (const p of conn.db.matchParticipant.iter()) {
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

  /** Rack minus letters of words still in flight. */
  private effectiveCounts(model: MatchModel, raw: Counts): Counts {
    const t = this.now();
    const out = new Int32Array(raw);
    for (const [id, p] of model.pending) {
      if (t - p.at > PENDING_TTL_MS) {
        model.pending.delete(id);
        continue;
      }
      for (let i = 0; i < 26; i++) out[i] = Math.max(0, out[i] - p.counts[i]);
    }
    return out;
  }

  opponents(conn: ConnLike, matchId: bigint): Opponent[] {
    const out: Opponent[] = [];
    for (const p of conn.db.matchParticipant.iter()) {
      if (p.matchId !== matchId || p.botId === this.myBotId) continue;
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

  private valuation(model: MatchModel, counts: Counts, alpha: number): Valuation {
    const key = countsKey(counts);
    const cached = model.valuation;
    if (cached && cached.rackKey === key && cached.alpha === alpha) return cached;
    const v = valuate(this.index, counts, alpha);
    if (v.ms > SLOW_VALUATION_MS) {
      this.log(`slow valuation: ${v.ms.toFixed(1)} ms for ${key.length} tiles`);
    }
    model.valuation = v;
    return v;
  }

  // ---- events ----

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

  /** Re-check every running match (covers missed events and failed plays). */
  tick(conn: ConnLike) {
    this.guard("tick", () => {
      for (const id of this.runningMatches(conn)) this.scheduleRefresh(conn, id);
    });
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
        for (const p of conn.db.matchParticipant.iter()) {
          if (p.matchId !== r.matchId) continue;
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
          balances,
          scores,
        });
      }
    });
  }

  onMatchEnded(conn: ConnLike, matchId: bigint) {
    this.guard("match end", () => {
      const key = String(matchId);
      const model = this.models.get(key);
      const me = this.myParticipant(conn, matchId);
      if (me) {
        const scores: bigint[] = [];
        for (const p of conn.db.matchParticipant.iter()) {
          if (p.matchId === matchId) scores.push(p.score);
        }
        const rank = 1 + scores.filter((s) => s > me.score).length;
        this.log(
          `m${key} ended: score ${me.score}, rank ${rank}/${scores.length}, ` +
            `best ${scores.reduce((a, b) => (b > a ? b : a), 0n)}, words ${model?.submitted ?? 0}`,
        );
      }
      this.models.delete(key);
    });
  }

  // ---- the decision loop ----

  private logMatchStart(conn: ConnLike, m: MatchStateRow) {
    const opps = this.opponents(conn, m.id);
    const sims = opps.filter((o) => o.isSim).length;
    this.log(
      `m${m.id} start: ${opps.length + 1} bots (${opps.length - sims} real rivals, ${sims} sims), ` +
        `${m.auctionType.tag}, auction ${m.auctionDurationMs} ms, rack ${m.startingRackSize ?? "?"}, bag ${m.bagTotal}`,
    );
  }

  /** Value the rack, play any words due, then bid on the open auction. */
  refresh(conn: ConnLike, matchId: bigint) {
    if (this.myBotId === null) return;
    const m = conn.db.matchState.id.find(matchId);
    if (!m || m.status.tag !== "Running") return;
    const me = this.myParticipant(conn, matchId);
    if (!me) return;
    const model = this.modelFor(matchId);
    if (!model.announced) {
      model.announced = true;
      this.logMatchStart(conn, m);
    }
    const row = m.currentAuctionId !== undefined ? conn.db.auction.id.find(m.currentAuctionId) : undefined;
    const open = row && row.status.tag === "Open" && row.matchId === matchId ? row : undefined;
    const bagTotal = Number(m.bagTotal);
    const flush = open !== undefined && shouldFlush(bagTotal, Number(m.auctionDurationMs));
    const alpha = alphaFor(flush);
    const balance = Number(me.balance);

    let counts = this.effectiveCounts(model, this.rackCounts(conn, matchId));
    let val: Valuation | null = null;
    try {
      val = this.valuation(model, counts, alpha);
    } catch (err) {
      this.warn("valuation", err);
    }

    // Words first: a cashed word or a flush changes the rack the bid is valued on.
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

    if (open) this.placeBid(conn, model, m, open, balance, val, bagTotal);
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
    // Outside the flush, wait for earlier plays to land before choosing more.
    if (!flush && model.pending.size > 0) return 0;
    const words = chooseWords(this.index, { counts, cands: val.cands, myBalance: balance, flush }).filter(
      (w) => (model.wordFailures.get(w) ?? 0) < MAX_WORD_FAILURES,
    );
    for (const w of words) this.submitWord(conn, matchId, model, w, flush);
    return words.length;
  }

  private submitWord(conn: ConnLike, matchId: bigint, model: MatchModel, word: string, flush: boolean) {
    const id = model.nextPendingId++;
    model.pending.set(id, { counts: countsOf(word), at: this.now() });
    model.submitted++;
    this.log(`m${matchId}: play '${word}' (+${wordReward(word)}${flush ? ", flush" : ""})`);
    let p: Promise<unknown>;
    try {
      p = conn.reducers.submitWord({ matchId, word });
    } catch (err) {
      model.pending.delete(id);
      this.warn(`play '${word}'`, err);
      return;
    }
    p.catch((err: unknown) => {
      model.wordFailures.set(word, (model.wordFailures.get(word) ?? 0) + 1);
      model.submitted--;
      this.out.warn(`[${this.name}] m${matchId}: play '${word}' refused: ${errMsg(err)}`);
    }).finally(() => {
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
    val: Valuation | null,
    bagTotal: number,
  ) {
    const key = String(auction.id);
    const li = letterIndex(auction.letter);
    const delta = val && li >= 0 ? val.delta[li] : 0;
    let decision: BidDecision;
    try {
      decision = decideBid({
        letter: auction.letter,
        delta,
        bagTotal,
        auctionType: (m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey") as AuctionKind,
        myBalance: balance,
        opponents: this.opponents(conn, m.id),
        fpHistory: this.fpHistory,
      });
    } catch (err) {
      this.warn("decideBid", err);
      decision = { amount: 0, reason: "error" };
    }
    const amount = Number.isFinite(decision.amount) ? Math.max(0, Math.floor(decision.amount)) : 0;
    model.bidInfo.set(key, { delta, bagTotal, reason: decision.reason });
    const prev = model.lastBid.get(key);
    if (prev === amount) return;
    if (prev === undefined && amount === 0) {
      if (!model.skipLogged.has(key)) {
        model.skipLogged.add(key);
        this.log(`m${m.id} a${key} '${auction.letter}' bag ${bagTotal}: no bid (${decision.reason})`);
      }
      return;
    }
    model.lastBid.set(key, amount);
    // Time to close by the local clock (includes any clock skew); a value near
    // or below 0 explains "Auction closed" refusals.
    const closeUs = auction.closesAt?.microsSinceUnixEpoch;
    const left = closeUs !== undefined ? `, ${Math.round(Number(closeUs) / 1000 - this.now())} ms left` : "";
    this.log(
      `m${m.id} a${key} '${auction.letter}' bag ${bagTotal}: bid ${amount} ` +
        `(value ${delta.toFixed(2)}, ${decision.reason}${prev !== undefined ? `, was ${prev}` : ""}${left})`,
    );
    try {
      conn.reducers
        .submitBid({ auctionId: auction.id, amount: BigInt(amount) })
        .catch((err: unknown) => this.warn(`bid on a${key}`, err));
    } catch (err) {
      this.warn(`bid on a${key}`, err);
    }
  }
}
