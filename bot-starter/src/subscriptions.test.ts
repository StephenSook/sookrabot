// Targeted subscriptions: the queries stay narrow, and the base / seed /
// window / re-floor state machine behaves through applies, replays, errors
// and stops. A fake subscriber stands in for the SDK (no network).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import {
  GAME_WINDOW_MS,
  MATCH_LOOKBACK_MS,
  READ_TABLES,
  REFLOOR_MIN_STEP_MS,
  REFLOOR_RETRY_MS,
  TargetedSubscription,
  WINDOW_MATCHES,
  baseQueries,
  seedQueries,
  windowFloors,
  windowQueries,
  type BaseScope,
  type SubHandle,
} from "./subscriptions.js";

const ME = "ab".repeat(32);
const SCOPE: BaseScope = { identityHex: ME };
const NOW = Date.parse("2026-10-24T20:00:00Z");

/** Table names a query reads (FROM and JOIN targets). */
function tablesOf(sql: string): string[] {
  return [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]);
}

/** Every table and view the generated bindings know (one *_table.ts file each). */
function allTables(): string[] {
  const dir = new URL("./module_bindings/", import.meta.url);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith("_table.ts"))
    .map((f) => f.slice(0, -"_table.ts".length));
}

function everyQuery(scope: BaseScope): string[] {
  return [
    ...baseQueries(scope),
    ...seedQueries(scope),
    ...windowQueries(9n, windowFloors([10n, 20n, 30n, 40n], NOW)),
  ];
}

test("queries read only the tables the bot uses, a strict subset of the schema", () => {
  const schema = allTables();
  assert.ok(schema.length >= 20, `bindings list ${schema.length} tables`);
  for (const scope of [SCOPE, { identityHex: ME, observeBotId: 9n }]) {
    const read = new Set(everyQuery(scope).flatMap(tablesOf));
    for (const t of read) {
      assert.ok((READ_TABLES as readonly string[]).includes(t), `unexpected table ${t}`);
      assert.ok(schema.includes(t), `${t} is not in the bindings`);
    }
    assert.ok(read.size < schema.length, "subscribes to every table");
    for (const big of ["auction_top_bid_archive", "word_play", "bot_stats", "tournament", "visible_auction_top_bids"]) {
      assert.ok(!read.has(big), `${big} subscribed`);
    }
  }
});

test("every query on a growing table is filtered", () => {
  const growing = new Set(["auction", "auction_result", "match_state", "match_participant", "lobby", "lobby_member"]);
  for (const scope of [SCOPE, { identityHex: ME, observeBotId: 9n }]) {
    for (const q of everyQuery(scope)) {
      if (tablesOf(q).some((t) => growing.has(t))) assert.match(q, / WHERE /, q);
    }
  }
  // The only unfiltered queries are the small bot table and our own rack view.
  const unfiltered = everyQuery(SCOPE).filter((q) => !q.includes(" WHERE "));
  assert.deepEqual(unfiltered.sort(), ["SELECT * FROM bot", "SELECT * FROM my_rack"]);
});

test("queries scope to our identity, or to the observed bot id", () => {
  for (const q of [...baseQueries(SCOPE), ...seedQueries(SCOPE)].filter((q) => q.includes("JOIN"))) {
    assert.ok(q.includes(`bc.identity = 0x${ME}`), q);
  }
  const obs = [...baseQueries({ identityHex: ME, observeBotId: 9n }), ...seedQueries({ identityHex: ME, observeBotId: 9n })];
  assert.ok(obs.includes("SELECT * FROM match_participant WHERE bot_id = 9"));
  assert.ok(obs.includes("SELECT * FROM lobby_member WHERE bot_id = 9"));
  assert.throws(() => baseQueries({ identityHex: "zz" }), /32-byte identity/);
  const w = windowQueries(9n, { mine: 3800n, gameSinceMs: NOW - GAME_WINDOW_MS });
  assert.ok(w.every((q) => !q.includes("mp.") || q.includes("mp.bot_id = 9 AND mp.match_id >= 3800")));
  assert.ok(w.includes(`SELECT * FROM auction_result WHERE closed_at >= '${new Date(NOW - GAME_WINDOW_MS).toISOString()}'`));
  assert.ok(
    w.includes(
      `SELECT * FROM match_state WHERE created_at >= '${new Date(NOW - GAME_WINDOW_MS - MATCH_LOOKBACK_MS).toISOString()}'`,
    ),
  );
});

test("window floor: our WINDOW_MATCHES-th most recent match, 0 with fewer", () => {
  assert.equal(WINDOW_MATCHES, 3);
  assert.equal(windowFloors([5n, 40n, 7n, 40n, 30n, 12n], NOW).mine, 12n);
  assert.equal(windowFloors([5n, 40n], NOW).mine, 0n);
  assert.equal(windowFloors([], NOW).mine, 0n);
  assert.equal(windowFloors([1n], NOW).gameSinceMs, NOW - GAME_WINDOW_MS);
});

// ---- the state machine ----

class FakeHandle implements SubHandle {
  active = false;
  ended = false;
  unsubscribes = 0;
  constructor(
    readonly queries: string[],
    private readonly applied: () => void,
    private readonly errored: (err: unknown) => void,
  ) {}
  /** The SDK marks the handle active, then runs the callback (first apply or a replay). */
  apply() {
    this.active = true;
    this.applied();
  }
  fail(err: unknown) {
    this.active = false;
    this.ended = true;
    this.errored(err);
  }
  unsubscribe() {
    if (this.unsubscribes++ > 0) throw new Error("Unsubscribe has already been called");
    this.active = false;
    this.ended = true;
  }
  isActive() {
    return this.active;
  }
  isEnded() {
    return this.ended;
  }
}

function harness(scope: BaseScope = SCOPE) {
  const handles: FakeHandle[] = [];
  const events: string[] = [];
  const plan = new TargetedSubscription(
    (queries, onApplied, onError) => {
      const h = new FakeHandle(queries, onApplied, onError);
      handles.push(h);
      return h;
    },
    scope,
    {
      onBaseApplied: () => events.push("base"),
      onReady: () => events.push("ready"),
      onError: (err) => events.push(`error:${String(err)}`),
      log: (msg) => events.push(`log:${msg.split(":")[0]}`),
    },
  );
  return { plan, handles, events };
}

test("base and seed both applied, then the window: ready, and the seed is dropped", () => {
  const { plan, handles, events } = harness();
  plan.start();
  assert.equal(handles.length, 2);
  const [base, seed] = handles;
  assert.deepEqual(base.queries, baseQueries(SCOPE));
  assert.deepEqual(seed.queries, seedQueries(SCOPE));
  base.apply();
  assert.deepEqual(events, [], "the base alone has no seats to floor the window on");
  seed.apply();
  assert.deepEqual(events, ["base"]);
  plan.openWindow(9n, [100n, 90n, 80n, 70n], NOW);
  assert.equal(handles.length, 3);
  const win = handles[2];
  assert.deepEqual(plan.floors, { mine: 80n, gameSinceMs: NOW - GAME_WINDOW_MS });
  assert.deepEqual(win.queries, windowQueries(9n, plan.floors!));
  assert.equal(seed.unsubscribes, 0, "the seed stays until the window holds the seats");
  win.apply();
  assert.deepEqual(events, ["base", "ready"]);
  assert.equal(seed.unsubscribes, 1);
  assert.equal(base.unsubscribes, 0);
});

test("a reconnect replay re-reports base and ready without opening a second window", () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW);
  handles[2].apply();
  events.length = 0;
  // Replay: the SDK re-applies the retained handles (base and window; the seed was dropped).
  handles[0].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW); // what index.ts does on the replayed base
  handles[2].apply();
  assert.equal(handles.length, 3);
  assert.deepEqual(events, ["base", "ready"]);
});

test("re-floor: a new window replaces the old only once applied; small moves are skipped", () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  assert.equal(plan.refloor([1n], NOW), false, "no window yet");
  plan.openWindow(9n, [10n, 20n, 30n], NOW);
  assert.equal(plan.refloor([10n, 20n, 30n, 40n], NOW), false, "window not applied yet");
  const old = handles[2];
  old.apply();
  events.length = 0;

  // Same seats, game floor moved too little: nothing to do.
  assert.equal(plan.refloor([10n, 20n, 30n], NOW + REFLOOR_MIN_STEP_MS - 1), false);
  // A new match of ours moved our floor up.
  const t1 = NOW + 1000;
  assert.equal(plan.refloor([10n, 20n, 30n, 40n], t1), true);
  assert.equal(handles.length, 4);
  const next = handles[3];
  assert.deepEqual(next.queries, windowQueries(9n, { mine: 20n, gameSinceMs: t1 - GAME_WINDOW_MS }));
  assert.equal(plan.floors!.mine, 10n, "the old window stays current until the new one is applied");
  assert.equal(plan.refloor([10n, 20n, 30n, 40n, 50n], t1 + REFLOOR_RETRY_MS), false, "one re-floor at a time");
  next.apply();
  assert.equal(old.unsubscribes, 1);
  assert.equal(plan.floors!.mine, 20n);
  assert.deepEqual(events, ["log:window re-floored"], "a re-floor is not a new readiness");

  // Too soon after the last attempt, even with a moved floor.
  assert.equal(plan.refloor([10n, 20n, 30n, 40n, 50n], t1 + REFLOOR_RETRY_MS - 1), false);
  // Our floor never moves down (seats outside the window are no longer cached).
  const t2 = t1 + REFLOOR_RETRY_MS + REFLOOR_MIN_STEP_MS;
  assert.equal(plan.refloor([30n], t2), true);
  assert.equal(handles[4].queries[0].includes("mp.match_id >= 20"), true);
});

test("a failed re-floor keeps the current window; a failed window or base asks for a resubscribe", () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [10n, 20n, 30n], NOW);
  handles[2].apply();
  events.length = 0;
  assert.equal(plan.refloor([10n, 20n, 30n, 40n], NOW), true);
  handles[3].fail(new Error("bad query"));
  assert.deepEqual(events, ["log:re-floor failed (bad query); keeping the current window"]);
  assert.equal(handles[2].unsubscribes, 0);
  assert.equal(plan.floors!.mine, 10n);
  assert.equal(plan.refloor([10n, 20n, 30n, 40n], NOW + REFLOOR_RETRY_MS), true, "tried again later");
  events.length = 0;
  handles[2].fail(new Error("removed"));
  assert.deepEqual(events, ["error:Error: removed"]);
  events.length = 0;
  handles[0].fail(new Error("base gone"));
  assert.deepEqual(events, ["error:Error: base gone"]);
});

test("stop drops every applied handle; late applies retire themselves and report nothing", () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  plan.stop();
  assert.equal(handles[0].unsubscribes, 1);
  assert.equal(handles[1].unsubscribes, 0, "not applied yet");
  handles[1].apply(); // the seed lands after the stop
  assert.equal(handles[1].unsubscribes, 1);
  assert.deepEqual(events, []);
  handles[1].fail(new Error("late"));
  plan.openWindow(9n, [1n], NOW);
  assert.equal(handles.length, 2, "a stopped plan opens nothing");
  assert.deepEqual(events, []);
});

test("quiesce keeps applied handles (their rows) but reports nothing; stop then drops them", () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW);
  handles[2].apply();
  events.length = 0;
  plan.quiesce();
  assert.deepEqual(handles.map((h) => h.unsubscribes), [0, 1, 0], "only the seed was dropped (by the window)");
  // A replay re-applies everything in one batch (the new plan's rows included): the old base retires.
  handles[0].apply();
  assert.equal(handles[0].unsubscribes, 1);
  handles[2].fail(new Error("gone"));
  assert.deepEqual(events, []);
  assert.equal(plan.refloor([1n, 2n, 3n, 4n], NOW + REFLOOR_RETRY_MS), false);
  plan.stop();
  assert.deepEqual(handles.map((h) => h.unsubscribes), [1, 1, 0], "the failed window has nothing left to drop");
  plan.stop(); // idempotent
  assert.deepEqual(handles.map((h) => h.unsubscribes), [1, 1, 0]);
});

test("stop after quiesce drops the handles that were kept", () => {
  const { plan, handles } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW);
  handles[2].apply();
  plan.quiesce();
  assert.deepEqual(handles.map((h) => h.unsubscribes), [0, 1, 0]);
  plan.stop();
  assert.deepEqual(handles.map((h) => h.unsubscribes), [1, 1, 1]);
});

test("observer scope: seats and lobby memberships by bot id", () => {
  const { plan, handles } = harness({ identityHex: ME, observeBotId: 9n });
  plan.start();
  assert.ok(handles[0].queries.includes("SELECT * FROM lobby_member WHERE bot_id = 9"));
  assert.deepEqual(handles[1].queries, ["SELECT * FROM match_participant WHERE bot_id = 9"]);
});
