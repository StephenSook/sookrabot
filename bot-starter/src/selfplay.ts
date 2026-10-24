// Offline self-play: runs the real SookraBot class (bot.ts, unchanged)
// through simulated matches against module-exact sims or starter clones.
//
//   npx tsx src/selfplay.ts [sims|starters] [matches] [seed]
//
// Rules mirrored from spacetimedb/src/game.ts: 98-tile bag, 5-tile hidden
// racks, balance 100, one letter per auction, Vickrey (second price, 1 when
// alone, random ties), unbid letters discarded, sims bid on every letter
// with jitter -2..2 and play their longest 3+ word right after a win, the
// match ends when the bag is empty after a close. Timing is idealized: the
// bot's bid and word plays land before each auction closes.

import * as fs from "node:fs";
import {
  type AuctionRow,
  type BotRow,
  type ConnLike,
  type HoldingRow,
  type MatchStateRow,
  type ParticipantRow,
  SookraBot,
} from "./bot.js";
import { LETTER_VALUE, WordIndex, countsOf, wordReward } from "./engine.js";
import { type SimStrategy, maxSimBid } from "./strategy.js";

const BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2,
  N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
};
const SIMS: [string, SimStrategy][] = [
  ["Cheapo", "Cheapskate"], ["Valor", "ValueBidder"], ["Brutus", "Aggressive"],
  ["Hagrid", "ValueBidder"], ["Maverick", "Aggressive"], ["Snippet", "Cheapskate"],
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Seat {
  id: bigint;
  kind: "me" | "sim" | "starter";
  strategy?: SimStrategy;
  rack: Map<string, number>;
  balance: number;
  score: number;
}

const MATCH = 1n;

class SimServer implements ConnLike {
  matchState: MatchStateRow;
  auction: AuctionRow | null = null;
  bids = new Map<bigint, number>(); // our bid per auction id
  constructor(public seats: Seat[], public bots: Map<bigint, BotRow>, bagTotal: number) {
    this.matchState = {
      id: MATCH,
      status: { tag: "Running" },
      currentAuctionId: undefined,
      bagTotal,
      auctionType: { tag: "Vickrey" },
      auctionDurationMs: 1000n,
      startingRackSize: 5,
    };
  }
  me(): Seat {
    return this.seats.find((s) => s.kind === "me")!;
  }
  db = {
    matchState: { id: { find: (id: bigint) => (id === MATCH ? this.matchState : undefined) } },
    auction: { id: { find: (id: bigint) => (this.auction && this.auction.id === id ? this.auction : undefined) } },
    matchParticipant: {
      iter: (): Iterable<ParticipantRow> =>
        this.seats.map((s) => ({ matchId: MATCH, botId: s.id, balance: BigInt(s.balance), score: BigInt(s.score) })),
    },
    myRack: {
      iter: (): Iterable<HoldingRow> =>
        [...this.me().rack].filter(([, n]) => n > 0).map(([letter, count]) => ({ matchId: MATCH, letter, count })),
    },
    bot: { id: { find: (id: bigint) => this.bots.get(id) } },
  };
  reducers = {
    submitBid: (a: { auctionId: bigint; amount: bigint }): Promise<unknown> => {
      const amt = Number(a.amount);
      if (!this.auction || this.auction.id !== a.auctionId || this.auction.status.tag !== "Open") {
        return Promise.reject(new Error("Auction closed"));
      }
      if (amt < 0 || amt > this.me().balance) return Promise.reject(new Error("Insufficient balance"));
      this.bids.set(a.auctionId, amt);
      return Promise.resolve();
    },
    submitWord: (a: { matchId: bigint; word: string }): Promise<unknown> => {
      if (this.matchState.status.tag !== "Running") return Promise.reject(new Error("Match not running"));
      const me = this.me();
      if (!spend(me, a.word)) return Promise.reject(new Error(`Not enough letters for ${a.word}`));
      return Promise.resolve();
    },
  };
}

function spend(seat: Seat, word: string): boolean {
  const need = countsOf(word);
  for (let i = 0; i < 26; i++) {
    if ((seat.rack.get(String.fromCharCode(65 + i)) ?? 0) < need[i]) return false;
  }
  for (const c of word) seat.rack.set(c, seat.rack.get(c)! - 1);
  const r = wordReward(word);
  seat.balance += r;
  seat.score += r;
  return true;
}

/** Longest word of at least minLen letters, lexicographically first among those (game.ts findBestPlayable). */
function longestWord(index: WordIndex, rack: Map<string, number>, minLen: number): string | null {
  const counts = countsOf(rack);
  const cands = index.scan(counts, false);
  let best: string | null = null;
  for (let i = 0; i < cands.n; i++) {
    const w = index.words[cands.keys[i]];
    if (w.length < minLen) continue;
    if (!best || w.length > best.length || (w.length === best.length && w < best)) best = w;
  }
  return best;
}

const turn = () => new Promise<void>((r) => setImmediate(r));

async function playMatch(index: WordIndex, field: string, rnd: () => number) {
  const bag: string[] = [];
  for (const [c, n] of Object.entries(BAG)) for (let i = 0; i < n; i++) bag.push(c);
  const draw = () => bag.splice(Math.floor(rnd() * bag.length), 1)[0];
  const seats: Seat[] = [{ id: 9n, kind: "me", rack: new Map(), balance: 100, score: 0 }];
  const bots = new Map<bigint, BotRow>([[9n, { name: "SookraBot", isSimulated: false, strategy: { tag: "Human" } }]]);
  const pool = [...SIMS];
  for (let i = 0; i < 5; i++) {
    const id = BigInt(20 + i);
    if (field === "sims") {
      const [name, strategy] = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      seats.push({ id, kind: "sim", strategy, rack: new Map(), balance: 100, score: 0 });
      bots.set(id, { name, isSimulated: true, strategy: { tag: strategy } });
    } else {
      seats.push({ id, kind: "starter", rack: new Map(), balance: 100, score: 0 });
      bots.set(id, { name: `Starter${i}`, isSimulated: false, strategy: { tag: "Human" } });
    }
  }
  for (const s of seats) {
    for (let i = 0; i < 5; i++) {
      const c = draw();
      s.rack.set(c, (s.rack.get(c) ?? 0) + 1);
    }
  }
  const server = new SimServer(seats, bots, bag.length);
  const bot = new SookraBot(index, "SP", { log: () => {}, warn: () => {} });
  bot.myBotId = 9n;
  const starterPlay = (s: Seat) => {
    for (;;) {
      const w = longestWord(index, s.rack, 2);
      if (!w || !spend(s, w)) return;
    }
  };
  for (const s of seats) if (s.kind === "starter") starterPlay(s);

  let auctionId = 1000n;
  while (bag.length > 0) {
    const letter = draw();
    auctionId++;
    server.auction = { id: auctionId, matchId: MATCH, letter, status: { tag: "Open" } };
    server.matchState = { ...server.matchState, bagTotal: bag.length, currentAuctionId: auctionId };
    const bids: { seat: Seat; amount: number }[] = [];
    for (const s of seats) {
      if (s.kind === "sim") {
        const jitter = Math.floor(rnd() * 5) - 2;
        const value = LETTER_VALUE[letter];
        const base = s.strategy === "Cheapskate" ? value - 1 : s.strategy === "ValueBidder" ? value : value + ("AEIOU".includes(letter) ? 4 : 2);
        const amt = Math.max(Math.min(Math.max(base + jitter, 1), s.balance), 0);
        if (amt > maxSimBid(s.strategy!, letter, s.balance)) throw new Error("sim bid above model max");
        bids.push({ seat: s, amount: amt });
      } else if (s.kind === "starter") {
        const value = LETTER_VALUE[letter];
        const want = (s.rack.get(letter) ?? 0) === 0 ? value + 2 : Math.max(1, value);
        bids.push({ seat: s, amount: Math.min(want, Math.max(0, s.balance)) });
      }
    }
    bot.onAuctionOpen(server, server.auction);
    for (let i = 0; i < 6; i++) await turn();
    const mine = server.bids.get(auctionId) ?? 0;
    bids.push({ seat: server.me(), amount: mine });
    const live = bids.filter((b) => b.amount > 0);
    for (let i = live.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [live[i], live[j]] = [live[j], live[i]];
    }
    live.sort((a, b) => b.amount - a.amount);
    server.auction = { ...server.auction, status: { tag: "Closed" } };
    if (live.length > 0) {
      const w = live[0];
      const paid = live.length > 1 ? live[1].amount : Math.min(1, w.amount);
      if (w.seat.balance >= paid) {
        w.seat.balance -= paid;
        w.seat.rack.set(letter, (w.seat.rack.get(letter) ?? 0) + 1);
        if (w.seat.kind === "sim") {
          const word = longestWord(index, w.seat.rack, 3);
          if (word) spend(w.seat, word);
        }
      }
    }
    if (bag.length > 0) for (const s of seats) if (s.kind === "starter") starterPlay(s);
  }
  server.matchState = { ...server.matchState, status: { tag: "Ended" }, currentAuctionId: undefined };
  const me = server.me().score;
  const others = seats.filter((s) => s.kind !== "me").map((s) => s.score);
  return { me, best: Math.max(...others), endBalance: server.me().balance };
}

async function main() {
  const field = process.argv[2] ?? "sims";
  const n = Number(process.argv[3] ?? 50);
  const seed = Number(process.argv[4] ?? 1);
  const words = fs
    .readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8")
    .split("\n");
  const index = WordIndex.fromWords(words);
  const rnd = mulberry32(seed);
  const t0 = performance.now();
  const scores: number[] = [];
  let wins = 0;
  let best = 0;
  let endBal = 0;
  for (let i = 0; i < n; i++) {
    const r = await playMatch(index, field, rnd);
    scores.push(r.me);
    best += r.best;
    endBal += r.endBalance;
    if (r.me >= r.best) wins++;
  }
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  console.log(
    JSON.stringify({
      field, n, seed,
      me_mean: +mean.toFixed(2), me_sd: +sd.toFixed(2),
      best_other_mean: +(best / n).toFixed(2), win_rate: +(wins / n).toFixed(3),
      end_balance_mean: +(endBal / n).toFixed(1), secs: +((performance.now() - t0) / 1000).toFixed(1),
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
