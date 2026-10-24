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

import { type Counts, type Valuation, LETTERS } from "./engine.js";

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
