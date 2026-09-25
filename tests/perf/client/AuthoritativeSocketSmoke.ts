/** Creates a disposable local dev world; never targets production. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { GameMapType } from "../../../src/core/game/Game";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { decodeViewPacket } from "../../../src/core/network/ViewProtocol";

const base = "http://127.0.0.1:9000/api/worlds";
const longSession = process.argv.includes("--long");
const expectLargeMap = process.argv.includes("--large");
async function api(
  route: string,
  token?: string,
  method = "GET",
  body?: unknown,
) {
  const res = await fetch(base + route, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
  return res.json();
}
const identities = await Promise.all(
  [0, 1, 2].map(async (i) => {
    const session = await api("/session", undefined, "POST", {
      displayName: `Socket tester ${i}`,
    });
    const bound = await api(
      "/session/game-identity",
      session.bearerToken,
      "POST",
      { playToken: randomUUID() },
    );
    return {
      bearer: session.bearerToken,
      play: bound.playToken,
      name: `Socket tester ${i}`,
    };
  }),
);
const created = await api("", identities[0].bearer, "POST", {
  name: "Server playtest socket smoke",
  targetDuration: longSession ? "1d" : "1h",
  access: "public",
  mode: "ffa",
  maxHumans: 8,
  startsAt: Date.now() + 62_000,
});
const world = created.snapshot.world.id;
for (const identity of identities.slice(1))
  await api(`/${world}/rsvp`, identity.bearer, "PUT", {});
console.log(
  JSON.stringify({ world, stage: "RSVPs ready, awaiting scheduled start" }),
);
let snapshot;
const timeout = Date.now() + 150_000;
do {
  snapshot = await api(`/${world}`, identities[0].bearer);
  if (Date.now() > timeout) throw new Error("Runtime allocation timed out");
  if (!snapshot.runtimeGameId) await new Promise((r) => setTimeout(r, 500));
} while (!snapshot.runtimeGameId);
const gameID = snapshot.runtimeGameId;
const histories = [new Map<number, string>(), new Map<number, string>()];
const counts = [0, 0, 0];
const sockets: WebSocket[] = [];
const started = performance.now();
let joins = 0,
  queryPassed = false,
  resumePassed = false,
  attackSent = false,
  attackObserved = false;
let firstLiveAt = 0;
const snapshotPlayers = new Map<number, string>();
await new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => {
    for (const ws of sockets) ws.close();
    clearInterval(timer);
    reject(
      new Error(
        `Socket smoke timed out: ${JSON.stringify({ counts, queryPassed, resumePassed, attackSent, attackObserved })}`,
      ),
    );
  }, 90_000);
  const timer = setInterval(() => {
    for (const ws of sockets)
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "ping" }));
  }, 3000);
  const finish = () => {
    clearTimeout(deadline);
    clearInterval(timer);
    for (const ws of sockets) ws.close();
    resolve();
  };
  identities.forEach((identity, index) => {
    let lastTick = 0,
      clientID = "",
      resuming = false;
    const connect = () => {
      const ws = new WebSocket("ws://127.0.0.1:9000/w0", {
        perMessageDeflate: true,
      });
      sockets.push(ws);
      ws.on("error", reject);
      ws.on("open", () =>
        ws.send(
          JSON.stringify(
            resuming
              ? { type: "rejoin", gameID, lastTurn: 0, token: identity.play }
              : {
                  type: "join",
                  gameID,
                  token: identity.play,
                  username: identity.name,
                  clanTag: null,
                  turnstileToken: null,
                },
          ),
        ),
      );
      ws.on("message", (data, binary) => {
        try {
          if (!binary) {
            const msg = JSON.parse(data.toString());
            if (msg.type === "error") throw new Error(JSON.stringify(msg));
            if (msg.type === "start") {
              assert.equal(msg.gameStartInfo.simulationMode, "server-v1");
              if (expectLargeMap)
                assert.equal(
                  msg.gameStartInfo.config.gameMap,
                  GameMapType.ExpandedGiantWorldLarge,
                );
              if (longSession)
                assert.equal(
                  msg.gameStartInfo.config.disableForcedTimeLimit,
                  true,
                );
              assert.equal(msg.turns.length, 0);
              clientID = msg.myClientID;
              ws.send(
                JSON.stringify({
                  type: "view_subscribe",
                  ...(resuming ? { afterTick: lastTick } : {}),
                }),
              );
            }
            return;
          }
          const bytes = Buffer.from(data as Buffer);
          const sequence = bytes.readUInt32BE();
          const packet = decodeViewPacket(
            bytes.buffer.slice(
              bytes.byteOffset + 4,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          );
          if (packet.kind === "error") throw new Error(packet.error);
          if (packet.kind === "result") {
            queryPassed = true;
            return;
          }
          if (packet.snapshot === "end") {
            joins++;
            const player = snapshotPlayers.get(index);
            if (index === 0 && player)
              ws.send(
                JSON.stringify({
                  type: "view_query",
                  query: {
                    id: "smoke",
                    type: "player_actions",
                    playerID: player,
                    units: null,
                  },
                }),
              );
          }
          if (packet.snapshot === "begin") {
            const player = packet.update.updates[GameUpdateType.Player].find(
              (p) => p.clientID === clientID,
            );
            if (player) snapshotPlayers.set(index, player.id);
          }
          if (!packet.snapshot) {
            assert.equal(packet.update.pendingTurns, 0);
            if (lastTick) assert.equal(packet.update.tick, lastTick + 1);
            lastTick = packet.update.tick;
            counts[index]++;
            if (index === 0 && !firstLiveAt) firstLiveAt = performance.now();
            if (index === 0 && lastTick >= 330 && !attackSent) {
              attackSent = true;
              ws.send(
                JSON.stringify({
                  type: "intent",
                  intent: { type: "attack", targetID: null, troops: 100000 },
                }),
              );
            }
            if (
              index === 0 &&
              attackSent &&
              packet.update.updates[GameUpdateType.Player].some(
                (p) =>
                  p.id === snapshotPlayers.get(0) &&
                  (p.outgoingAttacks?.length ?? 0) > 0,
              )
            )
              attackObserved = true;
            if (index < 2)
              histories[index].set(
                lastTick,
                createHash("sha256").update(bytes.subarray(4)).digest("hex"),
              );
            if (index === 1 && counts[index] === 25 && !resuming) {
              resuming = true;
              ws.close();
              connect();
            } else if (index === 1 && resuming) resumePassed = true;
            if (
              index === 0 &&
              counts[index] >= 360 &&
              counts[1] >= 350 &&
              resumePassed &&
              queryPassed &&
              attackObserved
            )
              finish();
          }
          // Third client intentionally stops acknowledging: others must continue.
          if (index !== 2)
            ws.send(JSON.stringify({ type: "view_ack", sequence }));
        } catch (error) {
          clearTimeout(deadline);
          clearInterval(timer);
          for (const socket of sockets) socket.close();
          reject(error);
        }
      });
    };
    connect();
  });
});
let compared = 0;
for (const [tick, frame] of histories[0])
  if (histories[1].has(tick)) {
    assert.equal(frame, histories[1].get(tick));
    compared++;
  }
assert.ok(compared >= 90);
console.log(
  JSON.stringify({
    gameID,
    longSession,
    expectLargeMap,
    joins,
    counts,
    identicalFrames: compared,
    queryPassed,
    resumePassed,
    attackObserved,
    liveTPS: ((counts[0] - 1) * 1000) / (performance.now() - firstLiveAt),
    elapsedMs: performance.now() - started,
    slowClientDidNotBlockOthers: true,
  }),
);
