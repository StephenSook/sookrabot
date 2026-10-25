// Live replay of SookraBot's endgame word play (counterfactual packing; read-only, offline).
// Input: JSON rows from replay_prep.py ({m, K, late: words played in the last K s, unplayed: letters won
// and never played}). For each, the greedy and the optimal (packExact) packing of those letters, against
// the reward the live bot actually took for them.
//   npx tsx scripts/replay_words.ts <rows.json>
import * as fs from "node:fs";
import { WordIndex, countsOf } from "../src/engine.js";

const index = WordIndex.fromWords(fs.readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8").split("\n"));
const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as { m: number; K: number; late: string[]; lateReward: number; unplayed: string; score: number }[];
const value = (keys: number[]) => keys.reduce((a, k) => a + index.reward[k], 0);
const by = new Map<number, { n: number; actual: number; greedy: number; exact: number; greedyLate: number; exactLate: number; d: number[] }>();
for (const r of rows) {
  const letters = r.late.join("") + r.unplayed;
  const counts = countsOf(letters);
  const cands = index.scan(counts, false);
  const g = value(index.pack(cands, counts, -1).keys);
  const e = value(index.packExact(cands, counts, -1, 0, 200000).keys);
  const lateOnly = countsOf(r.late.join(""));
  const c2 = index.scan(lateOnly, false);
  const g2 = value(index.pack(c2, lateOnly, -1).keys);
  const e2 = value(index.packExact(c2, lateOnly, -1, 0, 200000).keys);
  const acc = by.get(r.K) ?? { n: 0, actual: 0, greedy: 0, exact: 0, greedyLate: 0, exactLate: 0, d: [] };
  acc.n++;
  acc.actual += r.lateReward;
  acc.greedy += g;
  acc.exact += e;
  acc.greedyLate += g2;
  acc.exactLate += e2;
  acc.d.push(e - r.lateReward);
  by.set(r.K, acc);
}
for (const [K, a] of by) {
  const mean = a.d.reduce((x, y) => x + y, 0) / a.n;
  const sd = Math.sqrt(a.d.reduce((x, y) => x + (y - mean) ** 2, 0) / (a.n - 1));
  console.log(JSON.stringify({
    K, n: a.n, actual: +(a.actual / a.n).toFixed(2), repackLateGreedy: +(a.greedyLate / a.n).toFixed(2), repackLateExact: +(a.exactLate / a.n).toFixed(2),
    withUnplayedGreedy: +(a.greedy / a.n).toFixed(2), withUnplayedExact: +(a.exact / a.n).toFixed(2),
    gainExactAll: { mean: +mean.toFixed(2), ci95: [+(mean - 1.96 * sd / Math.sqrt(a.n)).toFixed(2), +(mean + 1.96 * sd / Math.sqrt(a.n)).toFixed(2)] },
  }));
}
