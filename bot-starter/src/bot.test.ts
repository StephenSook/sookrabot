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
  PENDING_CALL_DEADLINE_MAX_MS,
  PENDING_CALL_DEADLINE_MS,
  SookraBot,
  TRANSPORT_BACKOFF_MS,
  WORD_LATENCY_WINDOW,
} from "./bot.js";
import { WordIndex, countsOf, letterIndex, valuate, wordReward } from "./engine.js";
import { ConnectionLifecycle } from "./lifecycle.js";
import { LEAVE_ALPHA, PACED_KAPPA, PACE_MIN_DUEL, maxSimBid } from "./strategy.js";
import { Supervisor, type Scheduler } from "./supervisor.js";

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

/** Shaped like the SDK's "connection lost before the call was acknowledged; it may or may not have run". */
class FakeUnknownResult extends Error {
  constructor() {
    super("Connection lost before the call was acknowledged; it may or may not have run");
    this.name = "UnknownCallResultError";
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
  /** Every word submitted, in order, whatever became of it. */
  attempted: string[] = [];
  /** Server-side refusal of every bid, e.g. "Auction window expired". */
  bidRefusal: string | null = null;
  /** Transport failure for bids (never reaches the server). */
  bidTransportDown = false;
  /** The next bid executes on the server but its acknowledgement is lost. */
  bidUnknownOnce = false;
  refuseWords: string | null = null;
  wordTransportDown = false;
  throwOnRack = false;
  /** When set, word plays wait for release() instead of landing at once. */
  held: (() => void)[] | null = null;
  /** Per held play: run it on the server without answering, or fail it as the SDK does when its connection is dropped. */
  heldCalls: { runSilently: () => void; drop: (err: unknown) => void }[] = [];

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
      if (this.bidUnknownOnce) {
        this.bidUnknownOnce = false;
        throw new FakeUnknownResult();
      }
    },
    submitWord: (a: { matchId: bigint; word: string }): Promise<unknown> => {
      this.wordAttempts++;
      this.attempted.push(a.word);
      if (this.wordTransportDown) return Promise.reject(new FakeDisconnected());
      const land = () => this.runWord(a);
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
          this.heldCalls.push({ runSilently: land, drop: reject });
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

  /**
   * The module running a word play: refused (throws) unless every letter is
   * held, checked before any is taken (game.ts playWord), else the letters go
   * and the reward is credited.
   */
  runWord(a: { matchId: bigint; word: string }) {
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
  }

  rackString(): string {
    return this.rack.map((h) => h.letter.repeat(h.count)).join("");
  }

  /** Another connection to this same server (the bot tells connections apart by object identity). */
  connection(): ConnLike {
    return { db: this.db, reducers: this.reducers };
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
  // Budget pacing: the reward raises the balance, so the bid is re-sent at most once, at the paced amount.
  assert.ok(s.bids.length >= 1 && s.bids.length <= 2, "at most one re-send, after the word landed");
  assert.ok(s.bids.every((b) => b.auctionId === AUCTION));
  assert.ok(s.bids.at(-1)!.amount > 0n);
  assert.equal(s.bids.at(-1)!.amount, await referenceBid(s), "final bid = a fresh bot's bid on the post-play state");
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
  // Leave value 0 while flushing: the O is worth exactly COT's 5 points (the amount is paced).
  assert.ok(logs.some((l) => /'O' bag 2: bid \d+ \(value 5\.00,/.test(l)));
  assert.ok(s.bids.length >= 1 && s.bids.every((b) => b.amount > 0n));
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

test("a bid whose acknowledgement was lost is re-sent as desired, even unchanged or a 0 withdrawal", async () => {
  // Racks of a lone Q: no word exists, so the liquidity rule cannot change the rack.
  // First positive bid executes but its ack is lost; then we no longer want the letter.
  const a = setup("Q", 30, "S");
  a.s.bidUnknownOnce = true;
  a.bot.refresh(a.s, MATCH);
  await settle();
  assert.equal(a.s.bids.length, 1);
  assert.ok(a.s.bids[0].amount > 0n, "the server holds this bid");
  a.s.balance(ME, 0); // desired bid is now 0
  a.bot.refresh(a.s, MATCH);
  await settle();
  assert.equal(a.s.bids.at(-1)!.amount, 0n, "withdrawal sent despite no confirmed bid");

  // A confirmed bid X, then a replacement Y executes with its ack lost, then X is wanted again.
  const b = setup("Q", 30, "S");
  b.bot.refresh(b.s, MATCH);
  await settle();
  const x = b.s.bids.at(-1)!.amount;
  b.s.balance(ME, 3);
  b.s.bidUnknownOnce = true;
  b.bot.refresh(b.s, MATCH);
  await settle();
  assert.equal(b.s.bids.at(-1)!.amount, 3n, "server now holds the replacement");
  b.s.balance(ME, 100);
  b.bot.refresh(b.s, MATCH);
  await settle();
  assert.equal(b.s.bids.at(-1)!.amount, x, "X re-sent although it was the last confirmed amount");
  // Once acknowledged, normal dedupe resumes.
  const n = b.s.bids.length;
  b.bot.refresh(b.s, MATCH);
  await settle();
  assert.equal(b.s.bids.length, n);
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

test("Codex repro: a slow acknowledgement does not release the reservation (no double QINTARS)", async () => {
  const clock = { t: 5_000_000 };
  const { s, bot } = setup("RETAINSQ", 30, "E", { clock });
  s.held = [];
  bot.refresh(s, MATCH);
  await settle();
  assert.equal(s.wordAttempts, 1);
  clock.t += 3001; // well past any timer, ack still outstanding
  bot.refresh(s, MATCH);
  bot.tick(s);
  await settle();
  assert.equal(s.wordAttempts, 1, "elapsed time alone does not mean the play failed");
  clock.t += 60_000;
  bot.refresh(s, MATCH);
  bot.tick(s); // well past PENDING_CALL_DEADLINE_MS: the reservation still stands
  await settle();
  assert.equal(s.wordAttempts, 1);
  for (const release of s.held) release();
  await settle();
  assert.deepEqual(s.words, ["QINTARS"]);
});

test("Codex repro: a word call never answered blocks neither a disjoint word nor recovery", async () => {
  const clock = { t: 7_000_000 };
  const { s, bot } = setup("RETAINSQ", 30, "E", { clock });
  const stuckAt: number[] = [];
  bot.onStuck = (conn, why) => {
    assert.equal(conn, s);
    assert.match(why, /QINTARS/);
    stuckAt.push(clock.t);
  };
  s.held = [];
  bot.refresh(s, MATCH);
  await settle();
  s.held = null; // later plays land at once; QINTARS's answer never comes
  assert.deepEqual(s.attempted, ["QINTARS"]);
  const sentAt = clock.t;
  s.setRack("RETAINSQJUKBOX"); // we win tiles that make JUKEBOX with the leftover E
  let id = 200n;
  for (let ms = 250; ms <= 30_000; ms += 250) {
    clock.t = sentAt + ms;
    if (ms % 1000 === 0) bot.onAuctionOpen(s, s.nextAuction(id++, "E", 29));
    bot.tick(s);
    await settle();
  }
  assert.deepEqual(s.attempted, ["QINTARS", "JUKEBOX"], "JUKEBOX is cashed; QINTARS is never sent twice");
  assert.deepEqual(s.words, ["JUKEBOX"]);
  assert.ok(stuckAt.length >= 1, "a new connection is requested");
  const first = stuckAt[0] - sentAt;
  assert.ok(first > PENDING_CALL_DEADLINE_MS && first <= PENDING_CALL_DEADLINE_MS + 250, `first request after ${first} ms`);
  assert.ok(stuckAt.length <= Math.ceil(30_000 / PENDING_CALL_DEADLINE_MS), "asked again at most once per deadline");
});

/** A bot whose word call QINTARS (on connection `s`) is never answered, then reported stuck. */
async function stuckQintars(clock: { t: number }, onStuck: (bot: SookraBot, s: FakeServer) => void) {
  const { s, bot } = setup("RETAINSQ", 30, "E", { clock });
  const asked: ConnLike[] = [];
  bot.onStuck = (conn) => {
    asked.push(conn);
    bot.online = false; // the supervisor pauses the bot, then replaces the connection
    onStuck(bot, s);
  };
  s.held = [];
  bot.refresh(s, MATCH);
  await settle();
  s.held = null;
  return { s, bot, asked };
}

test("after a stuck call the new connection's rack decides: letters still there mean the play did not happen", async () => {
  const clock = { t: 8_000_000 };
  const { s, bot, asked } = await stuckQintars(clock, () => {});
  clock.t += PENDING_CALL_DEADLINE_MS - 1;
  bot.tick(s);
  await settle();
  assert.deepEqual(asked, [], "not before the deadline");
  clock.t += 2;
  bot.tick(s);
  await settle();
  assert.deepEqual(asked, [s]);
  assert.deepEqual(s.attempted, ["QINTARS"]);
  // The old connection never answers. The new one's subscription is applied and the bot resumes on it.
  const fresh = s.connection();
  clock.t += 2000;
  bot.online = true;
  bot.tick(fresh);
  await settle();
  assert.deepEqual(s.attempted, ["QINTARS", "QINTARS"], "played again, once, on the new connection");
  assert.deepEqual(s.words, ["QINTARS"]);
  bot.tick(fresh);
  await settle();
  assert.equal(s.attempted.length, 2);
});

test("after a stuck call the new connection's rack decides: letters gone mean the play happened", async () => {
  const clock = { t: 9_000_000 };
  const { s, bot, asked } = await stuckQintars(clock, () => {});
  s.heldCalls[0].runSilently(); // the server ran it; the answer was lost
  assert.deepEqual(s.words, ["QINTARS"]);
  clock.t += PENDING_CALL_DEADLINE_MS + 1;
  bot.tick(s);
  await settle();
  assert.equal(asked.length, 1);
  const fresh = s.connection();
  clock.t += 2000;
  bot.online = true;
  bot.tick(fresh);
  await settle();
  bot.refresh(fresh, MATCH);
  await settle();
  assert.deepEqual(s.attempted, ["QINTARS"], "not sent again: the letters are no longer in the rack");
  assert.equal(s.participants[0].score, 48n);
});

test("a stuck call failed by the replacement (as the SDK does) is not replayed until the new connection is ready", async () => {
  const clock = { t: 10_000_000 };
  const { s, bot, asked } = await stuckQintars(clock, (_bot, server) => {
    for (const call of server.heldCalls) call.drop(new FakeUnknownResult()); // old.disconnect() fails in-flight calls
  });
  clock.t += PENDING_CALL_DEADLINE_MS + 1;
  bot.tick(s);
  await settle();
  assert.equal(asked.length, 1);
  bot.refresh(s, MATCH);
  await settle();
  assert.deepEqual(s.attempted, ["QINTARS"], "offline: nothing is played on the old cache");
  const fresh = s.connection();
  clock.t += TRANSPORT_BACKOFF_MS + 1000;
  bot.online = true;
  bot.tick(fresh);
  await settle();
  assert.deepEqual(s.attempted, ["QINTARS", "QINTARS"]);
  assert.deepEqual(s.words, ["QINTARS"]);
});

test("the word-call deadline adapts: twice the slowest recent call (a report counts what it waited), 5 s to 60 s", async () => {
  const clock = { t: 11_000_000 };
  const { s, bot } = setup("RETAINSQ", 30, "E", { clock });
  const reports: { at: number; deadline: number }[] = [];
  bot.onStuck = () => reports.push({ at: clock.t, deadline: bot.wordDeadlineMs() });
  /** QINTARS goes out now and is answered `ms` later (no tick runs meanwhile). */
  const answeredAfter = async (ms: number) => {
    s.setRack("RETAINSQ");
    s.held = [];
    bot.refresh(s, MATCH);
    await settle();
    assert.equal(s.held.length, 1, "one call out");
    clock.t += ms;
    s.held[0]();
    s.held = null;
    await settle();
  };
  assert.equal(bot.wordDeadlineMs(), PENDING_CALL_DEADLINE_MS, "a fresh bot starts at the base");
  await answeredAfter(6000);
  assert.equal(bot.wordDeadlineMs(), 12_000, "an answer after 6 s: twice that");
  for (let i = 1; i < WORD_LATENCY_WINDOW; i++) await answeredAfter(100);
  assert.equal(bot.wordDeadlineMs(), 12_000, "the slow call is still among the last WORD_LATENCY_WINDOW");
  await answeredAfter(100);
  assert.equal(bot.wordDeadlineMs(), PENDING_CALL_DEADLINE_MS, "prompt answers bring it back to the base");
  assert.equal(s.words.length, 1 + WORD_LATENCY_WINDOW);
  assert.equal(reports.length, 0, "answered calls are never reported");
  // A call never answered, on a connection nothing replaces here: it is reported again
  // every deadline, and each report doubles what it had waited, up to the cap.
  s.setRack("RETAINSQ");
  s.held = [];
  bot.refresh(s, MATCH);
  await settle();
  const sentAt = clock.t;
  for (let ms = 250; ms <= 300_000; ms += 250) {
    clock.t = sentAt + ms;
    bot.tick(s);
  }
  await settle();
  assert.deepEqual(
    reports.slice(0, 4).map((r) => r.deadline),
    [10_500, 32_000, PENDING_CALL_DEADLINE_MAX_MS, PENDING_CALL_DEADLINE_MAX_MS],
    "reported at 5,250, 16,000, 48,250 and 108,500 ms",
  );
  let last = sentAt;
  let allowed = PENDING_CALL_DEADLINE_MS;
  for (const r of reports) {
    const gap = r.at - last;
    assert.ok(gap > allowed && gap <= allowed + 250, `reported ${gap} ms after the last, deadline ${allowed} ms`);
    last = r.at;
    allowed = r.deadline;
  }
  assert.equal(reports.length, 7);
  assert.equal(s.attempted.length, 2 + WORD_LATENCY_WINDOW, "the unanswered call is never sent again: its reservation holds");
});

// ---- End to end: the bot, the supervisor and the lifecycle wired as index.ts wires them ----

/** index.ts's tick interval. */
const TICK_MS = 250;

/** Fake timers for the supervisor, the lifecycle and slow answers; the bot reads `t` as its clock. */
class FakeClock implements Scheduler {
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  constructor(public t = 0) {}
  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.set(++this.seq, { at: this.t + ms, fn });
    return this.seq;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  now(): number {
    return this.t;
  }
  /** Fire every timer due within `ms`, earliest first (ties in the order they were set). */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}

/**
 * One connection object to `s`, as build() returns it in index.ts. A word
 * call reaches the server at once; the server runs it `latencyMs` later
 * (never, for Infinity) and answers then, but only while this connection is
 * open: disconnect() fails every call still waiting with
 * UnknownCallResultError, as the SDK does, and the server runs it anyway.
 * Bids are answered at once.
 */
class SlowLink implements ConnLike {
  readonly db: ConnLike["db"];
  readonly reducers: ConnLike["reducers"];
  private readonly waiting = new Set<(err: unknown) => void>();
  constructor(s: FakeServer, clock: FakeClock, latencyMs: number) {
    this.db = s.db;
    this.reducers = {
      submitBid: async (a) => {
        s.bids.push(a);
      },
      submitWord: (a) =>
        new Promise((resolve, reject) => {
          s.wordAttempts++;
          s.attempted.push(a.word);
          this.waiting.add(reject);
          if (latencyMs === Infinity) return; // lost on the way: the server never runs it
          clock.setTimeout(() => {
            let refusal: unknown = null;
            try {
              s.runWord(a);
            } catch (err) {
              refusal = err;
            }
            if (!this.waiting.delete(reject)) return; // dropped first: the answer is lost
            if (refusal === null) resolve(undefined);
            else reject(refusal);
          }, latencyMs);
        }),
    };
  }
  disconnect() {
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const reject of waiting) reject(new FakeUnknownResult());
  }
}

/**
 * SookraBot, the Supervisor and the ConnectionLifecycle wired as index.ts
 * wires them (the supervisor and lifecycle hooks, bot.onStuck, onApplied,
 * bootstrapActivity, and the tick interval with its watchdog), over
 * SlowLinks to one server holding RETAINSQ. Only the SDK and the clock are
 * fakes: a connection's handshake and subscription complete as it is built,
 * and while it is live an auction opens every second. `latencyMs(n)` is the
 * answer time on the n-th connection built (0 first).
 */
async function wired(opts: { latencyMs: (n: number) => number; refuseWords?: string }) {
  const clock = new FakeClock();
  const { s, bot, warns } = setup("RETAINSQ", 30, "E", { clock });
  s.refuseWords = opts.refuseWords ?? null;
  bot.online = false; // until the first subscription is applied
  const links: SlowLink[] = [];
  let activeConn: ConnLike | null = null;
  const supervisor = new Supervisor(
    {
      setOnline: (online) => {
        bot.online = online;
      },
      resubscribe: () => {},
      reconnect: (why) => lifecycle.replace(why),
      log: () => {},
    },
    clock,
  );
  const lifecycle: ConnectionLifecycle<SlowLink> = new ConnectionLifecycle<SlowLink>(
    supervisor,
    {
      build: (id) => {
        const link = new SlowLink(s, clock, opts.latencyMs(links.length));
        links.push(link);
        clock.setTimeout(() => {
          if (!lifecycle.accept(link, id)) return; // onConnect
          if (id !== supervisor.conn) return; // onApplied
          supervisor.onApplied(id);
          activeConn = link; // bootstrapActivity
          bot.tick(link);
        }, 0);
        return link;
      },
      deactivate: () => {
        activeConn = null;
      },
      log: () => {},
      warn: () => {},
    },
    clock,
  );
  bot.onStuck = (c, why) => {
    if (c === activeConn) supervisor.reportStuck(supervisor.conn, why);
  };
  lifecycle.start();
  clock.advance(0);
  await settle(); // QINTARS goes out at t = 0
  let auctionId = 200n;
  /** Run to `until`, TICK_MS at a time; `each(t)` runs first at every step. */
  const run = async (until: number, each: (t: number) => void = () => {}) => {
    while (clock.t < until) {
      clock.advance(TICK_MS);
      await settle();
      each(clock.t);
      const c = activeConn;
      if (!c) continue;
      if (clock.t % 1000 === 0) {
        supervisor.noteAuctionEvent();
        bot.onAuctionOpen(c, s.nextAuction(auctionId++, "E", 29));
      }
      bot.tick(c);
      supervisor.watchdog(supervisor.conn, bot.runningMatches(c).length > 0, 1000);
      await settle();
    }
  };
  return { s, bot, warns, links, run };
}

test("Codex repro, wired: word calls answered after 6 s replace a working connection once, not on every play", async () => {
  const w = await wired({ latencyMs: () => 6000 });
  await w.run(30_000, (t) => {
    if (t === 8000 || t === 16_000) w.s.setRack("RETAINSQ"); // fresh playable racks, as in the repro
  });
  assert.deepEqual(w.s.words, ["QINTARS", "QINTARS", "QINTARS"], "every play ran on the server");
  assert.equal(w.s.participants[0].score, 144n);
  assert.equal(w.s.attempted.length, 3, "none was sent twice");
  assert.equal(w.links.length, 2, "one replacement, for the first slow answer; none for the plays after it");
  assert.equal(w.bot.wordDeadlineMs(), 12_000, "twice the 6 s the accepted plays took");
});

test("Codex repro, wired: a refusal answered after 6 s is counted, not lost to a replacement every time", async () => {
  const w = await wired({ latencyMs: () => 6000, refuseWords: "'QINTARS' is not in the dictionary" });
  await w.run(40_000);
  assert.equal(w.links.length, 2, "one replacement, for the first slow answer");
  assert.equal(w.s.attempted.length, 1 + MAX_WORD_FAILURES, "lost once with the replaced connection, then refused until the cap");
  assert.equal(w.warns.filter((m) => m.includes("play 'QINTARS' refused")).length, MAX_WORD_FAILURES);
  assert.deepEqual(w.s.words, []);
  assert.equal(w.bot.wordDeadlineMs(), 12_000, "twice the 6 s the refusals took");
});

test("wired controls: a prompt server never loses its connection; a call never answered still gets one replaced", async () => {
  const fast = await wired({ latencyMs: () => 50 });
  await fast.run(30_000, (t) => {
    if (t === 8000 || t === 16_000) fast.s.setRack("RETAINSQ");
  });
  assert.deepEqual(fast.s.words, ["QINTARS", "QINTARS", "QINTARS"]);
  assert.equal(fast.links.length, 1, "no replacement");
  // The first connection never answers a word call; the next answers at once.
  const lost = await wired({ latencyMs: (n) => (n === 0 ? Infinity : 50) });
  await lost.run(20_000);
  assert.equal(lost.links.length, 2, "replaced after the first deadline");
  assert.deepEqual(lost.s.attempted, ["QINTARS", "QINTARS"], "played again on the new connection, once");
  assert.deepEqual(lost.s.words, ["QINTARS"]);
});

test("a play in flight counts toward the balance: no needless liquidity word while its reward is pending", async () => {
  const { s, bot } = setup("RETAINSQ", 30, "E");
  s.balance(ME, 0);
  s.held = [];
  bot.refresh(s, MATCH);
  await settle();
  assert.deepEqual(s.attempted, ["QINTARS"]); // +48 on its way
  s.setRack("RETAINSQCAT"); // the leftover E plus CAT spell CATE, a liquidity word for a broke bot
  bot.refresh(s, MATCH);
  await settle();
  assert.deepEqual(s.attempted, ["QINTARS"], "48 pending already lifts the balance past the floor");
  for (const release of s.held) release();
  await settle();
  assert.deepEqual(s.words, ["QINTARS"]);
  assert.deepEqual(s.attempted, ["QINTARS"]);
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
  assert.ok(s.bids.length >= 1 && s.bids.length <= 2); // a paced re-send after the reward lands
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

test("duel: a cash-poor bot's paced bid is held at PACE_MIN_DUEL (the 3-game final)", async () => {
  // Two seats with 5-tile racks: 88 auctions. 40 coins with 71 to go is r = 0.496 (sqrt 0.704), held at 0.75.
  const { s, bot, logs } = setup("AEINST", 70, "R", { withSim: false });
  s.balance(ME, 40);
  bot.refresh(s, MATCH);
  await settle();
  const delta = valuate(INDEX, countsOf("AEINST"), LEAVE_ALPHA).delta[letterIndex("R")];
  assert.equal(delta, 6);
  assert.equal(s.bids.length, 1);
  assert.equal(s.bids[0].amount, BigInt(Math.floor(PACED_KAPPA * PACE_MIN_DUEL * delta))); // 18
  assert.ok(logs.some((l) => l.includes("'R' bag 70: bid 18 (value 6.00")));
  // With a sim seated (3 bots, 83 auctions) there is no duel floor: 4 x sqrt(40 / 71 / (100 / 83)) x 6 = 16.
  const three = setup("AEINST", 70, "R");
  three.s.balance(ME, 40);
  three.bot.refresh(three.s, MATCH);
  await settle();
  assert.equal(three.s.bids.at(-1)!.amount, 16n);
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

test("Codex repro: warning history and index verification stay bounded over a long night", () => {
  const { s, bot } = setup("CAT", 30, "S");
  const inner = bot as unknown as { lastWarn: Map<string, number>; indexVerified: Set<string> };
  for (let i = 0; i < 2000; i++) bot.warn(`bid on a${i}`, new Error("Auction closed"));
  assert.ok(inner.lastWarn.size <= 256, `lastWarn ${inner.lastWarn.size}`);
  s.db.matchParticipant.mpByMatch = { filter: (id: bigint) => s.participants.filter((p) => p.matchId === id) };
  for (let i = 0; i < 2000; i++) bot.seatRows(s, BigInt(1000 + i)); // foreign matches seen by auction callbacks
  assert.ok(inner.indexVerified.size <= 256, `indexVerified ${inner.indexVerified.size}`);
  bot.seatRows(s, MATCH);
  assert.ok(inner.indexVerified.has(String(MATCH)));
  bot.onMatchEnded(s, MATCH);
  assert.ok(!inner.indexVerified.has(String(MATCH)), "match end retires its entry");
});

test("tick drops the model of a match whose end event was missed", async () => {
  const { s, bot, logs } = setup("CAT", 30, "S");
  bot.refresh(s, MATCH);
  await settle();
  assert.ok(bot.models.has(String(MATCH)));
  s.matchStates.get(MATCH)!.status = { tag: "Ended" };
  bot.tick(s);
  assert.ok(!bot.models.has(String(MATCH)));
  assert.ok(logs.some((l) => l.includes("m1 ended")));
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
