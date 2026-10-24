// Connection readiness supervisor.
//
// The bot may only act when the current DbConnection has a confirmed,
// applied subscription; otherwise its cache can be stale. This class owns
// that decision. index.ts reports connection events to it (each tagged with
// the id of the DbConnection that raised it) and it answers with hooks:
// pause or resume the bot, recreate the subscription, or replace the
// connection. Timers are bound to an epoch that changes on every readiness
// transition, so a timer armed for an earlier outage can never act later,
// and no timer ever marks the bot ready.

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

/** After an automatic reconnect, wait this long for the subscription replay before replacing the connection. */
export const REPLAY_TIMEOUT_MS = 10_000;
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
  /** Changes on every readiness transition; stale timers check it and do nothing. */
  epoch = 0;
  ready = false;
  lastAuctionAt = 0;
  private timer: unknown = null;
  private resubAttempts = 0;

  constructor(
    private readonly hooks: SupervisorHooks,
    private readonly sched: Scheduler = realScheduler,
  ) {}

  /** A new DbConnection is about to be built; returns the id its callbacks must report. */
  newConnection(): number {
    this.conn++;
    this.resubAttempts = 0;
    this.transition(false);
    return this.conn;
  }

  /** Subscription applied (first time, after a resubscribe, or after a reconnect replay). */
  onApplied(conn: number) {
    if (conn !== this.conn) return;
    this.resubAttempts = 0;
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
    const epoch = this.epoch;
    this.arm(REPLAY_TIMEOUT_MS, () => {
      if (epoch === this.epoch && !this.ready) {
        this.hooks.reconnect(`no subscription replay ${REPLAY_TIMEOUT_MS} ms after reconnect`);
      }
    });
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
      if (epoch === this.epoch && !this.ready) this.hooks.resubscribe();
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

  private transition(ready: boolean) {
    this.epoch++;
    if (this.timer !== null) {
      this.sched.clearTimeout(this.timer);
      this.timer = null;
    }
    this.ready = ready;
    this.hooks.setOnline(ready);
  }

  private arm(ms: number, fn: () => void) {
    this.timer = this.sched.setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }
}
