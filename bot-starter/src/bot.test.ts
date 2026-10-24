// Offline checks for the SookraBot loop, driven through a fake connection
// that mimics the module's reducers (bid replacement, word play removing
// letters and crediting balance and score). Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import {
  type AuctionRow,
  type BotRow,
  type ConnLike,
  type HoldingRow,
  type MatchStateRow,
  type ParticipantRow,
  MAX_WORD_FAILURES,
  SookraBot,
  TRANSPORT_BACKOFF_MS,
} from "./bot.js";
import { WordIndex, countsOf, letterIndex, wordReward } from "./engine.js";
import { maxSimBid } from "./strategy.js";

const INDEX = WordIndex.fromWords(
  fs.readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8").split("\n"),
);
const ME = 9n;
const RIVAL = 7n;
const SIM = 3n;
const MATCH = 1n;
const AUCTION = 100n;

/** Shaped like the SDK's transport failure (bot.ts classifies by name). */
class FakeDisconnected extends Error {
  constructor() {
    super("Not connected to SpacetimeDB");
    this.name = "DisconnectedError";
  }
}

class FakeServer implements ConnLike {
  matchStates = new Map<bigint, MatchStateRow>();
  auctions = new Map<bigint, AuctionRow>();
  participants: ParticipantRow[] = [];
  rack: HoldingRow[] = [];
  bots = new Map<bigint, BotRow>();
  bids: { auctionId: bigint; amount: bigint }[] = [];
  words: string[] = [];
  wordAttempts = 0;
  /** Server-side refusal of every bid, e.g. "Auction window expired". */
  bidRefusal: string | null = null;
  /** Transport failure for bids (never reaches the server). */
  bidTransportDown = false;
  refuseWords: string | null = null;
  wordTransportDown = false;
  throwOnRack = false;
  /** When set, word plays wait for release() instead of landing at once. */
  held: (() => void)[] | null = null;

  db: ConnLike["db"] = {
    matchState: { id: { find: (id: bigint) => this.matchStates.get(id) } },
    auction: { id: { find: (id: bigint) => this.auctions.get(id) } },
    matchParticipant: { iter: () => this.participants.values() },
    myRack: {
      iter: () => {
        if (this.throwOnRack) throw new Error("rack read exploded");
        return this.rack.filter((h) => h.count > 0).values();
      },
    },
    bot: { id: { find: (id: bigint) => this.bots.get(id) } },
  };

  reducers = {
    submitBid: async (a: { auctionId: bigint; amount: bigint }) => {
      if (this.bidTransportDown) throw new FakeDisconnected();
      if (this.bidRefusal) throw new Error(this.bidRefusal);
      this.bids.push(a);
    },
    submitWord: (a: { matchId: bigint; word: string }): Promise<unknown> => {
      this.wordAttempts++;
      if (this.wordTransportDown) return Promise.reject(new FakeDisconnected());
      const land = () => {
        if (this.refuseWords) throw new Error(this.refuseWords);
        const need = countsOf(a.word);
        const have = countsOf(this.rackString());
        for (let i = 0; i < 26; i++) {
          if (have[i] < need[i]) throw new Error(`Not enough letters for ${a.word}`);
        }
        for (const c of a.word) {
          const h = this.rack.find((r) => r.letter === c && r.count > 0)!;
          h.count--;
        }
        const me = this.participants.find((p) => p.botId === ME && p.matchId === a.matchId)!;
        me.balance += BigInt(wordReward(a.word));
        me.score += BigInt(wordReward(a.word));
        this.words.push(a.word);
      };
      if (this.held) {
        const held = this.held;
        return new Promise((resolve, reject) => {
          held.push(() => {
            try {
              land();
              resolve(undefined);
            } catch (err) {
              reject(err);
            }
          });
        });
      }
      try {
        land();
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };

  rackString(): string {
    return this.rack.map((h) => h.letter.repeat(h.count)).join("");
  }

  setRack(letters: string) {
    const c = countsOf(letters);
    this.rack = [];
    for (let i = 0; i < 26; i++) {
      if (c[i] > 0) this.rack.push({ matchId: MATCH, letter: String.fromCharCode(65 + i), count: c[i] });
    }
  }

  balance(botId: bigint, v: number) {
    this.participants.find((p) => p.botId === botId)!.balance = BigInt(v);
  }

  /** Close the current auction and open the next one, like closeAuction does. */
  nextAuction(id: bigint, letter: string, bagTotal: number) {
    const m = this.matchStates.get(MATCH)!;
    const cur = m.currentAuctionId !== undefined ? this.auctions.get(m.currentAuctionId) : undefined;
    if (cur) cur.status = { tag: "Closed" };
    this.auctions.set(id, { id, matchId: MATCH, letter, status: { tag: "Open" } });
    this.matchStates.set(MATCH, { ...m, currentAuctionId: id, bagTotal });
    return this.auctions.get(id)!;
  }
}

function setup(
  rack: string,
  bagTotal: number,
  letter = "S",
  opts: { durationMs?: number; withSim?: boolean; clock?: { t: number } } = {},
) {
  const s = new FakeServer();
  s.bots.set(ME, { name: "SookraBot", isSimulated: false, strategy: { tag: "Human" } });
  s.bots.set(RIVAL, { name: "Rival", isSimulated: false, strategy: { tag: "Human" } });
  s.bots.set(SIM, { name: "Brutus-sim", isSimulated: true, strategy: { tag: "Aggressive" } });
  const seated = opts.withSim === false ? [ME, RIVAL] : [ME, RIVAL, SIM];
  for (const id of seated) s.participants.push({ matchId: MATCH, botId: id, balance: 100n, score: 0n });
  s.setRack(rack);
  s.auctions.set(AUCTION, { id: AUCTION, matchId: MATCH, letter, status: { tag: "Open" } });
  s.matchStates.set(MATCH, {
    id: MATCH,
    status: { tag: "Running" },
    currentAuctionId: AUCTION,
    bagTotal,
    auctionType: { tag: "Vickrey" },
    auctionDurationMs: BigInt(opts.durationMs ?? 1000),
  });
  const logs: string[] = [];
  const warns: string[] = [];
  const clock = opts.clock;
  const bot = new SookraBot(
    INDEX,
    "T",
    { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    clock ? () => clock.t : Date.now,
  );
  bot.myBotId = ME;
  return { s, bot, logs, warns };
}

const turn = () => new Promise<void>((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 6; i++) await turn();
}

/** The bid a fresh bot (no caches) settles on for the current state. */
async function referenceBid(s: FakeServer): Promise<bigint | undefined> {
  const before = s.bids.length;
  const ref = new SookraBot(INDEX, "REF", { log: () => {}, warn: () => {} });
  ref.myBotId = ME;
  ref.refresh(s, MATCH);
  await settle();
  const sent = s.bids.slice(before);
  s.bids.length = before;
  return sent.at(-1)?.amount;
}

test("mid-match: cashes a 7-letter word, then bids from the post-play rack", async () => {
  const { s, bot } = setup("RETAINSQ", 30, "E");
  bot.refresh(s, MATCH);
  await settle();
  assert.deepEqual(s.words, ["QINTARS"]);
  assert.equal(s.participants[0].score, 48n);
  assert.equal(s.bids.length, 1, "one bid, not re-sent after the word landed");
  assert.equal(s.bids[0].auctionId, AUCTION);
  assert.ok(s.bids[0].amount > 0n);
});

test("mid-match: hoards short words and does not resend an unchanged bid", async () => {
  const { s, bot } = setup("CAT", 30, "S");
  bot.refresh(s, MATCH);
  bot.refresh(s, MATCH);
  bot.tick(s);
  await settle();
  assert.deepEqual(s.words, []);
  assert.equal(s.bids.length, 1);
});

test("final auction: flushes the whole packing; denies the letter only when a sim could score it", async () => {
  const { s, bot } = setup("JUKEBOXQAE", 0, "E");
  bot.refresh(s, MATCH);
  await settle();
  assert.ok(s.words.includes("JUKEBOX"));
  const total = s.words.reduce((a, w) => a + wordReward(w), 0);
  const cands = INDEX.scan(countsOf("JUKEBOXQAE"), false);
  assert.equal(total, INDEX.pack(cands, countsOf("JUKEBOXQAE"), -1).total);
  assert.equal(s.bids.length, 1);
  assert.equal(s.bids[0].amount, BigInt(maxSimBid("Aggressive", "E", 100) + 1)); // 8
  const noSim = setup("JUKEBOXQAE", 0, "E", { withSim: false });
  noSim.bot.refresh(noSim.s, MATCH);
  await settle();
  assert.ok(noSim.s.words.includes("JUKEBOX"));
  assert.equal(noSim.s.bids.length, 0);
});

test("1000 ms auctions: flush starts 2 auctions before the end, and those letters still get bids", async () => {
  // Flush plays SAX (10) and leaves C, T; an O then makes COT (5).
  const { s, bot, logs } = setup("CATSX", 2, "O");
  bot.refresh(s, MATCH);
  await settle();
  assert.deepEqual(s.words, ["SAX"]);
  assert.equal(s.bids.length, 1);
  assert.equal(s.bids[0].amount, 42n); // floor(8.5 * 5), leave value 0 while flushing
  assert.ok(logs.some((l) => l.includes("m1 start: 3 bots (1 real rivals, 1 sims)")));
  // Three auctions out it still hoards.
  const early = setup("CATSX", 3, "O");
  early.bot.refresh(early.s, MATCH);
  await settle();
  assert.deepEqual(early.s.words, []);
  // 250 ms auctions flush from 11 auctions out.
  const short = setup("CAT", 11, "S", { durationMs: 250 });
  short.bot.refresh(short.s, MATCH);
  await settle();
  assert.equal(short.s.words.length, 1);
});

test("fast path: the next bid is sent synchronously from the precomputed rack+letter table", async () => {
  const { s, bot, logs } = setup("CAT", 30, "S");
  bot.refresh(s, MATCH); // bids on S, then precomputes CAT+S and CAT in later turns
  await settle();
  // We win the S; the server opens the next auction in the same transaction.
  s.setRack("CATS");
  const next = s.nextAuction(101n, "E", 29);
  const before = s.bids.length;
  bot.onAuctionOpen(s, next);
  // No await: the reducer call already happened inside onAuctionOpen.
  assert.equal(s.bids.length, before + 1);
  assert.equal(s.bids.at(-1)!.auctionId, 101n);
  assert.ok(logs.some((l) => l.includes("a101") && l.includes(", table;")), "served from the table");
  const fast = s.bids.at(-1)!.amount;
  await settle();
  assert.equal(s.bids.at(-1)!.amount, fast, "refinement agrees, nothing re-sent");
  assert.equal(await referenceBid(s), fast, "same bid a cold bot computes");
});

test("cold start: a provisional bid goes out at once and is refined to the table value", async () => {
  const { s, bot, logs } = setup("CAT", 30, "S");
  bot.onAuctionOpen(s, s.auctions.get(AUCTION)!);
  assert.equal(s.bids.length, 1, "sent before any deferred work ran");
  assert.ok(logs.some((l) => l.includes(", static;")));
  await settle();
  const refined = s.bids.at(-1)!.amount;
  assert.equal(await referenceBid(s), refined);
});

test("late bids are counted per match and reported at match end", async () => {
  const { s, bot, logs, warns } = setup("CAT", 30, "S");
  s.bidRefusal = "Auction window expired";
  bot.onAuctionOpen(s, s.auctions.get(AUCTION)!);
  await settle();
  const stats = bot.lateStats(MATCH)!;
  assert.equal(stats.firstBids, 1);
  assert.equal(stats.lateFirst, 1);
  assert.ok(warns.some((w) => w.includes("a100: bid") && w.includes("auction missed")));
  bot.onMatchEnded(s, MATCH);
  assert.ok(logs.some((l) => l.includes("m1 ended") && l.includes("late 1 (100.0%)")));
});

test("a bid lost in transport is re-sent; a refused-as-late bid is not", async () => {
  const { s, bot } = setup("CAT", 30, "S");
  s.bidTransportDown = true;
  bot.refresh(s, MATCH);
  await settle();
  assert.equal(s.bids.length, 0);
  s.bidTransportDown = false;
  bot.refresh(s, MATCH);
  await settle();
  assert.equal(s.bids.length, 1, "re-sent once connectivity returned");
  const late = setup("CAT", 30, "S");
  late.s.bidRefusal = "Auction closed";
  late.bot.refresh(late.s, MATCH);
  await settle();
  late.s.bidRefusal = null;
  late.bot.refresh(late.s, MATCH);
  await settle();
  assert.equal(late.s.bids.length, 0, "no pointless retry on a closed auction");
});

test("transport errors never blacklist a word; it plays after the backoff", async () => {
  const clock = { t: 1_000_000 };
  const { s, bot } = setup("RETAINSQ", 30, "E", { clock });
  s.wordTransportDown = true;
  for (let i = 0; i < MAX_WORD_FAILURES + 2; i++) {
    bot.refresh(s, MATCH);
    await settle();
    bot.refresh(s, MATCH); // inside the backoff: no new attempt
    await settle();
    clock.t += TRANSPORT_BACKOFF_MS + 1;
  }
  assert.equal(s.wordAttempts, MAX_WORD_FAILURES + 2);
  s.wordTransportDown = false;
  bot.refresh(s, MATCH);
  await settle();
  assert.deepEqual(s.words, ["QINTARS"]);
});

test("a word in flight is not submitted twice", async () => {
  const { s, bot } = setup("RETAINSQ", 30, "E");
  s.held = [];
  bot.refresh(s, MATCH);
  bot.refresh(s, MATCH);
  await settle();
  assert.equal(s.wordAttempts, 1);
  for (const release of s.held) release();
  await settle();
  assert.deepEqual(s.words, ["QINTARS"]);
  assert.equal(s.wordAttempts, 1);
});

test("refused words are retried at most MAX_WORD_FAILURES times", async () => {
  const { s, bot, warns } = setup("RETAINSQ", 30, "E");
  s.refuseWords = "Match not running";
  for (let i = 0; i < 6; i++) {
    bot.refresh(s, MATCH);
    await settle();
  }
  assert.equal(s.wordAttempts, MAX_WORD_FAILURES);
  assert.ok(warns.some((w) => w.includes("refused")));
});

test("degrade, never crash: throwing reads and refused bids only log", async () => {
  const { s, bot, warns } = setup("CAT", 30, "S");
  s.throwOnRack = true;
  bot.scheduleRefresh(s, MATCH);
  await settle();
  bot.scheduleRefresh(s, MATCH);
  await settle();
  bot.onAuctionOpen(s, s.auctions.get(AUCTION)!);
  await settle();
  assert.ok(warns.length <= 2, "each distinct failure logged once");
  assert.equal(s.bids.length, 0);
  s.throwOnRack = false;
  s.bidRefusal = "Insufficient balance";
  bot.scheduleRefresh(s, MATCH);
  await settle();
  assert.ok(warns.some((w) => w.includes("a100: bid") && w.includes("refused")));
});

test("offline: no decisions on a stale cache while disconnected", async () => {
  const { s, bot } = setup("RETAINSQ", 30, "E");
  bot.online = false;
  bot.onAuctionOpen(s, s.auctions.get(AUCTION)!);
  bot.refresh(s, MATCH);
  bot.tick(s);
  await settle();
  assert.equal(s.bids.length + s.words.length, 0);
  bot.online = true;
  bot.tick(s);
  await settle();
  assert.deepEqual(s.words, ["QINTARS"]);
  assert.equal(s.bids.length, 1);
});

test("participant index is used when it agrees with a scan and dropped when it does not", async () => {
  const good = setup("CAT", 30, "S");
  let used = 0;
  good.s.db.matchParticipant.mpByMatch = {
    filter: (id: bigint) => {
      used++;
      return good.s.participants.filter((p) => p.matchId === id);
    },
  };
  good.bot.refresh(good.s, MATCH);
  await settle();
  assert.ok(used > 0);
  assert.ok(!good.logs.some((l) => l.includes("index disagrees")));
  const bad = setup("CAT", 30, "S");
  bad.s.db.matchParticipant.mpByMatch = { filter: () => [] };
  bad.bot.refresh(bad.s, MATCH);
  await settle();
  assert.ok(bad.logs.some((l) => l.includes("index disagrees")));
  bad.bot.refresh(bad.s, MATCH);
  await settle();
  assert.equal(bad.s.bids.length, 1, "falls back to scanning and still bids");
});

test("duel: a rival going broke drops the bid to the minimum that wins", async () => {
  const { s, bot } = setup("AEINST", 30, "R", { withSim: false });
  bot.refresh(s, MATCH);
  await settle();
  assert.equal(s.bids.length, 1);
  const first = s.bids[0].amount;
  assert.ok(first > 1n);
  s.balance(RIVAL, 0);
  bot.refresh(s, MATCH);
  await settle();
  assert.equal(s.bids.length, 2);
  assert.equal(s.bids[1].amount, 1n);
});

test("sims-only table bids up to the sim cap", async () => {
  const { s, bot } = setup("AEINST", 30, "R");
  s.participants = s.participants.filter((p) => p.botId !== RIVAL);
  bot.refresh(s, MATCH);
  await settle();
  // Aggressive sim on R: 1 + 2 + 2 jitter = 5, so the cap is 6.
  assert.equal(s.bids.length, 1);
  assert.equal(s.bids[0].amount, 6n);
});

test("ended matches and foreign auctions are ignored", async () => {
  const { s, bot } = setup("RETAINSQ", 30, "E");
  s.matchStates.get(MATCH)!.status = { tag: "Ended" };
  bot.refresh(s, MATCH);
  bot.onAuctionOpen(s, s.auctions.get(AUCTION)!);
  await settle();
  assert.equal(s.bids.length + s.words.length, 0);
  const other = setup("RETAINSQ", 30, "E");
  other.bot.myBotId = 42n;
  other.bot.refresh(other.s, MATCH);
  await settle();
  assert.equal(other.s.bids.length + other.s.words.length, 0);
  assert.equal(letterIndex("E"), 4);
});
