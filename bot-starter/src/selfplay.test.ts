// Checks for the self-play harness (selfplay.ts). Run with `npm test`.
//
// The harness must test the live bot: a variant is DEFAULT_POLICY with named
// constants changed and reaches SookraBot only through its constructor, so
// "head" is the live bot and a variant that restates every default plays the
// same matches. The few matches here are short (one process, a few seconds).

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { WordIndex, countsOf, letterIndex } from "./engine.js";
import {
  FIELD_NAMES,
  POLICY_KEYS,
  RULES,
  type Row,
  V5_CALIBRATION,
  V5_TOP,
  applyRivalMods,
  compare,
  fieldSeatNames,
  parseField,
  parseRivalMods,
  parseVariant,
  pricePaid,
  rackMasks,
  readRows,
  sevenCompleters,
  shardRange,
  summarize,
  v5Model,
  validate4,
  validate5,
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

test("fixture: the old entries are kept, the v4 entries are added, and every field seats real fixture entries", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/rival-models.json", import.meta.url), "utf8")).rivals;
  for (const old of ["LetterShark", "code", "bot", "dev-voices", "code-v2", "Yezi", "tinytung", "bot-v2", "slow-n-dumb",
    "dev-voices-v2", "Yezi-ar", "code-ar", "bot-ar", "tinytung-ar", "dev-voices-ar", "slow-n-dumb-ar", "podzemski-ar"]) {
    assert.ok(fixture[old], old);
    assert.equal(fixture[old].complete7, undefined, `${old}: old entries have no v4c features`);
  }
  const live = JSON.parse(fs.readFileSync(new URL("./fixtures/rival-live-v4.json", import.meta.url), "utf8")).rivals;
  for (const stem of Object.keys(live)) {
    assert.ok(fixture[`${stem}-v4`] && fixture[`${stem}-v4c`], stem);
    assert.ok(typeof fixture[`${stem}-v4`].rho === "number" && fixture[`${stem}-v4`].complete7 === undefined, `${stem}-v4`);
  }
  assert.equal(Object.keys(live).length, 17);
  // fitted() refuses a name the fixture lacks, so building every field's seats checks every name.
  for (const name of FIELD_NAMES) {
    for (const ms of [1, 2, 3]) {
      const seats = fieldSeatNames(name, ms);
      assert.equal(seats[0], "SookraBot", name);
      assert.equal(new Set(seats).size, seats.length, `${name}: distinct seats`);
    }
  }
  assert.deepEqual(fieldSeatNames("ar6-top", 1).slice(1), ["james-v4c", "Dante-v4c", "Yezi-v4c", "keanu-v4c", "LetterShark-v4c"]);
  assert.deepEqual(fieldSeatNames("ar4-top", 1).slice(1), ["james-v4c", "Dante-v4c", "Yezi-v4c"]);
  assert.deepEqual(fieldSeatNames("ar3-top", 1).slice(1), ["james-v4c", "Dante-v4c"]);
  assert.deepEqual(fieldSeatNames("ar6-top-ar", 1).slice(1), ["Yezi-ar", "code-ar", "bot-ar", "tinytung-ar", "dev-voices-ar"]);
  assert.deepEqual(fieldSeatNames("duel-dante-v4", 1), ["SookraBot", "Dante-v4c"]);
  assert.ok(fieldSeatNames("ar6-v4", 9).slice(1).every((n) => n.endsWith("-v4c")));
  assert.ok(fieldSeatNames("ar6-v4base", 9).slice(1).every((n) => n.endsWith("-v4")));
  assert.equal(fieldSeatNames("ar8-v4", 5).length, 8);
});

test("complete7: one scan with an extra tile finds exactly the letters that complete a 7+ word", () => {
  const index = WordIndex.fromWords(fs.readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8").split("\n"));
  const bag = Object.entries(RULES.BAG).flatMap(([c, k]) => Array<string>(k).fill(c));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const has7 = (counts: Int32Array) => index.bestKey(index.scan(counts, false), counts, 7) >= 0;
  let withCompleters = 0;
  let already7 = 0;
  for (let r = 0; r < 40; r++) {
    const tiles = 8 + Math.floor(rnd() * 4);
    const rack = Array.from({ length: tiles }, () => bag[Math.floor(rnd() * bag.length)]).join("");
    const counts = countsOf(rack);
    const mask = sevenCompleters(index, counts);
    if (has7(counts)) {
      already7++;
      assert.equal(mask, 0, rack);
      continue;
    }
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const plus = new Int32Array(counts);
      plus[letterIndex(letter)]++;
      assert.equal(((mask >>> letterIndex(letter)) & 1) === 1, has7(plus), `${rack} + ${letter}`);
    }
    if (mask !== 0) withCompleters++;
  }
  assert.ok(withCompleters > 3 && already7 > 3, `both cases covered (${withCompleters} with completers, ${already7} already 7+)`);
});

test("self-play: the v4 fields play, with the v4c word policies, and validate4 sets the rivals beside live", async () => {
  for (const field of ["ar6-top", "ar7-top", "ar6-top-mixed", "duel-james-v4"]) {
    const rows = await compare(field, 1, 3, ["head"], { quiet: true });
    assert.equal(rows.length, 1);
    // These fields seat fixed rivals, so any match seed gives the same names.
    assert.deepEqual(rows[0].others.map((o) => o.name), fieldSeatNames(field, 0).slice(1), field);
    assert.ok([rows[0].score, ...rows[0].others.map((o) => o.score)].some((s) => s > 0), field);
  }
  const v = await validate4(2, 1);
  assert.ok(v.length >= 6, "six rivals a table");
  for (const s of v as { rival: string; seats: number; live: { score: number } | null; rho: number }[]) {
    assert.match(s.rival, /-v4c$/);
    assert.ok(s.live && s.live.score > 0, `${s.rival}: live numbers`);
    assert.ok(s.seats >= 1);
  }
  const fixed = (await validate4(1, 1, 0.5, "v4")) as { rival: string; rho: number; rhoFitted: boolean }[];
  assert.ok(fixed.every((s) => s.rival.endsWith("-v4") && s.rho === 0.5 && !s.rhoFitted));
  await assert.rejects(validate4(1, 1, 1), /rho/);
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

test("fixture v5: the 51 earlier entries are byte-identical, every v5 rival comes as -v5, -v5c, -v5u, -v5p, -v5g", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/rival-models.json", import.meta.url), "utf8")).rivals;
  const old = Object.keys(fixture).filter((n) => !/-v5[cupg]?$/.test(n));
  assert.equal(old.length, 51);
  // sha256 of "name=JSON" lines of the 51 entries as they were before the v5 refit (harness-sync 405aec0).
  const hash = crypto.createHash("sha256").update(old.map((n) => `${n}=${JSON.stringify(fixture[n])}`).join("\n")).digest("hex");
  assert.equal(hash, "f545f68959003c1160131738a9bd2845fad2da5743b13dd1a7ac915020a9ee9f", "the pre-v5 entries are unchanged");
  const live = JSON.parse(fs.readFileSync(new URL("./fixtures/rival-live-v5.json", import.meta.url), "utf8"));
  const stems = Object.keys(live.rivals);
  assert.equal(stems.length, 35);
  assert.equal(Object.keys(fixture).length, 51 + 5 * 35);
  for (const stem of stems) {
    for (const e of ["v5", "v5c", "v5u", "v5p", "v5g"]) assert.ok(fixture[`${stem}-${e}`], `${stem}-${e}`);
    const g = fixture[`${stem}-v5g`];
    assert.deepEqual(Object.keys(g.gainCells).sort(), [1, 4, 7, 10].flatMap((x) => [0, 1, 2, 3, 4].map((b) => `g${x}|${b}`)).sort());
    assert.equal(g.rho, 0, `${stem}-v5g has no copula`);
    assert.equal(fixture[`${stem}-v5`].complete7, undefined, `${stem}-v5 is the existing format`);
    assert.equal(fixture[`${stem}-v5c`].dead, undefined, `${stem}-v5c has no dead runs`);
    assert.ok(Object.keys(fixture[`${stem}-v5u`].dead ?? {}).length >= 1, `${stem}-v5u has dead runs`);
    const p = fixture[`${stem}-v5p`];
    assert.deepEqual(p.blockEdges, [46, 18, 10, 5], `${stem}-v5p blocks`);
    assert.equal(Object.keys(p.bid.cells).length, 25, `${stem}-v5p: five classes by five blocks`);
    assert.ok(Object.keys(p.dead ?? {}).every((k: string) => /^v(1|2|3|4|5\+)\|[0-4]$/.test(k)), `${stem}-v5p dead keys`);
    assert.ok(live.rivals[stem].score >= 0 && live.rivals[stem].matches >= 15, stem);
  }
  for (const s of V5_TOP) assert.ok(stems.includes(s), s);
  assert.equal(live.tables.length, 288);
  for (const t of live.tables) {
    assert.equal(t.length, 7, `table m${t[0]}`);
    for (const s of t.slice(1)) assert.ok(stems.includes(s), `table m${t[0]}: ${s}`);
  }
});

test("rackMasks: one scan answers which letters complete a 7+ word and what each adds to the greedy pack value", () => {
  const index = WordIndex.fromWords(fs.readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8").split("\n"));
  const bag = Object.entries(RULES.BAG).flatMap(([c, k]) => Array<string>(k).fill(c));
  let seed = 777;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const pack = (counts: Int32Array) => index.pack(index.scan(counts, false), counts, -1, 0).total;
  let useful = 0;
  let dead = 0;
  for (let r = 0; r < 30; r++) {
    const rack = Array.from({ length: 3 + Math.floor(rnd() * 9) }, () => bag[Math.floor(rnd() * bag.length)]).join("");
    const counts = countsOf(rack);
    const masks = rackMasks(index, counts);
    const [c7, use, gains] = masks;
    assert.equal(c7, sevenCompleters(index, counts), rack);
    assert.equal(rackMasks(index, countsOf(rack)), masks, `${rack}: cached`);
    const base = pack(counts);
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const plus = new Int32Array(counts);
      plus[letterIndex(letter)]++;
      const isUseful = pack(plus) > base;
      assert.equal(((use >>> letterIndex(letter)) & 1) === 1, isUseful, `${rack} + ${letter}`);
      assert.equal(gains[letterIndex(letter)], pack(plus) - base, `${rack} + ${letter}: gain`);
      if (isUseful) useful++;
      else dead++;
    }
  }
  assert.ok(useful > 50 && dead > 50, `both cases covered (${useful} useful, ${dead} dead)`);
  // Greedy packing is not monotonic: a letter can lower the pack value (a dead letter for the v5 fits, which
  // count gain <= 0 as dead). VYXDITO packs to 24, VYXDITO + R to 22.
  const [, useV, gainsV] = rackMasks(index, countsOf("VYXDITO"));
  assert.equal(gainsV[letterIndex("R")], pack(countsOf("RVYXDITO")) - pack(countsOf("VYXDITO")));
  assert.ok(gainsV[letterIndex("R")] < 0, "a negative gain");
  assert.equal((useV >>> letterIndex("R")) & 1, 0, "not useful");
});

test("rival modifiers: each changes only what it names, never the fixture entry, and bad ones are refused", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/rival-models.json", import.meta.url), "utf8")).rivals;
  const hazard = fixture["postturing-v5u"];
  const shark = fixture["Dante-v5u"];
  assert.equal(hazard.policy, "hazard");
  assert.equal(shark.policy, "shark");
  const before = JSON.stringify(hazard);
  assert.deepEqual(applyRivalMods(hazard, parseRivalMods("shark")), { ...hazard, policy: "shark", minLen: undefined, sharkLen: undefined });
  assert.equal(applyRivalMods(hazard, parseRivalMods("minlen=7")).minLen, 7);
  assert.equal(applyRivalMods(shark, parseRivalMods("minlen=7")), shark, "minlen leaves a shark alone");
  assert.equal(applyRivalMods(hazard, parseRivalMods("noc7+nodead")).dead, undefined);
  const doubled = applyRivalMods(hazard, parseRivalMods("bidx=2"));
  const cells = (doubled.bid as { cells: Record<string, [number, number][]> }).cells;
  assert.deepEqual(cells["v1|0"], hazard.bid.cells["v1|0"].map(([x, s]: [number, number]) => [2 * x, s]));
  assert.deepEqual(doubled.dead!.v1, hazard.dead.v1.map(([x, s]: [number, number]) => [2 * x, s]));
  assert.equal(JSON.stringify(hazard), before, "the fixture entry is untouched");
  assert.deepEqual(parseRivalMods(""), []);
  assert.deepEqual(parseRivalMods("-"), []);
  assert.deepEqual(parseRivalMods("shark+bidx=1.5"), ["shark", "bidx=1.5"]);
  for (const bad of ["nope", "minlen", "bidx", "shark=1", "minlen=0", "minlen=-1", "shark+", "SHARK"]) {
    assert.throws(() => parseRivalMods(bad), Error, bad);
  }
  assert.deepEqual(parseRivalMods(V5_CALIBRATION.mods), ["nongainx=0.7"], "the calibration's global modifier parses");
  // bidx scales every run including gainCells; nongainx every run but gainCells.
  const g = fixture["postturing-v5g"];
  const all = applyRivalMods(g, parseRivalMods("bidx=2"));
  const non = applyRivalMods(g, parseRivalMods("nongainx=2"));
  assert.deepEqual(all.gainCells!["g4|1"], g.gainCells["g4|1"].map(([x, s]: [number, number]) => [2 * x, s]));
  assert.deepEqual(non.gainCells, g.gainCells);
  assert.deepEqual(non.dead!["v1|1"], g.dead["v1|1"].map(([x, s]: [number, number]) => [2 * x, s]));
});

test("calibration v5k: -v5g dead and completing letters' bids times 0.7 and a scale per top rival, nothing else", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/rival-models.json", import.meta.url), "utf8")).rivals;
  assert.equal(V5_CALIBRATION.base, "v5g");
  assert.equal(V5_CALIBRATION.rho, undefined, "each rival keeps its fitted rack awareness");
  assert.deepEqual(Object.keys(V5_CALIBRATION.bidScale).sort(), [...V5_TOP].sort(), "a scale for each top rival only");
  for (const [stem, s] of Object.entries(V5_CALIBRATION.bidScale)) assert.ok(s >= 0.6 && s <= 1.6, `${stem} ${s}`);
  // A -v5k model is its -v5g entry with its dead, complete7 and cell runs' x times 0.7 x the rival's scale, applied
  // once, and everything else (gainCells included) as fitted.
  const near = (a: [number, number][], b: [number, number][], f: number) =>
    a.length === b.length && a.every(([x, s], i) => Math.abs(x - f * b[i][0]) < 1e-9 && s === b[i][1]);
  for (const [stem, f] of [["Nijello", 0.7 * V5_CALIBRATION.bidScale.Nijello], ["sardine", 0.7]] as const) {
    const g = fixture[`${stem}-v5g`];
    const k = v5Model(stem, "v5k");
    assert.deepEqual(k.gainCells, g.gainCells, `${stem}: useful letters' bids as fitted`);
    for (const key of Object.keys(g.dead)) assert.ok(near(k.dead![key], g.dead[key], f), `${stem} dead ${key}`);
    if (g.complete7) assert.ok(near(k.complete7!, g.complete7, f), `${stem} complete7`);
    for (const key of Object.keys(g.bid.cells)) assert.ok(near(k.bid.kind === "survival" ? k.bid.cells[key] : [], g.bid.cells[key], f), key);
    assert.deepEqual({ ...k, bid: undefined, dead: undefined, complete7: undefined },
      { ...g, bid: undefined, dead: undefined, complete7: undefined }, `${stem}: nothing else changes`);
  }
  assert.deepEqual(v5Model("Nijello", "v5g"), fixture["Nijello-v5g"], "v5g is the entry itself");
});

test("self-play: the v5 fields seat the calibrated rivals, and validate5 replays the live tables beside live", async () => {
  const top5 = V5_TOP.slice(0, 5).map((n) => `${n}-v5k`);
  assert.deepEqual(fieldSeatNames("ar6-top5-v5", 1).slice(1), top5);
  assert.deepEqual(fieldSeatNames("ar4-top-v5", 1).slice(1), top5.slice(0, 3));
  assert.deepEqual(fieldSeatNames("ar3-top-v5", 1).slice(1), top5.slice(0, 2));
  for (const stem of V5_TOP.slice(0, 5)) {
    assert.deepEqual(fieldSeatNames(`duel-${stem.toLowerCase()}-v5`, 1), ["SookraBot", `${stem}-v5k`]);
  }
  for (const ms of [1, 2, 3, 4, 5]) {
    const mixed = fieldSeatNames("ar6-mixed-v5", ms).slice(1);
    assert.equal(mixed.filter((n) => top5.includes(n)).length, 2, `ar6-mixed-v5 ${ms}: ${mixed}`);
    const field = fieldSeatNames("ar6-field-v5", ms).slice(1);
    assert.equal(field.length, 5);
    for (const n of [...mixed, ...field]) {
      assert.match(n, /-v5k$/);
      assert.ok(!/^(SookraBot|deleted61|deleted37)-/.test(n), n);
    }
    for (const size of [3, 4]) {
      const draw = fieldSeatNames(`ar${size}-topdraw-v5`, ms).slice(1);
      assert.equal(draw.length, size - 1);
      assert.ok(draw.every((n) => V5_TOP.slice(0, 6).map((s) => `${s}-v5k`).includes(n)), draw.join());
    }
  }
  const rows = await compare("ar6-top5-v5", 1, 3, ["head"], { quiet: true });
  assert.deepEqual(rows[0].others.map((o) => o.name), top5);
  const v = (await validate5(2, 1, undefined, "v5k")) as {
    kind: string; stem: string; seats: number; top: boolean; live: { score: number }; sim: { score: number; pack_won: number };
  }[];
  assert.ok(v.length >= 6, "one line per rival seated");
  assert.equal(v.reduce((a, s) => a + s.seats, 0), 12, "two live tables of six");
  for (const s of v) {
    assert.equal(s.kind, "validate5");
    assert.ok(s.live.score >= 0 && s.sim.pack_won >= 0, s.stem);
  }
  const fixed = (await validate5(1, 1, 0.5, "v5c", "shark")) as { rho: number; mods: string; label: string; rival: string }[];
  assert.ok(fixed.every((s) => s.rho === 0.5 && s.mods === "shark" && s.label === "rho 0.5 shark" && s.rival.endsWith("-v5c")));
  await assert.rejects(validate5(1, 1, undefined, "v4c" as "v5c"), /entries/);
  await assert.rejects(validate5(1, 1, undefined, "v5c", "nope"), /modifier/);
});
