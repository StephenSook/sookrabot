// Word engine: scoring, an anagram index over the wordlist, greedy rack
// packing and the marginal-value table used for bidding.
//
// Pure functions only (no network, no timers), so every number here can be
// unit tested and cross-checked against the Python prototype
// (scrabble-analysis/scripts/sim.py), which this file mirrors:
//   - reward(word) = floor(base * num / den), multiplier 1, 3/2, 2, 5/2, 3
//     for lengths <=3, 4, 5, 6, 7+ (spacetimedb/src/letters.ts)
//   - best word = max of (reward * 64 + length), ties to the anagram key that
//     first appears in the lexicographically sorted wordlist
//   - greedy packing = take the best word repeatedly until nothing fits
//   - value(rack) = packing total + alpha * sum of LEAVE_W7 over leftover tiles

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Standard Scrabble letter values (spacetimedb/src/letters.ts).
export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

// Measured marginal value of a letter added to a random 7-tile rack under
// optimal packing (analysis.py E5). The prototype uses it as the leave value
// of a held tile; copied verbatim from sim.py W7.
export const LEAVE_W7: Record<string, number> = {
  A: 6.38, B: 6.75, C: 7.17, D: 5.79, E: 6.87, F: 7.39, G: 5.55, H: 8.61,
  I: 5.53, J: 8.8, K: 9.64, L: 5.41, M: 7.66, N: 5.06, O: 6.32, P: 7.11,
  Q: 4.61, R: 5.2, S: 6.8, T: 4.92, U: 5.52, V: 4.82, W: 6.57, X: 10.54,
  Y: 8.93, Z: 11.91,
};

const VALUE_BY_INDEX = Int32Array.from(LETTERS, (c) => LETTER_VALUE[c]);
const W7_BY_INDEX = Float64Array.from(LETTERS, (c) => LEAVE_W7[c]);

/** Letter counts indexed 0..25 (A..Z). */
export type Counts = Int32Array;

export function letterIndex(c: string): number {
  const i = c.charCodeAt(0) - 65;
  return i >= 0 && i < 26 && c.length === 1 ? i : -1;
}

export function emptyCounts(): Counts {
  return new Int32Array(26);
}

export function countsOf(src: string | Map<string, number>): Counts {
  const out = new Int32Array(26);
  if (typeof src === "string") {
    for (const c of src.toUpperCase()) {
      const i = letterIndex(c);
      if (i >= 0) out[i]++;
    }
  } else {
    for (const [c, n] of src) {
      const i = letterIndex(c.toUpperCase());
      if (i >= 0 && n > 0) out[i] += n;
    }
  }
  return out;
}

export function countsKey(counts: Counts): string {
  let s = "";
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < counts[i]; j++) s += LETTERS[i];
  }
  return s;
}

export function tileCount(counts: Counts): number {
  let n = 0;
  for (let i = 0; i < 26; i++) n += counts[i];
  return n;
}

/** Multiplier as an integer fraction (letters.ts). */
export function multiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

/** Reward the server pays for a word: floor(base * num / den). */
export function wordReward(word: string): number {
  let base = 0;
  for (const c of word.toUpperCase()) base += LETTER_VALUE[c] ?? 0;
  const [num, den] = multiplier(word.length);
  return Math.floor((base * num) / den);
}

export interface Candidates {
  /** Key ids in priority order (best word first). */
  keys: Int32Array;
  /** -1 when the key fits the rack; otherwise the one letter it needs extra. */
  extra: Int8Array;
  n: number;
}

export interface PackResult {
  /** Sum of rewards of the packed words. */
  total: number;
  /** Key ids of the packed words, in the order they were taken. */
  keys: number[];
  /** Tiles left after packing. */
  leftover: Counts;
}

/**
 * Anagram index. Keys (sorted-letter multisets) are stored in priority order:
 * reward * 64 + length descending, then first appearance in the sorted
 * wordlist ascending. Scanning in this order yields candidates already
 * ranked, so greedy packing is one pass over the candidate list.
 */
export class WordIndex {
  readonly size: number;
  /** Representative word per key (lexicographically first anagram). */
  readonly words: string[];
  readonly reward: Uint16Array;
  readonly len: Uint8Array;
  /** Sum of LEAVE_W7 over each key's letters (in key order, like sim.py). */
  readonly keyLeave: Float64Array;
  private readonly mask: Uint32Array;
  private readonly offset: Uint32Array;
  private readonly letters: Uint8Array;
  private readonly scratch = new Int32Array(26);

  private constructor(entries: { word: string; key: string; reward: number }[]) {
    const n = entries.length;
    this.size = n;
    this.words = new Array<string>(n);
    this.reward = new Uint16Array(n);
    this.len = new Uint8Array(n);
    this.keyLeave = new Float64Array(n);
    this.mask = new Uint32Array(n);
    this.offset = new Uint32Array(n + 1);
    let total = 0;
    for (const e of entries) total += e.key.length;
    this.letters = new Uint8Array(total);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      this.words[i] = e.word;
      this.reward[i] = e.reward;
      this.len[i] = e.key.length;
      this.offset[i] = p;
      let m = 0;
      let leave = 0;
      for (let j = 0; j < e.key.length; j++) {
        const li = e.key.charCodeAt(j) - 65;
        this.letters[p++] = li;
        m |= 1 << li;
        leave += W7_BY_INDEX[li];
      }
      this.mask[i] = m >>> 0;
      this.keyLeave[i] = leave;
    }
    this.offset[n] = p;
  }

  /** Build from raw wordlist lines (any case; non A-Z and 1-letter lines dropped). */
  static fromWords(lines: Iterable<string>): WordIndex {
    const set = new Set<string>();
    for (const raw of lines) {
      const w = raw.trim().toUpperCase();
      if (w.length >= 2 && /^[A-Z]+$/.test(w)) set.add(w);
    }
    const sorted = Array.from(set).sort();
    const seen = new Map<string, number>();
    const entries: { word: string; key: string; reward: number; order: number }[] = [];
    for (const w of sorted) {
      const key = w.split("").sort().join("");
      if (seen.has(key)) continue;
      seen.set(key, entries.length);
      entries.push({ word: w, key, reward: wordReward(w), order: entries.length });
    }
    entries.sort((a, b) => {
      const pa = a.reward * 64 + a.key.length;
      const pb = b.reward * 64 + b.key.length;
      return pb - pa || a.order - b.order;
    });
    return new WordIndex(entries);
  }

  keyString(k: number): string {
    let s = "";
    for (let p = this.offset[k]; p < this.offset[k + 1]; p++) {
      s += LETTERS[this.letters[p]];
    }
    return s;
  }

  /**
   * Keys spellable from `counts`, plus (when allowExtra) keys that need
   * exactly one more tile of a single letter, tagged with that letter.
   * One pass over the whole index.
   */
  scan(counts: Counts, allowExtra: boolean): Candidates {
    const tiles = tileCount(counts);
    const maxLen = tiles + (allowExtra ? 1 : 0);
    let rackMask = 0;
    for (let i = 0; i < 26; i++) if (counts[i] > 0) rackMask |= 1 << i;
    const need = this.scratch;
    need.set(counts);
    const keys: number[] = [];
    const extra: number[] = [];
    const { len, mask, offset, letters } = this;
    for (let k = 0; k < this.size; k++) {
      if (len[k] > maxLen) continue;
      const missing = (mask[k] & ~rackMask) >>> 0;
      if (missing !== 0 && (!allowExtra || (missing & (missing - 1)) !== 0)) continue;
      const start = offset[k];
      const end = offset[k + 1];
      let over = 0;
      let overLetter = -1;
      let p = start;
      for (; p < end; p++) {
        const c = letters[p];
        if (--need[c] < 0) {
          over++;
          overLetter = c;
          if (over > 1 || !allowExtra) {
            p++;
            break;
          }
        }
      }
      for (let q = start; q < p; q++) need[letters[q]]++;
      if (over === 0) {
        keys.push(k);
        extra.push(-1);
      } else if (over === 1 && allowExtra) {
        keys.push(k);
        extra.push(overLetter);
      }
    }
    return {
      keys: Int32Array.from(keys),
      extra: Int8Array.from(extra),
      n: keys.length,
    };
  }

  /** Take key k from rem if it fits; returns whether it was taken. */
  private take(k: number, rem: Counts): boolean {
    const start = this.offset[k];
    const end = this.offset[k + 1];
    let p = start;
    let ok = true;
    for (; p < end; p++) {
      if (--rem[this.letters[p]] < 0) {
        ok = false;
        p++;
        break;
      }
    }
    if (!ok) for (let q = start; q < p; q++) rem[this.letters[q]]++;
    return ok;
  }

  /** Whether key k is spellable from counts (counts unchanged). */
  fits(k: number, counts: Counts): boolean {
    const rem = new Int32Array(counts);
    return this.take(k, rem);
  }

  /**
   * Greedy packing of `counts` plus one optional extra tile (`extraLetter`
   * 0..25, or -1 for none), restricted to candidates from `scan`.
   * With keepWeight > 0, a word is only taken when its reward beats
   * keepWeight x the leave value of its own tiles (holding them is worth
   * more otherwise), so adding a tile can never force a bad word.
   * keepWeight 0 packs every word that fits (the end-of-match flush).
   */
  pack(cands: Candidates, counts: Counts, extraLetter = -1, keepWeight = 0): PackResult {
    const rem = new Int32Array(counts);
    if (extraLetter >= 0) rem[extraLetter]++;
    let remTiles = tileCount(rem);
    let total = 0;
    const keys: number[] = [];
    for (let i = 0; i < cands.n && remTiles >= 2; i++) {
      const e = cands.extra[i];
      if (e !== -1 && e !== extraLetter) continue;
      const k = cands.keys[i];
      if (keepWeight > 0 && this.reward[k] <= keepWeight * this.keyLeave[k]) continue;
      const l = this.len[k];
      while (l <= remTiles && this.take(k, rem)) {
        total += this.reward[k];
        keys.push(k);
        remTiles -= l;
      }
    }
    return { total, keys, leftover: rem };
  }

  /** Best word (by reward, then length) of at least minLen letters, or -1. */
  bestKey(cands: Candidates, counts: Counts, minLen: number): number {
    const rem = new Int32Array(counts);
    const tiles = tileCount(rem);
    for (let i = 0; i < cands.n; i++) {
      if (cands.extra[i] !== -1) continue;
      const k = cands.keys[i];
      const l = this.len[k];
      if (l < minLen || l > tiles) continue;
      if (this.take(k, rem)) return k;
    }
    return -1;
  }

  /** Subtract key k's letters from counts in place. */
  consume(counts: Counts, k: number): void {
    for (let p = this.offset[k]; p < this.offset[k + 1]; p++) {
      counts[this.letters[p]]--;
    }
  }
}

/** Leave value: sum of LEAVE_W7 over tiles, summed in A..Z order like sim.py. */
export function leaveSum(leftover: Counts): number {
  let s = 0;
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < leftover[i]; j++) s += W7_BY_INDEX[i];
  }
  return s;
}

export function packValue(p: PackResult, alpha: number): number {
  return p.total + alpha * leaveSum(p.leftover);
}

export interface Valuation {
  rackKey: string;
  alpha: number;
  /** scan(counts, true) for this rack; reusable for word choice. */
  cands: Candidates;
  /** Greedy packing of the rack itself. */
  base: PackResult;
  baseValue: number;
  /** delta[i] = value(rack + letter i) - value(rack). */
  delta: Float64Array;
  /** Wall time to compute, ms. */
  ms: number;
}

/**
 * Marginal value of each of the 26 letters for this rack.
 * mode "leave" (default, used by the bot): packing keeps tiles whose leave
 * value beats the word they would form. Sim (leave_sim.py, 400 deal-paired
 * matches, kappa 4.25): +18.5 points vs the forced packing in a mixed field,
 * +13.7 vs prototype hoarders, +34.7 vs sims.
 * In "leave" mode the value of rack + L is also never below keeping the
 * rack's own packing and adding L to the leave, so delta[L] >= alpha x
 * LEAVE_W7[L] >= 0 (greedy repacking alone is not monotonic: Codex found
 * ANPQT 16.2595 but ANPQT + C repacked to 15.3845). Sim: neutral (-1.4,
 * SE 1.0, mixed field; +0.1, SE 0.5, vs hoarders).
 * mode "forced": the prototype's packing (every word that fits), kept so the
 * Python cross-check of sim.py stays exact.
 */
export function valuate(
  index: WordIndex,
  counts: Counts,
  alpha: number,
  mode: "leave" | "forced" = "leave",
): Valuation {
  const t0 = performance.now();
  const leave = mode === "leave";
  const keep = leave ? alpha : 0;
  const cands = index.scan(counts, true);
  const base = index.pack(cands, counts, -1, keep);
  const baseValue = packValue(base, alpha);
  const delta = new Float64Array(26);
  for (let i = 0; i < 26; i++) {
    const repacked = packValue(index.pack(cands, counts, i, keep), alpha) - baseValue;
    delta[i] = leave ? Math.max(repacked, alpha * W7_BY_INDEX[i]) : repacked;
  }
  return {
    rackKey: countsKey(counts),
    alpha,
    cands,
    base,
    baseValue,
    delta,
    ms: performance.now() - t0,
  };
}

/** Score of a word list under the server rule. */
export function totalReward(words: string[]): number {
  let s = 0;
  for (const w of words) s += wordReward(w);
  return s;
}

export function letterValueAt(i: number): number {
  return VALUE_BY_INDEX[i];
}
