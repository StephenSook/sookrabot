import { readFileSync } from "node:fs";
import { WordIndex, countsOf, wordReward } from "../src/engine.js";
const words = readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8").split("\n");
const dict = new Set(words.map((w) => w.trim().toUpperCase()));
const index = WordIndex.fromWords(words);
const BAG = "A9B2C2D4E12F2G3H2I9J1K1L4M2N6O8P2Q1R6S4T6U4V2W2X1Y2Z1";
const bag: string[] = [];
for (const m of BAG.matchAll(/([A-Z])(\d+)/g)) for (let i = 0; i < +m[2]; i++) bag.push(m[1]);
let seed = 999;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
for (const size of [16, 20, 24]) for (const budget of [20000, 200000]) {
  let gS = 0, eS = 0, ms = 0;
  const N = 200;
  for (let r = 0; r < N; r++) {
    const b = [...bag];
    let rack = "";
    for (let i = 0; i < size; i++) rack += b.splice(Math.floor(rnd() * b.length), 1)[0];
    const c = countsOf(rack);
    const cands = index.scan(c, false);
    const g = index.pack(cands, c, -1, 0);
    const t0 = performance.now();
    const e = index.packExact(cands, c, -1, 0, budget);
    ms += performance.now() - t0;
    // validate
    const used = countsOf(e.keys.map((k) => index.words[k]).join(""));
    for (let i = 0; i < 26; i++) if (used[i] > c[i]) throw new Error("overuse " + rack);
    let tot = 0;
    for (const k of e.keys) { const w = index.words[k]; if (!dict.has(w)) throw new Error("notword " + w); tot += wordReward(w); }
    if (tot !== e.total) throw new Error("total mismatch");
    if (r === 0 && budget === 20000) console.log(size, rack, "greedy", g.keys.map((k) => index.words[k]).join(" "), g.total, "| exact", e.keys.map((k) => index.words[k]).join(" "), e.total);
    gS += g.total; eS += e.total;
  }
  console.log(`size ${size} budget ${budget}: greedy ${(gS / N).toFixed(2)} exact ${(eS / N).toFixed(2)} ms/rack ${(ms / N).toFixed(2)}`);
}
