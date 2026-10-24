// Targeted subscriptions: the bot's cache holds what it reads and nothing else.
//
// subscribeToAllTables put every row of the game in the client cache (about
// 260k auctions, 260k results, 260k archived top bids, 63k word plays on the
// finals morning) and streamed every row change of every match. The SDK's
// client-side indexes, including unique `find` by primary key, scan the
// whole table with a deep compare per row, so every `matchState.id.find`
// and `auction.id.find` the bot makes cost a scan of thousands to hundreds
// of thousands of rows. runningMatches alone, run twice per 250 ms tick,
// looks up the match row of each of our ~800 past seats: one core stayed
// pegged even in the lobby. Here the cache holds a few small groups of rows:
//
// - base (kept for the connection's life, scoped by its identity, or by
//   OBSERVE_BOT_ID in observer mode): our credential, the bot table, our rack
//   (view) and our lobby memberships.
// - seed (temporary): every seat we ever had, to find our recent matches. It
//   is dropped once the window is applied, which holds the seats that matter.
// - window (re-floored as matches pass): every row of our most recent
//   WINDOW_MATCHES matches and all later ones (match_state, auctions, auction
//   results, every seat at those tables), the lobbies we joined, and the
//   game-wide results of the last GAME_WINDOW_MS with their match rows. That
//   last part feeds the first-price clearing-price history
//   (bot.onAuctionResult), which learns from every first-price match, not
//   only ours; at connect it seeds that history from the same span instead
//   of from the whole archive.
//
// The window needs our bot id and seats, so it is subscribed once the base
// and the seed are applied. The bot is ready only when the window is applied.
// A re-floor subscribes the new window before dropping the old one; rows in
// both are reference-counted by the SDK, so nothing disappears in between
// and no insert callback fires twice. A reconnect replays the base and the
// window together; the window then reports ready again.

/** Our most recent matches kept in the window (a bot normally plays one at a time). */
export const WINDOW_MATCHES = 3;
/** Game-wide results kept for the first-price price history. */
export const GAME_WINDOW_MS = 15 * 60_000;
/**
 * Game-wide match rows reach this much further back, so a cached result of a
 * match that started earlier finds its type (onAuctionResult skips a result
 * whose match row is missing). A match has at most 98 auctions (the bag,
 * spacetimedb/src/letters.ts BAG_SIZE), so at the longest legal auction
 * (10 s, set_matchmaker_config) it lasts under 17 minutes.
 */
export const MATCH_LOOKBACK_MS = 30 * 60_000;
/** A window whose game floor moved less than this is not re-subscribed (unless our floor moved). */
export const REFLOOR_MIN_STEP_MS = 60_000;
/** While no match of ours is running, re-floor at least this often (index.ts tick). */
export const REFLOOR_IDLE_MS = 5 * 60_000;
/** Re-floors are at least this far apart (a failed one is not retried every tick). */
export const REFLOOR_RETRY_MS = 30_000;

/** Tables the bot reads. Anything else in a query is a regression (see subscriptions.test.ts). */
export const READ_TABLES = [
  "bot_credential",
  "bot",
  "my_rack",
  "match_participant",
  "lobby_member",
  "lobby",
  "match_state",
  "auction",
  "auction_result",
] as const;

export interface Floors {
  /** Lowest match id of ours in the window. */
  mine: bigint;
  /** Game-wide results from this time on (ms since the epoch). */
  gameSinceMs: number;
}

export interface BaseScope {
  /** Hex identity of this connection (no 0x). */
  identityHex: string;
  /** Observer mode: scope seats and lobby memberships to this bot instead of to our credential. */
  observeBotId?: bigint;
}

function hexLiteral(hex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`not a 32-byte identity: ${hex.length} chars`);
  return `0x${hex.toLowerCase()}`;
}

function timeLiteral(ms: number): string {
  return `'${new Date(ms).toISOString()}'`;
}

/** Rows of `table` (aliased `alias`) belonging to our bot: by credential, or by bot id when observing. */
function ourRows(scope: BaseScope, table: string, alias: string): string {
  if (scope.observeBotId !== undefined) return `SELECT * FROM ${table} WHERE bot_id = ${scope.observeBotId}`;
  const me = hexLiteral(scope.identityHex);
  return `SELECT ${alias}.* FROM bot_credential bc JOIN ${table} ${alias} ON bc.bot_id = ${alias}.bot_id WHERE bc.identity = ${me}`;
}

export function baseQueries(scope: BaseScope): string[] {
  return [
    `SELECT * FROM bot_credential WHERE identity = ${hexLiteral(scope.identityHex)}`,
    `SELECT * FROM bot`,
    `SELECT * FROM my_rack`,
    ourRows(scope, "lobby_member", "lm"),
  ];
}

export function seedQueries(scope: BaseScope): string[] {
  return [ourRows(scope, "match_participant", "mp")];
}

export function windowQueries(botId: bigint, floors: Floors): string[] {
  const mine = `mp.bot_id = ${botId} AND mp.match_id >= ${floors.mine}`;
  return [
    `SELECT ms.* FROM match_participant mp JOIN match_state ms ON mp.match_id = ms.id WHERE ${mine}`,
    `SELECT a.* FROM match_participant mp JOIN auction a ON mp.match_id = a.match_id WHERE ${mine}`,
    `SELECT r.* FROM match_participant mp JOIN auction_result r ON mp.match_id = r.match_id WHERE ${mine}`,
    `SELECT o.* FROM match_participant mp JOIN match_participant o ON mp.match_id = o.match_id WHERE ${mine}`,
    `SELECT l.* FROM lobby_member lm JOIN lobby l ON lm.lobby_id = l.id WHERE lm.bot_id = ${botId}`,
    // Game-wide, for the first-price price history.
    `SELECT * FROM match_state WHERE created_at >= ${timeLiteral(floors.gameSinceMs - MATCH_LOOKBACK_MS)}`,
    `SELECT * FROM auction_result WHERE closed_at >= ${timeLiteral(floors.gameSinceMs)}`,
  ];
}

/**
 * Floors from our seats (match ids of matches we sat in): the
 * WINDOW_MATCHES-th most recent of our matches, or 0 with fewer, and the
 * game-wide span ending now.
 */
export function windowFloors(seatMatchIds: Iterable<bigint>, nowMs: number): Floors {
  const ids = [...new Set(seatMatchIds)].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const mine = ids.length >= WINDOW_MATCHES ? ids[WINDOW_MATCHES - 1] : 0n;
  return { mine, gameSinceMs: nowMs - GAME_WINDOW_MS };
}

/** Worth a new window: our floor moved up, or the game floor moved by at least REFLOOR_MIN_STEP_MS. */
export function floorsMoved(cur: Floors, next: Floors): boolean {
  return next.mine > cur.mine || next.gameSinceMs - cur.gameSinceMs >= REFLOOR_MIN_STEP_MS;
}

// ---- the subscription state machine ----

export interface SubHandle {
  unsubscribe(): void;
  isActive(): boolean;
  isEnded(): boolean;
}

/** Subscribe `queries` as one handle on the connection. */
export type Subscriber = (
  queries: string[],
  onApplied: () => void,
  onError: (err: unknown) => void,
) => SubHandle;

export interface PlanHooks {
  /**
   * The base and the seed are applied (first time), or the base is replayed
   * after a reconnect. The caller resolves the bot id and calls openWindow
   * (at once, or after claiming a credential). With the window already open
   * (a replay) openWindow changes nothing.
   */
  onBaseApplied(): void;
  /** The window is applied (first time or replayed): everything the bot reads is cached. */
  onReady(): void;
  /** The base, the seed or the window failed or was removed: the caller resubscribes from scratch. */
  onError(err: unknown): void;
  log(msg: string): void;
}

interface Entry {
  handle: SubHandle | null;
  floors?: Floors;
}

type Slot = "base" | "seed" | "window" | "pending";

export class TargetedSubscription {
  private base: Entry | null = null;
  private seed: Entry | null = null;
  private window: Entry | null = null;
  /** A re-floored window waiting to be applied; the current one stays until then. */
  private pending: Entry | null = null;
  private botId: bigint | null = null;
  private stopped = false;
  /** Superseded by a resubscribe: report nothing, keep the handles until stop(). */
  private quiesced = false;
  private lastAttemptMs = -Infinity;

  constructor(
    private readonly subscribe: Subscriber,
    private readonly scope: BaseScope,
    private readonly hooks: PlanHooks,
  ) {}

  /** Subscribe the base and the seed. */
  start() {
    if (this.stopped || this.quiesced || this.base !== null) return;
    const baseApplied = () => {
      // First time: wait for both. A replay after the seed was dropped: the base alone.
      if (!this.base?.handle?.isActive()) return;
      if (this.seed !== null && !this.seed.handle?.isActive()) return;
      this.hooks.onBaseApplied();
    };
    this.add("base", baseQueries(this.scope), baseApplied);
    this.add("seed", seedQueries(this.scope), baseApplied);
  }

  /** Subscribe the window for `botId`. Does nothing if one is already open (a replayed base). */
  openWindow(botId: bigint, seatMatchIds: Iterable<bigint>, nowMs: number) {
    if (this.stopped || this.quiesced || this.window !== null) return;
    this.botId = botId;
    this.addWindow(botId, windowFloors(seatMatchIds, nowMs), "window");
  }

  /**
   * Move the window up (our newer matches, a later game-wide span). The old
   * window is dropped only once the new one is applied. Skipped while one is
   * pending, before the first window is applied, within REFLOOR_RETRY_MS of
   * the last attempt, or when the floors barely moved. True if one started.
   */
  refloor(seatMatchIds: Iterable<bigint>, nowMs: number): boolean {
    if (this.stopped || this.quiesced || this.botId === null || this.pending !== null) return false;
    if (!this.window?.handle?.isActive()) return false;
    if (nowMs - this.lastAttemptMs < REFLOOR_RETRY_MS) return false;
    const cur = this.window.floors!;
    const next = windowFloors(seatMatchIds, nowMs);
    if (next.mine < cur.mine) next.mine = cur.mine; // never move our floor down
    if (!floorsMoved(cur, next)) return false;
    this.lastAttemptMs = nowMs;
    this.addWindow(this.botId, next, "pending");
    return true;
  }

  /**
   * Report nothing from now on, but keep every handle (and its rows) until
   * stop(), a reconnect replay of it included: a resubscribe quiesces the old
   * plan and stops it once the new one is ready, so rows held by both never
   * leave the cache and their insert callbacks never fire a second time.
   */
  quiesce() {
    this.quiesced = true;
  }

  /** Drop every handle; callbacks that arrive later do nothing. */
  stop() {
    this.stopped = true;
    for (const e of [this.base, this.seed, this.window, this.pending]) if (e) drop(e.handle);
    this.base = this.seed = this.window = this.pending = null;
  }

  /** Floors of the current window (applied, or the first one on its way). */
  get floors(): Floors | undefined {
    return this.window?.floors;
  }

  private add(slot: Slot, queries: string[], onApplied: () => void, floors?: Floors): Entry {
    const entry: Entry = { handle: null, floors };
    this[slot] = entry;
    entry.handle = this.subscribe(
      queries,
      () => {
        if (this.retire(entry)) return;
        onApplied();
      },
      (err) => {
        if (this.stopped || this.quiesced || !this.holds(entry)) return;
        if (entry === this.pending) {
          // Not fatal: the current window still holds everything. The next re-floor tries again.
          this.pending = null;
          this.hooks.log(`re-floor failed (${err instanceof Error ? err.message : String(err)}); keeping the current window`);
          return;
        }
        // A required handle failed: this plan never reports ready again (a
        // later replay of its surviving window included). Its handles stay,
        // silent, so their rows overlap the resubscribe that replaces it.
        this.quiesced = true;
        this.hooks.onError(err);
      },
    );
    return entry;
  }

  private addWindow(botId: bigint, floors: Floors, slot: "window" | "pending") {
    const entry: Entry = this.add(
      slot,
      windowQueries(botId, floors),
      () => {
        if (entry === this.pending) {
          const old = this.window;
          this.window = entry;
          this.pending = null;
          if (old) drop(old.handle);
          this.hooks.log(
            `window re-floored: our matches from m${floors.mine}, game since ${new Date(floors.gameSinceMs).toISOString()}`,
          );
          return;
        }
        // Readiness waits for the rest of this message. A reconnect replay
        // reports every applied set first and the refused ones after it (SDK
        // 2.12 #applyReplayBatch), and a handle stays active across the drop,
        // so a base refused in the same replay is known only once the message
        // is done. The rows and their insert callbacks are already in place
        // by then; index.ts's onReady runs bot.tick at once, which refreshes
        // (and bids on) an auction that opened meanwhile. The check is on the
        // current window: a replay that also applies a pending re-floor
        // promotes it in the same message, and that must not cancel readiness.
        queueMicrotask(() => {
          const window = this.window;
          if (this.stopped || this.quiesced || window === null) return;
          // Ready needs the base too (credential, bot table, rack, lobby memberships).
          if (!this.base?.handle?.isActive() || !window.handle?.isActive()) return;
          // The seed did its job; the window holds the seats from our floor on.
          if (this.seed) {
            drop(this.seed.handle);
            this.seed = null;
          }
          this.hooks.onReady();
        });
      },
      floors,
    );
  }

  private holds(entry: Entry): boolean {
    return entry === this.base || entry === this.seed || entry === this.window || entry === this.pending;
  }

  /**
   * True if an applied handle must not report: one no longer wanted (stopped
   * plan, replaced window) unsubscribes itself; a quiesced plan's handle
   * stays subscribed, silent, until stop().
   */
  private retire(entry: Entry): boolean {
    if (this.stopped || !this.holds(entry)) {
      drop(entry.handle);
      return true;
    }
    return this.quiesced;
  }
}

/**
 * The plans of one connection: the current one, and the earlier attempts of a
 * resubscribe, kept quiesced (their rows stay cached) until the current one
 * is ready, then all stopped. Attempts that fail in a row all wait here, so
 * none is left subscribed when a later one succeeds.
 */
export class PlanChain {
  current: TargetedSubscription | null = null;
  private retired: TargetedSubscription[] = [];

  /** A new attempt replaces the current plan, which is quiesced and kept. */
  replace(next: TargetedSubscription) {
    if (this.current) {
      this.current.quiesce();
      this.retired.push(this.current);
    }
    this.current = next;
  }

  /** The current plan is ready: stop every earlier attempt. */
  ready() {
    for (const p of this.retired) p.stop();
    this.retired = [];
  }

  /** Earlier attempts not yet stopped. */
  get retiredCount(): number {
    return this.retired.length;
  }
}

function drop(handle: SubHandle | null) {
  if (!handle || !handle.isActive()) return; // not applied yet: it retires itself when it is
  try {
    handle.unsubscribe();
  } catch {
    // already unsubscribed
  }
}
