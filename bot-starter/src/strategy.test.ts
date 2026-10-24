// Checks for the SookraBot engine and policy. Run with `npm test`.
//
// The cross-check fixture (src/fixtures/py-crosscheck.json) was produced by
// the Python prototype (scrabble-analysis/scripts/crosscheck.py, which execs
// sim.py's own index and greedy_pack code) for 9 fixed and 200 random racks.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import {
  WordIndex,
  countsKey,
  countsOf,
  letterIndex,
  multiplier,
  packValue,
  valuate,
  wordReward,
} from "./engine.js";
import {
  BROKE_RIVAL_MAX_BID,
  DUEL_MAX_OPPONENTS,
  DUEL_RESERVE_PER_AUCTION,
  DUEL_RESERVE_WINDOW,
  FLUSH_LEAD_MS,
  KAPPA,
  type Opponent,
  chooseWords,
  decideBid,
  duelReserve,
  kappaFor,
  maxPossibleBid,
  maxSimBid,
  shouldFlush,
} from "./strategy.js";

const WORDLIST = fs
  .readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8")
  .split("\n");
const INDEX = WordIndex.fromWords(WORDLIST);
// A 6-bot table of real rivals (the prototype's setting; no duel reserve).
const REAL: Opponent[] = Array.from({ length: 5 }, () => ({ isSim: false, balance: 100 }));

interface FixtureRow {
  rack: string;
  total: number;
  used: string[];
  left: string;
  value: number;
  deltas: number[];
  bids: number[];
}
const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/py-crosscheck.json", import.meta.url), "utf8"),
) as { alpha: number; kappa: number; keys: number; fixed: FixtureRow[]; random: FixtureRow[] };

function bidsFor(rack: string): number[] {
  const v = valuate(INDEX, countsOf(rack), 0.35);
  return Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (L, i) =>
    decideBid({
      letter: L,
      delta: v.delta[i],
      bagTotal: 50,
      auctionType: "Vickrey",
      myBalance: 100,
      opponents: REAL,
    }).amount,
  );
}

// ---- scoring ----

test("wordReward matches the server's test-suite examples", () => {
  assert.equal(wordReward("QUIZ"), 33);
  assert.equal(wordReward("AXES"), 16);
  assert.equal(wordReward("QUAKE"), 36);
  assert.equal(wordReward("ZEBRAS"), 42);
  assert.equal(wordReward("JUKEBOX"), 81);
  assert.equal(wordReward("CAT"), 5);
  assert.equal(wordReward("MUZJIKS"), 87);
});

test("multiplier is 1, 3/2, 2, 5/2, 3 by length", () => {
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8, 15].map(multiplier), [
    [1, 1], [1, 1], [3, 2], [2, 1], [5, 2], [3, 1], [3, 1], [3, 1],
  ]);
});

// ---- index and packing ----

test("index size matches the Python prototype key count", () => {
  assert.equal(INDEX.size, FIXTURE.keys);
  assert.equal(INDEX.size, 156473);
});

test("small dictionary: best word first, multi-word packing, leftovers", () => {
  const idx = WordIndex.fromWords(["at", "cat", "tact", "act", "x1", "ox"]);
  const counts = countsOf("TACTOX");
  const cands = idx.scan(counts, false);
  const p = idx.pack(cands, counts, -1);
  // TACT (base 6 * 3/2 = 9, priority 9*64+4) outranks OX (9*64+2).
  assert.deepEqual(p.keys.map((k) => idx.words[k]), ["TACT", "OX"]);
  assert.equal(p.total, 18);
  assert.equal(countsKey(p.leftover), "");
  assert.equal(idx.words[idx.bestKey(cands, counts, 4)], "TACT");
  assert.equal(idx.bestKey(cands, counts, 5), -1);
});

test("scan with one extra tile tags the needed letter", () => {
  const idx = WordIndex.fromWords(["cat", "cats", "at"]);
  const cands = idx.scan(countsOf("CAT"), true);
  const byWord = new Map<string, number>();
  for (let i = 0; i < cands.n; i++) byWord.set(idx.words[cands.keys[i]], cands.extra[i]);
  assert.equal(byWord.get("CAT"), -1);
  assert.equal(byWord.get("AT"), -1);
  assert.equal(byWord.get("CATS"), letterIndex("S"));
  const withS = idx.pack(cands, countsOf("CAT"), letterIndex("S"));
  assert.deepEqual(withS.keys.map((k) => idx.words[k]), ["CATS"]);
  const without = idx.pack(cands, countsOf("CAT"), -1);
  assert.deepEqual(without.keys.map((k) => idx.words[k]), ["CAT"]);
});

// ---- cross-check against the Python prototype ----

test("cross-check: hardcoded prototype numbers for six racks", () => {
  // From crosscheck.py output (alpha 0.35, kappa 4.25, balance 100).
  const cases: [string, number, string[], string, number[]][] = [
    ["QUIZ", 33, ["IQUZ"], "",
      [9, 10, 10, 8, 10, 10, 8, 12, 8, 13, 14, 8, 11, 7, 9, 10, 6, 7, 10, 7, 8, 7, 9, 15, 13, 17]],
    ["AEINST", 15, ["AEINST"], "",
      [25, 51, 51, 38, 25, 63, 38, 63, 25, 80, 76, 25, 51, 25, 25, 51, 33, 25, 25, 25, 25, 63, 63, 100, 39, 100]],
    ["RETAINS", 21, ["AEINRST"], "",
      [12, 38, 38, 25, 12, 51, 25, 51, 12, 62, 63, 12, 38, 12, 12, 38, 100, 12, 12, 12, 12, 47, 51, 96, 12, 100]],
    ["JUKEBOXQ", 81, ["BEJKOUX"], "Q",
      [9, 10, 10, 8, 10, 10, 8, 12, 8, 13, 14, 8, 11, 7, 9, 10, 6, 7, 10, 7, 8, 7, 9, 15, 13, 17]],
    ["EEIIOUA", 5, ["AEU", "EO"], "II",
      [9, 25, 37, 30, 10, 22, 26, 41, 8, 64, 47, 33, 50, 22, 9, 16, 69, 30, 21, 24, 8, 38, 38, 55, 20, 100]],
    ["ZAXQJK", 19, ["AXZ"], "JKQ",
      [11, 10, 31, 8, 18, 10, 8, 12, 8, 13, 14, 8, 11, 7, 25, 10, 6, 7, 10, 7, 18, 7, 9, 15, 13, 100]],
    ["CAT", 5, ["ACT"], "",
      [17, 15, 10, 11, 17, 34, 8, 34, 8, 31, 42, 17, 15, 17, 17, 29, 40, 17, 17, 17, 8, 20, 20, 31, 20, 17]],
  ];
  for (const [rack, total, used, left, bids] of cases) {
    const counts = countsOf(rack);
    const v = valuate(INDEX, counts, 0.35);
    assert.equal(v.base.total, total, rack);
    assert.deepEqual(v.base.keys.map((k) => INDEX.keyString(k)), used, rack);
    assert.equal(countsKey(v.base.leftover), left, rack);
    assert.deepEqual(bidsFor(rack), bids, rack);
  }
});

test("cross-check: every fixture rack (9 fixed + 200 random) matches the prototype", () => {
  const rows = [...FIXTURE.fixed, ...FIXTURE.random];
  assert.equal(rows.length, 209);
  let bidMismatch = 0;
  for (const r of rows) {
    const counts = countsOf(r.rack);
    const v = valuate(INDEX, counts, FIXTURE.alpha);
    assert.equal(v.base.total, r.total, r.rack);
    assert.deepEqual(v.base.keys.map((k) => INDEX.keyString(k)), r.used, r.rack);
    assert.equal(countsKey(v.base.leftover), r.left, r.rack);
    assert.ok(Math.abs(packValue(v.base, FIXTURE.alpha) - r.value) < 1e-9, r.rack);
    for (let i = 0; i < 26; i++) {
      assert.ok(Math.abs(v.delta[i] - r.deltas[i]) < 1e-9, `${r.rack} delta ${i}`);
    }
    const bids = bidsFor(r.rack);
    if (bids.join() !== r.bids.join()) bidMismatch++;
  }
  assert.equal(bidMismatch, 0);
});

// ---- bidding policy ----

test("decideBid: final letter, no value, kappa, endgame boost, balance cap", () => {
  const base = { letter: "S", delta: 6, auctionType: "Vickrey" as const, myBalance: 100, opponents: REAL };
  assert.equal(decideBid({ ...base, bagTotal: 0 }).amount, 0);
  assert.equal(decideBid({ ...base, bagTotal: 30, delta: 0 }).amount, 0);
  assert.equal(decideBid({ ...base, bagTotal: 30, delta: -2 }).amount, 0);
  assert.equal(decideBid({ ...base, bagTotal: 30, delta: NaN }).amount, 0);
  assert.equal(decideBid({ ...base, bagTotal: 30 }).amount, Math.floor(KAPPA * 6)); // 25
  assert.equal(kappaFor(12), KAPPA);
  assert.equal(kappaFor(11), KAPPA * 2);
  assert.equal(decideBid({ ...base, bagTotal: 11 }).amount, 51);
  assert.equal(decideBid({ ...base, bagTotal: 11, myBalance: 20 }).amount, 20);
  assert.equal(decideBid({ ...base, bagTotal: 11, myBalance: -5 }).amount, 0);
});

test("maxSimBid follows the module's sim rule with +2 jitter", () => {
  assert.equal(maxSimBid("Aggressive", "E", 100), 7);
  assert.equal(maxSimBid("Aggressive", "S", 100), 5);
  assert.equal(maxSimBid("Aggressive", "Q", 100), 14);
  assert.equal(maxSimBid("ValueBidder", "Z", 100), 12);
  assert.equal(maxSimBid("Cheapskate", "T", 100), 2);
  assert.equal(maxSimBid("Aggressive", "Z", 9), 9);
  assert.equal(maxSimBid("Cheapskate", "A", 0), 0);
});

test("decideBid: sims-only table caps at the max sim bid + 1", () => {
  const sims: Opponent[] = [
    { isSim: true, strategy: "Aggressive", balance: 100 },
    { isSim: true, strategy: "Cheapskate", balance: 100 },
  ];
  const b = (delta: number, letter = "E") =>
    decideBid({ letter, delta, bagTotal: 30, auctionType: "Vickrey", myBalance: 100, opponents: sims }).amount;
  assert.equal(b(3), 8); // min(20*3, 7+1)
  assert.equal(b(0.2), 4); // floor(20*0.2)
  assert.equal(b(0), 0);
  // A real bot at the table switches back to kappa bidding.
  const mixed = [...sims, { isSim: false, balance: 100 }];
  assert.equal(
    decideBid({ letter: "E", delta: 3, bagTotal: 30, auctionType: "Vickrey", myBalance: 100, opponents: mixed }).amount,
    Math.floor(KAPPA * 3),
  );
});

test("decideBid: first price shades toward the observed price", () => {
  const input = { letter: "T", delta: 6, bagTotal: 30, auctionType: "FirstPrice" as const, myBalance: 100, opponents: REAL };
  // No history: 75% of the full bid (25 -> 18).
  assert.equal(decideBid(input).amount, 18);
  // History of 1-point letters selling for 4..8: q0.75 = 7, bid 8.
  const fpHistory = [4, 5, 6, 7, 8, 6, 5].map((paid) => ({ face: 1, paid }));
  assert.equal(decideBid({ ...input, fpHistory }).amount, 8);
  // Never above the full kappa bid.
  const pricey = [40, 41, 42, 43, 44].map((paid) => ({ face: 1, paid }));
  assert.equal(decideBid({ ...input, fpHistory: pricey }).amount, 25);
  // Other face values are ignored.
  const other = [4, 5, 6, 7, 8].map((paid) => ({ face: 3, paid }));
  assert.equal(decideBid({ ...input, fpHistory: other }).amount, 18);
});

test("duel rule: broke rivals get the minimum winning bid", () => {
  const input = (rivalBalance: number, delta = 6) => ({
    letter: "S", delta, bagTotal: 30, auctionType: "Vickrey" as const, myBalance: 50,
    opponents: [{ isSim: false, balance: rivalBalance }],
  });
  assert.equal(BROKE_RIVAL_MAX_BID, 2);
  assert.equal(decideBid(input(0)).amount, 1);
  assert.equal(decideBid(input(2)).amount, 3);
  assert.equal(decideBid(input(0, 0.05)).amount, 1); // any positive value is worth 1 coin
  assert.equal(decideBid(input(0, 0)).amount, 0);
  assert.equal(decideBid({ ...input(0), bagTotal: 0 }).amount, 0);
  // Broke sims count too: a sim with balance 0 can bid nothing.
  const sims: Opponent[] = [{ isSim: true, strategy: "Aggressive", balance: 0 }, { isSim: false, balance: 1 }];
  assert.equal(decideBid({ ...input(0), opponents: sims }).amount, 2);
});

test("duel rule: bids never exceed the richest rival's balance + 1", () => {
  const six: Opponent[] = [10, 5, 3, 0, 7].map((balance) => ({ isSim: false, balance }));
  const b = decideBid({ letter: "S", delta: 6, bagTotal: 30, auctionType: "Vickrey", myBalance: 100, opponents: six });
  assert.equal(b.amount, 11);
  assert.equal(maxPossibleBid({ isSim: true, strategy: "ValueBidder", balance: 100 }, "Q"), 12);
  assert.equal(maxPossibleBid({ isSim: false, balance: 37.9 }, "Q"), 37);
});

test("duel rule: one rival means a cash reserve sized to the remaining auctions", () => {
  assert.equal(DUEL_MAX_OPPONENTS, 1);
  assert.equal(duelReserve(1, 30), DUEL_RESERVE_PER_AUCTION * DUEL_RESERVE_WINDOW); // 10
  assert.equal(duelReserve(1, 30), 10);
  assert.equal(duelReserve(1, 5), 5);
  assert.equal(duelReserve(1, 0), 0);
  assert.equal(duelReserve(2, 30), 0);
  const rich: Opponent[] = [{ isSim: false, balance: 100 }];
  const duel = (myBalance: number, bagTotal: number, delta = 6) =>
    decideBid({ letter: "S", delta, bagTotal, auctionType: "Vickrey", myBalance, opponents: rich }).amount;
  assert.equal(duel(100, 30), 25); // reserve does not bind: floor(4.25 * 6)
  assert.equal(duel(20, 20), 10); // 20 - 10 reserve
  assert.equal(duel(12, 5), 7); // kappa doubled (51), capped at 12 - 5
  assert.equal(duel(5, 20), 0); // inside the reserve: an even share, floor(5 / 21)
  assert.equal(duel(3, 1), 2); // max(3 - 1, floor(3 / 2))
  // Six-bot tables keep the measured kappa rule.
  const five: Opponent[] = Array.from({ length: 5 }, () => ({ isSim: false, balance: 100 }));
  assert.equal(
    decideBid({ letter: "S", delta: 6, bagTotal: 20, auctionType: "Vickrey", myBalance: 40, opponents: five }).amount,
    25,
  );
});

// ---- word play ----

test("shouldFlush: always at the final auction, earlier for short auctions", () => {
  assert.equal(FLUSH_LEAD_MS, 3000);
  assert.equal(shouldFlush(0, 1000), true);
  assert.equal(shouldFlush(2, 1000), true);
  assert.equal(shouldFlush(3, 1000), false);
  assert.equal(shouldFlush(11, 250), true);
  assert.equal(shouldFlush(12, 250), false);
  assert.equal(shouldFlush(0, 10000), true);
  assert.equal(shouldFlush(1, 10000), false);
  assert.equal(shouldFlush(2, 0), true); // unknown duration is treated as 1000 ms
  assert.equal(shouldFlush(3, 0), false);
});

test("chooseWords: hoards short words, cashes 7+, flushes everything at the end", () => {
  const play = (rack: string, myBalance: number, flush: boolean) => {
    const counts = countsOf(rack);
    return chooseWords(INDEX, { counts, cands: INDEX.scan(counts, false), myBalance, flush });
  };
  assert.deepEqual(play("CAT", 100, false), []);
  // RETAINSQ holds both RETAINS (21) and QINTARS (48); the best 7 is cashed.
  const seven = play("RETAINSQ", 100, false);
  assert.deepEqual(seven, ["QINTARS"]);
  assert.equal(wordReward(seven[0]), 48);
  // Liquidity: broke, no 7, play the best 5+ word.
  const liq = play("QUAKES", 3, false);
  assert.equal(liq.length, 1);
  assert.ok(liq[0].length >= 5);
  // Flush plays the greedy packing.
  const flush = play("EEIIOUA", 50, true);
  assert.deepEqual(flush.map((w) => w.split("").sort().join("")), ["AEU", "EO"]);
});

// ---- speed ----

test("valuation of a 20-tile rack stays well inside a 250 ms auction", () => {
  const racks = ["AEEIINORSSTTLDGU", "BCDFGHJKLMNPQRSTVWXZ", "AAEEIIOOUURRSSTTNNLL", "AEINSTRLDGBCMPFHVWY"];
  for (const r of racks) {
    const v = valuate(INDEX, countsOf(r), 0.35);
    assert.ok(v.ms < 120, `${r} took ${v.ms.toFixed(1)} ms`);
  }
  const t0 = performance.now();
  WordIndex.fromWords(WORDLIST);
  const buildMs = performance.now() - t0;
  assert.ok(buildMs < 5000, `index build ${buildMs} ms`);
});
