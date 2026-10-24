// Connection readiness supervisor: deterministic tests with a fake clock.

import assert from "node:assert/strict";
import { test } from "node:test";
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
