// Empirical letter values learned from outcomes (prediction v2).
//
// EMP_POINTS_PER_WON_TILE: ordinary least squares of a bot's final score on how
// many tiles of each letter it won at auction, over the all-real 6-seat matches
// from m1000 on in the v5 snapshot (rival-data-v5, 2026-10-24 10:52 UTC; 319
// matches, 1871 bot-matches, R^2 0.739, intercept 4.6; standard errors 0.3 to
// 1.0). Script: scrabblebot-calhacks13-analysis/scripts/emp_letter_values.py.
// It is what a won tile of each letter has been worth in final score across
// the live field, averaged over racks, bag stages and bots (an association,
// not a rack-specific marginal value).

import { LETTERS } from "./engine.js";

const OLS: Record<string, number> = {
  A: 5.8, B: 7.3, C: 9.5, D: 5.7, E: 5.8, F: 9.8, G: 5.1, H: 9.4, I: 5.3, J: 14.4,
  K: 11.6, L: 4.2, M: 6.8, N: 4.3, O: 4.9, P: 7.6, Q: 14.1, R: 5.4, S: 4.9, T: 3.6,
  U: 6.0, V: 6.5, W: 9.0, X: 15.2, Y: 11.3, Z: 19.6,
};

export const EMP_POINTS_PER_WON_TILE: Float64Array = Float64Array.from(LETTERS, (c) => OLS[c]);

/** The empirical table times `scale` (for valuate's deadValue). */
export function scaledEmpirical(scale: number): Float64Array {
  return Float64Array.from(EMP_POINTS_PER_WON_TILE, (v) => v * scale);
}
