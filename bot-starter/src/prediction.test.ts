// Tests for the prediction v2 pieces: optimal packing, the unseen pool and the lookahead.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { WordIndex, countsOf, valuate, wordReward } from "./engine.js";
import {
  BAG_COUNTS,
  PoolTracker,
  hashSeed,
  lookaheadDelta,
  lookaheadLambda,
  mulberry32,
  multiLookDelta,
  poolWeights,
} from "./pool.js";
import { DEFAULT_POLICY } from "./strategy.js";

const WORDLIST = fs
  .readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8")
  .split("\n");
const INDEX = WordIndex.fromWords(WORDLIST);
const DICT = new Set(WORDLIST.map((w) => w.trim().toUpperCase()));

/** Exhaustive optimum of total reward over disjoint words (tiny racks only). */
function bruteBest(index: WordIndex, rack: string): number {
  const counts = countsOf(rack);
  const cands = index.scan(counts, false);
  const keys = Array.from(cands.keys);
  let best = 0;
  const rec = (start: number, rem: Int32Array, acc: number) => {
    if (acc > best) best = acc;
    for (let j = start; j < keys.length; j++) {
      if (!index.fits(keys[j], rem)) continue;
      const next = new Int32Array(rem);
      index.consume(next, keys[j]);
      rec(j, next, acc + index.reward[keys[j]]);
    }
  };
  rec(0, counts, 0);
  return best;
}

test("packExact never loses to greedy, plays only real words from the rack, and finds the optimum on small racks", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const bag: string[] = [];
  for (let i = 0; i < 26; i++) for (let j = 0; j < BAG_COUNTS[i]; j++) bag.push(String.fromCharCode(65 + i));
  for (let r = 0; r < 60; r++) {
    const size = r < 30 ? 7 : 16;
    const b = [...bag];
    let rack = "";
    for (let i = 0; i < size; i++) rack += b.splice(Math.floor(rnd() * b.length), 1)[0];
    const counts = countsOf(rack);
    const cands = INDEX.scan(counts, true);
    const greedy = INDEX.pack(cands, counts, -1, 0);
    const exact = INDEX.packExact(cands, counts, -1, 0, 200000);
    assert.ok(exact.total >= greedy.total, rack);
    const used = countsOf(exact.keys.map((k) => INDEX.words[k]).join(""));
    for (let i = 0; i < 26; i++) assert.ok(used[i] <= counts[i], rack);
    let total = 0;
    for (const k of exact.keys) {
      assert.ok(DICT.has(INDEX.words[k]), INDEX.words[k]);
      total += wordReward(INDEX.words[k]);
    }
    assert.equal(total, exact.total);
    if (size === 7) assert.equal(exact.total, bruteBest(INDEX, rack), rack);
  }
});

test("packExact beats greedy where greedy takes the wrong long word", () => {
  const counts = countsOf("OHIOXEEITUFARIRE");
  const cands = INDEX.scan(counts, true);
  assert.equal(INDEX.pack(cands, counts, -1, 0).total, 62);
  assert.equal(INDEX.packExact(cands, counts, -1, 0, 200000).total, 81);
});

test("valuate with exact packing: deltas stay at or above the leave floor", () => {
  const counts = countsOf("AEINRTQ");
  const v = valuate(INDEX, counts, 0.35, "leave", 20000);
  for (let i = 0; i < 26; i++) assert.ok(v.delta[i] >= 0);
  const g = valuate(INDEX, counts, 0.35, "leave", 0);
  assert.ok(v.baseValue >= g.baseValue - 1e-9);
});

test("PoolTracker: unseen = bag - auctioned - our start, each auction counted once", () => {
  const p = new PoolTracker();
  p.noteStart(countsOf("QAEIO"));
  p.noteStart(countsOf("ZZZZZ")); // a second start is ignored
  p.noteAuction("1", 20); // U
  p.noteAuction("1", 20); // repeated event
  p.noteAuction("2", 0); // A
  const u = p.unseen();
  assert.equal(u[16], 0); // Q: 1 in the bag, ours
  assert.equal(u[20], 3); // U: 4 - 1 auctioned
  assert.equal(u[0], 7); // A: 9 - 1 ours - 1 auctioned
  assert.equal(p.auctionsSeen, 2);
  const w = poolWeights(u);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(w[16], 0);
});

test("lookahead: on and gated by default, ramps to 0 at the end", () => {
  assert.equal(DEFAULT_POLICY.LOOKAHEAD_WEIGHT, 1);
  assert.equal(DEFAULT_POLICY.LOOKAHEAD_MIN_REAL_RIVALS, 2);
  assert.equal(lookaheadLambda(1, 0, 10), 0);
  assert.equal(lookaheadLambda(1, 5, 10), 0.5);
  assert.equal(lookaheadLambda(1, 40, 10), 1);
  const rack = countsOf("QAEIRT");
  const base = valuate(INDEX, rack, 0.35);
  const withU = new Int32Array(rack);
  withU[20]++;
  const vu = valuate(INDEX, withU, 0.35);
  const w = poolWeights(null);
  assert.ok(lookaheadDelta(base, vu, 20, w, 1) >= 0);
});

test("multi-letter lookahead: off by default, seeded, at or above the leave floor, and m 0 values the rack alone", () => {
  assert.equal(DEFAULT_POLICY.MLOOK_M, 0);
  const rack = countsOf("EINST");
  const pool = new Int32Array(BAG_COUNTS);
  for (let i = 0; i < 26; i++) pool[i] -= rack[i];
  const li = 0; // A
  const a = multiLookDelta(INDEX, rack, li, pool, 6, 12, 0.35, mulberry32(hashSeed("k")));
  const b = multiLookDelta(INDEX, rack, li, pool, 6, 12, 0.35, mulberry32(hashSeed("k")));
  assert.equal(a, b);
  assert.ok(a >= 0.35 * 6.38 - 1e-9);
  const plain = valuate(INDEX, rack, 0.35).delta[li];
  assert.ok(Math.abs(multiLookDelta(INDEX, rack, li, pool, 0, 12, 0.35, mulberry32(1)) - plain) < 1e-9);
  // A tilt of 0 on every letter but one draws only that letter (pool permitting).
  const tilt = new Float64Array(26);
  tilt[17] = 1; // R
  const onlyR = new Int32Array(rack);
  onlyR[17] += 2;
  const viaTilt = multiLookDelta(INDEX, rack, li, pool, 2, 3, 0.35, mulberry32(9), tilt);
  assert.ok(Math.abs(viaTilt - valuate(INDEX, onlyR, 0.35).delta[li]) < 1e-9);
});
