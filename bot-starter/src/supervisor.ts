// Connection readiness supervisor.
//
// The bot may only act when the current DbConnection has a confirmed,
// applied subscription; otherwise its cache can be stale. This class owns
// that decision. index.ts reports connection events to it (each tagged with
// the id of the DbConnection that raised it) and it answers with hooks:
// pause or resume the bot, recreate the subscription, or replace the
// connection. Every subscription attempt (first, retry, replay) has a
// deadline, so the bot is never left offline with nothing armed to recover
// it. Timers are bound to the connection id and to an epoch that changes on
// every readiness transition, so a timer armed for an earlier outage or an
// earlier connection can never act later, and no timer ever marks the bot
// ready.

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface SupervisorHooks {
  /** Pause (false) or resume (true) bot decisions. */
  setOnline(online: boolean): void;
  /** Create a fresh subscription on the current connection. */
  resubscribe(): void;
  /** Drop the current connection and build a new one. */
  reconnect(reason: string): void;
  log(msg: string): void;
}

/**
 * Every subscription attempt must be applied or refused within this long, or
 * the connection is replaced: the first one on a new connection (connecting
 * included), each retry after a subscription error, and the SDK's replay
 * after an automatic reconnect. Each expiry in a row doubles the deadline, up
 * to SUBSCRIBE_TIMEOUT_MAX_MS, so a snapshot that is merely slow (the tables
 * grow all night) still gets through; an applied subscription resets it.
 */
export const SUBSCRIBE_TIMEOUT_MS = 10_000;
export const SUBSCRIBE_TIMEOUT_MAX_MS = 120_000;
/** After an automatic reconnect, wait this long for the subscription replay before replacing the connection. */
export const REPLAY_TIMEOUT_MS = SUBSCRIBE_TIMEOUT_MS;
/** Subscription retry backoff: base, doubling, capped. */
export const RESUBSCRIBE_BASE_MS = 1000;
export const RESUBSCRIBE_MAX_MS = 15_000;
/** Failed subscriptions in a row before the whole connection is replaced. */
export const MAX_RESUBSCRIBE_ATTEMPTS = 4;
/**
 * Watchdog: while one of our matches is running, an auction opens every
 * auction length, so silence for max(WATCHDOG_MIN_MS, WATCHDOG_AUCTIONS x
 * auction length) means the subscription is dead and the connection is replaced.
 */
export const WATCHDOG_MIN_MS = 15_000;
export const WATCHDOG_AUCTIONS = 10;

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class Supervisor {
  /** Id of the current DbConnection; events from older ones are ignored. */
  conn = 0;
  /** Changes on every readiness transition; stale timers check it (and conn) and do nothing. */
  epoch = 0;
  ready = false;
  lastAuctionAt = 0;
  private timer: unknown = null;
  private resubAttempts = 0;
  /** Subscription deadlines that expired in a row (each doubles the next one). */
  private expiries = 0;

  constructor(
    private readonly hooks: SupervisorHooks,
    private readonly sched: Scheduler = realScheduler,
  ) {}

  /** A new DbConnection is about to be built; returns the id its callbacks must report. */
  newConnection(): number {
    this.conn++;
    this.resubAttempts = 0;
    this.transition(false);
    // Covers connecting and the first subscription: neither may hang forever.
    this.armSubscribeDeadline("connecting");
    return this.conn;
  }

  /** Subscription applied (first time, after a resubscribe, or after a reconnect replay). */
  onApplied(conn: number) {
    if (conn !== this.conn) return;
    this.resubAttempts = 0;
    this.expiries = 0;
    this.lastAuctionAt = this.sched.now();
    this.transition(true);
  }

  onDisconnect(conn: number) {
    if (conn !== this.conn) return;
    this.transition(false);
  }

  /** The SDK reconnected; its subscription replay must confirm before the bot acts. */
  onAutomaticReconnect(conn: number) {
    if (conn !== this.conn) return;
    this.transition(false);
    this.armSubscribeDeadline("reconnect (subscription replay)");
  }

  onSubscriptionError(conn: number, err: unknown) {
    if (conn !== this.conn) return;
    this.transition(false);
    this.resubAttempts++;
    const msg = err instanceof Error ? err.message : String(err);
    if (this.resubAttempts > MAX_RESUBSCRIBE_ATTEMPTS) {
      this.hooks.reconnect(`subscription failed ${this.resubAttempts} times (${msg})`);
      return;
    }
    const delay = Math.min(RESUBSCRIBE_MAX_MS, RESUBSCRIBE_BASE_MS * 2 ** (this.resubAttempts - 1));
    this.hooks.log(`subscription error (${msg}); resubscribing in ${delay} ms`);
    const epoch = this.epoch;
    this.arm(delay, () => {
      if (conn !== this.conn || epoch !== this.epoch || this.ready) return;
      // Deadline first: if resubscribing fails at once, the transition it causes cancels it.
      this.armSubscribeDeadline("resubscribing");
      this.hooks.resubscribe();
    });
  }

  /** Any auction row arriving proves the subscription is alive. */
  noteAuctionEvent() {
    this.lastAuctionAt = this.sched.now();
  }

  /** Call periodically. Replaces the connection if a running match of ours has gone silent. */
  watchdog(conn: number, inRunningMatch: boolean, auctionMs: number) {
    if (conn !== this.conn || !this.ready || !inRunningMatch) return;
    const limit = Math.max(WATCHDOG_MIN_MS, WATCHDOG_AUCTIONS * (auctionMs > 0 ? auctionMs : 1000));
    if (this.sched.now() - this.lastAuctionAt > limit) {
      this.transition(false);
      this.hooks.reconnect(`no auction event for ${limit} ms during a running match`);
    }
  }

  /**
   * The bot found the connection unusable although events still arrive (a
   * reducer call never answered): pause and replace it. Ignored unless it is
   * the current, ready connection; otherwise a recovery is already under way.
   */
  reportStuck(conn: number, reason: string) {
    if (conn !== this.conn || !this.ready) return;
    this.transition(false);
    this.hooks.reconnect(reason);
  }

  /**
   * Replace the connection unless a subscription is applied on it, or this
   * attempt is superseded (any transition), within the deadline. Never makes
   * the bot ready: only onApplied does.
   */
  private armSubscribeDeadline(after: string) {
    const conn = this.conn;
    const epoch = this.epoch;
    const ms = Math.min(SUBSCRIBE_TIMEOUT_MAX_MS, SUBSCRIBE_TIMEOUT_MS * 2 ** Math.min(this.expiries, 10));
    this.arm(ms, () => {
      if (conn !== this.conn || epoch !== this.epoch || this.ready) return;
      this.expiries++;
      this.hooks.reconnect(`no subscription applied ${ms} ms after ${after}`);
    });
  }

  private transition(ready: boolean) {
    this.epoch++;
    this.clearTimer();
    this.ready = ready;
    this.hooks.setOnline(ready);
  }

  private clearTimer() {
    if (this.timer !== null) {
      this.sched.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(ms: number, fn: () => void) {
    this.clearTimer();
    const handle: unknown = this.sched.setTimeout(() => {
      // A stale timer must not forget the current one, which a later transition still has to clear.
      if (this.timer === handle) this.timer = null;
      fn();
    }, ms);
    this.timer = handle;
  }
}
