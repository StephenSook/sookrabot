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
// src/bot.ts (per-match loop). This file only connects and wires events.
// Every auction this bot sees in its own matches is appended as one JSON
// line to sookra-<BOT_NAME>.auctions.log (gitignored by *.log).

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

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const AUCTION_LOG_PATH = path.join(process.cwd(), `sookra-${BOT_NAME}.auctions.log`);
/** Re-check running matches this often, in case an event was missed. */
const TICK_MS = 250;
/** Retry delay when the very first connection fails (the SDK only retries established ones). */
const INITIAL_RETRY_MS = 5000;
/** After an automatic reconnect, resume decisions this long later even without a replay confirmation. */
const RESUME_FALLBACK_MS = 5000;

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
bot.onRecord = (rec) => {
  fs.appendFile(AUCTION_LOG_PATH, JSON.stringify(rec) + "\n", (err) => {
    if (err) bot.warn("auction log", err);
  });
};

let myIdentity: Identity | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

// Keep the process alive through anything unexpected; log one line.
process.on("uncaughtException", (err) => bot.warn("uncaught", err));
process.on("unhandledRejection", (err) => bot.warn("unhandled rejection", err));

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
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

function asConn(conn: DbConnection): ConnLike {
  return conn;
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      // Fires on the first subscription and again after every reconnect replay.
      console.log(`[${BOT_NAME}] subscription applied`);
      bot.online = true;

      // Resolve our bot id, possibly after claiming a nonce.
      bot.myBotId = resolveMyBotId(conn);
      if (bot.myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
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
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const row = conn.db.bot.id.find(bot.myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${row?.name ?? "?"}' (id ${bot.myBotId})`,
      );
      bootstrapActivity(conn);
    })
    .subscribeToAllTables();

  const c = asConn(conn);
  // Latency-critical: bid synchronously from the precomputed table, defer the rest.
  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") bot.onAuctionOpen(c, a);
  });
  conn.db.myRack.onInsert((_ctx, h) => bot.scheduleRefresh(c, h.matchId));
  conn.db.myRack.onUpdate((_ctx, _old, h) => bot.scheduleRefresh(c, h.matchId));
  conn.db.myRack.onDelete((_ctx, h) => bot.scheduleRefresh(c, h.matchId));
  // Any balance change at our table can move a bid cap (ours or a rival's).
  conn.db.matchParticipant.onUpdate((_ctx, _old, p) => {
    if (bot.myBotId !== null && bot.models.has(String(p.matchId))) {
      bot.scheduleRefresh(c, p.matchId);
    }
  });
  conn.db.botCredential.onInsert(() => {
    if (bot.myBotId === null) bot.myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => bot.onAuctionResult(c, r));

  // When a match this bot was in ends, report it and hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (bot.myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = bot.myParticipant(c, neu.id) !== undefined;
      if (wasIn) {
        bot.onMatchEnded(c, neu.id);
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  try {
    if (bot.myBotId === null) return;
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

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  activeConn = asConn(conn);
  bot.tick(activeConn);
  if (tickTimer === null) {
    tickTimer = setInterval(() => {
      if (activeConn) bot.tick(activeConn);
    }, TICK_MS);
  }
}

let activeConn: ConnLike | null = null;
let restartPending = false;

/** Start a fresh connection when the SDK will not retry on its own. */
function restartLater(why: string) {
  if (restartPending) return;
  restartPending = true;
  console.error(`[${BOT_NAME}] ${why}; new connection in ${INITIAL_RETRY_MS} ms`);
  setTimeout(() => {
    restartPending = false;
    main();
  }, INITIAL_RETRY_MS);
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 10_000 })
    .onConnect(onConnect)
    .onAutomaticReconnect(() => {
      console.log(`[${BOT_NAME}] reconnected; waiting for subscription replay`);
      // Replay re-fires onApplied, which resumes decisions. If it never does, resume anyway.
      setTimeout(() => {
        if (!bot.online) {
          console.warn(`[${BOT_NAME}] no replay confirmation after reconnect; resuming`);
          bot.online = true;
        }
      }, RESUME_FALLBACK_MS);
    })
    .onConnectError(
      (_ctx: ErrorContext, err: Error, nextAttempt?: number, nextDelayMs?: number) => {
        console.error(
          `[${BOT_NAME}] connect error: ${err.message}` +
            (nextAttempt !== undefined ? ` (retry ${nextAttempt} in ${nextDelayMs} ms)` : ""),
        );
        if (nextAttempt === undefined) restartLater("connection failed with no retry scheduled");
      },
    )
    .onDisconnect((_ctx: ErrorContext, err?: Error, nextAttempt?: number) => {
      // The cache is stale until replay: make no decisions on it.
      bot.online = false;
      console.log(
        `[${BOT_NAME}] disconnected${err ? `: ${err.message}` : ""}` +
          (nextAttempt !== undefined ? ` (reconnect attempt ${nextAttempt})` : ""),
      );
      if (nextAttempt === undefined) {
        activeConn = null;
        restartLater("disconnected with no retry scheduled");
      }
    })
    .build();
}

main();
