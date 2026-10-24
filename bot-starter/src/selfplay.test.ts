// Checks for the self-play harness (selfplay.ts). Run with `npm test`.
//
// The harness must test the live bot: a variant is DEFAULT_POLICY with named
// constants changed and reaches SookraBot only through its constructor, so
// "head" is the live bot and a variant that restates every default plays the
// same matches. The few matches here are short (one process, a few seconds).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  POLICY_KEYS,
  RULES,
  type Row,
  compare,
  parseField,
  parseVariant,
  pricePaid,
  readRows,
  shardRange,
  summarize,
} from "./selfplay.js";
import { DEFAULT_POLICY } from "./strategy.js";

/** A row with what may differ between equal runs (wall time) or variants (the name) blanked. */
const content = (r: Row) => JSON.stringify({ ...r, ms: 0, variant: "" });

test("variants: head is DEFAULT_POLICY; NAME=value overrides that strategy.ts constant and nothing else", () => {
  const head = parseVariant("head");
  assert.equal(head.policy, DEFAULT_POLICY);
  assert.deepEqual(head.overrides, {});
  const v = parseVariant("PACED_KAPPA=4.5+pace_min=0.6");
  assert.deepEqual(v.overrides, { PACED_KAPPA: 4.5, PACE_MIN: 0.6 });
  assert.deepEqual(v.policy, { ...DEFAULT_POLICY, PACED_KAPPA: 4.5, PACE_MIN: 0.6 });
  assert.ok(Object.isFrozen(v.policy));
  assert.equal(DEFAULT_POLICY.PACED_KAPPA, 4, "the live policy is untouched");
  assert.deepEqual(parseVariant("CASH_MIN_LEN=99+HOLD_MIN_REAL_RIVALS=99").overrides, { CASH_MIN_LEN: 99, HOLD_MIN_REAL_RIVALS: 99 });
  assert.equal(parseVariant("FP_QUANTILE=1e-1").policy.FP_QUANTILE, 0.1);
  for (const bad of [
    "kappa:4.25", "pace:0.5:0.5:3:4", "cashlen:99", "hooked", "NOPE=1", "toString=1", "KAPPA=", "KAPPA=abc", "KAPPA=4+KAPPA=5",
    "CASH_MIN_LEN=7.5", "PACE_MIN=-1", "FP_QUANTILE=1.5", "FP_QUANTILE=0", "KAPPA=Infinity", "head+KAPPA=4",
  ]) {
    assert.throws(() => parseVariant(bad), Error, bad);
  }
});

test("variants: every policy knob can be named, and restating all of them is head", () => {
  assert.deepEqual([...POLICY_KEYS].sort(), Object.keys(DEFAULT_POLICY).sort());
  const all = parseVariant(POLICY_KEYS.map((k) => `${k}=${DEFAULT_POLICY[k]}`).join("+"));
  assert.deepEqual(all.policy, DEFAULT_POLICY);
  assert.equal(Object.keys(all.overrides).length, POLICY_KEYS.length);
});

test("fields: rack awareness, the auction rule, rival shading and warm history are part of the field", () => {
  assert.deepEqual(parseField("ar2"), {
    name: "ar2", base: "ar2", rho: undefined, env: { auction: "Vickrey", shade: 1 }, warm: false,
  });
  assert.deepEqual(parseField("ar6@0.9,fp,shade=0.8,warm"), {
    name: "ar6@0.9,fp,shade=0.8,warm", base: "ar6", rho: 0.9, env: { auction: "FirstPrice", shade: 0.8 }, warm: true,
  });
  for (const size of [2, 3, 4, 5, 6, 7, 8]) assert.equal(parseField(`ar${size}`).base, `ar${size}`);
  for (const bad of ["nope", "ar9", "ar6@1", "ar6@", "ar6@0.5@0.5", "ar6,xx", "ar6,shade=0", "ar6,shade=", "ar6,warm"]) {
    assert.throws(() => parseField(bad), Error, bad);
  }
});

test("auction close: first price pays the top bid, Vickrey the best other bid or 1 alone (game.ts closeAuction)", () => {
  assert.equal(pricePaid("FirstPrice", 9, [4, 0, 7]), 9);
  assert.equal(pricePaid("FirstPrice", 9, []), 9);
  assert.equal(pricePaid("Vickrey", 9, [4, 0, 7]), 7);
  assert.equal(pricePaid("Vickrey", 9, [9, 2]), 9, "a tie pays the tied amount");
  assert.equal(pricePaid("Vickrey", 9, [0, 0]), 1);
  assert.equal(pricePaid("Vickrey", 1, []), 1);
});

test("the harness's game constants are the module's (letters.ts DEFAULT_BAG, game.ts balance, rack and reserve)", () => {
  const src = (f: string) => fs.readFileSync(new URL(`../../spacetimedb/src/${f}`, import.meta.url), "utf8");
  const letters = src("letters.ts");
  const bag = Object.fromEntries([...letters.matchAll(/\["([A-Z])", (\d+)\]/g)].map((m) => [m[1], Number(m[2])]));
  assert.equal(Object.keys(bag).length, 26);
  assert.deepEqual(bag, RULES.BAG);
  const game = src("game.ts");
  assert.match(game, new RegExp(`export const STARTING_BALANCE = ${RULES.START_BALANCE}n;`));
  assert.match(game, new RegExp(`export const STARTING_RACK_SIZE = ${RULES.RACK};`));
  assert.match(game, /export const AUCTION_RESERVE = 1n;/);
  assert.match(game, /paid = first\.amount;/, "first price pays the top bid");
});

test("the harness never wraps or replaces a SookraBot method (the drift that made 'hooked' differ from head)", () => {
  const self = fs.readFileSync(new URL("./selfplay.ts", import.meta.url), "utf8");
  assert.doesNotMatch(self, /SookraBot\.prototype/);
  assert.doesNotMatch(self, /as unknown as/);
  assert.match(self, /new SookraBot\(index, seat\.spec\.name, log, Date\.now, policy\)/);
  assert.equal((self.match(/new SookraBot\(/g) ?? []).length, 1, "one construction site: the one injection point");
});

test("shards: contiguous blocks covering every match exactly once", () => {
  assert.deepEqual([0, 1, 2].map((i) => shardRange(10, `${i}/3`)), [[0, 3], [3, 6], [6, 10]]);
  assert.deepEqual(shardRange(10, undefined), [0, 10]);
  assert.deepEqual(shardRange(10, "0/1"), [0, 10]);
  for (const n of [1, 7, 400]) {
    for (const count of [1, 3, 8]) {
      const seen: number[] = [];
      for (let i = 0; i < count; i++) {
        const [lo, hi] = shardRange(n, `${i}/${count}`);
        for (let j = lo; j < hi; j++) seen.push(j);
      }
      assert.deepEqual(seen, Array.from({ length: n }, (_, j) => j));
    }
  }
  for (const bad of ["3/3", "-1/3", "a/b", "0/0", "1"]) assert.throws(() => shardRange(10, bad), Error, bad);
});

test("self-play: restating every default plays head's matches exactly, under Vickrey and first price", async () => {
  const all = POLICY_KEYS.map((k) => `${k}=${DEFAULT_POLICY[k]}`).join("+");
  for (const field of ["ar3@0.9", "ar2,fp"]) {
    const rows = await compare(field, 2, 31, ["head", all, "PACED_KAPPA=8"], { quiet: true });
    const of = (v: string) => rows.filter((r) => r.variant === v);
    assert.equal(of("head").length, 2);
    assert.deepEqual(of(all).map(content), of("head").map(content), field);
    assert.notDeepEqual(of("PACED_KAPPA=8").map(content), of("head").map(content), `${field}: a changed knob changes play`);
    assert.ok(rows.every((r) => r.auction === (field.includes(",fp") ? "FirstPrice" : "Vickrey")));
    const [, same, other] = summarize(rows) as { vsFirst: { identical: number; score: { mean: number } } }[];
    assert.equal(same.vsFirst.identical, 2);
    assert.equal(same.vsFirst.score.mean, 0);
    assert.ok(other.vsFirst.identical < 2);
  }
});

test("self-play: under first price the bot sees first-price auctions, and warm starts it with a price history", async () => {
  const bids = async (field: string) => {
    const lines: string[] = [];
    await compare(field, 1, 5, ["head"], { quiet: true, trace: (line) => lines.push(line) });
    return lines.filter((l) => l.includes(": bid "));
  };
  const vickrey = await bids("ar2");
  const cold = await bids("ar2,fp");
  const warm = await bids("ar2,fp,warm");
  const valueRule = /\(value [\d.]+, k\d/; // the reason of a Vickrey value bid
  const fpRule = / fp (no-history|q0\.75x\d+) k\d/;
  assert.ok(vickrey.filter((l) => valueRule.test(l)).length > 10, "Vickrey: value bids");
  assert.ok(vickrey.every((l) => !l.includes(" fp ")), "Vickrey: no first-price reasons");
  assert.ok(cold.filter((l) => fpRule.test(l)).length > 10, "first price: shaded value bids");
  assert.ok(cold.every((l) => !valueRule.test(l)), "first price: never the Vickrey value rule");
  assert.match(cold[0], /fp no-history/, "a cold bot has no prices yet");
  // The first 4 auctions of the 88 (bag 87 to 84) follow at most 3 results: under FP_MIN_OBS (5) prices.
  const early = (ls: string[]) => ls.filter((l) => / bag 8[4-7]: bid /.test(l));
  assert.ok(early(cold).length > 0 && early(cold).every((l) => !/fp q0\.75x/.test(l)), "cold: no history yet");
  assert.ok(early(warm).some((l) => /fp q0\.75x\d+/.test(l)), "warm: the first auctions already use the history");
});

test("self-play: shards merge into exactly the unsharded run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfplay-"));
  try {
    const whole = await compare("duel-ls", 3, 7, ["head", "PACE_MIN_DUEL=0.5"], { quiet: true, rowsPath: path.join(dir, "whole.jsonl") });
    for (const i of [0, 1]) {
      await compare("duel-ls", 3, 7, ["head", "PACE_MIN_DUEL=0.5"], { quiet: true, shard: `${i}/2`, rowsPath: path.join(dir, `s${i}.jsonl`) });
    }
    // A shard re-run appends identical rows: merge drops the duplicates.
    fs.appendFileSync(path.join(dir, "s1.jsonl"), fs.readFileSync(path.join(dir, "s1.jsonl")));
    const groups = readRows([path.join(dir, "s0.jsonl"), path.join(dir, "s1.jsonl")]);
    assert.deepEqual([...groups.keys()], ["duel-ls|7"]);
    const merged = groups.get("duel-ls|7")!;
    const key = (r: Row) => `${r.variant}|${r.i}`;
    const sort = (rs: Row[]) => [...rs].sort((a, b) => key(a).localeCompare(key(b)));
    assert.deepEqual(sort(merged).map(content), sort(whole).map(content));
    const strip = (s: Record<string, unknown>) => JSON.stringify({ ...s, secs: 0, msPerMatch: 0 });
    assert.deepEqual(summarize(merged).map(strip), summarize(whole).map(strip));
    // A conflicting duplicate (different results for the same variant and match) is refused.
    const bad = JSON.parse(fs.readFileSync(path.join(dir, "s0.jsonl"), "utf8").split("\n")[0]) as Row;
    fs.writeFileSync(path.join(dir, "bad.jsonl"), JSON.stringify({ ...bad, score: bad.score + 1 }) + "\n");
    assert.throws(() => readRows([path.join(dir, "s0.jsonl"), path.join(dir, "bad.jsonl")]), /differs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
