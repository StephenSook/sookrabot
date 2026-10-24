// Connection lifecycle: which connection object is current, and replacing it.
//
// index.ts builds each DbConnection through start() and reports its
// handshake here; the supervisor asks for replacements through replace().
// The object build() returns is kept from that moment, so a connection being
// replaced is disconnected at once, even while it is still connecting (the
// SDK then never completes its handshake, and stops its automatic
// reconnects). The supervisor retires the old id as the replacement begins,
// so a handshake that lands anyway is refused and disconnected. At most one
// connection object is ever left running: two would each hold a socket and a
// full subscription cache, and keep reconnecting on their own.

import type { Scheduler, Supervisor } from "./supervisor.js";

/** Retry delay when a connection fails and the SDK will not retry it. */
export const INITIAL_RETRY_MS = 5000;
/** Delay before building a new connection after dropping one ourselves. */
export const REPLACE_DELAY_MS = 1000;

export interface Disconnectable {
  disconnect(): void;
}

export interface LifecycleHooks<C extends Disconnectable> {
  /** Create a connection whose events report `id`. */
  build(id: number): C;
  /** The bot must stop acting on the connection it was using. */
  deactivate(): void;
  log(msg: string): void;
  warn(what: string, err: unknown): void;
}

export class ConnectionLifecycle<C extends Disconnectable> {
  /**
   * The object build() returned for the current id, from the moment it
   * exists (connecting or connected); null while a replacement is pending.
   */
  current: C | null = null;
  private restartPending = false;

  constructor(
    private readonly sup: Pick<Supervisor, "newConnection" | "conn">,
    private readonly hooks: LifecycleHooks<C>,
    private readonly sched: Pick<Scheduler, "setTimeout">,
  ) {}

  /** Build a connection for a fresh id, dropping any earlier object first. */
  start() {
    const id = this.sup.newConnection(); // pauses the bot; events from earlier ids are ignored from here on
    const old = this.current;
    this.current = null;
    this.drop(old);
    this.current = this.hooks.build(id);
  }

  /** The supervisor's reconnect hook: drop the current connection now (connecting or not) and build a new one shortly. */
  replace(why: string) {
    const old = this.current;
    this.current = null;
    this.hooks.deactivate();
    this.restartLater(`${why}; replacing the connection`, REPLACE_DELAY_MS);
    this.drop(old);
  }

  /** A connection completed its first handshake. False if it was superseded (it is then disconnected). */
  accept(conn: C, id: number): boolean {
    if (id === this.sup.conn) return true;
    this.drop(conn); // superseded while connecting
    return false;
  }

  /** Start a fresh connection after a delay (deduplicated). */
  restartLater(why: string, delayMs = INITIAL_RETRY_MS) {
    if (this.restartPending) return;
    this.restartPending = true;
    this.hooks.log(`${why}; new connection in ${delayMs} ms`);
    this.sched.setTimeout(() => {
      this.restartPending = false;
      this.start();
    }, delayMs);
  }

  private drop(conn: C | null) {
    try {
      conn?.disconnect();
    } catch (err) {
      this.hooks.warn("disconnect", err);
    }
  }
}
