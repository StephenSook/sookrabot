// Unseen-pool tracking and a one-step lookahead on bid values (prediction v2).
//
// Pure bookkeeping, no network: bot.ts feeds it the public auction letters of
// a match and our own starting rack; strategy knobs decide whether anything
// here reaches a bid (LOOKAHEAD_WEIGHT, off by default).
//
// Unseen pool (Heuri's "augmented bag"): the 98-tile bag minus every letter
// auctioned so far in the match (each auction draws one tile, sold or not) minus
// our own starting tiles. What is left is the bag plus the rivals' hidden
// starting tiles, each tile equally likely to be the next one drawn.
//
// Lookahead: a letter x is worth its immediate marginal value on the rack R
// plus how it changes the expected marginal value of the next letter we get,
//   delta'(x) = delta_R(x) + lambda * (E_pi[delta_{R+x}(e)] - E_pi[delta_R(e)]),
// with pi the unseen-pool share of each letter e. This is the one-future-good
// form of the sequential-auction marginal value (Greenwald and Boyan): it raises
// letters that make later letters worth more (a U with a Q, a step toward many
// 7-letter words) and lowers ones that make them worth less (a third vowel).

import { type Counts, type Valuation, type WordIndex, LEAVE_W7, LETTERS, packValue } from "./engine.js";

/** Standard 98-tile bag without blanks (spacetimedb/src/letters.ts). */
const BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2,
  N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
};
export const BAG_COUNTS: Counts = Int32Array.from(LETTERS, (c) => BAG[c]);

export class PoolTracker {
  /** Auction id -> letter index, so a repeated event is counted once. */
  private readonly seen = new Map<string, number>();
  /** Letters auctioned so far in this match, the open auction included. */
  readonly auctioned = new Int32Array(26);
  /** Our starting tiles, when the first auction of the match was observed. */
  start: Counts | null = null;
  /** Whether the start has been decided (captured, or known to be unavailable). */
  startDecided = false;

  noteAuction(id: string, li: number): void {
    if (li < 0 || li >= 26 || this.seen.has(id)) return;
    this.seen.set(id, li);
    this.auctioned[li]++;
  }

  /** Our starting rack (null when the first auction was missed: our start then counts as unseen). */
  noteStart(rack: Counts | null): void {
    if (this.startDecided) return;
    this.startDecided = true;
    this.start = rack ? new Int32Array(rack) : null;
  }

  get auctionsSeen(): number {
    return this.seen.size;
  }

  /** Unseen tiles per letter (never negative). */
  unseen(): Counts {
    const out = new Int32Array(26);
    for (let i = 0; i < 26; i++) {
      out[i] = Math.max(0, BAG_COUNTS[i] - this.auctioned[i] - (this.start ? this.start[i] : 0));
    }
    return out;
  }
}

/** Share of each letter in `counts` (the full bag when counts is null or empty). */
export function poolWeights(counts: Counts | null): Float64Array {
  const src = counts && counts.some((c) => c > 0) ? counts : BAG_COUNTS;
  let total = 0;
  for (let i = 0; i < 26; i++) total += src[i];
  const w = new Float64Array(26);
  for (let i = 0; i < 26; i++) w[i] = src[i] / total;
  return w;
}

/** Lookahead weight: `weight`, ramped down to 0 over the last `horizon` auctions (no future, no lookahead). */
export function lookaheadLambda(weight: number, bagTotal: number, horizon: number): number {
  if (!(weight > 0) || !(bagTotal > 0)) return 0;
  return weight * Math.min(1, bagTotal / Math.max(1, horizon));
}

/**
 * delta'(x) = delta_R(x) + lambda * (E_w[delta_{R+x}] - E_w[delta_R]), floored at 0.
 * `base` values the rack R, `withX` values R + x (same alpha), `li` is x.
 */
export function lookaheadDelta(base: Valuation, withX: Valuation, li: number, w: Float64Array, lambda: number): number {
  let eR = 0;
  let eX = 0;
  for (let e = 0; e < 26; e++) {
    eR += w[e] * base.delta[e];
    eX += w[e] * withX.delta[e];
  }
  return Math.max(0, base.delta[li] + lambda * (eX - eR));
}

// ---- Multi-letter lookahead (round 3, lever 1: pool-aware completion odds) ----
//
// The one-step lookahead above, at weight 1, is exactly E_e[delta_{R+e}(x)]: the
// marginal value of x after one more random pool letter. Its m-letter form is
//   delta_m(x) = E_S[ value(R + S + x) - value(R + S) ],
// S = m letters drawn without replacement from the unseen pool (optionally
// tilted toward letters the rack wants, since we win what we bid high on).
// Each sample is one scan of R + S and two greedy packings, so this is a
// Monte Carlo estimate of the hypergeometric completion odds of every word
// (7+ letter words included) that x helps the rack reach within m more
// letters, weighted by what those words pay.

const W7_BY_INDEX = Float64Array.from(LETTERS, (c) => LEAVE_W7[c]);

/** Seeded PRNG in [0, 1) (mulberry32), so a sample set is the same on every replay. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string (a sample seed). */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * delta_m(x) for letter `li` on rack `counts` (see above): the mean over
 * `samples` draws S of m tiles from `pool` (without replacement; each draw picks
 * letter e with weight remaining_e x tilt_e when `tilt` is given, else
 * remaining_e) of the leave-mode marginal value of x on R + S at weight `alpha`
 * (greedy packing with keepWeight alpha, floored at alpha x LEAVE_W7[x], as
 * valuate does). With m < 1 or an empty pool it values x on R alone.
 */
export function multiLookDelta(
  index: WordIndex,
  counts: Counts,
  li: number,
  pool: Counts,
  m: number,
  samples: number,
  alpha: number,
  rnd: () => number,
  tilt?: Float64Array,
): number {
  const floor = alpha * W7_BY_INDEX[li];
  const one = (rack: Counts): number => {
    const cands = index.scan(rack, true);
    const base = packValue(index.pack(cands, rack, -1, alpha), alpha);
    const withX = packValue(index.pack(cands, rack, li, alpha), alpha);
    return Math.max(withX - base, floor);
  };
  let poolTotal = 0;
  for (let e = 0; e < 26; e++) poolTotal += Math.max(0, pool[e]);
  const draws = Math.min(Math.floor(m), poolTotal);
  if (!(draws >= 1)) return one(counts);
  const n = Math.max(1, Math.floor(samples));
  const weight = new Float64Array(26);
  for (let e = 0; e < 26; e++) weight[e] = tilt ? Math.max(0, tilt[e]) : 1;
  const rem = new Int32Array(26);
  const rack = new Int32Array(26);
  let sum = 0;
  for (let s = 0; s < n; s++) {
    for (let e = 0; e < 26; e++) rem[e] = Math.max(0, pool[e]);
    rack.set(counts);
    for (let d = 0; d < draws; d++) {
      let total = 0;
      for (let e = 0; e < 26; e++) total += rem[e] * weight[e];
      let pick = -1;
      if (total > 0) {
        let r = rnd() * total;
        for (let e = 0; e < 26; e++) {
          const w = rem[e] * weight[e];
          if (w <= 0) continue;
          pick = e;
          r -= w;
          if (r < 0) break;
        }
      } else {
        // Every remaining letter has tilt 0: draw uniformly from what is left.
        let left = 0;
        for (let e = 0; e < 26; e++) left += rem[e];
        if (left <= 0) break;
        let r = Math.floor(rnd() * left);
        for (let e = 0; e < 26; e++) {
          if (r < rem[e]) {
            pick = e;
            break;
          }
          r -= rem[e];
        }
      }
      if (pick < 0) break;
      rem[pick]--;
      rack[pick]++;
    }
    sum += one(rack);
  }
  return sum / n;
}
