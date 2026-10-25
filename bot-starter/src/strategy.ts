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
 * ENDGAME_AUCTIONS auctions. 3.8 (from 4) with EARLY_KAPPA_SCALE 0.55: see there.
 */
export const PACED_KAPPA = 3.8;
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
 *
 * Round 3 retune on top of the one-step lookahead (db7be7e as head), paired
 * cloud self-play, calibrated v5 rivals: EARLY_KAPPA_SCALE 0.55 with
 * PACED_KAPPA 3.8 (from 0.4 and 4), seeds 8301 and 8401, 600 matches a field:
 * 6-seat Vickrey (field, mixed, field/top5 with ,smart rivals; 3000 paired)
 * +4.2 points (95% CI +3.2 to +5.1), place -0.11 (CI -0.14 to -0.08); the
 * top-five table (1800) +3.3 (CI +2.3 to +4.4), place -0.16; 8 seats (1200)
 * +1.7, place -0.12; 3, 4 and 5 seats +13.1, +7.3, +6.3; 6-seat first price
 * +6.1; duels (postturing, Dante; 1200) +4.2 (CI +0.05 to +8.4). With the
 * lookahead the 0.4 cut is too deep: 0.3 lost 2 to 9 points everywhere (seed
 * 8101), 0.5 to 0.65 all gained at 6 seats, 0.75 gained nothing.
 *
 * 0.7 (from 0.55) once the 3-letter lookahead (MLOOK, x0.75) was on, against that build
 * (f8c8ac2), seeds 9701 and 9801, 400 and 600 matches a field: 6-seat field and mixed +2.5 (CI
 * +1.3 to +3.7); top-five table, plain and ,smart, +1.5 (CI +0.5 to +2.6), place -0.04 (CI -0.07
 * to -0.01); 7 seats place -0.09, 8 seats place -0.05; 3 seats +10.0, 4 seats +2.9; first price
 * +2.4 at 6 seats, +0.6 at 4 (place +0.02, CI +0.00 to +0.04). 0.45 lost 0.2 to 7.0 points everywhere.
 */
export const EARLY_AUCTIONS = 28;
export const EARLY_KAPPA_SCALE = 0.7;
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
// 5 (from 2): calibrated self-play run 40170095539 against 87860f0, mean place 6-seat field -0.052 (t -2.83),
// top five -0.044, first price -0.037, 4 seats -0.121 (t -4.24), 8 seats no change, duel +0.015 (t 2.66).
export const LIQUIDITY_FALLBACK_MIN_LEN = 5;
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
 *
 * 2000 (from 3000, branch wordplay): the last 2 auctions at 1000 ms. Live on
 * Render the receive lag is about 60 ms with no late bid (30 matches, margin
 * min 723 ms), and flushLeadMs still lengthens the lead after any stall (a
 * 500 ms stall or more flushes 3 auctions out again). Paired self-play against
 * c13519b on the live-calibrated harness (,cal,xpack,rx=1.2), mean place
 * difference with 95% CI: 6-seat field -0.019 (-0.030 to -0.007, n 800, seed
 * 20001) and -0.046 (-0.074 to -0.018, n 500, seed 20002), top-five table
 * -0.030 (-0.046 to -0.014, n 800), 8 seats -0.048 (-0.084 to -0.012, n 250),
 * Dante duel -0.008 (-0.016 to -0.001, n 600, +3.8 points), 4 seats no place
 * change (+1.1 points, n 50); live replay of the word policy on the 248
 * recorded matches +0.15 points (-0.02 to +0.33). 1000 gained a little more
 * (-0.026 and -0.048) but leaves one auction of margin for the whole hoard.
 */
export const FLUSH_LEAD_MS = 2000;
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
/**
 * FP_QUANTILE 0.2 (from 0.3), round 3 on top of the early-cut retune: first-price fields, seeds 9201
 * and 9602, 500 to 600 matches each: +4.3 to +7.6 points at 2 to 6 seats (each CI above zero, also
 * against rivals shading by 0.8), +0.3 to +1.0 at 8 seats (CI includes zero); 0.4 lost 1.4 to 6.2.
 */
export const FP_QUANTILE = 0.2;
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

// Prediction v2 knobs. All are off by default except the gated lookahead
// (LOOKAHEAD_WEIGHT 1 with LOOKAHEAD_MIN_REAL_RIVALS 2), so DEFAULT_POLICY plays
// as the live build 5318ca6 everywhere the lookahead's gate is closed; the
// self-play harness turns any knob on or off by name.

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
 *
 * Cloud self-play, paired against 5318ca6 (head), LOOKAHEAD_WEIGHT 1:
 *  - 6-seat Vickrey, calibrated v5 rivals (top5, field, mixed; seeds 7102,
 *    7201, 7203; 6000 paired matches): +6.1 points (95% CI +5.4 to +6.7),
 *    place -0.24 (CI -0.27 to -0.21), wins +11.4 points of share;
 *  - the same tables with stronger rivals (,smart / @0.9 / shade=1.2, seed
 *    7202, 1800): +5.0 points (CI +3.8 to +6.3), place -0.15;
 *  - 3 seats (1200): +8.7 points, place -0.13; 5 seats (1800): +1.8 points
 *    (CI +0.4 to +3.3), place -0.11; 4 seats (2400): -0.7 points (CI -2.3 to
 *    +0.9), place -0.05 (CI -0.09 to -0.02);
 *  - duels: -9.6 to -62.7 points; 6-seat first price: -4.4. Hence the gate.
 * Weights 0.5, 0.75, 1.5 and 2 each gained less than 1. The unseen pool and
 * the full-bag prior measured the same (seed 7102: +6.4 / +7.4 / +4.2 against
 * +6.7 / +7.0 / +4.3). A spend-matched control (PACED_KAPPA 4.6, seed 7203)
 * gained only +0.6 to +1.9, so the gain is not just spending more.
 */
export const LOOKAHEAD_WEIGHT = 1;
export const LOOKAHEAD_HORIZON = 10;
export const LOOKAHEAD_POOL = 1;
/**
 * The lookahead applies only in Vickrey auctions at tables with at least
 * LOOKAHEAD_MIN_REAL_RIVALS real (non-sim) rivals (3 or more seats); 0:
 * everywhere. Gated off, duels, first-price and sim-padded tables play exactly
 * as head (cloud run seed 7301: 600 of 600 identical in each such field).
 * FP_LOOKAHEAD (finals-patch) reopens the gate at first-price tables.
 */
export const LOOKAHEAD_MIN_REAL_RIVALS = 2;
/**
 * EMP_DEAD_SCALE: a letter the rack's packing has no use for (its marginal
 * value is only its own leave value, alpha x LEAVE_W7) is valued instead at
 * alpha x EMP_DEAD_SCALE x the empirical points per won tile of that letter
 * (empirical.ts: final score regressed on tiles won, live all-real 6-seat
 * matches). 0: off. 0.85 keeps the table's mean near LEAVE_W7's.
 */
export const EMP_DEAD_SCALE = 0;

// Round 3 knobs, off by default.

/**
 * MLOOK_M: the refined bid values the letter on auction by the multi-letter
 * lookahead (pool.ts multiLookDelta), its mean marginal value on the rack plus
 * m = min(MLOOK_M, floor(bagTotal x MLOOK_RATE)) more letters drawn from the
 * unseen pool, over MLOOK_SAMPLES draws, at leave weight alpha x
 * MLOOK_ALPHA_SCALE: a sampled estimate of the odds that the pool completes a
 * word (7+ letters included) with this letter within the letters still to be
 * won. MLOOK_TILT draws letter e with weight pool_e x (delta_R(e) / mean
 * delta_R)^MLOOK_TILT (0: as the pool), since we win the letters we bid high
 * on. Same gate as the one-step lookahead (LOOKAHEAD_WEIGHT,
 * LOOKAHEAD_MIN_REAL_RIVALS); where m < 2 the one-step lookahead applies; with
 * LOOKAHEAD_POOL 0 the draws come from the full bag instead. MLOOK_SCALE
 * multiplies the value it returns (it runs above the one-step values, so this
 * matches spend only where it applies). 0: off.
 *
 * Round 3 settings, on by default: MLOOK_M 3, MLOOK_RATE 1 (three letters ahead until the last two
 * auctions), MLOOK_SAMPLES 32, MLOOK_SCALE 0.75. Paired cloud self-play against the early-cut build
 * (f773eff), calibrated v5 rivals, 600 matches a field: seed 9301 (alone) and 9601 (with the spite
 * and first-price settings below; those touch only duels and first price): 6-seat field and mixed
 * +10.3 to +11.3 points, place -0.07 to -0.13; top-five table +7.0 to +8.4, place -0.11 to -0.17;
 * ,smart top five +7.1; 3 seats +26 to +27, 4 seats +21 to +22, 5 seats +13 to +17; 7 seats +4.0
 * to +4.9, place -0.09;
 * 8 seats +1.7 to +2.7 (place -0.06 and -0.01, CIs include zero); padded pad-ls-code +17.5. A
 * spend control (PACED_KAPPA 3.23, the same 0.85 bid cut without the lookahead) gained +1.1 at 6
 * seats and lost 1.8 at 8, so the gain is the multi-letter value, not spending less. At m 12 and
 * rate 0.2 it lost (seed 8201); 16 samples gained 1 to 2.3 points less than 32 (seed 9301). It costs
 * about 20 ms of CPU per auction on a CI runner (32 samples), after the instant bid has gone out.
 */
export const MLOOK_M = 3;
export const MLOOK_RATE = 1;
export const MLOOK_SAMPLES = 32;
export const MLOOK_ALPHA_SCALE = 1;
export const MLOOK_TILT = 0;
export const MLOOK_SCALE = 0.75;
/** EARLY_RAMP 1: the early cut ramps linearly up to 1 over the window instead of a step (earlyScale). 0: step. */
export const EARLY_RAMP = 0;
/**
 * SPITE_ALPHA: in a Vickrey duel (the 3-game final), when the rival's predicted bid on the letter
 * (median of its bids seen this match on letters of the same face, at least SPITE_MIN_OBS of them) is
 * above ours, bid ours + SPITE_ALPHA x (predicted - ours), capped at SPITE_CAP x ours, tapering to 0
 * over the last SPITE_HORIZON auctions: our bid is the rival's price, so it pays more (Brandt,
 * Sandholm and Shoham 2007). 0: off. Round 3, on: alpha 0.5, cap 2, 2 observations. Duel fields
 * (postturing, Dante, guesser, Doppio, Nijello, james, LetterShark, Yezi), seeds 9001 and 9401, 800
 * a field: score margin +5.2 (CI +2.7 to +7.6, n 5600) and +5.4 (CI +3.0 to +7.8, n 6400), wins +1
 * point; alpha 1 lost 11.6. Gated to two-seat Vickrey tables, so nothing else changes.
 */
export const SPITE_ALPHA = 0.5;
export const SPITE_CAP = 2;
export const SPITE_HORIZON = 15;
export const SPITE_MIN_OBS = 2;
/**
 * SPEND_FLOOR: every value bid (paced, Vickrey, at tables of at least
 * SPEND_FLOOR_MIN_REAL_RIVALS real rivals) is raised by
 * floor(SPEND_FLOOR x balance / auctions left including this one), an even
 * share of the purse, so letters nobody else wants are bought at the
 * runner-up price (the rival gaucho bot's tuned pace term, 0.738). 0: off.
 */
export const SPEND_FLOOR = 0;
export const SPEND_FLOOR_MIN_REAL_RIVALS = 2;

// Finals knobs (2026-10-24 evening, branch finals-patch). Paired cloud self-play against 9f1faba (head),
// rivals shading by 0.8 at first-price tables (,fp,shade=0.8,warm), seeds 10241 to 10245; d = variant
// minus head per match, 95% CI = mean +/- 1.96 se; swiss = Swiss points (match size minus place).

/**
 * ALLIN_LAST: at the last auction a real bot can still use (bagTotal 1: the match ends inside the
 * transaction that closes the bagTotal 0 auction, game.ts closeAuction), coins are worth nothing
 * afterwards, so any letter with positive value is bid min(balance, richest rival's balance + 1) in
 * either auction type, with no duel reserve. Only at tables with no sim seated (a sim can still use
 * the final letter, and the final-letter deny bid needs coins). 0: off.
 *
 * On (sign fixed by the rules; checked for harm): first price +0.28 points at 6 seats (n 500, CI
 * +0.15 to +0.40), +0.31 top five (CI +0.10 to +0.52), +0.32 at 4 (n 400, CI +0.22 to +0.43), +0.38
 * at 8 (CI +0.25 to +0.52, swiss +0.022, CI +0.004 to +0.041); Vickrey 4, 6, 7 and 8 seats: d score
 * exactly 0 in every match (n 500 each); Vickrey duels +0.01 to +0.10 (n 1500 each, never below 0),
 * first-price duels +0.04 to +0.58; 3-game final (summed score, 500 finals a field) win share moved
 * by at most 0.003 either way, summed margin +0.03 to +2.1.
 */
export const ALLIN_LAST = 1;
/**
 * FP_LOOKAHEAD: the one-step and multi-letter lookaheads (bot.ts lookaheadOn) also run in
 * first-price auctions at tables with at least LOOKAHEAD_MIN_REAL_RIVALS real rivals. 0: off
 * (Vickrey only). Vickrey tables and duels are untouched by construction.
 *
 * On: first price, 6-seat field +8.7 points (n 500, CI +6.2 to +11.3; swiss +0.088, CI +0.044 to
 * +0.132), top five +3.6 (CI +1.3 to +5.9; swiss +0.056, CI -0.003 to +0.115), 8 seats +5.7 (n 400,
 * CI +4.1 to +7.2; swiss +0.163, CI +0.070 to +0.255), 4 seats +3.8 (n 400, CI -0.7 to +8.4; swiss
 * +0.022, CI -0.014 to +0.059). Shipped together with ALLIN_LAST, confirmed on a fresh seed (10251,
 * code a94a4a1, n 400 a field): first price 6 seats +7.2 (CI +4.4 to +10.1; swiss +0.077, CI +0.025
 * to +0.130), 8 seats +6.9 (CI +5.3 to +8.5; swiss +0.300, CI +0.199 to +0.401), 4 seats +4.2 (CI
 * -0.3 to +8.7; swiss +0.003); the two 4-seat runs pooled (n 800): +4.0 (CI about +0.8 to +7.2),
 * swiss +0.013 (CI about -0.013 to +0.038). Vickrey 6 and 8 seats: d score exactly 0 (n 400 each);
 * first-price duel (Nijello) +0.08 (CI -0.48 to +0.64), 3-game final win share 0.797 to 0.801.
 */
export const FP_LOOKAHEAD = 1;
/**
 * FP_SURPLUS: with at least FP_MIN_OBS same-face first-price prices, the bid is the b in
 * [current shaded bid, min(full bid, rival cap, spendable)] that maximizes (full - b) x G(b), G the
 * empirical chance that b beats the rivals' top bid (share of same-face rival winning prices below
 * b, half of those equal to it). The current FP_QUANTILE target stays the floor, so a letter worth
 * many coins to the rack is no longer capped like a filler. 0: off.
 *
 * Off: it lost everywhere it was measured (code ce48201, before the spendable cap; the cap only
 * lowers the bids it raises). First price -15.6 points at 6 seats (CI -17.7 to -13.5),
 * -13.3 top five, -29.4 at 4, -3.4 at 8; first-price duels -45.6 (Nijello) and -45.8 (postturing),
 * the 3-game final win share 0.77 to 0.34 and 0.92 to 0.70. With FP_LOOKAHEAD it gave back the
 * lookahead's gain at 6 seats (+0.3 field and -2.7 top five, against +8.7 and +3.6) and lost 17.5
 * at 4 seats; only at 8 seats did it add (+6.1 against +5.7).
 */
export const FP_SURPLUS = 0;
/**
 * EARLY_LEN_SEATS: at tables of at least this many seats, the early-cut window is
 * round(EARLY_AUCTIONS x auctions per match / EARLY_REF_AUCTIONS) instead of EARLY_AUCTIONS, so the
 * cut covers the same share of a shorter match (28 auctions of 68 at 6 seats). A seat threshold,
 * not a switch: 7 means 7+ seats. 0: off.
 *
 * Off: at 7, Vickrey 7 seats +0.33 points (n 500, CI -0.39 to +1.04) but swiss -0.050 (CI -0.090 to
 * -0.010), a worse place; Vickrey 8 seats +0.22 in two runs (n 500 and 400, each CI about -0.7 to
 * +1.1; swiss +0.022 and +0.028, CIs include 0); first price 8 seats +0.96 (CI +0.01 to +1.91; swiss
 * +0.045, CI -0.023 to +0.113) and +0.5 on top of the shipped knobs.
 */
export const EARLY_LEN_SEATS = 0;
/** Auctions in the 6-seat match EARLY_AUCTIONS was tuned on (98 - 5 x 6). */
export const EARLY_REF_AUCTIONS = 68;

// Word-play and timing knobs (2026-10-24 night, branch wordplay), off by default. Measured in the
// live-calibrated harness (selfplay.ts field modifier ,cal; see the knob notes for each result).

/**
 * TIME_TILT: at paced tables with at least EARLY_MIN_REAL_RIVALS real rivals, kappa times
 * 1 + TIME_TILT x (1 - 2 x idx / (auctions - 1)), idx the auction index (0 first): spend more early
 * and less late (live SookraBot spends 31.7 / 61.8 / 79.8 coins early / mid / late, the winners about
 * 73 / 58 / 54, and every bot earns about twice as many points a coin early as late). 0: off.
 */
export const TIME_TILT = 0;
/**
 * DEAD_LATE_BAG: with fewer than this many auctions to come, no bid on a dead letter (isDeadLetter:
 * worth no more to the rack than its own leave value), whose value is a word that can no longer form.
 * Live SookraBot wins 0.55 letters a match after its last word (7.2 coins), the flushers 0.07 to 0.16.
 * 0: off.
 */
export const DEAD_LATE_BAG = 0;
/**
 * ENDGAME_SMALL_SEATS: at tables of at most this many seats (the whole table, us included), the endgame
 * boost is ENDGAME_BOOST_SMALL instead of ENDGAME_KAPPA_BOOST; bigger tables keep ENDGAME_KAPPA_BOOST. 0: off.
 *
 * On at 6 with ENDGAME_BOOST_SMALL 1 (no endgame boost at 6 seats or fewer). Calibrated self-play
 * (,cal,xpack,rx=1.2), ENDGAME_KAPPA_BOOST 1 against 2 on top of FLUSH_LEAD_MS 2000, mean place, 95% CI:
 * 6-seat field -0.046 (-0.082 to -0.010, n 480, seed 20004), top five -0.075 (-0.121 to -0.029), and in
 * the seed 20002 stack -0.043; 4 seats -0.006 (-0.015 to +0.003, +0.4 points); Dante duel 0.000. At 8
 * seats it lost: +0.058 (-0.033 to +0.150) and +0.12 against the same stack without it, hence the gate;
 * 7 seats and up keep the boost of 2 and play exactly as before.
 */
export const ENDGAME_SMALL_SEATS = 6;
export const ENDGAME_BOOST_SMALL = 1;

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
  readonly MLOOK_M: number;
  readonly MLOOK_RATE: number;
  readonly MLOOK_SAMPLES: number;
  readonly MLOOK_ALPHA_SCALE: number;
  readonly MLOOK_TILT: number;
  readonly MLOOK_SCALE: number;
  readonly EARLY_RAMP: number;
  readonly SPITE_ALPHA: number;
  readonly SPITE_CAP: number;
  readonly SPITE_HORIZON: number;
  readonly SPITE_MIN_OBS: number;
  readonly SPEND_FLOOR: number;
  readonly SPEND_FLOOR_MIN_REAL_RIVALS: number;
  readonly ALLIN_LAST: number;
  readonly FP_LOOKAHEAD: number;
  readonly FP_SURPLUS: number;
  readonly EARLY_LEN_SEATS: number;
  readonly TIME_TILT: number;
  readonly DEAD_LATE_BAG: number;
  readonly ENDGAME_SMALL_SEATS: number;
  readonly ENDGAME_BOOST_SMALL: number;
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
  MLOOK_M,
  MLOOK_RATE,
  MLOOK_SAMPLES,
  MLOOK_ALPHA_SCALE,
  MLOOK_TILT,
  MLOOK_SCALE,
  EARLY_RAMP,
  SPITE_ALPHA,
  SPITE_CAP,
  SPITE_HORIZON,
  SPITE_MIN_OBS,
  SPEND_FLOOR,
  SPEND_FLOOR_MIN_REAL_RIVALS,
  ALLIN_LAST,
  FP_LOOKAHEAD,
  FP_SURPLUS,
  EARLY_LEN_SEATS,
  TIME_TILT,
  DEAD_LATE_BAG,
  ENDGAME_SMALL_SEATS,
  ENDGAME_BOOST_SMALL,
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
  /** Predicted bid of a duel rival on this letter (SPITE_ALPHA); absent: unknown, no spite. */
  rivalBidHint?: number;
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

/**
 * FP_SURPLUS bid: the b in [lo, hi] maximizing (value - b) x G(b), with G(b) the share of `prices`
 * (rivals' winning first-price bids) below b, counting those equal to b as half (a random tie).
 * Ties in expected surplus keep the lower bid. Returns lo when hi < lo.
 */
export function surplusBid(value: number, prices: readonly number[], lo: number, hi: number): number {
  const n = prices.length;
  let best = lo;
  if (n === 0 || !(hi > lo)) return best;
  const win = (b: number) => {
    let below = 0;
    let equal = 0;
    for (const x of prices) {
      if (x < b) below++;
      else if (x === b) equal++;
    }
    return (below + 0.5 * equal) / n;
  };
  let bestU = (value - lo) * win(lo);
  for (let b = lo + 1; b <= hi; b++) {
    const u = (value - b) * win(b);
    if (u > bestU + 1e-9) {
      bestU = u;
      best = b;
    }
  }
  return best;
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
  ramp = 0,
): number {
  if (scale === 1 || realRivals < minRealRivals) return 1;
  const idx = auctions - 1 - bagTotal;
  if (!(idx < window)) return 1;
  // EARLY_RAMP: the cut eases linearly from `scale` at the first auction to 1 at the end of the window.
  return ramp > 0 ? scale + ((1 - scale) * Math.max(0, idx)) / window : scale;
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
  // Finals knob (ALLIN_LAST, on since 18b3203; 0 restores 9f1faba): coins are worthless after the last
  // playable auction. The trigger is the delta as given, which at a lookahead table can carry a small
  // lookahead term on a letter with no immediate use; such a win costs only coins worth nothing by then.
  const allIn =
    p.ALLIN_LAST > 0 &&
    input.bagTotal === 1 &&
    input.opponents.length > 0 &&
    input.opponents.every((o) => !o.isSim);
  if (allIn) {
    return { amount: clamp(rivalCap), reason: `all-in last (cap ${rivalCap})` };
  }
  if (rivalMax <= p.BROKE_RIVAL_MAX_BID) {
    amount = rivalCap;
    reason = `rivals broke (max ${rivalMax})`;
  } else {
    ({ amount, reason } = valueBid(input, rivalCap, balance, p));
  }
  // Round 3 lever, off by default (SPITE_ALPHA 0): in a Vickrey duel, when the rival is predicted to outbid us,
  // raise our bid (its price) toward its predicted bid, capped at SPITE_CAP x our own bid, tapering to 0 over
  // the last SPITE_HORIZON auctions (coins drained at the end are worth nothing).
  const hint = input.rivalBidHint;
  if (
    p.SPITE_ALPHA > 0 &&
    hint !== undefined &&
    input.auctionType === "Vickrey" &&
    input.opponents.length === 1 &&
    !input.opponents[0].isSim &&
    amount > 0 &&
    hint > amount
  ) {
    const a = p.SPITE_ALPHA * Math.min(1, input.bagTotal / Math.max(1, p.SPITE_HORIZON));
    const spite = Math.min(Math.floor(amount + a * (hint - amount)), Math.floor(p.SPITE_CAP * amount), rivalCap);
    if (spite > amount) {
      amount = spite;
      reason += ` spite ${hint}`;
    }
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
  // Finals knob (EARLY_LEN_SEATS, off by default): the early window scales with match length at big tables.
  const earlyWindow =
    p.EARLY_LEN_SEATS > 0 && paced && input.opponents.length + 1 >= p.EARLY_LEN_SEATS
      ? Math.round((p.EARLY_AUCTIONS * input.auctionsPerMatch!) / EARLY_REF_AUCTIONS)
      : p.EARLY_AUCTIONS;
  // paced implies auctionsPerMatch is a positive number (pacingOn).
  // ENDGAME_SMALL_SEATS: small tables use ENDGAME_BOOST_SMALL in the endgame (only kappa reads the boost).
  const seats = input.opponents.length + 1;
  const pk: Policy =
    p.ENDGAME_SMALL_SEATS > 0 && seats <= p.ENDGAME_SMALL_SEATS && p.ENDGAME_BOOST_SMALL !== p.ENDGAME_KAPPA_BOOST
      ? { ...p, ENDGAME_KAPPA_BOOST: p.ENDGAME_BOOST_SMALL }
      : p;
  const kappaRule = paced
    ? pacedKappa(input.bagTotal, balance, input.auctionsPerMatch, paceMin, pk) *
      earlyScale(
        input.bagTotal,
        input.auctionsPerMatch!,
        realRivals,
        earlyWindow,
        p.EARLY_KAPPA_SCALE,
        p.EARLY_MIN_REAL_RIVALS,
        p.EARLY_RAMP,
      )
    : kappaFor(input.bagTotal, undefined, pk);
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
  // Word-play knob (TIME_TILT, off by default): a linear tilt of kappa from early to late.
  const apm = input.auctionsPerMatch ?? 0;
  const tilt =
    p.TIME_TILT !== 0 && paced && apm > 1 && realRivals >= p.EARLY_MIN_REAL_RIVALS
      ? Math.max(0.1, 1 + p.TIME_TILT * (1 - (2 * Math.max(0, apm - 1 - input.bagTotal)) / (apm - 1)))
      : 1;
  const kappaTilted = kappaRule * tilt;
  // Word-play knob (DEAD_LATE_BAG, off by default): no late bid on a letter only its leave value prices.
  if (
    p.DEAD_LATE_BAG > 0 &&
    input.bagTotal < p.DEAD_LATE_BAG &&
    !simsOnlyVickrey &&
    input.leaveAlpha !== undefined &&
    isDeadLetter(input.letter, input.delta, input.leaveAlpha)
  ) {
    return { amount: 0, reason: `dead-late (bag ${input.bagTotal})` };
  }
  const kappaExact = dead ? kappaTilted * p.DEAD_KAPPA_SCALE : kappaTilted;
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
  // Round 3 lever, off by default (SPEND_FLOOR 0): an additive spend floor per auction.
  if (
    p.SPEND_FLOOR > 0 &&
    paced &&
    input.auctionType === "Vickrey" &&
    realRivals >= p.SPEND_FLOOR_MIN_REAL_RIVALS
  ) {
    const add = Math.floor((p.SPEND_FLOOR * balance) / (input.bagTotal + 1));
    if (add > 0) {
      full += add;
      tag += ` floor+${add}`;
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
    // Finals knob (FP_SURPLUS, off by default): maximize expected surplus against the observed prices.
    if (p.FP_SURPLUS > 0 && obs.length >= p.FP_MIN_OBS) {
      // Search only bids that can be submitted: the balance and decideBid's duel-reserve cap bind later.
      const reserve = duelReserve(input.opponents.length, input.bagTotal, p);
      const spendCap = reserve > 0 ? Math.max(balance - reserve, Math.floor(balance / (input.bagTotal + 1))) : balance;
      const best = surplusBid(full, obs, amount, Math.min(full, rivalCap, spendCap));
      if (best > amount) {
        amount = best;
        reason += ` surplus ${best}`;
      }
    }
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
