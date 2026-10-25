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
  EARLY_AUCTIONS,
  ENDGAME_AUCTIONS,
  ENDGAME_KAPPA_BOOST,
  FLUSH_LEAD_MS,
  FP_NO_HISTORY_SHADE,
  FP_QUANTILE,
  KAPPA,
  LEAVE_ALPHA,
  LIQUIDITY_FALLBACK_MIN_LEN,
  LIQUIDITY_FLOOR,
  HOLD_MIN_REAL_RIVALS,
  PACED_KAPPA,
  PACE_MAX,
  PACE_MIN,
  PACE_MIN_DUEL,
  DEFAULT_POLICY,
  type Opponent,
  type Policy,
  type PricePoint,
  alphaFor,
  auctionsPerMatch,
  chooseWords,
  decideBid,
  duelReserve,
  isDeadLetter,
  kappaFor,
  maxPossibleBid,
  maxSimBid,
  paceMultiplier,
  pacedKappa,
  flushLeadMs,
  MAX_FLUSH_LEAD_MS,
  sevenCompleterMask,
  shouldFlush,
} from "./strategy.js";
import * as strategy from "./strategy.js";

test("budget pacing: kappa scales with the balance left per remaining auction", () => {
  assert.equal(auctionsPerMatch(6, 5), 68);
  assert.equal(auctionsPerMatch(2, 5), 88);
  assert.equal(paceMultiplier(100, 67, 68), 1); // first auction of a 6-bot match: even spend
  assert.equal(paceMultiplier(100, 30, undefined), 1); // match length unknown: pacing off
  assert.ok(Math.abs(paceMultiplier(25, 33, 68) - Math.sqrt(25 / 34 / (100 / 68))) < 1e-12);
  assert.equal(paceMultiplier(0, 30, 68), PACE_MIN);
  assert.equal(paceMultiplier(1000, 1, 68), PACE_MAX);
  const real: Opponent[] = Array.from({ length: 5 }, () => ({ isSim: false, balance: 100 }));
  const bid = (myBalance: number, bagTotal: number) =>
    decideBid({ letter: "S", delta: 6, bagTotal, auctionType: "Vickrey", myBalance, opponents: real, auctionsPerMatch: 68 })
      .amount;
  // Even spend at the first auction: the paced base kappa 3.8, cut to 0.7 of it (EARLY_KAPPA_SCALE) in the
  // first EARLY_AUCTIONS auctions at this five-rival table: floor(3.8 x 0.7 x 6) = 15.
  assert.equal(bid(100, 67), 15);
  // Ahead of even spend (index 27, still early): 3.8 x sqrt(20 / 41 / (100 / 68)) = 2.189, x 0.7 x 6 = 9.2.
  assert.equal(bid(20, 40), 9);
  assert.ok(bid(20, 40) < Math.floor(PACED_KAPPA * 6));
  // Behind even spend (index 47, past the early window): bids more than the base kappa, uncut.
  assert.ok(bid(60, 20) > Math.floor(PACED_KAPPA * 6));
  assert.equal(bid(60, 20), Math.floor(PACED_KAPPA * paceMultiplier(60, 20, 68) * 6));
  const endgame = decideBid({
    letter: "S", delta: 1, bagTotal: 5, auctionType: "Vickrey", myBalance: 30, opponents: real, auctionsPerMatch: 68,
    policy: withPolicy({ ENDGAME_SMALL_SEATS: 0 }),
  }).amount;
  assert.equal(endgame, Math.floor(PACED_KAPPA * 2 * paceMultiplier(30, 5, 68) * 1)); // endgame boost kept (14)
  // The live policy (ENDGAME_SMALL_SEATS 6, ENDGAME_BOOST_SMALL 1) drops the boost at this 6-seat table (7).
  const small = decideBid({
    letter: "S", delta: 1, bagTotal: 5, auctionType: "Vickrey", myBalance: 30, opponents: real, auctionsPerMatch: 68,
  }).amount;
  assert.equal(small, Math.floor(PACED_KAPPA * 1 * paceMultiplier(30, 5, 68) * 1));
  // Without a match length (as in the rules below and the Python cross-check) the unpaced KAPPA rule holds.
  assert.equal(
    decideBid({ letter: "S", delta: 6, bagTotal: 40, auctionType: "Vickrey", myBalance: 100, opponents: real }).amount,
    Math.floor(KAPPA * 6),
  );
  // Sims-only tables keep their own rule.
  const sims: Opponent[] = [{ isSim: true, strategy: "Aggressive", balance: 100 }];
  assert.equal(
    decideBid({ letter: "E", delta: 3, bagTotal: 30, auctionType: "Vickrey", myBalance: 100, opponents: sims, auctionsPerMatch: 88 })
      .amount,
    8,
  );
});

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
  // The endgame boost covers the last 8 auctions (bagTotal 7 to 0), not 12.
  assert.equal(ENDGAME_AUCTIONS, 8);
  assert.equal(kappaFor(8), KAPPA);
  assert.equal(kappaFor(7), KAPPA * 2);
  assert.equal(kappaFor(11), KAPPA);
  assert.equal(decideBid({ ...base, bagTotal: 11 }).amount, 25);
  // ENDGAME_SMALL_SEATS 6: no endgame boost at this 6-seat table; a 7-seat table keeps the boost of 2.
  assert.equal(decideBid({ ...base, bagTotal: 7 }).amount, 25);
  const seven = { ...base, opponents: Array.from({ length: 6 }, () => ({ isSim: false, balance: 100 })) };
  assert.equal(decideBid({ ...seven, bagTotal: 7 }).amount, 51);
  assert.equal(decideBid({ ...seven, bagTotal: 8 }).amount, 25);
  assert.equal(decideBid({ ...base, bagTotal: 7, myBalance: 20 }).amount, 20);
  assert.equal(decideBid({ ...base, bagTotal: 7, myBalance: -5 }).amount, 0);
});

test("budget pacing in a duel: the factor stops at PACE_MIN_DUEL, not PACE_MIN", () => {
  assert.equal(PACE_MIN_DUEL, 0.75);
  assert.ok(PACE_MIN < PACE_MIN_DUEL && PACE_MIN_DUEL < 1);
  // The floor is a parameter of the factor (PACE_MIN by default); the ceiling is shared.
  assert.equal(paceMultiplier(0, 30, 88), PACE_MIN);
  assert.equal(paceMultiplier(0, 30, 88, PACE_MIN_DUEL), PACE_MIN_DUEL);
  assert.equal(paceMultiplier(100, 87, 88, PACE_MIN_DUEL), 1);
  assert.equal(paceMultiplier(1000, 1, 88, PACE_MIN_DUEL), PACE_MAX);
  assert.equal(paceMultiplier(50, 10, undefined, PACE_MIN_DUEL), 1); // match length unknown: pacing off
  // pacedKappa: PACED_KAPPA, doubled in the last ENDGAME_AUCTIONS auctions, times the factor.
  assert.equal(pacedKappa(30, 100, 68), PACED_KAPPA * paceMultiplier(100, 30, 68));
  assert.equal(pacedKappa(7, 100, 68), PACED_KAPPA * ENDGAME_KAPPA_BOOST * paceMultiplier(100, 7, 68));
  assert.equal(pacedKappa(8, 100, 68), PACED_KAPPA * paceMultiplier(100, 8, 68));
  assert.equal(pacedKappa(70, 40, 88, PACE_MIN_DUEL), PACED_KAPPA * PACE_MIN_DUEL);
  // 40 coins with 71 auctions to go: r = 40 / 71 / (100 / 88) = 0.496, sqrt(r) = 0.704.
  assert.equal(Math.floor(pacedKappa(70, 40, 88) * 6), 16); // what the PACE_MIN floor gives
  const spot = { letter: "S", delta: 6, bagTotal: 70, auctionType: "Vickrey" as const, myBalance: 40 };
  const rival: Opponent[] = [{ isSim: false, balance: 100 }];
  // Duel (88 auctions): held at 0.75, kappa 3.8 x 0.75 = 2.85, so 17 (the duel reserve of 10 does not bind).
  assert.equal(decideBid({ ...spot, opponents: rival, auctionsPerMatch: 88 }).amount, 17);
  // First price shades the same paced bid: floor(17 x FP_NO_HISTORY_SHADE 0.4) = 6 with no price history.
  assert.equal(decideBid({ ...spot, auctionType: "FirstPrice", opponents: rival, auctionsPerMatch: 88 }).amount, 6);
  // Two rivals (83 auctions) get no duel floor: 3.8 x sqrt(40 / 71 / (100 / 83)) = 2.60, which would bid 15;
  // auction index 12 is inside the early window and two rivals are enough for the cut: 2.60 x 0.7 x 6, so 10.
  // The duel above (index 17 of 88) is exempt from the cut.
  assert.equal(EARLY_AUCTIONS > 12, true);
  assert.equal(decideBid({ ...spot, opponents: [...rival, ...rival], auctionsPerMatch: 83 }).amount, 10);
  assert.equal(
    decideBid({ ...spot, opponents: [...rival, ...rival], auctionsPerMatch: 83, policy: { ...DEFAULT_POLICY, EARLY_KAPPA_SCALE: 1 } }).amount,
    15,
  );
  // Above the floor a duel is paced like any table: the first auction is 3.8 x 6 = 22.8, so 22.
  assert.equal(decideBid({ ...spot, bagTotal: 87, myBalance: 100, opponents: rival, auctionsPerMatch: 88 }).amount, 22);
  // A sims-only duel and a broke rival keep their own rules.
  const sim: Opponent[] = [{ isSim: true, strategy: "Aggressive", balance: 100 }];
  assert.equal(decideBid({ ...spot, opponents: sim, auctionsPerMatch: 88 }).amount, maxSimBid("Aggressive", "S", 100) + 1);
  assert.equal(decideBid({ ...spot, opponents: [{ isSim: false, balance: 1 }], auctionsPerMatch: 88 }).amount, 2);
});

test("early bid cut: the paced kappa x EARLY_KAPPA_SCALE in the first EARLY_AUCTIONS auctions, duels exempt", () => {
  const { EARLY_AUCTIONS, EARLY_KAPPA_SCALE, EARLY_MIN_REAL_RIVALS, earlyScale } = strategy;
  assert.equal(EARLY_AUCTIONS, 28);
  assert.equal(EARLY_KAPPA_SCALE, 0.7);
  assert.equal(EARLY_MIN_REAL_RIVALS, 2);
  // Auction index = auctions - 1 - bagTotal: 0 at the first auction; indexes 0 to 27 are cut.
  assert.equal(earlyScale(67, 68, 5), 0.7);
  assert.equal(earlyScale(40, 68, 5), 0.7);
  assert.equal(earlyScale(39, 68, 5), 1);
  assert.equal(earlyScale(1, 68, 5), 1);
  assert.equal(earlyScale(82, 83, 2), 0.7); // two real rivals are enough
  assert.equal(earlyScale(87, 88, 1), 1); // a duel (the 3-game final) is exempt
  assert.equal(earlyScale(67, 68, 0), 1);
  // The rule's own parameters: window, scale (1 turns it off) and minimum real rivals.
  assert.equal(earlyScale(40, 68, 5, 27), 1);
  assert.equal(earlyScale(67, 68, 5, 28, 1), 1);
  assert.equal(earlyScale(87, 88, 1, 28, 0.5, 1), 0.5);

  // A six-seat all-real table (68 auctions).
  const bid = (myBalance: number, bagTotal: number, delta: number, x: Partial<Parameters<typeof decideBid>[0]> = {}) =>
    decideBid({ letter: "S", delta, bagTotal, auctionType: "Vickrey", myBalance, opponents: REAL, auctionsPerMatch: 68, ...x })
      .amount;
  // First auction, even spend: kappa 3.8 x 0.7 = 2.66, so 15 for a 6-point letter (22 uncut).
  assert.equal(bid(100, 67, 6), 15);
  // Index 27, 100 coins for 41 auctions: kappa 3.8 x sqrt(68 / 41) = 4.894, x 0.7 x 5 = 17.1 (24 uncut).
  assert.equal(bid(100, 40, 5), 17);
  // Index 28, the first auction past the window: 3.8 x sqrt(1.7) = 4.955, x 5 = 24.
  assert.equal(bid(100, 39, 5), 24);
  // First price shades the cut bid: full 15, no history, 40% of it: 6.
  assert.equal(bid(100, 67, 6, { auctionType: "FirstPrice" }), 6);
  // A duel keeps the full paced kappa at its first auction: 3.8 x 6 = 22.8, so 22.
  assert.equal(bid(100, 87, 6, { opponents: [{ isSim: false, balance: 100 }], auctionsPerMatch: 88 }), 22);
  // Rules that do not pace keep their own kappa: no match length (KAPPA 4.25: 25), sims-only (cap 8).
  assert.equal(bid(100, 67, 6, { auctionsPerMatch: undefined }), 25);
  const sims: Opponent[] = [
    { isSim: true, strategy: "Aggressive", balance: 100 },
    { isSim: true, strategy: "Cheapskate", balance: 100 },
  ];
  assert.equal(bid(100, 80, 3, { letter: "E", opponents: sims, auctionsPerMatch: 83 }), 8);
  // Sims do not count toward EARLY_MIN_REAL_RIVALS: one real rival and four sims (six seats) bid the
  // full paced kappa, 3.8 x 6 = 22.8, so 22; two real rivals and three sims are cut, 15.
  const sim = (strategy: "Aggressive" | "Cheapskate" | "ValueBidder"): Opponent => ({ isSim: true, strategy, balance: 100 });
  const real = (): Opponent => ({ isSim: false, balance: 100 });
  const oneReal = [real(), sim("Aggressive"), sim("Aggressive"), sim("ValueBidder"), sim("Cheapskate")];
  assert.equal(bid(100, 67, 6, { opponents: oneReal }), 22);
  assert.equal(bid(100, 67, 6, { opponents: [real(), real(), sim("Aggressive"), sim("ValueBidder"), sim("Cheapskate")] }), 15);
  // One real rival and one sim (three seats, 83 auctions): no cut either, 22.
  assert.equal(bid(100, 82, 6, { opponents: [real(), sim("Aggressive")], auctionsPerMatch: 83 }), 22);
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
  assert.equal(FP_NO_HISTORY_SHADE, 0.4);
  assert.equal(FP_QUANTILE, 0.2);
  // No history: 40% of the full bid (25 -> 10).
  assert.equal(decideBid(input).amount, 10);
  // History of 1-point letters selling for 4..8 (sorted 4 5 5 6 6 7 8): q0.2 = 5, bid 6.
  const fpHistory = [4, 5, 6, 7, 8, 6, 5].map((paid) => ({ face: 1, paid }));
  assert.equal(decideBid({ ...input, fpHistory }).amount, 6);
  // The same history at quantile 0.75 (the default before 2026-10-24): q0.75 = 7, bid 8.
  assert.equal(decideBid({ ...input, fpHistory, policy: { ...DEFAULT_POLICY, FP_QUANTILE: 0.75 } }).amount, 8);
  // Never above the full kappa bid.
  const pricey = [40, 41, 42, 43, 44].map((paid) => ({ face: 1, paid }));
  assert.equal(decideBid({ ...input, fpHistory: pricey }).amount, 25);
  // Other face values are ignored.
  const other = [4, 5, 6, 7, 8].map((paid) => ({ face: 3, paid }));
  assert.equal(decideBid({ ...input, fpHistory: other }).amount, 10);
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
  assert.equal(duel(3, 2), 1); // max(3 - 2, floor(3 / 3))
  // bagTotal 1, the last usable auction: ALLIN_LAST spends everything (9f1faba: max(3 - 1, floor(3 / 2)) = 2).
  assert.equal(duel(3, 1), 3);
  assert.equal(
    decideBid({ letter: "S", delta: 6, bagTotal: 1, auctionType: "Vickrey", myBalance: 3, opponents: rich, policy: { ...DEFAULT_POLICY, ALLIN_LAST: 0 } }).amount,
    2,
  );
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
  assert.equal(FLUSH_LEAD_MS, 2000);
  assert.equal(shouldFlush(0, 1000), true);
  assert.equal(shouldFlush(1, 1000), true);
  assert.equal(shouldFlush(2, 1000), false);
  assert.equal(shouldFlush(7, 250), true);
  assert.equal(shouldFlush(8, 250), false);
  assert.equal(shouldFlush(0, 10000), true);
  assert.equal(shouldFlush(1, 10000), false);
  assert.equal(shouldFlush(1, 0), true); // unknown duration is treated as 1000 ms
  assert.equal(shouldFlush(2, 0), false);
  // The 3000 ms lead the bot shipped with until wordplay, as an explicit argument.
  assert.equal(shouldFlush(2, 1000, 3000), true);
  assert.equal(shouldFlush(3, 1000, 3000), false);
});

test("flushLeadMs: unchanged under normal jitter, longer after a stall, skew-proof, capped", () => {
  assert.equal(flushLeadMs([]), FLUSH_LEAD_MS);
  assert.equal(flushLeadMs([67, 158, 72, -30]), FLUSH_LEAD_MS);
  assert.equal(flushLeadMs([1000]), FLUSH_LEAD_MS);
  // Friday's venue stall (about 1,100 ms over a ~60 ms baseline) still flushes in the last 3 auctions.
  assert.equal(shouldFlush(3, 1000, flushLeadMs([60, 1136])), false);
  assert.equal(shouldFlush(2, 1000, flushLeadMs([60, 1136])), true);
  // An m276-size stall (3,253 ms over an 80 ms baseline) starts word plays 7 auctions out.
  assert.equal(flushLeadMs([80, 3253, 90]), 7346);
  assert.equal(shouldFlush(6, 1000, flushLeadMs([80, 3253])), true);
  assert.equal(shouldFlush(7, 1000, flushLeadMs([80, 3253])), false);
  // A constant clock skew cancels in either direction: 6 s ahead is not a stall...
  assert.equal(flushLeadMs([6050, 6060, 6040]), FLUSH_LEAD_MS);
  // ...and a real stall still counts when the Mac's clock runs 6 s behind.
  assert.equal(flushLeadMs([-5950, -2747]), 7406);
  // Only the most recent 20 lags count toward the stall, junk values are ignored, and the lead is capped.
  assert.equal(flushLeadMs([9000, ...Array.from({ length: 20 }, () => 50)]), FLUSH_LEAD_MS);
  assert.equal(flushLeadMs([Number.NaN, Number.POSITIVE_INFINITY, 100]), FLUSH_LEAD_MS);
  assert.equal(flushLeadMs([0, 60000]), MAX_FLUSH_LEAD_MS);
  // One early outlier (a clock correction from 6 s behind) does not poison the baseline.
  assert.equal(flushLeadMs([-5950, ...Array.from({ length: 30 }, () => 50)]), FLUSH_LEAD_MS);
  assert.equal(flushLeadMs([-5950, ...Array.from({ length: 60 }, () => 50)]), FLUSH_LEAD_MS);
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

test("chooseWords: with HOLD_MIN_REAL_RIVALS real rivals, words wait for the flush (liquidity aside)", () => {
  const play = (rack: string, myBalance: number, flush: boolean, realRivals: number) => {
    const counts = countsOf(rack);
    return chooseWords(INDEX, { counts, cands: INDEX.scan(counts, false), myBalance, flush, realRivals });
  };
  assert.equal(HOLD_MIN_REAL_RIVALS, 2);
  assert.deepEqual(play("RETAINSQ", 100, false, 1), ["QINTARS"]); // duel: cash the 7 at once
  assert.deepEqual(play("RETAINSQ", 100, false, 5), []); // all-real table: hold it
  const liq = play("QUAKES", 3, false, 5); // broke: the liquidity word still goes
  assert.equal(liq.length, 1);
  assert.ok(liq[0].length >= 5);
  assert.ok(play("RETAINSQ", 100, true, 5).includes("QINTARS")); // the flush plays everything
});

test("match 123: 10 coins, a 6-letter word in hand, 46 auctions left: cash it, then pace the bids", () => {
  // Live m123 (Vickrey, 68 auctions; LetterShark, four sims and us), from SookraBot's auction log. At
  // kappa 4.25 the bot paid 110 coins for 12 letters by auction 17. After auction 22 it held 10 coins and
  // the rack JUTTEDVG with 46 auctions to come; it cashed JUTTED (+35), was down to 3 coins by auction 42
  // and won none of the last 26 letters (LetterShark won 23 of them).
  const counts = countsOf("JUTTEDVG");
  const words = (realRivals: number) =>
    chooseWords(INDEX, { counts, cands: INDEX.scan(counts, true), myBalance: 10, flush: false, realRivals });
  assert.deepEqual(words(1), ["JUTTED"]); // the live table: one real rival
  assert.deepEqual(words(5), ["JUTTED"]); // all-real tables hold words, but not the liquidity word
  assert.equal(wordReward("JUTTED"), 35);
  // The engine reproduces the logged marginal values: G on JUTTEDV 1.943, K on VG (after the cash) 3.374.
  const g = valuate(INDEX, countsOf("JUTTEDV"), LEAVE_ALPHA).delta[letterIndex("G")];
  const k = valuate(INDEX, countsOf("VG"), LEAVE_ALPHA).delta[letterIndex("K")];
  assert.ok(Math.abs(g - 1.943) < 5e-4 && Math.abs(k - 3.374) < 5e-4, `G ${g}, K ${k}`);
  const table: Opponent[] = [
    { isSim: false, balance: 56 }, // LetterShark
    { isSim: true, strategy: "ValueBidder", balance: 100 },
    { isSim: true, strategy: "Aggressive", balance: 102 },
    { isSim: true, strategy: "Aggressive", balance: 100 },
    { isSim: true, strategy: "Cheapskate", balance: 100 },
  ];
  // Pacing as it was at m123 (PACED_KAPPA 4), before the early bid cut (EARLY_KAPPA_SCALE 1); the cut is checked last.
  const noCut: Policy = { ...DEFAULT_POLICY, PACED_KAPPA: 4, EARLY_KAPPA_SCALE: 1 };
  const bid = (letter: string, delta: number, bagTotal: number, myBalance: number, opponents = table, auctions?: number) =>
    decideBid({ letter, delta, bagTotal, auctionType: "Vickrey", myBalance, opponents, auctionsPerMatch: auctions, policy: noCut })
      .amount;
  // Auction 22 (G): 16 coins for 47 auctions, 0.23 of the starting rate per auction. The live bid at
  // kappa 4.25 was 8; paced, the factor bottoms out at PACE_MIN (kappa 2): 3. Index 21 is inside the
  // early window, but this table has one real rival (the sims do not count), so no early cut.
  assert.equal(bid("G", 1.943, 46, 16), 8);
  assert.equal(bid("G", 1.943, 46, 16, table, 68), 3);
  // Auction 23 (K), after the cash: 45 coins for 46 auctions, kappa 4 x sqrt(0.665) = 3.26: 11, not 14.
  assert.equal(bid("K", 3.374, 45, 45), 14);
  assert.equal(bid("K", 3.374, 45, 45, table, 68), 11);
  // The cut (at its 5318ca6 values, PACED_KAPPA 4 and EARLY_KAPPA_SCALE 0.4) applies only where two real
  // rivals sit: this table (one real rival) bids as uncut, and with a second real rival in place of a sim the
  // cut applies (index 22): 3.26 x 0.4 x 3.374, so 4.
  const cut: Policy = { ...DEFAULT_POLICY, PACED_KAPPA: 4, EARLY_KAPPA_SCALE: 0.4 };
  const live = (letter: string, delta: number, bagTotal: number, myBalance: number, opponents = table) =>
    decideBid({ letter, delta, bagTotal, auctionType: "Vickrey", myBalance, opponents, auctionsPerMatch: 68, policy: cut }).amount;
  assert.equal(live("G", 1.943, 46, 16), 3);
  assert.equal(live("K", 3.374, 45, 45), 11);
  const twoReal: Opponent[] = [table[0], { isSim: false, balance: 100 }, ...table.slice(2)];
  assert.equal(live("K", 3.374, 45, 45, twoReal), 4);
  assert.equal(bid("K", 3.374, 45, 45, twoReal, 68), 11, "without the cut");
  // The same spot in a final (a duel vs LetterShark, 88 auctions): the factor, 0.547, is held at
  // PACE_MIN_DUEL (kappa 3), so 5 rather than 4, inside the duel cap of 16 - 10 reserved = 6.
  assert.equal(bid("G", 1.943, 46, 16, [table[0]], 88), 5);
});

// ---- the policy: every knob by name, the one way a variant reaches the code ----

const withPolicy = (o: Partial<Policy>): Policy => ({ ...DEFAULT_POLICY, ...o });

test("policy: DEFAULT_POLICY holds each tuning constant under its own name, frozen", () => {
  const exported = strategy as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(DEFAULT_POLICY)) assert.equal(v, exported[k], k);
  assert.ok(Object.isFrozen(DEFAULT_POLICY));
  assert.throws(() => {
    (DEFAULT_POLICY as { KAPPA: number }).KAPPA = 9;
  }, TypeError);
  assert.equal(DEFAULT_POLICY.KAPPA, KAPPA);
});

test("policy: each bid knob set in the policy moves decideBid as its constant does", () => {
  // The numbers below were worked out with PACED_KAPPA 4, the early cut off, ENDGAME_AUCTIONS 12 and first-price
  // quantile and shade 0.75 (the defaults before the 2026-10-24 strategy search); each override applies on top.
  const BASE: Partial<Policy> = {
    PACED_KAPPA: 4, EARLY_KAPPA_SCALE: 1, ENDGAME_AUCTIONS: 12, FP_QUANTILE: 0.75, FP_NO_HISTORY_SHADE: 0.75, ENDGAME_SMALL_SEATS: 0,
  };
  const bid = (o: Partial<Policy>, x: Partial<Parameters<typeof decideBid>[0]> = {}) =>
    decideBid({
      letter: "S", delta: 5, bagTotal: 40, auctionType: "Vickrey", myBalance: 100, opponents: REAL,
      auctionsPerMatch: 68, ...x, policy: withPolicy({ ...BASE, ...o }),
    }).amount;
  // 100 coins for 41 auctions of 68: r = 68/41, pacing factor sqrt(r) = 1.2878.
  assert.equal(bid({}), 25);
  // No policy given: the live DEFAULT_POLICY (PACED_KAPPA 3.8), whose early cut applies at index 27:
  // 3.8 x 1.2878 = 4.8938, x 0.7 x 5 = 17.1.
  const live = decideBid({ letter: "S", delta: 5, bagTotal: 40, auctionType: "Vickrey", myBalance: 100, opponents: REAL, auctionsPerMatch: 68 });
  assert.equal(live.amount, 17);
  assert.equal(live.amount, bid({ ...DEFAULT_POLICY }));
  assert.equal(bid({ PACED_KAPPA: 6 }), 38);
  assert.equal(bid({ PACE_EXPONENT: 1 }), 33);
  assert.equal(bid({ PACE_MAX: 1 }), 20);
  assert.equal(bid({ PACE_MIN: 2 }), 40);
  // Endgame (10 auctions to come, 15 coins: factor 0.963): doubled inside ENDGAME_AUCTIONS.
  const late = { bagTotal: 10, myBalance: 15, delta: 1 };
  assert.equal(bid({}, late), 7);
  assert.equal(bid({ ENDGAME_AUCTIONS: 8 }, late), 3);
  assert.equal(bid({ ENDGAME_KAPPA_BOOST: 3 }, late), 11);
  // ENDGAME_SMALL_SEATS: a table this small (6 seats) uses ENDGAME_BOOST_SMALL, a bigger one the boost.
  assert.equal(bid({ ENDGAME_SMALL_SEATS: 6 }, late), bid({ ENDGAME_KAPPA_BOOST: 1 }, late));
  assert.equal(bid({ ENDGAME_SMALL_SEATS: 5 }, late), 7);
  assert.equal(bid({ ENDGAME_SMALL_SEATS: 6, ENDGAME_BOOST_SMALL: 3 }, late), 11);
  // KAPPA is the unpaced kappa (no match length; the live bot always passes one).
  assert.equal(bid({}, { auctionsPerMatch: undefined }), Math.floor(KAPPA * 5));
  assert.equal(bid({ KAPPA: 3 }, { auctionsPerMatch: undefined }), 15);
  assert.equal(bid({ KAPPA: 3 }), 25, "paced tables ignore KAPPA");
  // Duel, 20 coins with 60 auctions to come of 88: factor 0.537, floored at PACE_MIN_DUEL.
  const duel = { opponents: [{ isSim: false, balance: 100 }], myBalance: 20, bagTotal: 60, auctionsPerMatch: 88, delta: 2 };
  assert.equal(bid({}, duel), 6);
  assert.equal(bid({ PACE_MIN_DUEL: 1 }, duel), 8);
  assert.equal(bid({ DUEL_MAX_OPPONENTS: 0 }, duel), 4, "not a duel: PACE_MIN floor");
  // Duel reserve: 15 wanted, 20 - 10 reserved allows 10.
  const reserve = { ...duel, delta: 5 };
  assert.equal(bid({}, reserve), 10);
  assert.equal(bid({ DUEL_RESERVE_WINDOW: 5 }, reserve), 15);
  assert.equal(bid({ DUEL_RESERVE_PER_AUCTION: 0 }, reserve), 15);
  assert.equal(duelReserve(1, 60, withPolicy({ DUEL_RESERVE_PER_AUCTION: 2, DUEL_RESERVE_WINDOW: 3 })), 6);
  // Sims-only Vickrey: SIM_ONLY_KAPPA x value, under the sim cap (Aggressive on E: 8).
  const simsOnly = { letter: "E", delta: 0.25, opponents: [{ isSim: true, strategy: "Aggressive" as const, balance: 100 }] };
  assert.equal(bid({}, simsOnly), 5);
  assert.equal(bid({ SIM_ONLY_KAPPA: 10 }, simsOnly), 2);
  // Broke rivals (all at 2 coins): bid their max + 1 unless BROKE_RIVAL_MAX_BID says they are not broke.
  const broke = { delta: 0.2, opponents: Array.from({ length: 5 }, () => ({ isSim: false, balance: 2 })) };
  assert.equal(bid({}, broke), 3);
  assert.equal(bid({ BROKE_RIVAL_MAX_BID: 1 }, broke), 1);
  // First price, full bid 25: no history shades to FP_NO_HISTORY_SHADE, history to the FP_QUANTILE price + 1.
  const fp = { auctionType: "FirstPrice" as const };
  assert.equal(bid({}, fp), 18);
  assert.equal(bid({ FP_NO_HISTORY_SHADE: 0.5 }, fp), 12);
  const history: PricePoint[] = [1, 2, 3, 4, 5, 6, 7, 8].map((paid) => ({ face: 1, paid }));
  const fpH = { ...fp, fpHistory: history };
  assert.equal(bid({}, fpH), 7);
  assert.equal(bid({ FP_QUANTILE: 0.5 }, fpH), 5);
  assert.equal(bid({ FP_MIN_OBS: 9 }, fpH), 18);
  assert.equal(bid({ FP_HISTORY_MAX: 5 }, fpH), 8); // the last 5 prices, 4 to 8
  assert.equal(bid({ FP_HISTORY_MAX: 4 }, fpH), 18); // fewer than FP_MIN_OBS kept: no history
  // Early bid cut: auction index 27 of 68 (40 to come); kappa 5.1514 halved inside EARLY_AUCTIONS.
  assert.equal(bid({ EARLY_AUCTIONS: 28, EARLY_KAPPA_SCALE: 0.5 }), 12);
  assert.equal(bid({ EARLY_AUCTIONS: 27, EARLY_KAPPA_SCALE: 0.5 }), 25, "index 27 is past the first 27");
  assert.equal(bid({ EARLY_AUCTIONS: 28 }), 25, "scale 1: off");
  assert.equal(bid({ EARLY_AUCTIONS: 28, EARLY_KAPPA_SCALE: 0.5 }, { auctionsPerMatch: undefined }), Math.floor(KAPPA * 5), "unpaced: off");
  // In a duel (index 27 of 88) only when EARLY_MIN_REAL_RIVALS allows it: kappa 3 halved, 3 rather than 6.
  assert.equal(bid({ EARLY_AUCTIONS: 30, EARLY_KAPPA_SCALE: 0.5, EARLY_MIN_REAL_RIVALS: 1 }, duel), 3);
  assert.equal(bid({ EARLY_AUCTIONS: 30, EARLY_KAPPA_SCALE: 0.5, EARLY_MIN_REAL_RIVALS: 2 }, duel), 6);
  assert.equal(bid({ ...DEFAULT_POLICY, PACED_KAPPA: 4 }, duel), 6, "the live policy exempts duels");
});

test("policy: word, flush and leave knobs set in the policy move chooseWords, flushLeadMs and alphaFor", () => {
  const play = (rack: string, myBalance: number, realRivals: number, o: Partial<Policy>, bagTotal?: number) => {
    const counts = countsOf(rack);
    return chooseWords(INDEX, {
      counts, cands: INDEX.scan(counts, true), myBalance, flush: false, realRivals, bagTotal, policy: withPolicy(o),
    });
  };
  assert.deepEqual(play("RETAINSQ", 100, 1, {}), ["QINTARS"]);
  // HOLD_FROM_BAG: at a hold table, cash 7+ words while at least that many auctions are to come.
  assert.deepEqual(play("RETAINSQ", 100, 5, {}, 40), []);
  assert.deepEqual(play("RETAINSQ", 100, 5, { HOLD_FROM_BAG: 30 }, 40), ["QINTARS"]);
  assert.deepEqual(play("RETAINSQ", 100, 5, { HOLD_FROM_BAG: 30 }, 30), ["QINTARS"]);
  assert.deepEqual(play("RETAINSQ", 100, 5, { HOLD_FROM_BAG: 30 }, 29), []);
  assert.deepEqual(play("RETAINSQ", 100, 5, { HOLD_FROM_BAG: 30 }), [], "bag unknown: hold");
  assert.deepEqual(play("RETAINSQ", 100, 1, { CASH_MIN_LEN: 8 }), []);
  assert.deepEqual(play("RETAINSQ", 100, 1, { HOLD_MIN_REAL_RIVALS: 1 }), []);
  assert.deepEqual(play("RETAINSQ", 100, 5, { HOLD_MIN_REAL_RIVALS: 6 }), ["QINTARS"]);
  assert.deepEqual(play("JUTTEDVG", 10, 5, {}), ["JUTTED"]);
  assert.deepEqual(play("JUTTEDVG", 10, 5, { LIQUIDITY_FLOOR: 10 }), [], "at the floor: no liquidity word");
  assert.deepEqual(play("JUTTEDVG", 10, 5, { LIQUIDITY_MIN_LEN: 7, LIQUIDITY_FALLBACK_MIN_LEN: 7 }), []);
  assert.equal(flushLeadMs([], withPolicy({ FLUSH_LEAD_MS: 5000 })), 5000);
  assert.equal(flushLeadMs([50, 60, 3000], withPolicy({ FLUSH_LEAD_MS: 5000 })), 6900); // 2 x 2950 + 1000
  assert.equal(flushLeadMs([50, 60, 3000], withPolicy({ FLUSH_LEAD_MS: 8000 })), 8000);
  assert.equal(alphaFor(false, withPolicy({ LEAVE_ALPHA: 0.5 })), 0.5);
  assert.equal(alphaFor(true, withPolicy({ LEAVE_ALPHA: 0.5 })), 0);
  assert.equal(alphaFor(false), LEAVE_ALPHA);
  // Leave decay: below LEAVE_DECAY_BAG auctions to come, alpha x (bagTotal + 1) / LEAVE_DECAY_BAG.
  const decay = withPolicy({ LEAVE_ALPHA: 0.4, LEAVE_DECAY_BAG: 20 });
  assert.equal(alphaFor(false, decay, 30), 0.4);
  assert.equal(alphaFor(false, decay, 19), 0.4);
  assert.ok(Math.abs(alphaFor(false, decay, 9) - 0.2) < 1e-12);
  assert.equal(alphaFor(true, decay, 9), 0);
  assert.equal(alphaFor(false, decay), 0.4, "bag unknown: no decay");
  assert.equal(alphaFor(false, DEFAULT_POLICY, 3), LEAVE_ALPHA, "off by default");
});

// ---- round 2 levers: COMPLETE7_PREMIUM, CASH_WHEN_BROKE, DEAD_KAPPA_SCALE (all off by default) ----

test("round 2 levers are off in DEFAULT_POLICY, and their inputs then change nothing", () => {
  assert.equal(DEFAULT_POLICY.COMPLETE7_PREMIUM, 1);
  assert.equal(DEFAULT_POLICY.COMPLETE7_CAP_SHARE, 1);
  assert.equal(DEFAULT_POLICY.CASH_BROKE_BALANCE, 0);
  assert.equal(DEFAULT_POLICY.CASH_BROKE_AUCTIONS, 0);
  assert.equal(DEFAULT_POLICY.DEAD_KAPPA_SCALE, 1);
  const spots = [
    { letter: "S", delta: 5, bagTotal: 39, auctionsPerMatch: 68 },
    { letter: "S", delta: 0.35 * LEAVE_W7.S, bagTotal: 39, auctionsPerMatch: 68 }, // a dead letter's value
    { letter: "Q", delta: 12, bagTotal: 60, auctionsPerMatch: 68 }, // early window
    { letter: "E", delta: 3, bagTotal: 5, auctionsPerMatch: 68 }, // endgame
  ];
  for (const spot of spots) {
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
      const base = { ...spot, auctionType, myBalance: 100, opponents: REAL };
      const plain = decideBid(base);
      for (const extras of [{ completes7: true, leaveAlpha: 0.35 }, { completes7: false }, { leaveAlpha: 0 }]) {
        assert.deepEqual(decideBid({ ...base, ...extras }), plain, `${JSON.stringify(spot)} ${auctionType}`);
        assert.deepEqual(decideBid({ ...base, ...extras, policy: DEFAULT_POLICY }), plain);
      }
    }
  }
  const play = (rack: string, myBalance: number, bagTotal?: number) => {
    const counts = countsOf(rack);
    return chooseWords(INDEX, { counts, cands: INDEX.scan(counts, true), myBalance, flush: false, realRivals: 5, bagTotal });
  };
  // Held whatever the bag position, ones no match has included (HOLD_FROM_BAG 999 and CASH_BROKE_AUCTIONS 0 are off).
  for (const bag of [undefined, 0, 1, 19, 40, 98, 999, 1000, NaN, Infinity, -1]) {
    assert.deepEqual(play("RETAINSQ", 20, bag), [], `bag ${bag}: held`);
  }
});

test("COMPLETE7_PREMIUM: a letter that completes a 7+ word is bid at the factor, the raise capped by a share of the balance", () => {
  // Six-seat all-real table, index 28 (past the early window): kappa 4 (PACED_KAPPA, pinned) x sqrt(1.7) = 5.2154, delta 5: 26.
  const bid = (o: Partial<Policy>, x: Partial<Parameters<typeof decideBid>[0]> = {}) =>
    decideBid({
      letter: "S", delta: 5, bagTotal: 39, auctionType: "Vickrey", myBalance: 100, opponents: REAL,
      auctionsPerMatch: 68, ...x, policy: withPolicy({ PACED_KAPPA: 4, ...o }),
    });
  assert.deepEqual(bid({}), { amount: 26, reason: "k5.2154" });
  assert.deepEqual(bid({ COMPLETE7_PREMIUM: 2 }, { completes7: true }), { amount: 52, reason: "k5.2154 c7 x2" });
  assert.equal(bid({ COMPLETE7_PREMIUM: 2 }, { completes7: false }).amount, 26);
  assert.equal(bid({ COMPLETE7_PREMIUM: 2 }).amount, 26, "unknown: no premium");
  assert.equal(bid({}, { completes7: true }).amount, 26, "premium 1: off");
  // The raise stops at the cap (30% of 100), and never takes a bid below the plain one (10% of 100 = 10 < 26).
  assert.deepEqual(bid({ COMPLETE7_PREMIUM: 2, COMPLETE7_CAP_SHARE: 0.3 }, { completes7: true }), { amount: 30, reason: "k5.2154 c7 x2" });
  assert.deepEqual(bid({ COMPLETE7_PREMIUM: 2, COMPLETE7_CAP_SHARE: 0.1 }, { completes7: true }), { amount: 26, reason: "k5.2154" });
  // First price shades the raised bid (no history: 40% of 52).
  assert.equal(bid({}, { auctionType: "FirstPrice" }).amount, 10);
  assert.equal(bid({ COMPLETE7_PREMIUM: 2 }, { auctionType: "FirstPrice", completes7: true }).amount, 20);
  // The rival cap and the duel reserve still apply after it: 20 coins in a duel, 10 held back.
  const duel = { opponents: [{ isSim: false, balance: 100 }], myBalance: 20, bagTotal: 60, auctionsPerMatch: 88, delta: 2, completes7: true };
  assert.deepEqual(bid({ COMPLETE7_PREMIUM: 3 }, duel), { amount: 10, reason: "k3 c7 x3 duel-reserve 10" });
  assert.equal(bid({ COMPLETE7_PREMIUM: 9 }, { completes7: true, opponents: Array.from({ length: 5 }, () => ({ isSim: false, balance: 40 })) }).amount, 41);
  // A sims-only Vickrey table keeps its own rule.
  const sims = { letter: "E", delta: 0.25, opponents: [{ isSim: true, strategy: "Aggressive" as const, balance: 100 }], completes7: true };
  assert.deepEqual(bid({ COMPLETE7_PREMIUM: 3 }, sims), bid({}, sims));
});

test("sevenCompleterMask: letters that put a 7+ letter word into the rack's packing, a second one included", () => {
  const mask = (rack: string) => {
    const c = countsOf(rack);
    return sevenCompleterMask(INDEX, INDEX.scan(c, true), c, LEAVE_ALPHA);
  };
  const letters = (m: number) => [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((_, i) => ((m >>> i) & 1) === 1).join("");
  assert.equal(letters(mask("RETAIN")), "CDEFGHIKLMNPRSTUW"); // RETAINS, CERTAIN, DETRAIN, ...
  assert.ok(letters(mask("AEINST")).includes("R"));
  assert.equal(mask("QUIZ"), 0, "no 7+ word within one tile");
  assert.equal(mask("RETAINSQ"), 0, "QINTARS is already there and no letter adds a second");
  // A rack whose packing holds MYXOMATA + COOTER: an S (or A, C, D, E, F, N, P, U, W) adds a second 7+ word.
  assert.equal(letters(mask("MOOAYROTMECAXTR")), "ACDEFNPSUW");
  const c = countsOf("MOOAYROTMECAXTR");
  const cands = INDEX.scan(c, true);
  const sevens = (extra: number) => INDEX.pack(cands, c, extra, LEAVE_ALPHA).keys.filter((k) => INDEX.len[k] >= 7).length;
  assert.equal(sevens(-1), 1);
  assert.equal(sevens(letterIndex("S")), 2);
  assert.equal(sevens(letterIndex("B")), 1);
});

test("CASH_WHEN_BROKE: a table that holds words cashes 7+ words while broke, or all of them late in the match", () => {
  const play = (rack: string, myBalance: number, o: Partial<Policy>, bagTotal?: number, realRivals = 5) => {
    const counts = countsOf(rack);
    return chooseWords(INDEX, {
      counts, cands: INDEX.scan(counts, true), myBalance, flush: false, realRivals, bagTotal, policy: withPolicy(o),
    });
  };
  // Balance: under CASH_BROKE_BALANCE the best 7+ word is cashed, one at a time until the balance is back.
  assert.deepEqual(play("RETAINSQ", 20, {}, 40), []);
  assert.deepEqual(play("RETAINSQ", 20, { CASH_BROKE_BALANCE: 30 }, 40), ["QINTARS"]);
  assert.deepEqual(play("RETAINSQ", 30, { CASH_BROKE_BALANCE: 30 }, 40), [], "at the threshold: hold");
  assert.deepEqual(play("QINTARSJUKEBOX", 20, { CASH_BROKE_BALANCE: 50 }, 40), ["JUKEBOX"], "81 coins after one");
  assert.deepEqual(play("QINTARSJUKEBOX", 0, { CASH_BROKE_BALANCE: 200 }, 40), ["JUKEBOX", "QINTARS"]);
  // Auctions: below CASH_BROKE_AUCTIONS to come every 7+ word is cashed; never with the bag unknown.
  assert.deepEqual(play("QINTARSJUKEBOX", 100, { CASH_BROKE_AUCTIONS: 20 }, 19), ["JUKEBOX", "QINTARS"]);
  assert.deepEqual(play("RETAINSQ", 100, { CASH_BROKE_AUCTIONS: 20 }, 20), []);
  assert.deepEqual(play("RETAINSQ", 100, { CASH_BROKE_AUCTIONS: 20 }), []);
  // Words under CASH_MIN_LEN stay held, and the liquidity word still comes after (JUTTED, 35 coins).
  assert.deepEqual(play("JUTTEDVG", 20, { CASH_BROKE_BALANCE: 30 }, 40), []);
  assert.deepEqual(play("JUTTEDVG", 10, { CASH_BROKE_BALANCE: 30 }, 40), ["JUTTED"]);
  // Tables that do not hold cash 7+ words as they form anyway.
  assert.deepEqual(play("RETAINSQ", 100, { CASH_BROKE_BALANCE: 30 }, 40, 1), ["QINTARS"]);
  assert.deepEqual(play("RETAINSQ", 100, {}, 40, 1), ["QINTARS"]);
});

test("DEAD_KAPPA_SCALE: a letter worth no more than its leave value is bid at the scaled kappa", () => {
  const dead = 0.35 * LEAVE_W7.S; // 2.38: what valuate gives a letter that joins no word
  assert.ok(isDeadLetter("S", dead, 0.35));
  assert.ok(isDeadLetter("S", dead + 1e-12, 0.35), "repacking noise");
  assert.ok(!isDeadLetter("S", dead + 0.01, 0.35));
  assert.ok(!isDeadLetter("S", 0.5, 0), "flushing: nothing with value is dead");
  assert.ok(!isDeadLetter("?", 0, 0.35));
  const bid = (o: Partial<Policy>, x: Partial<Parameters<typeof decideBid>[0]> = {}) =>
    decideBid({
      letter: "S", delta: dead, bagTotal: 39, auctionType: "Vickrey", myBalance: 100, opponents: REAL,
      auctionsPerMatch: 68, ...x, policy: withPolicy({ PACED_KAPPA: 4, ...o }), // worked at PACED_KAPPA 4
    });
  assert.deepEqual(bid({}, { leaveAlpha: 0.35 }), { amount: 12, reason: "k5.2154" });
  assert.deepEqual(bid({ DEAD_KAPPA_SCALE: 0.5 }, { leaveAlpha: 0.35 }), { amount: 6, reason: "k2.6077 dead x0.5" });
  assert.deepEqual(bid({ DEAD_KAPPA_SCALE: 1.5 }, { leaveAlpha: 0.35 }), { amount: 18, reason: "k7.823 dead x1.5" });
  assert.equal(bid({ DEAD_KAPPA_SCALE: 0.5 }).amount, 12, "no leave weight: not known to be dead");
  assert.equal(bid({ DEAD_KAPPA_SCALE: 0.5 }, { leaveAlpha: 0.35, delta: 5 }).amount, 26, "a useful letter");
  assert.equal(bid({ DEAD_KAPPA_SCALE: 0.5 }, { leaveAlpha: 0.35, auctionType: "FirstPrice" }).amount, 2, "40% of 6");
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
    // COMPLETE7_PREMIUM adds the 7+ completer mask to each table (bot.ts valuation), off the bid path too.
    const v = valuate(INDEX, countsOf(r), 0.35);
    let mask = Infinity;
    for (let i = 0; i < 3; i++) mask = Math.min(mask, cpuMs(() => sevenCompleterMask(INDEX, v.cands, countsOf(r), 0.35)));
    t.diagnostic(`${r}: 7+ completer mask ${mask.toFixed(1)} ms of CPU`);
    assert.ok(mask < 120, `${r}: mask took ${mask.toFixed(1)} ms of CPU (best of 3)`);
  }
  const buildMs = cpuMs(() => WordIndex.fromWords(WORDLIST));
  t.diagnostic(`index build: ${buildMs.toFixed(0)} ms of CPU`);
  assert.ok(buildMs < 5000, `index build ${buildMs.toFixed(0)} ms of CPU`);
});

test("ALLIN_LAST: at bagTotal 1 a letter with value is bid min(balance, richest rival + 1), no duel reserve, no sims", () => {
  const bid = (o: Partial<Policy>, x: Partial<Parameters<typeof decideBid>[0]> = {}) =>
    decideBid({
      letter: "S", delta: 3, bagTotal: 1, auctionType: "Vickrey", myBalance: 100, opponents: REAL,
      auctionsPerMatch: 68, ...x, policy: withPolicy(o),
    });
  const on = { ALLIN_LAST: 1 };
  const off = { ALLIN_LAST: 0 };
  assert.equal(bid(on).amount, 100);
  assert.match(bid(on).reason, /all-in last/);
  assert.equal(bid(on, { myBalance: 40 }).amount, 40);
  const poorer = Array.from({ length: 5 }, (_, i) => ({ isSim: false, balance: 10 + i * 5 }));
  assert.equal(bid(on, { opponents: poorer }).amount, 31);
  assert.equal(bid(on, { auctionType: "FirstPrice", opponents: poorer }).amount, 31);
  // At other auctions, without value, or with a sim seated: exactly the 9f1faba bid (ALLIN_LAST 0).
  for (const x of [{ bagTotal: 2 }, { bagTotal: 0 }, { delta: 0 }, { bagTotal: 30 }]) {
    assert.deepEqual(bid(on, x), bid(off, x), JSON.stringify(x));
  }
  assert.ok(bid(off).amount < 100, "9f1faba at bagTotal 1 is a value bid");
  const withSim = [...REAL.slice(0, 4), { isSim: true, strategy: "Aggressive" as const, balance: 100 }];
  assert.deepEqual(bid(on, { opponents: withSim }), bid(off, { opponents: withSim }));
  // Duel: 9f1faba holds back a 1-coin reserve at bagTotal 1; all-in spends it.
  const duel = { opponents: [{ isSim: false, balance: 100 }], myBalance: 20, auctionsPerMatch: 88 };
  assert.ok(bid(off, duel).amount <= 19);
  assert.equal(bid(on, duel).amount, 20);
});

test("FP_SURPLUS: the first-price bid maximizes (value - b) x G(b), floored at the quantile target", () => {
  const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  // G(19) = 9.5 / 10: (30 - 19) x 0.95 = 10.45 beats 10 at 20 and 10.2 at 18.
  assert.equal(strategy.surplusBid(30, prices, 11, 30), 19);
  assert.equal(strategy.surplusBid(30, prices, 11, 18), 18, "capped at hi");
  assert.equal(strategy.surplusBid(12, prices, 11, 12), 11);
  assert.equal(strategy.surplusBid(30, prices, 25, 30), 25, "never below the floor");
  assert.equal(strategy.surplusBid(30, [], 5, 30), 5);
  const bid = (o: Partial<Policy>, delta: number) =>
    decideBid({
      letter: "S", delta, bagTotal: 40, auctionType: "FirstPrice", myBalance: 100, opponents: REAL,
      auctionsPerMatch: 68, fpHistory: prices.map((paid) => ({ face: 1, paid })), policy: withPolicy(o),
    });
  // Head caps every letter at the 0.2 quantile + 1 (11 + 1 = 12), a completer worth 40 coins as a filler.
  assert.equal(bid({}, 12).amount, 12);
  const hi = bid({ FP_SURPLUS: 1 }, 12);
  assert.ok(hi.amount > 12, `surplus bid ${hi.amount}`);
  assert.match(hi.reason, /surplus/);
  // A letter worth little keeps the head bid (the floor).
  assert.equal(bid({ FP_SURPLUS: 1 }, 2).amount, bid({}, 2).amount);
  // The search stops at what can be spent (Codex review, finals-patch): balance 10 with prices [1, 50 x4]
  // must not pick 51 and be clamped to 10 (same win chance as the head bid 2, less surplus).
  const poor = (o: Partial<Policy>, x: Partial<Parameters<typeof decideBid>[0]>) =>
    decideBid({
      letter: "S", delta: 60, bagTotal: 40, auctionType: "FirstPrice", myBalance: 10, opponents: REAL, auctionsPerMatch: 68,
      fpHistory: [1, 50, 50, 50, 50].map((paid) => ({ face: 1, paid })), policy: withPolicy(o), ...x,
    }).amount;
  assert.equal(poor({}, {}), 2);
  assert.equal(poor({ FP_SURPLUS: 1 }, {}), 2);
  // Duel: the reserve (10 coins at 40 to come) caps the search at max(balance - 10, balance / 41) = 40.
  const duelOpp = { opponents: [{ isSim: false, balance: 100 }], myBalance: 50, auctionsPerMatch: 88, delta: 60 };
  // Capped at the balance only, the search would pick 50 and the reserve clamp would submit 40 (same win
  // chance as 2, less surplus); capped at the reserve too, it keeps the floor.
  assert.equal(poor({}, duelOpp), 2);
  assert.equal(poor({ FP_SURPLUS: 1 }, duelOpp), 2);
  // Vickrey is untouched.
  const v = (o: Partial<Policy>) =>
    decideBid({ letter: "S", delta: 12, bagTotal: 40, auctionType: "Vickrey", myBalance: 100, opponents: REAL, auctionsPerMatch: 68, policy: withPolicy(o) });
  assert.deepEqual(v({ FP_SURPLUS: 1 }), v({}));
});

test("EARLY_LEN_SEATS: at 7+ seats the early-cut window is round(28 x auctions / 68)", () => {
  const seats = (n: number) => Array.from({ length: n - 1 }, () => ({ isSim: false, balance: 100 }));
  const bid = (o: Partial<Policy>, n: number, idx: number) => {
    const apm = 98 - 5 * n;
    return decideBid({
      letter: "S", delta: 5, bagTotal: apm - 1 - idx, auctionType: "Vickrey", myBalance: 100, opponents: seats(n),
      auctionsPerMatch: apm, policy: withPolicy(o),
    }).amount;
  };
  const on = { EARLY_LEN_SEATS: 7 };
  // 8 seats, 58 auctions: window 24. Index 25 is cut in head (window 28), not with the knob.
  assert.ok(bid(on, 8, 25) > bid({}, 8, 25));
  assert.equal(bid(on, 8, 23), bid({}, 8, 23));
  assert.equal(bid(on, 8, 30), bid({}, 8, 30));
  // 6 seats (window 28 either way) and 4 seats: unchanged.
  for (const idx of [0, 20, 27, 28, 40]) {
    assert.equal(bid(on, 6, idx), bid({}, 6, idx));
    assert.equal(bid(on, 4, idx), bid({}, 4, idx));
  }
});

// ---- field knobs: EARLY_HV_FLOOR, LATE_COMMON_CAP, COMMIT7 (all off by default) ----

test("field knobs are off in DEFAULT_POLICY, and their inputs then change nothing", () => {
  assert.equal(DEFAULT_POLICY.EARLY_HV_FLOOR, 0);
  assert.equal(DEFAULT_POLICY.EARLY_HV_AUCTIONS, 23);
  assert.equal(DEFAULT_POLICY.LATE_COMMON_CAP, 0);
  assert.equal(DEFAULT_POLICY.LATE_COMMON_AUCTIONS, 22);
  assert.equal(DEFAULT_POLICY.COMMIT7, 0);
  const spots = [
    { letter: "H", delta: 2, bagTotal: 67, auctionsPerMatch: 68 }, // early, high value
    { letter: "Q", delta: 3, bagTotal: 50, auctionsPerMatch: 68 },
    { letter: "E", delta: 6, bagTotal: 10, auctionsPerMatch: 68 }, // late, common
    { letter: "D", delta: 6, bagTotal: 21, auctionsPerMatch: 68 },
    { letter: "S", delta: 5, bagTotal: 30, auctionsPerMatch: 68 },
    { letter: "E", delta: 3, bagTotal: 1, auctionsPerMatch: 68 }, // ALLIN_LAST
  ];
  for (const spot of spots) {
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
      const base = { ...spot, auctionType, myBalance: 100, opponents: REAL };
      const plain = decideBid(base);
      for (const extras of [{ usable: true, completesWord: false }, { usable: false, completesWord: true }, { usable: true }]) {
        assert.deepEqual(decideBid({ ...base, ...extras }), plain, `${JSON.stringify(spot)} ${auctionType}`);
        assert.deepEqual(decideBid({ ...base, ...extras, policy: DEFAULT_POLICY }), plain);
      }
    }
  }
  // Words: a hold table holds RETAINSQ whatever the bag position (COMMIT7 0).
  const counts = countsOf("RETAINSQ");
  for (const bag of [undefined, 0, 1, 20, 40, 67]) {
    assert.deepEqual(
      chooseWords(INDEX, { counts, cands: INDEX.scan(counts, true), myBalance: 100, flush: false, realRivals: 5, bagTotal: bag }),
      [],
      `bag ${bag}`,
    );
  }
});

test("EARLY_HV_FLOOR: an early high-value letter is bid at least the floor x its early median price, paced, never lowered", () => {
  const bid = (o: Partial<Policy>, x: Partial<Parameters<typeof decideBid>[0]> = {}) =>
    decideBid({
      letter: "H", delta: 2, bagTotal: 67, auctionType: "Vickrey", myBalance: 100, opponents: REAL,
      auctionsPerMatch: 68, ...x, policy: withPolicy(o),
    });
  const on = { EARLY_HV_FLOOR: 1 };
  assert.equal(strategy.EARLY_HV_PRICE.H, 23);
  // First auction, even spend: head bids floor(3.8 x 0.7 x 2) = 5; the floor raises it to 1 x 23.
  assert.deepEqual(bid({}), { amount: 5, reason: "k2.66" });
  assert.deepEqual(bid(on), { amount: 23, reason: "k2.66 hv-floor 23" });
  assert.equal(bid({ EARLY_HV_FLOOR: 0.5 }).amount, 11);
  // A useful H already bid above the floor keeps its bid: floor(2.66 x 10) = 26.
  assert.deepEqual(bid(on, { delta: 10 }), bid({}, { delta: 10 }));
  // Spent ahead of pace (40 coins with 61 auctions to come): the floor shrinks by the pacing factor 0.668, so 15.
  assert.equal(bid({}, { myBalance: 40, bagTotal: 60 }).amount, 3);
  assert.equal(bid(on, { myBalance: 40, bagTotal: 60 }).amount, 15);
  // The window: auction index 22 (45 to come) is floored, index 23 (44 to come) is not.
  assert.equal(bid(on, { bagTotal: 45 }).amount, 23);
  assert.deepEqual(bid(on, { bagTotal: 44 }), bid({}, { bagTotal: 44 }));
  assert.equal(bid({ EARLY_HV_FLOOR: 1, EARLY_HV_AUCTIONS: 45 }, { bagTotal: 44 }).amount, 23);
  // K J X Q Z only when the rack has a use for the letter: Q's early median is 34.
  for (const usable of [undefined, false]) assert.deepEqual(bid(on, { letter: "Q", usable }), bid({}, { letter: "Q" }), `Q ${usable}`);
  assert.equal(bid(on, { letter: "Q", usable: true }).amount, 34);
  for (const L of "FVWY") assert.equal(bid(on, { letter: L }).amount, strategy.EARLY_HV_PRICE[L], L);
  // Other letters are untouched.
  for (const L of "EBCDMPS") assert.deepEqual(bid(on, { letter: L, usable: true }), bid({}, { letter: L }), L);
  // The rival cap still binds (richest rival 10: 11), and so does the balance.
  const poor = Array.from({ length: 5 }, () => ({ isSim: false, balance: 10 }));
  assert.equal(bid(on, { opponents: poor }).amount, 11);
  assert.equal(bid(on, { myBalance: 9 }).amount, 9);
  // First price: the floor applies to the shaded bid (no history: 40% of 5 = 2).
  assert.equal(bid({}, { auctionType: "FirstPrice" }).amount, 2);
  assert.equal(bid(on, { auctionType: "FirstPrice" }).amount, 23);
  // Duels, sim-padded tables and unpaced bids are exempt.
  const duel = { opponents: [{ isSim: false, balance: 100 }], bagTotal: 87, auctionsPerMatch: 88 };
  assert.deepEqual(bid(on, duel), bid({}, duel));
  const padded = [REAL[0], ...Array.from({ length: 4 }, () => ({ isSim: true, strategy: "Cheapskate" as const, balance: 100 }))];
  assert.deepEqual(bid(on, { opponents: padded }), bid({}, { opponents: padded }));
  assert.deepEqual(bid(on, { auctionsPerMatch: undefined }), bid({}, { auctionsPerMatch: undefined }));
});

test("LATE_COMMON_CAP: a late common letter that completes no word is capped at the cap x its median price", () => {
  const bid = (o: Partial<Policy>, x: Partial<Parameters<typeof decideBid>[0]> = {}) =>
    decideBid({
      letter: "E", delta: 6, bagTotal: 10, auctionType: "Vickrey", myBalance: 100, opponents: REAL,
      auctionsPerMatch: 68, completesWord: false, ...x, policy: withPolicy(o),
    });
  const on = { LATE_COMMON_CAP: 1.5 };
  // 100 coins with 11 auctions left: kappa 3.8 x 2.486 = 9.448, x 6 = 56; capped at floor(1.5 x 11) = 16.
  assert.deepEqual(bid({}), { amount: 56, reason: "k9.448" });
  assert.deepEqual(bid(on), { amount: 16, reason: "k9.448 late-cap 16" });
  assert.equal(bid({ LATE_COMMON_CAP: 1 }).amount, 11);
  // A letter that completes a word the bot would play, or an unknown one, is not capped.
  assert.deepEqual(bid(on, { completesWord: true }), bid({}));
  assert.deepEqual(bid(on, { completesWord: undefined }), bid({}));
  // A bid already under the cap stays: floor(9.448 x 1) = 9.
  assert.equal(bid(on, { delta: 1 }).amount, 9);
  // Each common letter by its own median (D 14: 21), other letters are untouched.
  for (const [L, med] of Object.entries(strategy.LATE_COMMON_PRICE)) assert.equal(bid(on, { letter: L }).amount, Math.floor(1.5 * med), L);
  for (const L of "BCFHMPKQZ") assert.deepEqual(bid(on, { letter: L }), bid({}, { letter: L }), L);
  // The window: 21 auctions to come is capped, 22 is not.
  assert.equal(bid(on, { bagTotal: 21 }).amount, 16);
  assert.deepEqual(bid(on, { bagTotal: 22 }), bid({}, { bagTotal: 22 }));
  // The last two auctions keep their own rules: ALLIN_LAST at 1, the final letter at 0.
  assert.deepEqual(bid(on, { bagTotal: 1 }), bid({}, { bagTotal: 1 }));
  assert.equal(bid(on, { bagTotal: 1 }).amount, 100);
  assert.deepEqual(bid(on, { bagTotal: 0 }), bid({}, { bagTotal: 0 }));
  // First price caps the shaded bid (no history: 40% of 56 = 22).
  assert.equal(bid({}, { auctionType: "FirstPrice" }).amount, 22);
  assert.equal(bid(on, { auctionType: "FirstPrice" }).amount, 16);
  // Duels and sim-padded tables are exempt.
  const duel = { opponents: [{ isSim: false, balance: 100 }], auctionsPerMatch: 88 };
  assert.deepEqual(bid(on, duel), bid({}, duel));
  const padded = [REAL[0], ...Array.from({ length: 4 }, () => ({ isSim: true, strategy: "Cheapskate" as const, balance: 100 }))];
  assert.deepEqual(bid(on, { opponents: padded }), bid({}, { opponents: padded }));
});

test("commonCompleterMask: common letters whose packing takes a word that needs exactly that letter", () => {
  const mask = (rack: string, keep = LEAVE_ALPHA) => {
    const c = countsOf(rack);
    return strategy.commonCompleterMask(INDEX, INDEX.scan(c, true), c, keep);
  };
  const letters = (m: number) => [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((_, i) => ((m >>> i) & 1) === 1).join("");
  // AINSTR + E spells RETAINS (and more 7s with A, D, G, L, O, S, T, U); AINSTR + I or N or R makes no 7 the packing takes.
  assert.equal(letters(mask("AINSTR")), "ADEGLOSTU");
  assert.equal(mask("EEEEE"), 0, "no word within one tile");
  // At the leave weight a short word does not beat its tiles' leave value; at 0 (the flush) it is taken.
  assert.equal(mask("CT"), 0);
  assert.equal(letters(mask("CT", 0)), "AEIOU");
  // Only the letters of LATE_COMMON_PRICE are checked: a consonant-only rack is completed by the vowels.
  assert.equal(letters(mask("BCDFGHM")), "AEIOU");
});

test("COMMIT7: a table that holds words cashes 7+ letter words as they form; the flush and liquidity are unchanged", () => {
  const play = (rack: string, myBalance: number, o: Partial<Policy>, bagTotal?: number, realRivals = 5, flush = false) => {
    const counts = countsOf(rack);
    return chooseWords(INDEX, {
      counts, cands: INDEX.scan(counts, true), myBalance, flush, realRivals, bagTotal, policy: withPolicy(o),
    });
  };
  const on = { COMMIT7: 1 };
  assert.deepEqual(play("RETAINSQ", 100, {}, 40), []);
  for (const bag of [undefined, 67, 40, 10, 2]) assert.deepEqual(play("RETAINSQ", 100, on, bag), ["QINTARS"], `bag ${bag}`);
  // Every 7+ word, best first, as at a table that does not hold (the same choices as HOLD_FROM_BAG 0).
  assert.deepEqual(play("QINTARSJUKEBOX", 100, on, 40), ["JUKEBOX", "QINTARS"]);
  assert.deepEqual(play("QINTARSJUKEBOX", 100, on, 40), play("QINTARSJUKEBOX", 100, { HOLD_FROM_BAG: 0 }, 40));
  // Shorter words stay held; the liquidity word still goes when broke (JUTTED, 35 coins).
  assert.deepEqual(play("JUTTEDVG", 100, on, 40), []);
  assert.deepEqual(play("JUTTEDVG", 10, on, 40), ["JUTTED"]);
  // A duel already cashes 7s; the flush plays the whole packing either way.
  assert.deepEqual(play("RETAINSQ", 100, on, 40, 1), play("RETAINSQ", 100, {}, 40, 1));
  assert.deepEqual(play("RETAINSQ", 100, on, 0, 5, true), play("RETAINSQ", 100, {}, 0, 5, true));
});
