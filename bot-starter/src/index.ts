// SookraBot, built on the ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Strategy: src/strategy.ts (bids, word policy), src/engine.ts (valuation),
// src/bot.ts (per-match loop), src/supervisor.ts (connection readiness),
// src/lifecycle.ts (building and replacing connection objects).
// src/subscriptions.ts (what the client cache holds).
// This file only connects and wires events. Every auction this bot sees in
// its own matches is appended as one JSON line to
// sookra-<BOT_NAME>.auctions.log (gitignored by *.log).
//
// SUBSCRIBE_ALL=1 goes back to subscribing to every table (the old,
// CPU-heavy cache) in case the targeted subscriptions misbehave.
//
// Observer mode, for measuring: `OBSERVE_BOT_ID=<id> BOT_NAME=<scratch name>
// npm start` connects with a fresh anonymous identity (no token is read or
// saved), subscribes as if it were bot <id>, and runs the bot loop with
// reducers that do nothing: it never joins a lobby, bids or plays.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { WordIndex } from "./engine.js";
import { SookraBot, type ConnLike } from "./bot.js";
import { Supervisor, realScheduler } from "./supervisor.js";
import { ConnectionLifecycle } from "./lifecycle.js";
import { GAME_WINDOW_MS, PlanChain, REFLOOR_IDLE_MS, TargetedSubscription, type Subscriber } from "./subscriptions.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
/**
 * With no TOURNAMENT_ID, the bot registers itself for any tournament that is
 * taking registrations (the module allows one active tournament at a time),
 * so entering one needs no restart or redeploy. AUTO_REGISTER=0 turns it off.
 */
const AUTO_REGISTER = process.env.AUTO_REGISTER !== "0";
const SUBSCRIBE_ALL = process.env.SUBSCRIBE_ALL === "1";
const OBSERVE_BOT_ID = process.env.OBSERVE_BOT_ID ? BigInt(process.env.OBSERVE_BOT_ID) : null;
if (OBSERVE_BOT_ID !== null && (BOT_TOKEN || BOT_NONCE || TOURNAMENT_ID)) {
  console.error(`[${BOT_NAME}] observer mode takes no BOT_TOKEN, BOT_NONCE or TOURNAMENT_ID`);
  process.exit(1);
}
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const AUCTION_LOG_PATH = path.join(process.cwd(), `sookra-${BOT_NAME}.auctions.log`);
/** Re-check running matches (and the watchdog) this often. */
const TICK_MS = 250;

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Build the anagram index from the shared wordlist once, at startup.
const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const indexStart = performance.now();
const WORDLIST: string[] = fs.existsSync(dictionaryPath)
  ? fs.readFileSync(dictionaryPath, "utf8").split("\n")
  : [];
const INDEX = WordIndex.fromWords(WORDLIST);
console.log(
  `[${BOT_NAME}] word index: ${INDEX.size} anagram keys from ${WORDLIST.length} lines in ${(
    performance.now() - indexStart
  ).toFixed(0)} ms`,
);
if (INDEX.size === 0) {
  console.error(`[${BOT_NAME}] WARNING: no wordlist at ${dictionaryPath}; the bot will bid 0 and play nothing`);
}

const bot = new SookraBot(INDEX, BOT_NAME, console);
bot.online = false; // until the first subscription is applied
bot.onRecord = (rec) => {
  fs.appendFile(AUCTION_LOG_PATH, JSON.stringify(rec) + "\n", (err) => {
    if (err) bot.warn("auction log", err);
  });
};

let myIdentity: Identity | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
/** Set once the current connection's subscription is applied; used by the tick. */
let activeConn: ConnLike | null = null;

const supervisor = new Supervisor({
  setOnline: (online) => {
    bot.online = online;
  },
  resubscribe: () => {
    if (lifecycle.current) subscribe(lifecycle.current, supervisor.conn);
  },
  reconnect: (why) => lifecycle.replace(why),
  log: (msg) => console.log(`[${BOT_NAME}] ${msg}`),
});
const lifecycle: ConnectionLifecycle<DbConnection> = new ConnectionLifecycle<DbConnection>(
  supervisor,
  {
    build: buildConnection,
    deactivate: () => {
      activeConn = null;
    },
    log: (msg) => console.error(`[${BOT_NAME}] ${msg}`),
    warn: (what, err) => bot.warn(what, err),
  },
  realScheduler,
);
// A word call that is never answered: replace the connection the bot acts on.
// Dropping it fails its in-flight calls, and the new connection's rack decides
// whether the play happened.
bot.onStuck = (c, why) => {
  if (c === activeConn) supervisor.reportStuck(supervisor.conn, why);
};

// Keep the process alive through anything unexpected; log one line.
process.on("uncaughtException", (err) => bot.warn("uncaught", err));
process.on("unhandledRejection", (err) => bot.warn("unhandled rejection", err));

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (OBSERVE_BOT_ID !== null) return OBSERVE_BOT_ID;
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

/** Match ids of every match the bot sat in, from the cached seats. */
function seatMatchIds(db: ConnLike["db"], botId: bigint): bigint[] {
  const out: bigint[] = [];
  for (const p of db.matchParticipant.iter()) if (p.botId === botId) out.push(p.matchId);
  return out;
}

/** The targeted subscriptions of each connection (absent with SUBSCRIBE_ALL). */
const chains = new WeakMap<DbConnection, PlanChain>();

function currentPlan(conn: DbConnection | null): TargetedSubscription | null {
  return conn ? (chains.get(conn)?.current ?? null) : null;
}

/** Move the current connection's window up to our newer matches and a later game-wide span. */
function refloor(why: string) {
  const conn = lifecycle.current;
  const plan = currentPlan(conn);
  if (!conn || !plan || bot.myBotId === null) return;
  try {
    if (plan.refloor(seatMatchIds(conn.db, bot.myBotId), Date.now())) {
      console.log(`[${BOT_NAME}] re-flooring the subscription window (${why})`);
    }
  } catch (err) {
    bot.warn("re-floor", err);
  }
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

/** Observer mode: the same cache, with reducers that do nothing. One object per connection. */
const observerConns = new WeakMap<DbConnection, ConnLike>();
function asConn(conn: DbConnection): ConnLike {
  if (OBSERVE_BOT_ID === null) return conn;
  let c = observerConns.get(conn);
  if (!c) {
    c = {
      db: conn.db,
      reducers: { submitBid: () => Promise.resolve(), submitWord: () => Promise.resolve() },
    };
    observerConns.set(conn, c);
  }
  return c;
}

function subscriptionError(id: number, err: unknown) {
  console.error(`[${BOT_NAME}] subscription error: ${err instanceof Error ? err.message : String(err)}`);
  supervisor.onSubscriptionError(id, err ?? new Error("subscription error"));
}

/** Subscribe (again) on a connection; readiness comes only from onReady. */
function subscribe(conn: DbConnection, id: number) {
  if (SUBSCRIBE_ALL) {
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        if (id !== supervisor.conn) return; // a connection we already replaced
        console.log(`[${BOT_NAME}] subscription applied (connection ${id}, all tables)`);
        onBaseApplied(conn, id, null);
      })
      .onError((ctx) => subscriptionError(id, (ctx as { event?: unknown }).event))
      .subscribeToAllTables();
    return;
  }
  if (!myIdentity) return; // subscribe runs only after the handshake
  // A resubscribe: earlier attempts report nothing more, and their rows stay
  // until this one is ready (so rows in both are never removed and re-inserted).
  let found = chains.get(conn);
  if (!found) {
    found = new PlanChain();
    chains.set(conn, found);
  }
  const chain = found;
  const subscriber: Subscriber = (queries, onApplied, onError) =>
    conn
      .subscriptionBuilder()
      .onApplied(() => onApplied())
      .onError((ctx) => onError((ctx as { event?: unknown }).event ?? new Error("subscription error")))
      .subscribe(queries);
  const plan: TargetedSubscription = new TargetedSubscription(
    subscriber,
    { identityHex: myIdentity.toHexString(), observeBotId: OBSERVE_BOT_ID ?? undefined },
    {
      onBaseApplied: () => onBaseApplied(conn, id, plan),
      onReady: () => {
        chain.ready();
        onReady(conn, id);
      },
      onError: (err) => subscriptionError(id, err),
      log: (msg) => console.log(`[${BOT_NAME}] ${msg}`),
    },
  );
  chain.replace(plan);
  plan.start();
}

/**
 * The bot-independent part of the cache is applied (first time, a
 * resubscribe, or a reconnect replay): resolve our bot id, possibly after
 * claiming a nonce, then open the window on it (a replay finds it open).
 */
function onBaseApplied(conn: DbConnection, id: number, plan: TargetedSubscription | null) {
  if (id !== supervisor.conn) return; // a connection we already replaced
  const next = () => {
    if (plan === null) onReady(conn, id);
    else plan.openWindow(bot.myBotId!, seatMatchIds(conn.db, bot.myBotId!), Date.now());
  };

  bot.myBotId = resolveMyBotId(conn);
  if (bot.myBotId === null) {
    if (BOT_NONCE) {
      console.log(`[${BOT_NAME}] claiming credential with nonce…`);
      conn.reducers
        .claimCredential({ code: BOT_NONCE })
        .catch(logFailure("claiming the credential"));
      // Wait briefly for the credential to land; check again.
      setTimeout(() => {
        if (id !== supervisor.conn) return;
        bot.myBotId = resolveMyBotId(conn);
        if (bot.myBotId === null) {
          console.error(
            `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
          );
          process.exit(1);
        }
        const row = conn.db.bot.id.find(bot.myBotId);
        console.log(
          `[${BOT_NAME}] claimed credential for bot '${row?.name ?? "?"}' (id ${bot.myBotId})`,
        );
        next();
      }, 1000);
      return;
    } else {
      console.error(
        `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
      );
      process.exit(1);
    }
  }
  next();
}

/** Everything the bot reads is cached (first time, a resubscribe, or a reconnect replay). */
function onReady(conn: DbConnection, id: number) {
  if (id !== supervisor.conn || bot.myBotId === null) return;
  const plan = currentPlan(conn);
  if (plan) {
    const f = plan.floors;
    console.log(
      `[${BOT_NAME}] subscription applied (connection ${id}): our matches from m${f?.mine}, ` +
        `cache ${conn.db.matchState.count()} matches, ${conn.db.matchParticipant.count()} seats, ` +
        `${conn.db.auction.count()} auctions, ${conn.db.auctionResult.count()} results`,
    );
  }
  const row = conn.db.bot.id.find(bot.myBotId);
  console.log(
    OBSERVE_BOT_ID !== null
      ? `[${BOT_NAME}] observing bot '${row?.name ?? "?"}' (id ${bot.myBotId}); reducers disabled`
      : `[${BOT_NAME}] acting as bot '${row?.name ?? "?"}' (id ${bot.myBotId})`,
  );
  supervisor.onApplied(id);
  bootstrapActivity(conn);
}

/** The handshake of the current connection (lifecycle.accept has checked it). */
function onConnect(conn: DbConnection, identity: Identity, token: string, id: number) {
  myIdentity = identity;
  if (OBSERVE_BOT_ID === null) saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()} (connection ${id})`);

  subscribe(conn, id);

  const c = asConn(conn);
  const live = () => id === supervisor.conn;
  // Latency-critical: bid synchronously from the precomputed table, defer the rest.
  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (!live()) return;
    supervisor.noteAuctionEvent();
    if (a.status.tag === "Open") bot.onAuctionOpen(c, a);
  });
  conn.db.myRack.onInsert((_ctx, h) => live() && bot.scheduleRefresh(c, h.matchId));
  conn.db.myRack.onUpdate((_ctx, _old, h) => live() && bot.scheduleRefresh(c, h.matchId));
  conn.db.myRack.onDelete((_ctx, h) => live() && bot.scheduleRefresh(c, h.matchId));
  // Any balance change at our table can move a bid cap (ours or a rival's).
  conn.db.matchParticipant.onUpdate((_ctx, _old, p) => {
    if (live() && bot.myBotId !== null && bot.models.has(String(p.matchId))) {
      bot.scheduleRefresh(c, p.matchId);
    }
  });
  conn.db.botCredential.onInsert(() => {
    if (live() && bot.myBotId === null) bot.myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (!live()) return;
    supervisor.noteAuctionEvent();
    bot.onAuctionResult(c, r);
  });
  // A tournament opening for registration while we run (bootstrapActivity covers one already open).
  conn.db.tournament.onInsert((_ctx, t) => live() && autoRegister(conn, t));
  conn.db.tournament.onUpdate((_ctx, _old, t) => live() && autoRegister(conn, t));

  // When a match this bot was in ends, report it and hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (!live() || bot.myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = bot.myParticipant(c, neu.id) !== undefined;
      if (wasIn) {
        bot.onMatchEnded(c, neu.id);
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
        refloor(`match ${neu.id} ended`);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  try {
    if (bot.myBotId === null || OBSERVE_BOT_ID !== null) return;
    if (bot.runningMatches(asConn(conn)).length > 0) return;
    const openLobby = Array.from(conn.db.lobby.iter()).find(
      (l) => l.status.tag === "Open",
    );
    const alreadyIn =
      openLobby !== undefined &&
      Array.from(conn.db.lobbyMember.iter()).some(
        (lm) => lm.lobbyId === openLobby.id && lm.botId === bot.myBotId,
      );
    if (alreadyIn) return;
    console.log(`[${BOT_NAME}] joining lobby`);
    conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
  } catch (err) {
    bot.warn("join lobby", err);
  }
}

/** Tournament ids each connection already asked to register for (the reducer is idempotent; this keeps the log quiet). */
const autoRegistered = new WeakMap<DbConnection, Set<string>>();

/** Register for `t` if it is taking registrations (AUTO_REGISTER, no TOURNAMENT_ID). */
function autoRegister(conn: DbConnection, t: { id: bigint; status: { tag: string } }) {
  try {
    if (TOURNAMENT_ID || !AUTO_REGISTER || OBSERVE_BOT_ID !== null || bot.myBotId === null) return;
    if (t.status.tag !== "Registration") return;
    let asked = autoRegistered.get(conn);
    if (!asked) autoRegistered.set(conn, (asked = new Set()));
    const key = String(t.id);
    if (asked.has(key)) return;
    asked.add(key);
    console.log(`[${BOT_NAME}] tournament ${key} is taking registrations; registering`);
    conn.reducers
      .registerForTournament({ tournamentId: t.id })
      .then(() => console.log(`[${BOT_NAME}] registered for tournament ${key}`))
      .catch(logFailure(`registering for tournament ${key}`));
  } catch (err) {
    bot.warn("auto-register", err);
  }
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  for (const t of conn.db.tournament.iter()) autoRegister(conn, t);
  joinLobby(conn);
  activeConn = asConn(conn);
  bot.tick(activeConn);
  if (tickTimer === null) {
    tickTimer = setInterval(() => {
      const c = activeConn;
      if (!c) return;
      bot.tick(c);
      try {
        const running = bot.runningMatches(c);
        const ms = running.length > 0 ? Number(c.db.matchState.id.find(running[0])?.auctionDurationMs ?? 1000) : 1000;
        supervisor.watchdog(supervisor.conn, running.length > 0, ms);
        // Between matches, keep the game-wide part of the window from growing.
        const floors = currentPlan(lifecycle.current)?.floors;
        if (running.length === 0 && floors && Date.now() - GAME_WINDOW_MS - floors.gameSinceMs >= REFLOOR_IDLE_MS) {
          refloor("idle");
        }
      } catch (err) {
        bot.warn("watchdog", err);
      }
    }, TICK_MS);
  }
}

/** The lifecycle's build hook: a connection whose events all report `id`. */
function buildConnection(id: number): DbConnection {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST} (connection ${id})`);
  return DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(OBSERVE_BOT_ID !== null ? undefined : (BOT_TOKEN ?? loadToken()))
    .withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 10_000 })
    .onConnect((conn, identity, token) => {
      if (lifecycle.accept(conn, id)) onConnect(conn, identity, token, id);
    })
    .onAutomaticReconnect(() => {
      console.log(`[${BOT_NAME}] reconnected (connection ${id}); waiting for subscription replay`);
      supervisor.onAutomaticReconnect(id);
    })
    .onConnectError(
      (_ctx: ErrorContext, err: Error, nextAttempt?: number, nextDelayMs?: number) => {
        console.error(
          `[${BOT_NAME}] connect error: ${err.message}` +
            (nextAttempt !== undefined ? ` (retry ${nextAttempt} in ${nextDelayMs} ms)` : ""),
        );
        if (id === supervisor.conn && nextAttempt === undefined) {
          lifecycle.restartLater("connection failed with no retry scheduled");
        }
      },
    )
    .onDisconnect((_ctx: ErrorContext, err?: Error, nextAttempt?: number) => {
      // The cache is stale until a replay is applied: make no decisions on it.
      // A scheduled retry gets a deadline covering its handshake and replay.
      supervisor.onDisconnect(id, nextAttempt !== undefined);
      console.log(
        `[${BOT_NAME}] disconnected${err ? `: ${err.message}` : ""} (connection ${id})` +
          (nextAttempt !== undefined ? ` (reconnect attempt ${nextAttempt})` : ""),
      );
      if (id === supervisor.conn && nextAttempt === undefined) {
        activeConn = null;
        lifecycle.restartLater("disconnected with no retry scheduled");
      }
    })
    .build();
}

lifecycle.start();
