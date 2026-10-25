// Live replay of SookraBot's word policy (read-only, offline). Holds every live auction outcome fixed
// (the letters SookraBot won, when, and what it paid; starting tiles inferred from its plays) and replays
// strategy.ts chooseWords under a policy variant: words at each auction open, the flush by FLUSH_LEAD_MS
// at 1000 ms auctions, a purchase dropped when the replayed balance cannot pay its live price.
//   npx tsx scripts/replay_policy.ts <replay2.json> <variant>...
import * as fs from "node:fs";
import { WordIndex, countsOf, wordReward } from "../src/engine.js";
import { alphaFor, chooseWords, shouldFlush } from "../src/strategy.js";
import { parseVariant } from "../src/selfplay.js";

const index = WordIndex.fromWords(fs.readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8").split("\n"));
const matches = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as { m: number; score: number; start: string; wins: [number, string, number][] }[];
const AUCTIONS = 68;
const results = new Map<string, number[]>();
for (const name of process.argv.slice(3)) {
  const p = parseVariant(name).policy;
  const scores: number[] = [];
  let dropped = 0;
  let short = 0;
  let words = 0;
  let left = 0;
  for (const mt of matches) {
    const rack = countsOf(mt.start);
    let balance = 100;
    let score = 0;
    const won = new Map(mt.wins.map(([r, L, paid]) => [r, { L, paid }]));
    for (let r = 0; r < AUCTIONS; r++) {
      const bagTotal = AUCTIONS - 1 - r;
      const flush = shouldFlush(bagTotal, 1000, p.FLUSH_LEAD_MS);
      const cands = index.scan(rack, false);
      const ws = chooseWords(index, { counts: rack, cands, myBalance: balance, flush, alpha: alphaFor(flush, p, bagTotal), realRivals: 5, bagTotal, policy: p });
      for (const w of ws) {
        const c = countsOf(w);
        if (c.some((k, i) => rack[i] < k)) continue;
        for (let i = 0; i < 26; i++) rack[i] -= c[i];
        balance += wordReward(w);
        score += wordReward(w);
        words++;
        if (w.length <= 3) short++;
      }
      const win = won.get(r);
      if (win) {
        if (balance >= win.paid) {
          balance -= win.paid;
          rack[win.L.charCodeAt(0) - 65]++;
        } else dropped++;
      }
    }
    left += rack.reduce((a, b) => a + b, 0);
    scores.push(score);
  }
  results.set(name, scores);
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const actual = matches.reduce((a, m) => a + m.score, 0) / n;
  console.log(JSON.stringify({ variant: name, n, replayScore: +mean.toFixed(2), liveScore: +actual.toFixed(2), droppedPerMatch: +(dropped / n).toFixed(2), wordsPerMatch: +(words / n).toFixed(2), shortShare: +(short / Math.max(1, words)).toFixed(3), leftPerMatch: +(left / n).toFixed(2) }));
}
const base = results.get(process.argv[3])!;
for (const [name, s] of results) {
  if (name === process.argv[3]) continue;
  const d = s.map((x, i) => x - base[i]);
  const n = d.length;
  const m = d.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) / Math.sqrt(n);
  console.log(JSON.stringify({ variant: name, vs: process.argv[3], dScore: +m.toFixed(2), ci95: [+(m - 1.96 * se).toFixed(2), +(m + 1.96 * se).toFixed(2)] }));
}
