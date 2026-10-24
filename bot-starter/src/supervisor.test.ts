// Connection recovery: the readiness supervisor, the connection lifecycle that
// index.ts runs, and the SDK behaviour both rely on. Deterministic: a fake
// clock, fake connections, and for the SDK contract fake sockets with mocked
// timers (no network).

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setGlobalLogLevel } from "spacetimedb";
import { DbConnection, type DbConnectionBuilder } from "./module_bindings/index.js";
import {
  MAX_RESUBSCRIBE_ATTEMPTS,
  REPLAY_TIMEOUT_MS,
  RESUBSCRIBE_BASE_MS,
  RESUBSCRIBE_MAX_MS,
  SUBSCRIBE_TIMEOUT_MAX_MS,
  SUBSCRIBE_TIMEOUT_MS,
  Supervisor,
  WATCHDOG_MIN_MS,
  type Scheduler,
} from "./supervisor.js";
import { ConnectionLifecycle, INITIAL_RETRY_MS, REPLACE_DELAY_MS } from "./lifecycle.js";

type FakeTimer = { at: number; fn: () => void; cleared: boolean };

class FakeScheduler implements Scheduler {
  t = 0;
  /** Timers that fired although they had been cleared (leaky mode only). */
  staleFired = 0;
  private seq = 0;
  private timers = new Map<number, FakeTimer>();
  /** leaky: clearTimeout does not stop a timer, as if its callback were already on its way. */
  constructor(private readonly leaky = false) {}
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn, cleared: false });
    return id;
  }
  clearTimeout(handle: unknown): void {
    const timer = this.timers.get(handle as number);
    if (!timer) return;
    if (this.leaky) timer.cleared = true;
    else this.timers.delete(handle as number);
  }
  now(): number {
    return this.t;
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, FakeTimer] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      if (next[1].cleared) this.staleFired++;
      next[1].fn();
    }
    this.t = end;
  }
  /** Timers still due to fire (cleared ones excluded). */
  pending(): number {
    let n = 0;
    for (const timer of this.timers.values()) if (!timer.cleared) n++;
    return n;
  }
}

function make(sched = new FakeScheduler()) {
  const calls = { online: [] as boolean[], resubscribe: 0, reconnect: [] as string[] };
  const sup = new Supervisor(
    {
      setOnline: (b) => calls.online.push(b),
      resubscribe: () => calls.resubscribe++,
      reconnect: (why) => calls.reconnect.push(why),
      log: () => {},
    },
    sched,
  );
  return { sup, sched, calls };
}

test("only a subscription applied on the current connection makes the bot ready", () => {
  const { sup, calls } = make();
  const c1 = sup.newConnection();
  assert.equal(sup.ready, false);
  assert.equal(calls.online.at(-1), false);
  sup.onApplied(c1);
  assert.equal(sup.ready, true);
  assert.equal(calls.online.at(-1), true);
  const c2 = sup.newConnection();
  sup.onApplied(c1); // late callback from the old connection
  assert.equal(sup.ready, false);
  sup.onApplied(c2);
  assert.equal(sup.ready, true);
});

test("Codex repro: an old reconnect timer cannot resume during a later outage", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sup.onDisconnect(c, true); // the SDK scheduled a retry: arms the outage deadline
  sup.onAutomaticReconnect(c);
  sched.advance(1000);
  sup.onApplied(c); // replay confirmed: timer must be cancelled
  sched.advance(REPLAY_TIMEOUT_MS - 1100);
  sup.onDisconnect(c, false); // second outage; the SDK gave up, so index.ts builds a new connection itself
  sched.advance(10 * REPLAY_TIMEOUT_MS);
  assert.equal(sup.ready, false);
  assert.equal(calls.online.at(-1), false);
  assert.deepEqual(calls.reconnect, [], "no stale timer acted");
  // No timer ever sets online=true: every true came from onApplied (2 here: initial and replay).
  assert.equal(calls.online.filter(Boolean).length, 2);
  // With a retry scheduled, the later outage has its own deadline, counted from its own disconnect.
  const b = make();
  const cb = b.sup.newConnection();
  b.sup.onApplied(cb);
  b.sup.onDisconnect(cb, true);
  b.sup.onAutomaticReconnect(cb);
  b.sched.advance(1000);
  b.sup.onApplied(cb);
  b.sched.advance(REPLAY_TIMEOUT_MS - 1100); // t = 9,900
  b.sup.onDisconnect(cb, true);
  b.sched.advance(REPLAY_TIMEOUT_MS - 1); // past t = 10,000, when the cancelled deadline was due
  assert.deepEqual(b.calls.reconnect, []);
  b.sched.advance(1);
  assert.equal(b.calls.reconnect.length, 1);
  assert.equal(b.calls.online.filter(Boolean).length, 2);
});

test("replay that never confirms leads to a fresh connection, never to readiness on a stale cache", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sup.onDisconnect(c, true);
  sup.onAutomaticReconnect(c);
  sched.advance(REPLAY_TIMEOUT_MS + 1);
  assert.equal(sup.ready, false);
  assert.equal(calls.reconnect.length, 1);
  assert.match(calls.reconnect[0], /replay/);
});

test("Codex repro: a reconnect whose handshake never completes replaces the connection (held an hour)", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  // A ready socket drops and the SDK schedules a retry. The retry socket opens but the
  // handshake never completes, so the SDK never announces a reconnect: no onAutomaticReconnect.
  sup.onDisconnect(c, true);
  assert.equal(sup.ready, false);
  assert.equal(sched.pending(), 1, "a deadline is armed at the disconnect");
  sched.advance(SUBSCRIBE_TIMEOUT_MS - 1);
  assert.deepEqual(calls.reconnect, []);
  sched.advance(1);
  assert.equal(calls.reconnect.length, 1);
  assert.match(calls.reconnect[0], /disconnect/);
  sched.advance(3_603_000);
  assert.equal(calls.reconnect.length, 1, "one replacement requested, nothing else fires");
  assert.equal(sup.ready, false);
  assert.equal(calls.online.filter(Boolean).length, 1, "only the applied subscription made the bot ready");
});

test("the deadline from the disconnect also covers the replay: a late handshake never extends it", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sup.onDisconnect(c, true); // t = 0
  sched.advance(SUBSCRIBE_TIMEOUT_MS - 1000);
  sup.onAutomaticReconnect(c); // the handshake completes 1 s before the deadline
  sched.advance(999);
  assert.deepEqual(calls.reconnect, []);
  sched.advance(1);
  assert.equal(calls.reconnect.length, 1, "replaced one deadline after the disconnect, not after the handshake");
  assert.equal(sup.ready, false);
  // A replay that applies in time makes the bot ready and leaves nothing armed.
  const b = make();
  const cb = b.sup.newConnection();
  b.sup.onApplied(cb);
  b.sup.onDisconnect(cb, true);
  b.sched.advance(1500);
  b.sup.onAutomaticReconnect(cb);
  b.sched.advance(2000);
  b.sup.onApplied(cb);
  assert.equal(b.sup.ready, true);
  assert.equal(b.sched.pending(), 0);
  b.sched.advance(10 * SUBSCRIBE_TIMEOUT_MAX_MS);
  assert.deepEqual(b.calls.reconnect, []);
});

test("a connection that keeps dropping before its replay applies is replaced one deadline after the first drop", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sup.onDisconnect(c, true); // t = 0: first drop
  for (let i = 0; i < 4; i++) {
    sched.advance(1500);
    sup.onAutomaticReconnect(c); // handshake completes...
    sched.advance(500);
    sup.onDisconnect(c, true); // ...and the socket drops again before the replay applies
  }
  sched.advance(SUBSCRIBE_TIMEOUT_MS - 8000 - 1); // t = 9,999
  assert.deepEqual(calls.reconnect, []);
  sched.advance(1);
  assert.equal(calls.reconnect.length, 1, "drops and handshakes never push the deadline back");
  assert.equal(sup.ready, false);
  assert.equal(calls.online.filter(Boolean).length, 1);
});

test("a failed subscription is recreated with backoff, then the connection is replaced", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sup.onSubscriptionError(c, new Error("replay failed"));
  assert.equal(sup.ready, false);
  sched.advance(RESUBSCRIBE_BASE_MS - 1);
  assert.equal(calls.resubscribe, 0);
  sched.advance(1);
  assert.equal(calls.resubscribe, 1);
  for (let i = 1; i < MAX_RESUBSCRIBE_ATTEMPTS; i++) {
    sup.onSubscriptionError(c, new Error("again"));
    // Long enough for this retry to go out; its refusal arrives within the deadline.
    sched.advance(Math.min(RESUBSCRIBE_MAX_MS, RESUBSCRIBE_BASE_MS * 2 ** i));
  }
  assert.equal(calls.resubscribe, MAX_RESUBSCRIBE_ATTEMPTS);
  assert.deepEqual(calls.reconnect, []);
  sup.onSubscriptionError(c, new Error("still failing"));
  assert.equal(calls.reconnect.length, 1);
  // Success resets the count: one error on the next connection is retried, not escalated.
  const c2 = sup.newConnection();
  sup.onApplied(c2);
  sup.onSubscriptionError(c2, new Error("once"));
  assert.equal(calls.reconnect.length, 1);
  sched.advance(RESUBSCRIBE_BASE_MS);
  assert.equal(calls.resubscribe, MAX_RESUBSCRIBE_ATTEMPTS + 1);
  assert.equal(calls.reconnect.length, 1);
});

test("an initial subscription that is never answered replaces the connection; the deadline grows, then resets", () => {
  const { sup, sched, calls } = make();
  sup.newConnection();
  sched.advance(SUBSCRIBE_TIMEOUT_MS - 1);
  assert.deepEqual(calls.reconnect, []);
  sched.advance(1);
  assert.equal(calls.reconnect.length, 1);
  assert.match(calls.reconnect[0], /subscription/);
  assert.equal(sup.ready, false);
  assert.equal(sched.pending(), 0, "nothing else fires until the replacement exists");
  // The replacement waits twice as long (a big snapshot on a slow link must still fit), and is still bounded.
  sup.newConnection();
  sched.advance(2 * SUBSCRIBE_TIMEOUT_MS - 1);
  assert.equal(calls.reconnect.length, 1);
  sched.advance(1);
  assert.equal(calls.reconnect.length, 2);
  // Never longer than the cap, however many attempts in a row expire.
  for (let i = 0; i < 12; i++) {
    sup.newConnection();
    sched.advance(SUBSCRIBE_TIMEOUT_MAX_MS);
  }
  assert.equal(calls.reconnect.length, 14);
  assert.ok(!calls.online.includes(true), "no timer ever made the bot ready");
  // An applied subscription resets the deadline.
  const c = sup.newConnection();
  sup.onApplied(c);
  assert.equal(calls.online.filter(Boolean).length, 1);
  sup.onDisconnect(c, true);
  sup.onAutomaticReconnect(c);
  sched.advance(SUBSCRIBE_TIMEOUT_MS);
  assert.equal(calls.reconnect.length, 15);
});

test("Codex repro: a retried subscription that is never answered replaces the connection (held an hour)", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sup.onDisconnect(c, true);
  sup.onAutomaticReconnect(c);
  sup.onSubscriptionError(c, new Error("replay failed"));
  sched.advance(RESUBSCRIBE_BASE_MS);
  assert.equal(calls.resubscribe, 1, "retry sent; its answer never comes");
  sched.advance(SUBSCRIBE_TIMEOUT_MS - 1);
  assert.deepEqual(calls.reconnect, []);
  sched.advance(1);
  assert.equal(calls.reconnect.length, 1);
  assert.match(calls.reconnect[0], /resubscrib/);
  sched.advance(3_601_000);
  assert.equal(calls.reconnect.length, 1, "one replacement requested, nothing else fires");
  assert.equal(calls.resubscribe, 1);
  assert.equal(sup.ready, false);
  assert.equal(calls.online.filter(Boolean).length, 1, "only the applied subscription made the bot ready");
});

test("old-epoch timers that fire after a newer connection exists do nothing", () => {
  const sched = new FakeScheduler(true); // clearTimeout does not stop a timer
  const { sup, calls } = make(sched);
  const c1 = sup.newConnection(); // t=0: c1's subscription deadline
  sup.onApplied(c1);
  sup.onSubscriptionError(c1, new Error("x")); // c1's retry, due at 1 s
  sup.onDisconnect(c1, true); // c1's outage deadline (it also covers the replay)
  sup.onAutomaticReconnect(c1);
  sched.advance(SUBSCRIBE_TIMEOUT_MS / 2);
  const c2 = sup.newConnection(); // replaces c1; c2's own deadline
  // c1's deadlines fire while c2's subscription is still outstanding (the bot is not ready).
  sched.advance(SUBSCRIBE_TIMEOUT_MS / 2 + 2000);
  assert.deepEqual(calls.reconnect, [], "a stale deadline must not replace the newer connection");
  assert.equal(calls.resubscribe, 0, "a stale retry must not resubscribe");
  assert.equal(sup.ready, false);
  sup.onApplied(c2);
  sched.advance(10 * SUBSCRIBE_TIMEOUT_MAX_MS); // c2's own (now stale) deadline fires too
  assert.equal(sched.staleFired, 4, "c1 deadline, c1 retry, c1 outage deadline, c2 deadline");
  assert.deepEqual(calls.reconnect, []);
  assert.equal(calls.resubscribe, 0);
  assert.equal(sup.ready, true);
  assert.equal(calls.online.filter(Boolean).length, 2, "readiness only from the two applied subscriptions");
});

test("watchdog: no auction event for too long during a running match replaces the connection", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sched.advance(WATCHDOG_MIN_MS - 1);
  sup.watchdog(c, true, 1000);
  assert.deepEqual(calls.reconnect, []);
  sup.noteAuctionEvent();
  sched.advance(WATCHDOG_MIN_MS - 1);
  sup.watchdog(c, true, 1000);
  assert.deepEqual(calls.reconnect, [], "events keep it quiet");
  sched.advance(2);
  sup.watchdog(c, false, 1000);
  assert.deepEqual(calls.reconnect, [], "not in a running match: lobby waits are normal");
  sup.watchdog(c, true, 1000);
  assert.equal(calls.reconnect.length, 1);
  assert.equal(sup.ready, false);
  // Long auctions stretch the limit: 10 auctions of 5 s.
  const b = make();
  const cb = b.sup.newConnection();
  b.sup.onApplied(cb);
  b.sched.advance(40_000);
  b.sup.watchdog(cb, true, 5000);
  assert.deepEqual(b.calls.reconnect, []);
  b.sched.advance(10_001);
  b.sup.watchdog(cb, true, 5000);
  assert.equal(b.calls.reconnect.length, 1);
});

test("a stuck call reported on the ready connection replaces it; early or stale reports are ignored", () => {
  const { sup, calls } = make();
  const c1 = sup.newConnection();
  sup.reportStuck(c1, "early"); // not ready: this attempt's own deadline already covers it
  assert.deepEqual(calls.reconnect, []);
  const c2 = sup.newConnection();
  sup.onApplied(c2);
  sup.reportStuck(c1, "from the replaced connection");
  assert.deepEqual(calls.reconnect, []);
  assert.equal(sup.ready, true);
  sup.reportStuck(c2, "m1: play 'QINTARS' unanswered for 5250 ms");
  assert.equal(sup.ready, false);
  assert.equal(calls.online.at(-1), false, "paused before the connection is replaced");
  assert.deepEqual(calls.reconnect, ["m1: play 'QINTARS' unanswered for 5250 ms"]);
  sup.reportStuck(c2, "again");
  assert.equal(calls.reconnect.length, 1, "one replacement per outage");
});

test("disconnect cancels pending timers; with an SDK retry scheduled only the outage deadline remains", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sup.onSubscriptionError(c, new Error("x"));
  assert.equal(sched.pending(), 1);
  sup.onDisconnect(c, false); // no retry: index.ts builds the next connection itself
  assert.equal(sched.pending(), 0);
  sched.advance(60_000);
  assert.equal(calls.resubscribe, 0);
  assert.deepEqual(calls.reconnect, []);
  // With a retry scheduled, the resubscribe retry is cancelled (the socket is gone) and the
  // outage deadline takes its place.
  const b = make();
  const cb = b.sup.newConnection();
  b.sup.onApplied(cb);
  b.sup.onSubscriptionError(cb, new Error("x"));
  b.sup.onDisconnect(cb, true);
  assert.equal(b.sched.pending(), 1);
  b.sched.advance(60_000);
  assert.equal(b.calls.resubscribe, 0);
  assert.equal(b.calls.reconnect.length, 1);
});

test("asking for a replacement retires the old id at once: its late events are ignored", () => {
  for (const trigger of ["deadline", "subscription errors", "watchdog", "stuck call"] as const) {
    const { sup, sched, calls } = make();
    const a = sup.newConnection();
    if (trigger === "deadline") {
      sched.advance(SUBSCRIBE_TIMEOUT_MS);
    } else {
      sup.onApplied(a);
      if (trigger === "subscription errors") {
        for (let i = 0; i <= MAX_RESUBSCRIBE_ATTEMPTS; i++) sup.onSubscriptionError(a, new Error("x"));
      } else if (trigger === "watchdog") {
        sched.advance(WATCHDOG_MIN_MS + 1);
        sup.watchdog(a, true, 1000);
      } else {
        sup.reportStuck(a, "stuck");
      }
    }
    assert.equal(calls.reconnect.length, 1, trigger);
    assert.notEqual(sup.conn, a, `${trigger}: the old id is retired before the replacement is built`);
    const readyBefore = calls.online.filter(Boolean).length;
    // Late events from the old connection, inside the replacement delay:
    sup.onApplied(a);
    sup.onAutomaticReconnect(a);
    sup.onDisconnect(a, true);
    sup.onSubscriptionError(a, new Error("late"));
    sup.reportStuck(a, "late");
    assert.equal(sup.ready, false, trigger);
    assert.equal(calls.online.filter(Boolean).length, readyBefore, `${trigger}: never ready again on the old id`);
    assert.equal(sched.pending(), 0, `${trigger}: nothing armed for the old id`);
    assert.equal(calls.reconnect.length, 1, trigger);
    assert.equal(sup.newConnection(), a + 1, `${trigger}: the replacement takes the next id, none skipped`);
  }
});

// The connection lifecycle index.ts runs (lifecycle.ts), wired to the real
// supervisor exactly as there. Only the SDK connection and the clock are fakes.

class FakeConn {
  disconnects = 0;
  constructor(readonly id: number) {}
  disconnect() {
    this.disconnects++;
  }
  get running() {
    return this.disconnects === 0;
  }
}

function makeLifecycle() {
  const sched = new FakeScheduler();
  const built: FakeConn[] = [];
  const accepted: number[] = [];
  const sup = new Supervisor(
    { setOnline: () => {}, resubscribe: () => {}, reconnect: (why) => lifecycle.replace(why), log: () => {} },
    sched,
  );
  const lifecycle: ConnectionLifecycle<FakeConn> = new ConnectionLifecycle<FakeConn>(
    sup,
    {
      build: (id) => {
        const c = new FakeConn(id);
        built.push(c);
        return c;
      },
      deactivate: () => {},
      log: () => {},
      warn: () => {},
    },
    sched,
  );
  /** The SDK's onConnect for c: index.ts goes on with it only if the lifecycle accepts it. */
  const handshake = (c: FakeConn) => {
    if (lifecycle.accept(c, c.id)) accepted.push(c.id);
  };
  const running = () => built.filter((c) => c.running);
  return { sched, sup, lifecycle, built, accepted, handshake, running };
}

test("Codex repro: a connection replaced while still connecting is disconnected at once; its late handshake is refused", () => {
  const { sched, sup, lifecycle, built, accepted, handshake, running } = makeLifecycle();
  lifecycle.start(); // A at t = 0; its handshake does not arrive in time
  const a = built[0];
  sched.advance(SUBSCRIBE_TIMEOUT_MS); // t = 10,000: A's deadline expires and replacement begins
  assert.equal(a.disconnects, 1, "A is disconnected while still connecting");
  assert.notEqual(sup.conn, a.id);
  sched.advance(500);
  handshake(a); // t = 10,500: A's handshake lands inside the replacement delay anyway
  assert.deepEqual(accepted, [], "A is never accepted");
  assert.equal(built.length, 1);
  sched.advance(REPLACE_DELAY_MS - 500); // t = 11,000: B is built
  assert.equal(built.length, 2);
  const b = built[1];
  handshake(b);
  assert.deepEqual(accepted, [b.id]);
  assert.deepEqual(running(), [b], "exactly one connection object left running");
});

test("Codex repro: handshakes that never answer leave one connection object running, never a pile", () => {
  const { sched, lifecycle, built, running } = makeLifecycle();
  lifecycle.start();
  while (sched.now() < 32_000) {
    sched.advance(250);
    assert.ok(running().length <= 1, `at most one connection object running at ${sched.now()} ms`);
  }
  assert.equal(built.length, 3, "A at 0 ms, B at 11,000 ms, C at 32,000 ms (the deadline doubles)");
  assert.deepEqual(running(), [built[2]]);
});

test("a dropped connection whose retry never finishes its handshake is stopped and replaced, end to end", () => {
  const { sched, sup, lifecycle, built, accepted, handshake, running } = makeLifecycle();
  lifecycle.start();
  const a = built[0];
  handshake(a);
  sup.onApplied(a.id);
  assert.equal(sup.ready, true);
  sched.advance(60_000);
  sup.onDisconnect(a.id, true); // t = 60,000: the SDK retries; that socket never finishes the handshake
  sched.advance(SUBSCRIBE_TIMEOUT_MS - 1);
  assert.equal(a.disconnects, 0);
  sched.advance(1); // t = 70,000
  assert.equal(a.disconnects, 1, "A and its SDK retries are stopped");
  sched.advance(REPLACE_DELAY_MS); // t = 71,000
  assert.equal(built.length, 2);
  assert.deepEqual(running(), [built[1]]);
  handshake(built[1]);
  sup.onApplied(built[1].id);
  assert.equal(sup.ready, true);
  assert.deepEqual(accepted, [a.id, built[1].id]);
});

test("when the SDK gives up and index.ts restarts on its own, the old object is dropped before the next is built", () => {
  const { sched, lifecycle, built, handshake, running } = makeLifecycle();
  lifecycle.start();
  const a = built[0];
  handshake(a);
  lifecycle.restartLater("disconnected with no retry scheduled"); // what index.ts does then
  sched.advance(INITIAL_RETRY_MS);
  assert.equal(built.length, 2);
  assert.equal(a.disconnects, 1);
  assert.deepEqual(running(), [built[1]]);
});

// The SDK behaviour the recovery above relies on, pinned against the installed
// spacetimedb package (the dist build the bot runs): a real DbConnection over
// fake sockets, with mocked timers. Nothing touches the network: the socket
// factory below never opens one.

// The SDK logs every connection attempt with console.log ("INFO Connecting to
// SpacetimeDB WS..."), and this process's stdout is the stream the test runner
// reads its events from. With those lines on it the runner failed to parse
// that stream in 2 of 8 runs of this file ("Unable to deserialize cloned
// data"), turning the file red although no assertion had failed. Only SDK
// errors are logged here.
setGlobalLogLevel("error");

class FakeSocket {
  readonly protocol = "v2.bsatn.spacetimedb";
  readyState = 1; // OPEN
  closed = false;
  private onCloseFn: (ev: CloseEvent) => void = () => {};
  private onOpenFn: () => void = () => {};
  private onMessageFn: (msg: { data: Uint8Array }) => void = () => {};
  set onclose(h: (ev: CloseEvent) => void) {
    this.onCloseFn = h;
  }
  set onopen(h: () => void) {
    this.onOpenFn = h;
  }
  set onmessage(h: (msg: { data: Uint8Array }) => void) {
    this.onMessageFn = h;
  }
  set onerror(_h: (ev: ErrorEvent) => void) {}
  send(_msg: Uint8Array) {}
  close() {
    this.drop(1000);
  }
  open() {
    this.onOpenFn();
  }
  /** The server completes the handshake: ServerMessage::InitialConnection, BSATN encoded. */
  handshake() {
    const token = new TextEncoder().encode("test-token");
    const msg = new Uint8Array(1 + 32 + 16 + 4 + token.length);
    msg[0] = 0; // variant 0: InitialConnection
    msg[1] = 1; // identity: u256, little endian
    msg[33] = 2; // connection id: u128, little endian
    new DataView(msg.buffer).setUint32(49, token.length, true);
    msg.set(token, 53);
    this.onMessageFn({ data: msg });
  }
  /** The network drops the socket. */
  drop(code = 1006) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onCloseFn({ code, reason: "", wasClean: code === 1000 } as unknown as CloseEvent);
  }
}

/** Let the SDK's pending promise work run (setImmediate is not mocked). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function sdkConnection() {
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const openSocket = async () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const conn: DbConnection = DbConnection.builder()
    .withUri("ws://127.0.0.1:9") // never contacted: the socket factory is a fake
    .withDatabaseName("contract-test")
    .withWSFn(openSocket as unknown as Parameters<DbConnectionBuilder["withWSFn"]>[0])
    .withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 10_000 }) // as index.ts
    .onConnect((c) => events.push(c === conn ? "connect (the built object)" : "connect (another object)"))
    .onAutomaticReconnect(() => events.push("automaticReconnect"))
    .onConnectError((_ctx, _err, next) => events.push(`connectError retry=${next}`))
    .onDisconnect((_ctx, _err, next) => events.push(`disconnect retry=${next}`))
    .build();
  return { conn, sockets, events };
}

test("SDK contract: disconnect() while connecting stops the connection; a handshake that arrives anyway is never delivered", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Socket open, handshake not yet answered.
    const a = sdkConnection();
    await settle();
    assert.equal(a.sockets.length, 1);
    a.sockets[0].open();
    a.conn.disconnect();
    a.sockets[0].handshake();
    mock.timers.tick(3_600_000);
    await settle();
    assert.deepEqual(a.events, ["disconnect retry=undefined"], "no connect, no retry");
    assert.equal(a.sockets.length, 1);
    assert.ok(a.sockets[0].closed);
    // Socket not even created yet.
    const b = sdkConnection();
    b.conn.disconnect();
    await settle();
    b.sockets[0]?.open();
    b.sockets[0]?.handshake();
    mock.timers.tick(3_600_000);
    await settle();
    assert.deepEqual(b.events, ["disconnect retry=undefined"]);
    assert.ok(b.sockets.every((s) => s.closed));
  } finally {
    mock.timers.reset();
  }
});

test("SDK contract: onConnect receives the very object build() returned", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { conn, sockets, events } = sdkConnection();
    await settle();
    sockets[0].open();
    sockets[0].handshake();
    assert.deepEqual(events, ["connect (the built object)"]);
    conn.disconnect();
  } finally {
    mock.timers.reset();
  }
});

test("SDK contract: a drop reports a scheduled retry; a retry whose handshake never completes emits nothing, ever", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { conn, sockets, events } = sdkConnection();
    await settle();
    sockets[0].open();
    sockets[0].handshake();
    sockets[0].drop();
    assert.deepEqual(events, ["connect (the built object)", "disconnect retry=1"]);
    mock.timers.tick(10_000); // past the first retry delay (1000 to 1500 ms)
    await settle();
    assert.equal(sockets.length, 2, "the SDK opened a retry socket");
    sockets[1].open(); // ...whose handshake never completes
    mock.timers.tick(3_600_000);
    await settle();
    assert.deepEqual(events, ["connect (the built object)", "disconnect retry=1"], "no handshake timeout: silence");
    assert.equal(sockets.length, 2);
    conn.disconnect();
  } finally {
    mock.timers.reset();
  }
});
