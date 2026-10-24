// SookraBot policy: how much to bid and which words to play.
//
// Valuation comes from engine.ts (greedy packing plus a leave value). This
// file turns a marginal value into a bid and a rack into word plays. Every
// tuning knob is a named constant below; the measured basis for each is in
// research_notes/.../scrabblebot_strategy.md (sim.py results).

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
/** Weight of the leave value of held tiles (sim: 0.35 best; 0 scored 107 vs 314). */
export const LEAVE_ALPHA = 0.35;
/** Cash any word of at least this many letters as soon as it forms (multiplier saturates at 7). */
export const CASH_MIN_LEN = 7;
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

export function kappaFor(bagTotal: number): number {
  return bagTotal < ENDGAME_AUCTIONS ? KAPPA * ENDGAME_KAPPA_BOOST : KAPPA;
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
export function duelReserve(opponentCount: number, bagTotal: number): number {
  if (opponentCount > DUEL_MAX_OPPONENTS) return 0;
  return DUEL_RESERVE_PER_AUCTION * Math.max(0, Math.min(bagTotal, DUEL_RESERVE_WINDOW));
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
 *  - otherwise floor(kappa * delta), kappa doubled in the last 12 auctions;
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
  if (rivalMax <= BROKE_RIVAL_MAX_BID) {
    amount = rivalCap;
    reason = `rivals broke (max ${rivalMax})`;
  } else {
    ({ amount, reason } = valueBid(input, rivalCap));
  }
  // The duel reserve applies to every branch, the broke-rival one included.
  const reserve = duelReserve(input.opponents.length, input.bagTotal);
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

/** Bid from the marginal value (kappa, sims-only cap, first-price shading), capped at rivalCap. */
function valueBid(input: BidInput, rivalCap: number): BidDecision {
  const sims = input.opponents.filter((o) => o.isSim && o.strategy);
  const simCap = sims.length
    ? Math.max(...sims.map((o) => maxSimBid(o.strategy!, input.letter, o.balance))) + 1
    : 0;
  const simsOnly = input.opponents.length > 0 && sims.length === input.opponents.length;
  const kappa = kappaFor(input.bagTotal);
  const full = Math.floor(kappa * input.delta);

  let amount: number;
  let reason: string;
  if (simsOnly && input.auctionType === "Vickrey") {
    amount = Math.min(Math.floor(SIM_ONLY_KAPPA * input.delta), simCap);
    reason = `sims-only cap ${simCap}`;
  } else if (input.auctionType === "FirstPrice" && simsOnly) {
    amount = Math.min(full, simCap);
    reason = `fp sims-only k${kappa}`;
  } else if (input.auctionType === "FirstPrice") {
    const face = LETTER_VALUE[input.letter] ?? 1;
    const obs = (input.fpHistory ?? [])
      .filter((p) => p.face === face)
      .slice(-FP_HISTORY_MAX)
      .map((p) => p.paid);
    let target: number;
    if (obs.length >= FP_MIN_OBS) {
      target = Math.max(simCap, quantile(obs, FP_QUANTILE) + 1);
      reason = `fp q${FP_QUANTILE}x${obs.length} k${kappa}`;
    } else {
      target = Math.max(simCap, Math.floor(full * FP_NO_HISTORY_SHADE));
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

/** True once the match ends within FLUSH_LEAD_MS (always at the final auction). */
export function shouldFlush(bagTotal: number, auctionDurationMs: number): boolean {
  if (bagTotal <= 0) return true;
  const ms = auctionDurationMs > 0 ? auctionDurationMs : 1000;
  return (bagTotal + 1) * ms <= FLUSH_LEAD_MS;
}

/** Leave weight for the valuation: leftovers are worthless once flushing. */
export function alphaFor(flush: boolean): number {
  return flush ? 0 : LEAVE_ALPHA;
}

export interface WordInput {
  counts: Counts;
  /** Candidates from index.scan(counts, ...) for exactly these counts (or a superset rack). */
  cands: Candidates;
  myBalance: number;
  flush: boolean;
  /** Leave weight used to judge what a liquidity play leaves behind (default LEAVE_ALPHA). */
  alpha?: number;
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
): number {
  for (const minLen of [LIQUIDITY_MIN_LEN, LIQUIDITY_FALLBACK_MIN_LEN]) {
    const top: number[] = [];
    for (let i = 0; i < cands.n && top.length < LIQUIDITY_TOP_K; i++) {
      if (cands.extra[i] !== -1) continue;
      const k = cands.keys[i];
      if (index.len[k] >= minLen && index.fits(k, rem)) top.push(k);
    }
    if (top.length === 0) continue;
    const need = LIQUIDITY_FLOOR - balance;
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
  if (input.flush) {
    return index.pack(input.cands, input.counts, -1).keys.map((k) => index.words[k]);
  }
  const rem = new Int32Array(input.counts);
  const out: string[] = [];
  let balance = input.myBalance;
  for (;;) {
    const k = index.bestKey(input.cands, rem, CASH_MIN_LEN);
    if (k < 0) break;
    out.push(index.words[k]);
    balance += index.reward[k];
    index.consume(rem, k);
  }
  if (balance < LIQUIDITY_FLOOR) {
    const k = liquidityWord(index, input.cands, rem, balance, input.alpha ?? LEAVE_ALPHA);
    if (k >= 0) out.push(index.words[k]);
  }
  return out;
}
