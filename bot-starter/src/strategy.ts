// SookraBot policy: how much to bid and which words to play.
//
// Valuation comes from engine.ts (greedy packing plus a leave value). This
// file turns a marginal value into a bid and a rack into word plays. Every
// tuning knob is a named constant below; the measured basis for each is in
// research_notes/.../scrabblebot_strategy.md (sim.py results).
//
// DEFAULT_POLICY collects those constants by name. A SookraBot plays with one
// Policy (the live bot: DEFAULT_POLICY) and passes it to every function here;
// the self-play harness tests a variant by overriding fields of it, so the
// variant runs exactly this code with one value changed.

import {
  type Candidates,
  type Counts,
  LEAVE_W7,
  LETTER_VALUE,
  WordIndex,
  letterIndex,
  packValue,
} from "./engine.js";

export { LETTER_VALUE } from "./engine.js";

// ---- Tuning constants ----

/** Currency bid per point of marginal value against real bots (sim best response 4 to 4.5). */
export const KAPPA = 4.25;
/**
 * Kappa is multiplied by ENDGAME_KAPPA_BOOST when fewer than this many auctions remain.
 * 8, not 12: with 12 the bot spent its last coins on letters worth only their leave
 * value (live m625, casual log of 2026-10-24: N, N, O, valued 1.8 to 2.2, bought
 * for 19 to 21 each with 11 to 8 auctions to come). Cloud self-play (seed 101, 400
 * matches a field): +1.1 to +1.6 points in each of ar6-top, ar6-v4, ar4-top and
 * ar6-top-mixed (t 3.8 to 6.2), while 18 lost 0.6 to 4.8; in duels +0.0 to +0.5
 * (seed 404, 1200 a field), the 3-game final win share moving by at most 0.003
 * (t 1.0 or less).
 */
export const ENDGAME_AUCTIONS = 8;
export const ENDGAME_KAPPA_BOOST = 2;
/**
 * Budget pacing at tables with a real rival: kappa is multiplied by
 * clamp(r ^ PACE_EXPONENT, PACE_MIN, PACE_MAX), where r = (balance / auctions
 * left including this one) / (STARTING_BALANCE / auctions per match). r is 1
 * at the first auction; a bot behind an even spend (r > 1) bids more, one
 * ahead of it (r < 1) bids less, so coins, which score nothing at the end,
 * are spent down instead of being stranded or run out early.
 */
export const PACE_EXPONENT = 0.5;
export const PACE_MIN = 0.5;
export const PACE_MAX = 3;
/**
 * The pacing floor in a duel (at most DUEL_MAX_OPPONENTS rivals, as in the
 * 3-game final), in place of PACE_MIN: with one rival every letter we skip
 * is that rival's, so a cash-poor bot keeps bidding 3/4 of the paced kappa
 * (the duel reserve still holds back the last coins). Paired self-play vs
 * the PACE_MIN floor (selfplay.ts compare, seed 2718, 2000 duels a field):
 * score margin up in 8 of 9 duel fields, e.g. +3.3 vs LetterShark (seeds
 * 2718 and 1618, win rate 73.2% to 74.4%), +9.7 vs code, +9.5 vs Yezi-ar;
 * flat vs code-ar (+0.5, t 0.2). PACE_MIN_DUEL = PACE_MIN restores one floor.
 */
export const PACE_MIN_DUEL = 0.75;
/**
 * Base kappa while pacing (in place of KAPPA, which stays the kappa of the
 * unpaced rule and of the Python cross-check), still doubled in the last
 * ENDGAME_AUCTIONS auctions.
 */
export const PACED_KAPPA = 4;
/**
 * Early bid cut while pacing: in the first EARLY_AUCTIONS auctions of a match
 * (auction index auctionsPerMatch - 1 - bagTotal), kappa is multiplied by
 * EARLY_KAPPA_SCALE, at tables with at least EARLY_MIN_REAL_RIVALS real
 * (non-sim) rivals, so duels are exempt. Coins not spent early raise the
 * pacing factor later. EARLY_KAPPA_SCALE 1: off.
 *
 * Live (builds B to E, rival-data-v4 findings): in auctions 1 to 22 SookraBot's
 * winning bid averaged 30.7 against 14.7 to 23.2 for the top six bots, and it
 * spent 65.0 coins; in auctions 23 to 45 it won 2.26 letters a match against 4.4
 * to 4.9 for james, Dante, LetterShark, cashu and keanu. Cloud self-play (round
 * 3, seed 404, 600 matches a field, with ENDGAME_AUCTIONS 8): +8.1 points and
 * -0.58 places at ar6-top (t 10.6), +8.4 at ar6-v4, +22.4 at ar4-top, +22.0 at
 * ar3-top, +7.7 against rack-aware shark-policy rivals, +1.2 at 8 seats, and
 * +10.3 against two SookraBot copies playing the old defaults (-2.2 at seed 606
 * when the copies cut too). Window 28 against 22 and 34 in the same run: 34
 * lost 1.1 to 1.2 points at 7 and 8 seats, 22 lost 5.4 at 4 seats, and
 * elsewhere each was within 2.6 points of 28. A cut in duels lost 31 to 63
 * points a game (round 1). Sims do not count: at six-seat tables of one real
 * rival and four sims the cut lost 28 and 44 points a match (pad-code and
 * pad-ls, seed 606, 400 matches, t -11.6 and -19.4) where ENDGAME_AUCTIONS 8
 * alone gained 1.0; with two real rivals and three sims the tuned rules gained
 * 5.6 (pad-ls-code, t 3.0), 2.0 without the cut. A casual lobby can be padded
 * with sims, and an admin can enter sims into a tournament (registerSimBots).
 */
export const EARLY_AUCTIONS = 28;
export const EARLY_KAPPA_SCALE = 0.4;
export const EARLY_MIN_REAL_RIVALS = 2;
/** Every bot starts a match with this balance (game.ts STARTING_BALANCE). */
export const STARTING_BALANCE = 100;
/** Tiles in the bag at the start of a match (letters.ts DEFAULT_BAG). */
export const BAG_TILES = 98;
/** Weight of the leave value of held tiles (sim: 0.35 best; 0 scored 107 vs 314). */
export const LEAVE_ALPHA = 0.35;
/**
 * Leave decay: with fewer than LEAVE_DECAY_BAG auctions to come, the leave
 * weight is LEAVE_ALPHA x (bagTotal + 1) / LEAVE_DECAY_BAG, since a held tile
 * has fewer letters left to form a word with. 0 (default): no decay.
 */
export const LEAVE_DECAY_BAG = 0;
/** Cash any word of at least this many letters as soon as it forms (multiplier saturates at 7). */
export const CASH_MIN_LEN = 7;
/**
 * At tables with at least this many real rivals, no word is cashed before the
 * end-of-match flush except the liquidity word below: every tile stays
 * available to the final packing (the live all-real table leader,
 * YeziShanYang, scores 62% of its points after auction 46). Duels and
 * sim-padded tables keep CASH_MIN_LEN.
 */
export const HOLD_MIN_REAL_RIVALS = 2;
/**
 * Holding (HOLD_MIN_REAL_RIVALS) starts only once fewer than this many
 * auctions are still to come; before that, words of CASH_MIN_LEN+ letters are
 * cashed as they form, so their reward buys letters while most are still to
 * be auctioned. 999 or more (default 999): off, hold for the whole match.
 */
export const HOLD_FROM_BAG = 999;
/**
 * Below this balance (after cashing), also cash one word: preferably of
 * LIQUIDITY_MIN_LEN+ letters, else of any length (LIQUIDITY_FALLBACK_MIN_LEN),
 * so a broke bot holding only e.g. QUIZ is never stuck bidding 0. Among the
 * LIQUIDITY_TOP_K best-paying words that restore the floor, the one that
 * leaves the most valuable hoard (reward + value of the rest) is chosen.
 */
export const LIQUIDITY_FLOOR = 15;
export const LIQUIDITY_MIN_LEN = 5;
export const LIQUIDITY_FALLBACK_MIN_LEN = 2;
export const LIQUIDITY_TOP_K = 24;
/**
 * Kappa used when every opponent is a sim. Sims cannot outbid
 * maxSimBid + 1, so the bid is also capped there (Vickrey: you pay the
 * realized top sim bid either way). Sim result: kappa 20 scored 358 vs 314 at 4.
 */
export const SIM_ONLY_KAPPA = 20;
/** Sims add uniform jitter in -2..2 to their base bid (game.ts SIM_BID_JITTER). */
export const SIM_BID_JITTER = 2;
/**
 * Start dumping the whole packing once the match will end within this many
 * ms: at bagTotal 0 always, and earlier when auctions are short, so word
 * plays reach the server before the final auction closes. 3000 ms means the
 * last 3 auctions at 1000 ms and the last 12 at 250 ms: the live starter log
 * had 70 of 1,027 bids refused "Auction closed", and a late flush loses the
 * whole hoard while an early one only strands the last few letters.
 */
export const FLUSH_LEAD_MS = 3000;
/**
 * First-price shading: recent rival prices kept, minimum sample, quantile.
 * FP_QUANTILE 0.3 and FP_NO_HISTORY_SHADE 0.4 (from 0.75 and 0.75): in every
 * first-price field the cloud search tried, shading harder won more. Round 1.5
 * (seed 202, 400 matches): quantile and shade 0.6 gave +7 to +11 points at
 * ar6-top,fp tables, 0.5 gave +11 to +18, 0.4 and 0.5 gave +15 to +20, also when
 * the rivals shade their own bids by 25%. Round 3 (seed 404, 500 matches, with the
 * early cut and ENDGAME_AUCTIONS 8): 0.3 and 0.4 gave +24 to +31 at 6-seat
 * first-price tables against +19 to +25 for 0.4 and 0.5. Untested against live
 * first-price rivals; casual matches are Vickrey.
 */
export const FP_HISTORY_MAX = 40;
export const FP_MIN_OBS = 5;
export const FP_QUANTILE = 0.3;
/** First-price shading with too little price history: bid this share of the full bid. */
export const FP_NO_HISTORY_SHADE = 0.4;
/**
 * Broke rivals: when no rival can bid more than this (public balances, sim
 * rules), bid exactly their max + 1 on any letter with value. NYC's final was
 * lost by a bot with zero cash while the winner bought the bag at 1 a letter.
 */
export const BROKE_RIVAL_MAX_BID = 2;
/** Duel liquidity applies at tables with at most this many rivals (the 3-game final is 1v1). */
export const DUEL_MAX_OPPONENTS = 1;
/**
 * Coins held back per remaining auction in a duel, counting at most
 * DUEL_RESERVE_WINDOW auctions (so the reserve is at most 10). Sized by the
 * duel sim (400 deal-paired 88-auction duels, seed 31, score difference vs
 * rival): no reserve -9.3 vs a kappa-4.25 hoarder and +24.1 vs kappa 8;
 * 1 x 10 gave -5.2 and +34.5 (within noise, SE about 10 to 14); 2 x 15
 * gave -84.7 and -8.0, so a large reserve loses mid-game letters.
 */
export const DUEL_RESERVE_PER_AUCTION = 1;
export const DUEL_RESERVE_WINDOW = 10;

// Round 2 levers. Each is off by default, so DEFAULT_POLICY plays exactly as
// the live build 5318ca6 does; the self-play harness turns one on by name.

/**
 * COMPLETE7_PREMIUM: when winning the letter lets the bot spell a 7+ letter
 * word it cannot spell now (sevenCompleterMask: a 7+ letter word needs exactly
 * this letter, and the rack plus it packs into more 7+ letter words than the
 * rack alone), the letter is bid at COMPLETE7_PREMIUM x kappa, so
 * floor(kappa x COMPLETE7_PREMIUM x delta) (one coin above twice the plain
 * bid at times, from the rounding), but the raise stops at
 * COMPLETE7_CAP_SHARE x the balance and never takes the bid below the plain
 * one. 1: off. Live (rival-data-v4): Chinese Dante wins 61% of the auctions
 * where the letter completes a 7-letter word, against 25% otherwise.
 */
export const COMPLETE7_PREMIUM = 1;
export const COMPLETE7_CAP_SHARE = 1;
/**
 * CASH_WHEN_BROKE: at a table that holds words (HOLD_MIN_REAL_RIVALS), held
 * words of CASH_MIN_LEN+ letters are cashed, best first, while the balance is
 * under CASH_BROKE_BALANCE, and every one is cashed as it forms once fewer
 * than CASH_BROKE_AUCTIONS auctions are to come. 0: off. Live (rival-data-v4,
 * builds B to E): SookraBot held a playable 7+ letter word in 52% of auctions
 * 1 to 60 and won 9% of those; james cashes at about 50 points or when broke.
 */
export const CASH_BROKE_BALANCE = 0;
export const CASH_BROKE_AUCTIONS = 0;
/**
 * Dead letters: a letter worth no more to the rack than its own leave value
 * (isDeadLetter: delta <= alpha x LEAVE_W7, alpha from the valuation the delta
 * comes from) is bid at DEAD_KAPPA_SCALE x kappa. 1: off. Why this lever: in
 * the v5 calibration (validate5 at the 288 live all-real tables from m1000 on,
 * live side) SookraBot wins 11.4 letters a match against 13.2 for the top
 * eleven, and the letter regimes split the 1.8 as 0.9 dead letters (it wins
 * 8.6% of the dead letters it can afford, the top eleven 14.6%), 0.5 useful
 * ones (25.3% against 26.8%) and 0.4 letters that complete a 7+ word (it wins
 * 66.7% of those, more than any of them, but is offered 1.8 a match against
 * 4.9). The harness counts a letter dead when the greedy packing gains nothing
 * from it (selfplay.ts rackMasks), close to but not the same as this rule.
 */
export const DEAD_KAPPA_SCALE = 1;

// Prediction v2 knobs. Each is off by default, so DEFAULT_POLICY plays exactly
// as the live build does; the self-play harness turns one on by name.

/**
 * WORDS_EXACT_NODES: word choices use the optimal packing of the rack
 * (WordIndex.packExact, branch and bound from the greedy packing, at most this
 * many search nodes) instead of the greedy one: the end-of-match flush cashes
 * it, and a liquidity word is judged by the optimal value of what it leaves.
 * 0: off (greedy). Random racks from the bag (scripts/packcheck.ts, 200 each,
 * budget 200000): greedy 72.2 / 93.0 / 117.5 against optimal 83.4 / 105.2 /
 * 127.6 at 16 / 20 / 24 tiles, 0.9 to 2.9 ms a rack.
 */
export const WORDS_EXACT_NODES = 0;
/**
 * EXACT_VALUE_NODES: the bid table (valuate) values each rack and rack + letter
 * by the optimal packing (packExact, at most this many nodes each) instead of
 * the greedy one, so a letter's marginal value is what it adds to the best
 * packing. 0: off (greedy).
 */
export const EXACT_VALUE_NODES = 0;
/**
 * DEAD_GATE_REAL_RIVALS: DEAD_KAPPA_SCALE applies only in Vickrey auctions at
 * tables with at least this many real (non-sim) rivals. 0: no gate (the round
 * 2 lever as it was). Why: round 2 (cloud, seeds 5102, 5201, 5401) measured
 * DEAD_KAPPA_SCALE 1.1 at about +1.4 points at 6-seat Vickrey tables (t 5 to
 * 6 pooled) and losses in duels, at 4 seats and under first price, and
 * proposed this gate.
 */
export const DEAD_GATE_REAL_RIVALS = 0;
/**
 * LOOKAHEAD_WEIGHT: the refined bid (bot.ts refresh) values the letter on
 * auction with a one-step lookahead over the unseen pool (pool.ts
 * lookaheadDelta): its marginal value plus LOOKAHEAD_WEIGHT x how winning it
 * changes the expected marginal value of the next letter, ramped to 0 over the
 * last LOOKAHEAD_HORIZON auctions. LOOKAHEAD_POOL 1 weights the next letter by
 * the unseen pool (bag minus auctioned letters minus our starting tiles), 0 by
 * the full bag. LOOKAHEAD_WEIGHT 0: off.
 */
export const LOOKAHEAD_WEIGHT = 0;
export const LOOKAHEAD_HORIZON = 10;
export const LOOKAHEAD_POOL = 1;
/**
 * The lookahead applies only in Vickrey auctions at tables with at least
 * LOOKAHEAD_MIN_REAL_RIVALS real (non-sim) rivals; 0: everywhere. Ungated it
 * lost in every duel field, at a 6-seat first-price table and was flat at 4
 * seats (cloud run 40125994357, seed 7202).
 */
export const LOOKAHEAD_MIN_REAL_RIVALS = 0;
/**
 * EMP_DEAD_SCALE: a letter the rack's packing has no use for (its marginal
 * value is only its own leave value, alpha x LEAVE_W7) is valued instead at
 * alpha x EMP_DEAD_SCALE x the empirical points per won tile of that letter
 * (empirical.ts: final score regressed on tiles won, live all-real 6-seat
 * matches). 0: off. 0.85 keeps the table's mean near LEAVE_W7's.
 */
export const EMP_DEAD_SCALE = 0;

/**
 * The tuning constants above, by name: what a SookraBot plays with. Game rules
 * (STARTING_BALANCE, BAG_TILES, SIM_BID_JITTER) and the network-stall bounds of
 * flushLeadMs are not knobs and stay plain constants.
 */
export interface Policy {
  readonly KAPPA: number;
  readonly ENDGAME_AUCTIONS: number;
  readonly ENDGAME_KAPPA_BOOST: number;
  readonly PACE_EXPONENT: number;
  readonly PACE_MIN: number;
  readonly PACE_MAX: number;
  readonly PACE_MIN_DUEL: number;
  readonly PACED_KAPPA: number;
  readonly EARLY_AUCTIONS: number;
  readonly EARLY_KAPPA_SCALE: number;
  readonly EARLY_MIN_REAL_RIVALS: number;
  readonly LEAVE_ALPHA: number;
  readonly LEAVE_DECAY_BAG: number;
  readonly CASH_MIN_LEN: number;
  readonly HOLD_MIN_REAL_RIVALS: number;
  readonly HOLD_FROM_BAG: number;
  readonly LIQUIDITY_FLOOR: number;
  readonly LIQUIDITY_MIN_LEN: number;
  readonly LIQUIDITY_FALLBACK_MIN_LEN: number;
  readonly LIQUIDITY_TOP_K: number;
  readonly SIM_ONLY_KAPPA: number;
  readonly FLUSH_LEAD_MS: number;
  readonly FP_HISTORY_MAX: number;
  readonly FP_MIN_OBS: number;
  readonly FP_QUANTILE: number;
  readonly FP_NO_HISTORY_SHADE: number;
  readonly BROKE_RIVAL_MAX_BID: number;
  readonly DUEL_MAX_OPPONENTS: number;
  readonly DUEL_RESERVE_PER_AUCTION: number;
  readonly DUEL_RESERVE_WINDOW: number;
  readonly COMPLETE7_PREMIUM: number;
  readonly COMPLETE7_CAP_SHARE: number;
  readonly CASH_BROKE_BALANCE: number;
  readonly CASH_BROKE_AUCTIONS: number;
  readonly DEAD_KAPPA_SCALE: number;
  readonly WORDS_EXACT_NODES: number;
  readonly EXACT_VALUE_NODES: number;
  readonly DEAD_GATE_REAL_RIVALS: number;
  readonly LOOKAHEAD_WEIGHT: number;
  readonly LOOKAHEAD_HORIZON: number;
  readonly LOOKAHEAD_POOL: number;
  readonly LOOKAHEAD_MIN_REAL_RIVALS: number;
  readonly EMP_DEAD_SCALE: number;
}

/** The live policy: every field is the constant of the same name. Frozen, so nothing can change it at run time. */
export const DEFAULT_POLICY: Policy = Object.freeze({
  KAPPA,
  ENDGAME_AUCTIONS,
  ENDGAME_KAPPA_BOOST,
  PACE_EXPONENT,
  PACE_MIN,
  PACE_MAX,
  PACE_MIN_DUEL,
  PACED_KAPPA,
  EARLY_AUCTIONS,
  EARLY_KAPPA_SCALE,
  EARLY_MIN_REAL_RIVALS,
  LEAVE_ALPHA,
  LEAVE_DECAY_BAG,
  CASH_MIN_LEN,
  HOLD_MIN_REAL_RIVALS,
  HOLD_FROM_BAG,
  LIQUIDITY_FLOOR,
  LIQUIDITY_MIN_LEN,
  LIQUIDITY_FALLBACK_MIN_LEN,
  LIQUIDITY_TOP_K,
  SIM_ONLY_KAPPA,
  FLUSH_LEAD_MS,
  FP_HISTORY_MAX,
  FP_MIN_OBS,
  FP_QUANTILE,
  FP_NO_HISTORY_SHADE,
  BROKE_RIVAL_MAX_BID,
  DUEL_MAX_OPPONENTS,
  DUEL_RESERVE_PER_AUCTION,
  DUEL_RESERVE_WINDOW,
  COMPLETE7_PREMIUM,
  COMPLETE7_CAP_SHARE,
  CASH_BROKE_BALANCE,
  CASH_BROKE_AUCTIONS,
  DEAD_KAPPA_SCALE,
  WORDS_EXACT_NODES,
  EXACT_VALUE_NODES,
  DEAD_GATE_REAL_RIVALS,
  LOOKAHEAD_WEIGHT,
  LOOKAHEAD_HORIZON,
  LOOKAHEAD_POOL,
  LOOKAHEAD_MIN_REAL_RIVALS,
  EMP_DEAD_SCALE,
});

// ---- Types ----

export type AuctionKind = "Vickrey" | "FirstPrice";
export type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive";

export interface Opponent {
  isSim: boolean;
  /** Set for sims; undefined for real bots. */
  strategy?: SimStrategy;
  balance: number;
}

export interface PricePoint {
  /** Face value of the letter. */
  face: number;
  /** What the winning rival paid (first price: its own bid). */
  paid: number;
}

export interface BidInput {
  letter: string;
  /** Marginal value of the letter in points (engine valuation delta). */
  delta: number;
  /** Auctions still to come after this one (match_state.bag_total). */
  bagTotal: number;
  auctionType: AuctionKind;
  myBalance: number;
  opponents: Opponent[];
  /** First-price prices paid by real rivals, oldest first. */
  fpHistory?: PricePoint[];
  /** Auctions in this match (auctionsPerMatch()); budget pacing is off when absent. */
  auctionsPerMatch?: number;
  /** Tuning constants (default DEFAULT_POLICY). */
  policy?: Policy;
  /**
   * Winning this letter lets the rack spell a 7+ letter word it cannot spell
   * now (sevenCompleterMask of the valuation the delta comes from). Read only
   * when COMPLETE7_PREMIUM is on; absent: unknown, no premium.
   */
  completes7?: boolean;
  /**
   * Leave weight of the valuation the delta comes from (Valuation.alpha), for
   * isDeadLetter. Read only when DEAD_KAPPA_SCALE is on; absent: never dead.
   */
  leaveAlpha?: number;
}

export interface BidDecision {
  amount: number;
  reason: string;
}

// ---- Bidding ----

/** Highest bid a sim with this strategy and balance can make on `letter`. */
export function maxSimBid(strategy: SimStrategy, letter: string, balance: number): number {
  const value = LETTER_VALUE[letter] ?? 1;
  let base: number;
  if (strategy === "Cheapskate") base = value - 1;
  else if (strategy === "ValueBidder") base = value;
  else base = value + ("AEIOU".includes(letter) ? 4 : 2);
  return Math.max(Math.min(Math.max(base + SIM_BID_JITTER, 1), balance), 0);
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[pos];
}

/** Kappa `base` (default the policy's KAPPA), times ENDGAME_KAPPA_BOOST in the last ENDGAME_AUCTIONS auctions. */
export function kappaFor(bagTotal: number, base?: number, p: Policy = DEFAULT_POLICY): number {
  const k = base ?? p.KAPPA;
  return bagTotal < p.ENDGAME_AUCTIONS ? k * p.ENDGAME_KAPPA_BOOST : k;
}

/** Pacing is on at tables with a real rival once the match length is known. */
function pacingOn(simsOnly: boolean, auctions: number | undefined): boolean {
  return !simsOnly && auctions !== undefined && auctions > 0;
}

/** Auctions in a match: every tile not dealt into a starting rack is auctioned once. */
export function auctionsPerMatch(seats: number, startingRackSize: number): number {
  return Math.max(1, BAG_TILES - startingRackSize * seats);
}

/**
 * Budget pacing multiplier on kappa (see PACE_EXPONENT), clamped to
 * min..PACE_MAX (min: PACE_MIN, or PACE_MIN_DUEL in a duel; default the
 * policy's PACE_MIN); 1 when the match length is unknown.
 */
export function paceMultiplier(
  balance: number,
  bagTotal: number,
  auctions: number | undefined,
  min?: number,
  p: Policy = DEFAULT_POLICY,
): number {
  if (auctions === undefined || !(auctions > 0) || !(bagTotal >= 0)) return 1;
  const r = Math.max(0, balance) / (bagTotal + 1) / (STARTING_BALANCE / auctions);
  return Math.min(p.PACE_MAX, Math.max(min ?? p.PACE_MIN, r ** p.PACE_EXPONENT));
}

/**
 * Early bid cut on the paced kappa (see EARLY_AUCTIONS): `scale` in the first
 * `window` auctions of a match (auction index auctions - 1 - bagTotal) when
 * `realRivals` (seated non-sim opponents) is at least `minRealRivals`, else 1.
 * The parameters default to EARLY_AUCTIONS, EARLY_KAPPA_SCALE and
 * EARLY_MIN_REAL_RIVALS; scale 1 is off.
 */
export function earlyScale(
  bagTotal: number,
  auctions: number,
  realRivals: number,
  window = EARLY_AUCTIONS,
  scale = EARLY_KAPPA_SCALE,
  minRealRivals = EARLY_MIN_REAL_RIVALS,
): number {
  if (scale === 1 || realRivals < minRealRivals) return 1;
  return auctions - 1 - bagTotal < window ? scale : 1;
}

/** Kappa with budget pacing: PACED_KAPPA, doubled in the last ENDGAME_AUCTIONS auctions, times paceMultiplier. */
export function pacedKappa(
  bagTotal: number,
  balance: number,
  auctions: number | undefined,
  min?: number,
  p: Policy = DEFAULT_POLICY,
): number {
  return kappaFor(bagTotal, p.PACED_KAPPA, p) * paceMultiplier(balance, bagTotal, auctions, min, p);
}

/** Highest bid this opponent can place right now (real bots: their whole balance). */
export function maxPossibleBid(o: Opponent, letter: string): number {
  const bal = Math.max(0, Math.floor(o.balance));
  return o.isSim && o.strategy ? maxSimBid(o.strategy, letter, bal) : bal;
}

/**
 * Coins held back in a duel so late letters stay winnable:
 * DUEL_RESERVE_PER_AUCTION for each remaining auction, counting at most
 * DUEL_RESERVE_WINDOW of them. 0 at tables with more than DUEL_MAX_OPPONENTS rivals.
 */
export function duelReserve(opponentCount: number, bagTotal: number, p: Policy = DEFAULT_POLICY): number {
  if (opponentCount > p.DUEL_MAX_OPPONENTS) return 0;
  return p.DUEL_RESERVE_PER_AUCTION * Math.max(0, Math.min(bagTotal, p.DUEL_RESERVE_WINDOW));
}

/**
 * A dead letter for DEAD_KAPPA_SCALE: worth no more to the rack than its own
 * leave value, delta <= alpha x LEAVE_W7 (valuate floors every delta there, so
 * a dead letter's delta is exactly that), with alpha the leave weight of the
 * valuation the delta comes from. At alpha 0 (flushing) no letter with value is dead.
 */
export function isDeadLetter(letter: string, delta: number, alpha: number): boolean {
  const w = LEAVE_W7[letter];
  return w !== undefined && delta <= alpha * w + 1e-9;
}

/**
 * Letters that complete a 7+ letter word on this rack, for COMPLETE7_PREMIUM
 * (bit i for letter i): some word of 7+ letters needs exactly that letter as
 * its one extra tile (scan's tag), and the rack plus that letter packs into
 * more words of 7+ letters than the rack alone (WordIndex.pack, keepWeight as
 * the valuation packs; for a rack that already holds a 7+ word, a second one).
 * `cands` is scan(counts, true), as in a Valuation. When the rack spells no 7+
 * word this is a subset of selfplay.ts sevenCompleters (the calibration's
 * complete7 regime): it leaves out a letter whose 7+ word the greedy packing
 * would not use (equal on 111 of 159 random racks of 6 to 15 tiles).
 */
export function sevenCompleterMask(index: WordIndex, cands: Candidates, counts: Counts, keepWeight: number): number {
  let needs = 0;
  for (let i = 0; i < cands.n; i++) {
    const e = cands.extra[i];
    if (e >= 0 && index.len[cands.keys[i]] >= 7) needs |= 1 << e;
  }
  if (needs === 0) return 0;
  const sevens = (keys: number[]) => {
    let n = 0;
    for (const k of keys) if (index.len[k] >= 7) n++;
    return n;
  };
  const base = sevens(index.pack(cands, counts, -1, keepWeight).keys);
  let mask = 0;
  for (let i = 0; i < 26; i++) {
    if (((needs >>> i) & 1) === 1 && sevens(index.pack(cands, counts, i, keepWeight).keys) > base) mask |= 1 << i;
  }
  return mask >>> 0;
}

/**
 * Bid rule, in order:
 *  - final letter (bagTotal 0): a real bot can never play it, but a sim that
 *    wins it plays a word before the match ends (game.ts closeAuction), and
 *    leftover coins are worthless, so with sims seated bid max sim bid + 1
 *    to deny it; with no sims, 0;
 *  - no positive marginal value: 0;
 *  - every rival can bid at most BROKE_RIVAL_MAX_BID (public balances, sim
 *    rules): bid exactly their max + 1, the minimum that wins;
 *  - sims-only table (Vickrey): min(floor(SIM_ONLY_KAPPA * delta), max sim bid + 1);
 *  - otherwise floor(kappa * delta), kappa doubled in the last
 *    ENDGAME_AUCTIONS (8) auctions and multiplied by the budget pacing
 *    factor (pacedKappa; its floor is PACE_MIN_DUEL in a duel, PACE_MIN
 *    otherwise), and by EARLY_KAPPA_SCALE in the first EARLY_AUCTIONS
 *    auctions at tables of EARLY_MIN_REAL_RIVALS or more real (non-sim)
 *    rivals (earlyScale);
 *  - round 2 levers, off by default: kappa x DEAD_KAPPA_SCALE on a dead
 *    letter (isDeadLetter), and on a letter that completes a 7+ word
 *    (completes7) kappa x COMPLETE7_PREMIUM, the raise stopping at
 *    COMPLETE7_CAP_SHARE x the balance; neither applies at a sims-only
 *    Vickrey table;
 *  - first price (you pay your own bid): shade to min(full bid, estimated
 *    price to win), where the estimate is max(max sim bid + 1, FP_QUANTILE
 *    of recent real-rival winning prices for letters of the same face value
 *    + 1), or FP_NO_HISTORY_SHADE of the full bid with under FP_MIN_OBS
 *    observations;
 *  - never above the most any rival can bid + 1 (wins outright; in Vickrey
 *    the price is unchanged, in first price it saves coins);
 *  - duel (one rival): never spend into the reserve, except an even share
 *    of the balance per remaining auction;
 *  - always clamp to 0..balance.
 */
export function decideBid(input: BidInput): BidDecision {
  const p = input.policy ?? DEFAULT_POLICY;
  const balance = Math.max(0, Math.floor(Number.isFinite(input.myBalance) ? input.myBalance : 0));
  const clamp = (x: number) => Math.max(0, Math.min(Math.floor(x), balance));
  if (letterIndex(input.letter) < 0) return { amount: 0, reason: "bad-letter" };
  if (!(input.bagTotal > 0)) {
    const simMax = input.opponents
      .filter((o) => o.isSim && o.strategy)
      .reduce((m, o) => Math.max(m, maxSimBid(o.strategy!, input.letter, o.balance)), 0);
    if (simMax > 0) return { amount: clamp(simMax + 1), reason: `final-letter deny sims (cap ${simMax + 1})` };
    return { amount: 0, reason: "final-letter" };
  }
  if (!(input.delta > 0)) {
    return { amount: 0, reason: "no-value" };
  }
  const rivalMax = input.opponents.reduce((m, o) => Math.max(m, maxPossibleBid(o, input.letter)), 0);
  const rivalCap = rivalMax + 1;
  let amount: number;
  let reason: string;
  if (rivalMax <= p.BROKE_RIVAL_MAX_BID) {
    amount = rivalCap;
    reason = `rivals broke (max ${rivalMax})`;
  } else {
    ({ amount, reason } = valueBid(input, rivalCap, balance, p));
  }
  // The duel reserve applies to every branch, the broke-rival one included.
  const reserve = duelReserve(input.opponents.length, input.bagTotal, p);
  if (reserve > 0) {
    const evenShare = Math.floor(balance / (input.bagTotal + 1));
    const duelCap = Math.max(balance - reserve, evenShare);
    if (amount > duelCap) {
      amount = duelCap;
      reason += ` duel-reserve ${reserve}`;
    }
  }
  return { amount: clamp(amount), reason };
}

/** Bid from the marginal value (kappa, pacing, sims-only cap, first-price shading), capped at rivalCap. */
function valueBid(input: BidInput, rivalCap: number, balance: number, p: Policy): BidDecision {
  const sims = input.opponents.filter((o) => o.isSim && o.strategy);
  const simCap = sims.length
    ? Math.max(...sims.map((o) => maxSimBid(o.strategy!, input.letter, o.balance))) + 1
    : 0;
  const simsOnly = input.opponents.length > 0 && sims.length === input.opponents.length;
  const paced = pacingOn(simsOnly, input.auctionsPerMatch);
  const paceMin = input.opponents.length <= p.DUEL_MAX_OPPONENTS ? p.PACE_MIN_DUEL : p.PACE_MIN;
  // The early cut counts real rivals only, as HOLD_MIN_REAL_RIVALS does (bot.ts).
  const realRivals = input.opponents.filter((o) => !o.isSim).length;
  // paced implies auctionsPerMatch is a positive number (pacingOn).
  const kappaRule = paced
    ? pacedKappa(input.bagTotal, balance, input.auctionsPerMatch, paceMin, p) *
      earlyScale(
        input.bagTotal,
        input.auctionsPerMatch!,
        realRivals,
        p.EARLY_AUCTIONS,
        p.EARLY_KAPPA_SCALE,
        p.EARLY_MIN_REAL_RIVALS,
      )
    : kappaFor(input.bagTotal, undefined, p);
  const simsOnlyVickrey = simsOnly && input.auctionType === "Vickrey";
  // Round 2 levers (off by default: DEAD_KAPPA_SCALE 1, COMPLETE7_PREMIUM 1); tag marks them in the reason.
  const deadGateOpen =
    p.DEAD_GATE_REAL_RIVALS <= 0 || (input.auctionType === "Vickrey" && realRivals >= p.DEAD_GATE_REAL_RIVALS);
  const dead =
    p.DEAD_KAPPA_SCALE !== 1 &&
    deadGateOpen &&
    !simsOnlyVickrey &&
    input.leaveAlpha !== undefined &&
    isDeadLetter(input.letter, input.delta, input.leaveAlpha);
  const kappaExact = dead ? kappaRule * p.DEAD_KAPPA_SCALE : kappaRule;
  const kappa = +kappaExact.toFixed(4); // for the reason strings
  let full = Math.floor(kappaExact * input.delta);
  let tag = dead ? ` dead x${p.DEAD_KAPPA_SCALE}` : "";
  if (p.COMPLETE7_PREMIUM !== 1 && input.completes7 === true && !simsOnlyVickrey) {
    const raised = Math.min(
      Math.floor(kappaExact * p.COMPLETE7_PREMIUM * input.delta),
      Math.floor(p.COMPLETE7_CAP_SHARE * balance),
    );
    if (raised > full) {
      full = raised;
      tag += ` c7 x${p.COMPLETE7_PREMIUM}`;
    }
  }

  let amount: number;
  let reason: string;
  if (simsOnlyVickrey) {
    amount = Math.min(Math.floor(p.SIM_ONLY_KAPPA * input.delta), simCap);
    reason = `sims-only cap ${simCap}`;
  } else if (input.auctionType === "FirstPrice" && simsOnly) {
    amount = Math.min(full, simCap);
    reason = `fp sims-only k${kappa}`;
  } else if (input.auctionType === "FirstPrice") {
    const face = LETTER_VALUE[input.letter] ?? 1;
    const obs = (input.fpHistory ?? [])
      .filter((pp) => pp.face === face)
      .slice(-p.FP_HISTORY_MAX)
      .map((pp) => pp.paid);
    let target: number;
    if (obs.length >= p.FP_MIN_OBS) {
      target = Math.max(simCap, quantile(obs, p.FP_QUANTILE) + 1);
      reason = `fp q${p.FP_QUANTILE}x${obs.length} k${kappa}`;
    } else {
      target = Math.max(simCap, Math.floor(full * p.FP_NO_HISTORY_SHADE));
      reason = `fp no-history k${kappa}`;
    }
    amount = Math.min(full, target);
  } else {
    amount = full;
    reason = `k${kappa}`;
  }
  reason += tag;

  if (amount > rivalCap) {
    amount = rivalCap;
    reason += ` rival-cap ${rivalCap}`;
  }
  return { amount, reason };
}

// ---- Word play ----

/** Never start the flush earlier than this, whatever the lag (12 auctions at 1000 ms). */
export const MAX_FLUSH_LEAD_MS = 12000;
/** How many of the most recent auction receive lags the flush lead looks at. */
export const FLUSH_LAG_WINDOW = 20;
/** Receive lags the baseline is taken from, and the percentile used (robust to one outlier). */
export const FLUSH_BASELINE_WINDOW = 40;
export const FLUSH_BASELINE_PERCENTILE = 0.1;

/**
 * Word-flush lead for the current match: FLUSH_LEAD_MS normally, longer after a stall.
 * Held words must reach the server before the final auction closes, and m276 lost
 * its whole hoard to a 3,253 ms receive lag. A receive lag is our wall clock minus
 * the server's open time, so it carries any clock skew; the stall is therefore
 * measured against this match's best lag (the baseline), which cancels a constant
 * skew in either direction. The lead allows twice the worst recent stall plus a
 * second. Normal jitter leaves it at FLUSH_LEAD_MS, so normal play and the
 * self-play harness (no lag) are unchanged. It only moves word plays earlier;
 * valuation alpha keeps the fixed rule, so precomputed bid tables stay valid.
 */
export function flushLeadMs(lagsMs: readonly number[], p: Policy = DEFAULT_POLICY): number {
  // Baseline: a low percentile of the recent lags, so one early outlier (a clock
  // correction mid-match) expires instead of making every later lag look stalled.
  const recent = lagsMs.filter((lag) => Number.isFinite(lag)).slice(-FLUSH_BASELINE_WINDOW);
  if (recent.length === 0) return p.FLUSH_LEAD_MS;
  const sorted = [...recent].sort((a, b) => a - b);
  const baseline = sorted[Math.floor(FLUSH_BASELINE_PERCENTILE * (sorted.length - 1))];
  let stall = 0;
  for (const lag of lagsMs.slice(-FLUSH_LAG_WINDOW)) {
    if (Number.isFinite(lag) && lag - baseline > stall) stall = lag - baseline;
  }
  return Math.min(MAX_FLUSH_LEAD_MS, Math.max(p.FLUSH_LEAD_MS, Math.ceil(2 * stall + 1000)));
}

/** True once the match ends within leadMs (always at the final auction). */
export function shouldFlush(bagTotal: number, auctionDurationMs: number, leadMs: number = FLUSH_LEAD_MS): boolean {
  if (bagTotal <= 0) return true;
  const ms = auctionDurationMs > 0 ? auctionDurationMs : 1000;
  return (bagTotal + 1) * ms <= leadMs;
}

/**
 * Leave weight for the valuation: leftovers are worthless once flushing, and
 * worth less near the end when LEAVE_DECAY_BAG is set (bagTotal: auctions to come).
 */
export function alphaFor(flush: boolean, p: Policy = DEFAULT_POLICY, bagTotal?: number): number {
  if (flush) return 0;
  if (p.LEAVE_DECAY_BAG > 0 && bagTotal !== undefined && bagTotal + 1 < p.LEAVE_DECAY_BAG) {
    return (p.LEAVE_ALPHA * Math.max(0, bagTotal + 1)) / p.LEAVE_DECAY_BAG;
  }
  return p.LEAVE_ALPHA;
}

export interface WordInput {
  counts: Counts;
  /** Candidates from index.scan(counts, ...) for exactly these counts (or a superset rack). */
  cands: Candidates;
  myBalance: number;
  flush: boolean;
  /** Leave weight used to judge what a liquidity play leaves behind (default LEAVE_ALPHA). */
  alpha?: number;
  /** Real (non-sim) rivals at the table; HOLD_MIN_REAL_RIVALS or more holds words for the flush. */
  realRivals?: number;
  /**
   * Auctions still to come (match_state.bag_total); holding starts below HOLD_FROM_BAG (always when
   * absent), and CASH_BROKE_AUCTIONS cashes held words below it (never when absent).
   */
  bagTotal?: number;
  /** Tuning constants (default DEFAULT_POLICY). */
  policy?: Policy;
}

/**
 * Liquidity word for a bot under LIQUIDITY_FLOOR, or -1: among the
 * LIQUIDITY_TOP_K best-paying spellable words of at least minLen letters
 * (LIQUIDITY_MIN_LEN first, then LIQUIDITY_FALLBACK_MIN_LEN), keep those that
 * lift the balance to the floor (or the single best-paying one if none does),
 * and pick the one maximizing reward + value of the remaining rack.
 */
export function liquidityWord(
  index: WordIndex,
  cands: Candidates,
  rem: Counts,
  balance: number,
  alpha: number,
  p: Policy = DEFAULT_POLICY,
): number {
  for (const minLen of [p.LIQUIDITY_MIN_LEN, p.LIQUIDITY_FALLBACK_MIN_LEN]) {
    const top: number[] = [];
    for (let i = 0; i < cands.n && top.length < p.LIQUIDITY_TOP_K; i++) {
      if (cands.extra[i] !== -1) continue;
      const k = cands.keys[i];
      if (index.len[k] >= minLen && index.fits(k, rem)) top.push(k);
    }
    if (top.length === 0) continue;
    const need = p.LIQUIDITY_FLOOR - balance;
    let eligible = top.filter((k) => index.reward[k] >= need);
    if (eligible.length === 0) eligible = [top[0]];
    let best = -1;
    let bestScore = -Infinity;
    for (const k of eligible) {
      const rest = new Int32Array(rem);
      index.consume(rest, k);
      const restPack =
        p.WORDS_EXACT_NODES > 0
          ? index.packExact(cands, rest, -1, alpha, p.WORDS_EXACT_NODES)
          : index.pack(cands, rest, -1, alpha);
      const score = index.reward[k] + packValue(restPack, alpha);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    return best;
  }
  return -1;
}

/**
 * Words to submit now, in order. Flush: the full greedy packing. Otherwise:
 * every 7+ letter word (best first), at a table that holds words only those
 * CASH_WHEN_BROKE releases (CASH_BROKE_BALANCE, CASH_BROKE_AUCTIONS; off by
 * default), then one liquidity word if the balance would still be under
 * LIQUIDITY_FLOOR.
 */
export function chooseWords(index: WordIndex, input: WordInput): string[] {
  const p = input.policy ?? DEFAULT_POLICY;
  if (input.flush) {
    const packed =
      p.WORDS_EXACT_NODES > 0
        ? index.packExact(input.cands, input.counts, -1, 0, p.WORDS_EXACT_NODES)
        : index.pack(input.cands, input.counts, -1);
    return packed.keys.map((k) => index.words[k]);
  }
  const rem = new Int32Array(input.counts);
  const out: string[] = [];
  let balance = input.myBalance;
  // HOLD_FROM_BAG (999 or more: off, so no bag position can reach it) cashes 7+ words while at least that
  // many auctions are still to come.
  const cashEarly = p.HOLD_FROM_BAG < 999 && input.bagTotal !== undefined && input.bagTotal >= p.HOLD_FROM_BAG;
  const hold = (input.realRivals ?? 0) >= p.HOLD_MIN_REAL_RIVALS && !cashEarly;
  // CASH_WHEN_BROKE (0 and 0: off): late in the match every held CASH_MIN_LEN+ word is cashed, and
  // while broke the best one at a time until the balance is back at CASH_BROKE_BALANCE.
  const late = p.CASH_BROKE_AUCTIONS > 0 && input.bagTotal !== undefined && input.bagTotal < p.CASH_BROKE_AUCTIONS;
  const broke = () => p.CASH_BROKE_BALANCE > 0 && balance < p.CASH_BROKE_BALANCE;
  while (!hold || late || broke()) {
    const k = index.bestKey(input.cands, rem, p.CASH_MIN_LEN);
    if (k < 0) break;
    out.push(index.words[k]);
    balance += index.reward[k];
    index.consume(rem, k);
  }
  if (balance < p.LIQUIDITY_FLOOR) {
    const k = liquidityWord(index, input.cands, rem, balance, input.alpha ?? p.LEAVE_ALPHA, p);
    if (k >= 0) out.push(index.words[k]);
  }
  return out;
}
