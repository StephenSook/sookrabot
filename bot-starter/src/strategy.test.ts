// Checks for the SookraBot engine and policy. Run with `npm test`.
//
// The cross-check fixture (src/fixtures/py-crosscheck.json) was produced by
// the Python prototype (scrabble-analysis/scripts/crosscheck.py, which execs
// sim.py's own index and greedy_pack code) for 9 fixed and 200 random racks.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import {
  LEAVE_W7,
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
  LIQUIDITY_FALLBACK_MIN_LEN,
  LIQUIDITY_FLOOR,
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
) as {
  alpha: number;
  kappa: number;
  keys: number;
  fixed: FixtureRow[];
  random: FixtureRow[];
  leave_fixed: FixtureRow[];
  leave_random: FixtureRow[];
};

function bidsFor(rack: string, mode: "leave" | "forced" = "forced"): number[] {
  const v = valuate(INDEX, countsOf(rack), 0.35, mode);
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
    const v = valuate(INDEX, counts, 0.35, "forced");
    assert.equal(v.base.total, total, rack);
    assert.deepEqual(v.base.keys.map((k) => INDEX.keyString(k)), used, rack);
    assert.equal(countsKey(v.base.leftover), left, rack);
    assert.deepEqual(bidsFor(rack, "forced"), bids, rack);
  }
});

function crossCheck(rows: FixtureRow[], mode: "leave" | "forced") {
  let bidMismatch = 0;
  for (const r of rows) {
    const counts = countsOf(r.rack);
    const v = valuate(INDEX, counts, FIXTURE.alpha, mode);
    assert.equal(v.base.total, r.total, r.rack);
    assert.deepEqual(v.base.keys.map((k) => INDEX.keyString(k)), r.used, r.rack);
    assert.equal(countsKey(v.base.leftover), r.left, r.rack);
    assert.ok(Math.abs(packValue(v.base, FIXTURE.alpha) - r.value) < 1e-9, r.rack);
    for (let i = 0; i < 26; i++) {
      assert.ok(Math.abs(v.delta[i] - r.deltas[i]) < 1e-9, `${r.rack} delta ${i}`);
    }
    if (bidsFor(r.rack, mode).join() !== r.bids.join()) bidMismatch++;
  }
  assert.equal(bidMismatch, 0);
}

test("cross-check: forced packing matches sim.py on every fixture rack (9 fixed + 200 random)", () => {
  const rows = [...FIXTURE.fixed, ...FIXTURE.random];
  assert.equal(rows.length, 209);
  crossCheck(rows, "forced");
});

test("cross-check: leave-aware packing matches the Python leave model on every fixture rack", () => {
  const rows = [...FIXTURE.leave_fixed, ...FIXTURE.leave_random];
  assert.equal(rows.length, 209);
  crossCheck(rows, "leave");
  // Hardcoded from crosscheck.py output: ACT is now held (6.4645) instead of played (5).
  const act = valuate(INDEX, countsOf("CAT"), 0.35);
  assert.equal(act.base.total, 0);
  assert.equal(countsKey(act.base.leftover), "ACT");
  assert.ok(Math.abs(act.baseValue - 6.4645) < 1e-9);
  assert.deepEqual(bidsFor("CAT", "leave"),
    [10, 10, 10, 8, 10, 27, 8, 27, 8, 25, 36, 10, 11, 10, 10, 23, 34, 10, 10, 10, 8, 13, 13, 25, 13, 17]);
  assert.deepEqual(bidsFor("QUIZ", "leave"), bidsFor("QUIZ", "forced")); // QUIZ is still worth playing
});

test("leave-aware valuation: adding a tile never forces a bad word (Codex O + S example)", () => {
  const S = letterIndex("S");
  // Forced packing plays OS (2) and loses O's leave (0.35 x 6.32 = 2.212): delta -0.212.
  const forced = valuate(INDEX, countsOf("O"), 0.35, "forced");
  assert.ok(Math.abs(forced.delta[S] - (2 - 0.35 * 6.32)) < 1e-9);
  assert.ok(forced.delta[S] < 0);
  // Leave-aware: OS is worth less than holding O and S, so S adds its leave value.
  const leave = valuate(INDEX, countsOf("O"), 0.35);
  assert.ok(Math.abs(leave.delta[S] - 0.35 * 6.8) < 1e-9);
  // No letter has a negative delta on small racks where only short words are possible.
  for (const rack of ["O", "E", "AE", "ST", "CAT"]) {
    const v = valuate(INDEX, countsOf(rack), 0.35);
    for (let i = 0; i < 26; i++) assert.ok(v.delta[i] >= -1e-9, `${rack}+${String.fromCharCode(65 + i)}`);
  }
});

test("valuation is monotonic: Codex ANPQT + C example", () => {
  // Greedy repack of ANPQT+C plays PACT (15.3845) though QAT + leave (16.2595) was better;
  // keeping the old packing and adding C to the leave is worth 16.2595 + 0.35 x 7.17 = 18.769.
  const v = valuate(INDEX, countsOf("ANPQT"), 0.35);
  assert.ok(Math.abs(v.baseValue - 16.2595) < 1e-9);
  const C = letterIndex("C");
  assert.ok(Math.abs(v.baseValue + v.delta[C] - 18.769) < 1e-9, `got ${v.baseValue + v.delta[C]}`);
});

test("valuation property: value(rack + L) >= value(rack) + its leave, 400 random racks x 26 letters", () => {
  let seed = 20261023;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const bag = "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ";
  let violations = 0;
  for (let n = 0; n < 400; n++) {
    const tiles = bag.split("");
    let rack = "";
    const size = 1 + Math.floor(rnd() * 22);
    for (let i = 0; i < size; i++) rack += tiles.splice(Math.floor(rnd() * tiles.length), 1)[0];
    for (const alpha of [0.35, 0]) {
      const v = valuate(INDEX, countsOf(rack), alpha);
      for (let i = 0; i < 26; i++) {
        const floor = alpha * LEAVE_W7[String.fromCharCode(65 + i)];
        if (!(v.delta[i] >= floor - 1e-9)) violations++;
      }
    }
  }
  assert.equal(violations, 0);
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

test("Codex repro: the broke-rival branch still respects the duel reserve", () => {
  const duel = (myBalance: number, rivalBalance: number, bagTotal: number) =>
    decideBid({
      letter: "S", delta: 6, bagTotal, auctionType: "Vickrey", myBalance,
      opponents: [{ isSim: false, balance: rivalBalance }],
    }).amount;
  // Reserve 10, duel cap max(2 - 10, floor(2 / 31)) = 0: do not spend the last 2 coins on a tie.
  assert.equal(duel(2, 2, 30), 0);
  // With cash above the reserve the minimum winning bid still goes out.
  assert.equal(duel(50, 2, 30), 3);
  assert.equal(duel(50, 0, 30), 1);
  // Late in the match the reserve shrinks with the remaining auctions.
  assert.equal(duel(4, 2, 1), 3); // reserve 1: cap max(3, 2) = 3
});

test("final letter: deny it to sims (they can still score it), 0 against real bots only", () => {
  const input = (opponents: Opponent[], myBalance = 100) =>
    decideBid({ letter: "E", delta: 0, bagTotal: 0, auctionType: "Vickrey", myBalance, opponents });
  assert.equal(input(REAL).amount, 0);
  const withSims: Opponent[] = [...REAL.slice(0, 3), { isSim: true, strategy: "Aggressive", balance: 100 }];
  assert.equal(input(withSims).amount, maxSimBid("Aggressive", "E", 100) + 1); // 8
  assert.equal(input(withSims, 5).amount, 5); // capped by our balance
  const brokeSim: Opponent[] = [{ isSim: true, strategy: "Aggressive", balance: 0 }];
  assert.equal(input(brokeSim).amount, 0); // a broke sim cannot bid, nothing to deny
});

// ---- word play ----

test("liquidity: a broke bot cashes a short word rather than bid 0 forever (Codex QUIZ example)", () => {
  const play = (rack: string, myBalance: number) => {
    const counts = countsOf(rack);
    return chooseWords(INDEX, { counts, cands: INDEX.scan(counts, true), myBalance, flush: false });
  };
  // QUIZ is the only word in these tiles and has 4 letters.
  assert.deepEqual(play("QUIZ", 0), ["QUIZ"]);
  // Still hoards when solvent.
  assert.deepEqual(play("QUIZ", LIQUIDITY_FLOOR), []);
  // A 2-letter fallback when nothing longer exists, even if it cannot restore the floor.
  assert.deepEqual(play("AX", 0), ["AX"]);
  // 5+ letter words are preferred when they exist.
  const five = play("QUAKES", 3);
  assert.deepEqual(five, ["QUAKES"]);
  assert.equal(LIQUIDITY_FALLBACK_MIN_LEN, 2);
});

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

/**
 * CPU time this process spends in fn, in ms. Time spent waiting for a CPU
 * while other processes run is not counted, so a busy machine cannot fail a
 * speed check; a slower algorithm still does.
 */
function cpuMs(fn: () => void): number {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

test("valuation of a 20-tile rack stays well inside a 250 ms auction", (t) => {
  // CPU time, best of 3 (the first run can include JIT warmup). Wall time failed
  // this check under other processes' load (224 ms) with the code unchanged.
  const racks = ["AEEIINORSSTTLDGU", "BCDFGHJKLMNPQRSTVWXZ", "AAEEIIOOUURRSSTTNNLL", "AEINSTRLDGBCMPFHVWY"];
  for (const r of racks) {
    let best = Infinity;
    for (let i = 0; i < 3; i++) best = Math.min(best, cpuMs(() => valuate(INDEX, countsOf(r), 0.35)));
    t.diagnostic(`${r}: ${best.toFixed(1)} ms of CPU`);
    assert.ok(best > 0, "the measurement saw the work");
    assert.ok(best < 120, `${r} took ${best.toFixed(1)} ms of CPU (best of 3)`);
  }
  const buildMs = cpuMs(() => WordIndex.fromWords(WORDLIST));
  t.diagnostic(`index build: ${buildMs.toFixed(0)} ms of CPU`);
  assert.ok(buildMs < 5000, `index build ${buildMs.toFixed(0)} ms of CPU`);
});
