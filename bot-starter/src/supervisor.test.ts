// Connection readiness supervisor: deterministic tests with a fake clock.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_RESUBSCRIBE_ATTEMPTS,
  REPLAY_TIMEOUT_MS,
  RESUBSCRIBE_BASE_MS,
  Supervisor,
  WATCHDOG_MIN_MS,
  type Scheduler,
} from "./supervisor.js";

class FakeScheduler implements Scheduler {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  now(): number {
    return this.t;
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
  pending(): number {
    return this.timers.size;
  }
}

function make() {
  const sched = new FakeScheduler();
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
  sup.onDisconnect(c);
  sup.onAutomaticReconnect(c); // arms the replay timeout
  sched.advance(1000);
  sup.onApplied(c); // replay confirmed: timer must be cancelled
  sched.advance(REPLAY_TIMEOUT_MS - 1100);
  sup.onDisconnect(c); // second outage
  sched.advance(10 * REPLAY_TIMEOUT_MS);
  assert.equal(sup.ready, false);
  assert.equal(calls.online.at(-1), false);
  assert.deepEqual(calls.reconnect, [], "no stale timer acted");
  // No timer ever sets online=true: every true came from onApplied (2 here: initial and replay).
  assert.equal(calls.online.filter(Boolean).length, 2);
});

test("replay that never confirms leads to a fresh connection, never to readiness on a stale cache", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sup.onDisconnect(c);
  sup.onAutomaticReconnect(c);
  sched.advance(REPLAY_TIMEOUT_MS + 1);
  assert.equal(sup.ready, false);
  assert.equal(calls.reconnect.length, 1);
  assert.match(calls.reconnect[0], /replay/);
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
    sched.advance(60_000);
  }
  assert.equal(calls.resubscribe, MAX_RESUBSCRIBE_ATTEMPTS);
  assert.deepEqual(calls.reconnect, []);
  sup.onSubscriptionError(c, new Error("still failing"));
  assert.equal(calls.reconnect.length, 1);
  // Success resets the count.
  const c2 = sup.newConnection();
  sup.onApplied(c2);
  sup.onSubscriptionError(c2, new Error("once"));
  sched.advance(60_000);
  assert.equal(calls.reconnect.length, 1);
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

test("disconnect cancels pending timers; nothing fires afterwards", () => {
  const { sup, sched, calls } = make();
  const c = sup.newConnection();
  sup.onApplied(c);
  sup.onSubscriptionError(c, new Error("x"));
  assert.equal(sched.pending(), 1);
  sup.onDisconnect(c);
  assert.equal(sched.pending(), 0);
  sched.advance(60_000);
  assert.equal(calls.resubscribe, 0);
});
