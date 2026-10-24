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
  PlanChain,
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

test("every cached game-wide result has its match row cached, even for the longest legal match", () => {
  // A result is cached when it closed after the game floor. Its match was
  // created at most one full match earlier: BAG_SIZE auctions at the longest
  // legal auction length (spacetimedb/src: BAG_SIZE 98, 250..10000 ms).
  const longestMatchMs = 98 * 10_000;
  assert.ok(MATCH_LOOKBACK_MS >= longestMatchMs, `${MATCH_LOOKBACK_MS} < ${longestMatchMs}`);
  // The server constants this relies on.
  const letters = fs.readFileSync(new URL("../../spacetimedb/src/letters.ts", import.meta.url), "utf8");
  assert.match(letters, /export const BAG_SIZE = 98;/);
  const server = fs.readFileSync(new URL("../../spacetimedb/src/index.ts", import.meta.url), "utf8");
  assert.match(server, /auctionDurationMs > 10_000n/);
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

/** Let readiness (deferred to the end of the SDK message) run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("base and seed both applied, then the window: ready, and the seed is dropped", async () => {
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
  assert.deepEqual(events, ["base"], "ready waits for the rest of the SDK message");
  await settle();
  assert.deepEqual(events, ["base", "ready"]);
  assert.equal(seed.unsubscribes, 1);
  assert.equal(base.unsubscribes, 0);
});

test("a reconnect replay re-reports base and ready without opening a second window", async () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW);
  handles[2].apply();
  await settle();
  events.length = 0;
  // Replay: the SDK re-applies the retained handles (base and window; the seed was dropped).
  handles[0].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW); // what index.ts does on the replayed base
  handles[2].apply();
  await settle();
  assert.equal(handles.length, 3);
  assert.deepEqual(events, ["base", "ready"]);
});

test("re-floor: a new window replaces the old only once applied; small moves are skipped", async () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  assert.equal(plan.refloor([1n], NOW), false, "no window yet");
  plan.openWindow(9n, [10n, 20n, 30n], NOW);
  assert.equal(plan.refloor([10n, 20n, 30n, 40n], NOW), false, "window not applied yet");
  const old = handles[2];
  old.apply();
  await settle();
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
  await settle();
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

test("a reconnect replay with a re-floor pending reports ready once, on the promoted window", async () => {
  // Codex round 5: the replay applies the base, the old window and the
  // pending re-floor in one message; the pending one is promoted on the way.
  // Readiness must still come, or the bot sits offline until the supervisor
  // replaces the connection.
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [10n, 20n, 30n], NOW);
  handles[2].apply();
  await settle();
  assert.equal(plan.refloor([10n, 20n, 30n, 40n], NOW), true);
  events.length = 0;
  // The drop and the replay, before the re-floor was applied.
  handles[0].apply();
  handles[2].apply();
  handles[3].apply();
  await settle();
  assert.deepEqual(events, ["base", "log:window re-floored", "ready"]);
  assert.equal(plan.floors!.mine, 20n);
  assert.equal(handles[2].unsubscribes, 1, "the old window is dropped once the new one holds the rows");
});

test("a failed re-floor keeps the current window; a failed window or base asks for a resubscribe", async () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [10n, 20n, 30n], NOW);
  handles[2].apply();
  await settle();
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
  assert.deepEqual(events, [], "a failed plan reports one error; the resubscribe replaces it");

  const other = harness();
  other.plan.start();
  other.handles[0].apply();
  other.handles[0].fail(new Error("base gone"));
  assert.deepEqual(other.events, ["error:Error: base gone"]);
});

test("a replay that refuses the base reports no readiness, then or on any later replay", async () => {
  // Codex rounds 3 and 4. SDK 2.12 replays every retained handle in one
  // message: it reports the applied sets first, the refused ones after, and a
  // handle stays active across the drop. A replay that refuses the base and
  // re-applies the window must not mark the bot ready (not even for the rest
  // of that message: bootstrap would join a lobby, bids would go out without
  // the rack), and neither may a later replay of the window alone.
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW);
  handles[2].apply();
  await settle();
  assert.deepEqual(events, ["base", "ready"]);
  events.length = 0;
  // First replay: the window's apply, then the base's refusal, in one message.
  handles[2].apply();
  handles[0].fail(new Error("base replay refused"));
  await settle();
  assert.deepEqual(events, ["error:Error: base replay refused"]);
  events.length = 0;
  // A second drop cancelled the resubscribe; the next replay holds only the window.
  handles[2].apply();
  await settle();
  assert.deepEqual(events, [], "no readiness without the base");
  assert.equal(handles[2].unsubscribes, 0, "its rows stay for the resubscribe to overlap");
});

test("the window reports ready only while the base is applied", async () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW);
  handles[0].active = false; // the base dropped out underneath (no callback yet)
  handles[2].apply();
  await settle();
  assert.deepEqual(events, ["base"]);
});

test("stop drops every applied handle; late applies retire themselves and report nothing", async () => {
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
  await settle();
  assert.equal(handles.length, 2, "a stopped plan opens nothing");
  assert.deepEqual(events, []);
});

test("quiesce keeps applied handles (their rows) but reports nothing; stop then drops them", async () => {
  const { plan, handles, events } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW);
  handles[2].apply();
  await settle();
  events.length = 0;
  plan.quiesce();
  assert.deepEqual(handles.map((h) => h.unsubscribes), [0, 1, 0], "only the seed was dropped (by the window)");
  // A reconnect replay of a quiesced plan: it stays subscribed and reports nothing.
  handles[0].apply();
  handles[2].apply();
  await settle();
  assert.deepEqual(handles.map((h) => h.unsubscribes), [0, 1, 0]);
  handles[2].fail(new Error("gone"));
  assert.deepEqual(events, []);
  assert.equal(plan.refloor([1n, 2n, 3n, 4n], NOW + REFLOOR_RETRY_MS), false);
  plan.openWindow(9n, [1n, 2n, 3n, 4n], NOW);
  assert.equal(handles.length, 3, "a quiesced plan opens nothing");
  plan.stop();
  assert.deepEqual(handles.map((h) => h.unsubscribes), [1, 1, 0], "the failed window has nothing left to drop");
  plan.stop(); // idempotent
  assert.deepEqual(handles.map((h) => h.unsubscribes), [1, 1, 0]);
});

test("a reconnect replay during a resubscribe keeps the old window until the new one is applied", async () => {
  // Codex round 2: A's window applied, A's base failed, so B was started; the
  // connection dropped before B opened its window, and the replay re-applies
  // A's window next to B's base and seed. A's window must stay subscribed
  // until B's window is applied, or rows in both leave the cache and their
  // insert callbacks (fpHistory, auction log) fire again.
  const ops: string[] = [];
  const hs: FakeHandle[] = [];
  const chain = new PlanChain();
  const make = (name: string) => {
    let n = 0;
    const plan: TargetedSubscription = new TargetedSubscription(
      (queries, onApplied, onError) => {
        const label = `${name}:${["base", "seed", "window"][n++] ?? "refloor"}`;
        ops.push(`subscribe ${label}`);
        const h = new FakeHandle(queries, onApplied, onError);
        const unsub = h.unsubscribe.bind(h);
        h.unsubscribe = () => {
          ops.push(`unsubscribe ${label}`);
          unsub();
        };
        hs.push(h);
        return h;
      },
      SCOPE,
      {
        onBaseApplied: () => plan.openWindow(9n, [1n, 2n, 3n], NOW),
        onReady: () => chain.ready(),
        onError: () => {},
        log: () => {},
      },
    );
    return plan;
  };
  const a = make("A");
  chain.replace(a);
  a.start();
  hs[0].apply(); // A base
  hs[1].apply(); // A seed -> A window subscribed
  hs[2].apply(); // A window applied -> ready
  await settle();
  hs[0].fail(new Error("base removed")); // index.ts resubscribes
  const b = make("B");
  chain.replace(b);
  b.start(); // B base, B seed
  // Disconnect, then the replay: A's window, B's base and seed.
  hs[2].apply();
  hs[3].apply();
  hs[4].apply(); // B opens its window
  await settle();
  assert.ok(!ops.includes("unsubscribe A:window"), `A's window dropped early: ${ops.join(", ")}`);
  hs[5].apply(); // B's window applied: now A goes
  await settle();
  const iDrop = ops.indexOf("unsubscribe A:window");
  assert.ok(iDrop > ops.indexOf("subscribe B:window"), ops.join(", "));
  assert.deepEqual(
    hs.map((h) => h.active),
    [false, false, false, true, false, true],
    "B's base and window remain; A is gone; B's seed was dropped by its window",
  );
});

test("stop after quiesce drops the handles that were kept", async () => {
  const { plan, handles } = harness();
  plan.start();
  handles[0].apply();
  handles[1].apply();
  plan.openWindow(9n, [1n, 2n, 3n], NOW);
  handles[2].apply();
  await settle();
  plan.quiesce();
  assert.deepEqual(handles.map((h) => h.unsubscribes), [0, 1, 0]);
  plan.stop();
  assert.deepEqual(handles.map((h) => h.unsubscribes), [1, 1, 1]);
});

test("resubscribe chain: attempts that fail in a row are all dropped once one succeeds", async () => {
  const handles: FakeHandle[] = [];
  const chain = new PlanChain();
  const errors: string[] = [];
  const attempt = () => {
    const plan: TargetedSubscription = new TargetedSubscription(
      (queries, onApplied, onError) => {
        const h = new FakeHandle(queries, onApplied, onError);
        handles.push(h);
        return h;
      },
      SCOPE,
      {
        onBaseApplied: () => plan.openWindow(9n, [1n, 2n, 3n], NOW),
        onReady: () => chain.ready(),
        onError: (err) => errors.push(String(err)),
        log: () => {},
      },
    );
    chain.replace(plan);
    plan.start();
    const [base, seed] = handles.slice(-2);
    base.apply();
    seed.apply();
    return handles[handles.length - 1]; // the window
  };
  attempt().fail(new Error("A")); // A: base and seed applied, window refused
  attempt().fail(new Error("B")); // B: the same
  assert.deepEqual(errors, ["Error: A", "Error: B"]);
  assert.equal(chain.retiredCount, 1, "A waits for a ready plan (B is current)");
  const win = attempt(); // C
  assert.equal(chain.retiredCount, 2);
  assert.equal(handles.filter((h) => h.active).length, 6, "A's and B's base and seed are still cached");
  win.apply();
  await settle();
  assert.equal(chain.retiredCount, 0);
  const active = handles.filter((h) => h.active);
  assert.deepEqual(
    active.map((h) => h.queries),
    [baseQueries(SCOPE), windowQueries(9n, windowFloors([1n, 2n, 3n], NOW))],
    "only C's base and window remain (its seed is dropped by the window)",
  );
});

test("observer scope: seats and lobby memberships by bot id", () => {
  const { plan, handles } = harness({ identityHex: ME, observeBotId: 9n });
  plan.start();
  assert.ok(handles[0].queries.includes("SELECT * FROM lobby_member WHERE bot_id = 9"));
  assert.deepEqual(handles[1].queries, ["SELECT * FROM match_participant WHERE bot_id = 9"]);
});
