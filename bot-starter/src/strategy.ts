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
  LETTER_VALUE,
  WordIndex,
  letterIndex,
  packValue,
} from "./engine.js";

export { LETTER_VALUE } from "./engine.js";

// ---- Tuning constants ----

/** Currency bid per point of marginal value against real bots (sim best response 4 to 4.5). */
export const KAPPA = 4.25;
/** Kappa is multiplied by ENDGAME_KAPPA_BOOST when fewer than this many auctions remain. */
export const ENDGAME_AUCTIONS = 12;
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
 * EARLY_KAPPA_SCALE, at tables with at least EARLY_MIN_RIVALS rivals
 * (2: duels are exempt). Coins not spent early raise the pacing factor
 * later. EARLY_KAPPA_SCALE 1 (default): off.
 */
export const EARLY_AUCTIONS = 0;
export const EARLY_KAPPA_SCALE = 1;
export const EARLY_MIN_RIVALS = 1;
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
 * be auctioned. 999 (default): hold for the whole match.
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
/** First-price shading: recent rival prices kept, minimum sample, quantile. */
export const FP_HISTORY_MAX = 40;
export const FP_MIN_OBS = 5;
export const FP_QUANTILE = 0.75;
/** First-price shading with too little price history: bid this share of the full bid. */
export const FP_NO_HISTORY_SHADE = 0.75;
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
  readonly EARLY_MIN_RIVALS: number;
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
  EARLY_MIN_RIVALS,
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
 * Early bid cut (see EARLY_AUCTIONS): EARLY_KAPPA_SCALE in the first
 * EARLY_AUCTIONS auctions of a match at tables with at least EARLY_MIN_RIVALS
 * rivals, else 1.
 */
export function earlyScale(bagTotal: number, auctions: number, rivals: number, p: Policy = DEFAULT_POLICY): number {
  if (p.EARLY_KAPPA_SCALE === 1 || rivals < p.EARLY_MIN_RIVALS) return 1;
  return auctions - 1 - bagTotal < p.EARLY_AUCTIONS ? p.EARLY_KAPPA_SCALE : 1;
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
 * Bid rule, in order:
 *  - final letter (bagTotal 0): a real bot can never play it, but a sim that
 *    wins it plays a word before the match ends (game.ts closeAuction), and
 *    leftover coins are worthless, so with sims seated bid max sim bid + 1
 *    to deny it; with no sims, 0;
 *  - no positive marginal value: 0;
 *  - every rival can bid at most BROKE_RIVAL_MAX_BID (public balances, sim
 *    rules): bid exactly their max + 1, the minimum that wins;
 *  - sims-only table (Vickrey): min(floor(SIM_ONLY_KAPPA * delta), max sim bid + 1);
 *  - otherwise floor(kappa * delta), kappa doubled in the last 12 auctions
 *    and multiplied by the budget pacing factor (pacedKappa; its floor is
 *    PACE_MIN_DUEL in a duel, PACE_MIN otherwise);
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
  const kappaExact = paced
    ? pacedKappa(input.bagTotal, balance, input.auctionsPerMatch, paceMin, p) *
      earlyScale(input.bagTotal, input.auctionsPerMatch!, input.opponents.length, p)
    : kappaFor(input.bagTotal, undefined, p);
  const kappa = +kappaExact.toFixed(4); // for the reason strings
  const full = Math.floor(kappaExact * input.delta);

  let amount: number;
  let reason: string;
  if (simsOnly && input.auctionType === "Vickrey") {
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
  /** Auctions still to come (match_state.bag_total); holding starts below HOLD_FROM_BAG (always when absent). */
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
      const score = index.reward[k] + packValue(index.pack(cands, rest, -1, alpha), alpha);
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
 * every 7+ letter word (best first), then one liquidity word if the balance
 * would still be under LIQUIDITY_FLOOR.
 */
export function chooseWords(index: WordIndex, input: WordInput): string[] {
  const p = input.policy ?? DEFAULT_POLICY;
  if (input.flush) {
    return index.pack(input.cands, input.counts, -1).keys.map((k) => index.words[k]);
  }
  const rem = new Int32Array(input.counts);
  const out: string[] = [];
  let balance = input.myBalance;
  const hold =
    (input.realRivals ?? 0) >= p.HOLD_MIN_REAL_RIVALS && (input.bagTotal === undefined || input.bagTotal < p.HOLD_FROM_BAG);
  while (!hold) {
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
