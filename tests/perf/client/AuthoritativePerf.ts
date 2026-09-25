/** Real server worker + two real render views, without DOM/GPU. Run with tsx. */
import assert from "node:assert/strict";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { GameView } from "../../../src/client/view/GameView";
import { Config } from "../../../src/core/configuration/Config";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../../src/core/game/Game";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { loadTerrainMap } from "../../../src/core/game/TerrainMapLoader";
import { decodeViewPacket } from "../../../src/core/network/ViewProtocol";
import type { GameStartInfo } from "../../../src/core/Schemas";
import type { WorkerClient } from "../../../src/core/worker/WorkerClient";
import { NodeGameMapLoader } from "../../../src/server/simulation/NodeGameMapLoader";
import { SimulationHost } from "../../../src/server/simulation/SimulationHost";
import "./Shims";

const ticks = Number(process.argv[2] ?? 1800);
const mapsDir = path.resolve(process.argv[3] ?? "resources/maps");
const bots = Number(process.argv[4] ?? 2000);
if (
  !Number.isSafeInteger(ticks) ||
  ticks < 2 ||
  !Number.isSafeInteger(bots) ||
  bots < 0 ||
  bots > 3900
)
  throw new Error(
    "Usage: AuthoritativePerf.ts <ticks >= 2> [maps directory] [bots 0..3900]",
  );
const start: GameStartInfo = {
  gameID: "authPerf",
  lobbyCreatedAt: 0,
  config: {
    gameMap: GameMapType.ExpandedGiantWorld,
    gameMapSize: GameMapSize.Normal,
    gameType: GameType.Private,
    gameMode: GameMode.FFA,
    difficulty: Difficulty.Medium,
    nations: "default",
    bots,
    randomSpawn: true,
    donateGold: false,
    donateTroops: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    disableForcedTimeLimit: true,
  },
  players: [
    { clientID: "human001", username: "First player", clanTag: null },
    { clientID: "human002", username: "Second player", clanTag: null },
  ],
};
const loader = new NodeGameMapLoader(mapsDir);
const makeView = async (clientID: string) =>
  new GameView(
    {} as WorkerClient,
    new Config(start.config, null, false),
    await loadTerrainMap(
      start.config.gameMap,
      GameMapSize.Normal,
      loader,
      false,
    ),
    clientID,
    clientID,
    null,
    start.gameID,
    start.players,
  );
const host = new SimulationHost(start, [], mapsDir);
let peakRss = 0;
let maxDebtMs = 0;
let debtMs = 0;
const server: number[] = [],
  clients: number[] = [],
  wire: number[] = [];
const compressedSamples: number[] = [];
const describe = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted[sorted.length - 1],
  };
};
console.debug = () => {};
try {
  await host.ready;
  const first = await makeView("human001");
  let late: GameView | undefined;
  let snapshotResult: unknown;
  const wall = performance.now();
  for (let turnNumber = 0; turnNumber < ticks; turnNumber++) {
    const result = await host.turn({
      turnNumber,
      intents:
        turnNumber > 300 && turnNumber % 80 === 0
          ? [
              {
                type: "attack",
                clientID: "human001",
                targetID: null,
                troops: 1500,
              },
            ]
          : [],
    });
    server.push(result.duration);
    debtMs = Math.max(0, debtMs + result.duration - 100);
    maxDebtMs = Math.max(maxDebtMs, debtMs);
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    wire.push(result.bytes.byteLength);
    if (turnNumber % 100 === 0)
      compressedSamples.push(deflateRawSync(result.bytes).byteLength);
    for (const view of [first, late]) {
      if (!view) continue;
      const t = performance.now();
      const packet = decodeViewPacket(result.bytes.buffer as ArrayBuffer);
      assert.equal(packet.kind, "update");
      if (packet.kind === "update") view.update(packet.update);
      clients.push(performance.now() - t);
    }
    if (turnNumber === Math.floor(ticks / 2)) {
      late = await makeView("human002");
      const t = performance.now();
      const snapshot = await host.snapshot();
      for (const bytes of snapshot.packets) {
        const packet = decodeViewPacket(bytes.buffer as ArrayBuffer);
        if (packet.kind === "update") late.update(packet.update);
      }
      snapshotResult = {
        tick: snapshot.tick,
        totalMs: performance.now() - t,
        packets: snapshot.packets.length,
        bytes: snapshot.packets.reduce((n, p) => n + p.byteLength, 0),
        estimatedCompressedBytes: snapshot.packets.reduce(
          (n, p) => n + deflateRawSync(p).byteLength,
          0,
        ),
      };
      assert.deepEqual(late.tileStateBuffer(), first.tileStateBuffer());
    }
    if (turnNumber % 300 === 299)
      console.log(
        JSON.stringify({
          tick: turnNumber + 1,
          server: describe(server),
          client: describe(clients),
        }),
      );
  }
  assert.deepEqual(late!.tileStateBuffer(), first.tileStateBuffer());
  const unitPositions = (view: GameView) =>
    view
      .units()
      .map((u) => [u.id(), u.tile()])
      .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(unitPositions(late!), unitPositions(first));
  const finalSnapshot = await host.snapshot();
  const finalState = decodeViewPacket(
    finalSnapshot.packets[0].buffer as ArrayBuffer,
  );
  if (finalState.kind === "update") {
    assert.deepEqual(
      unitPositions(first),
      finalState.update.updates[GameUpdateType.Unit]
        .filter((u) => u.isActive)
        .map((u) => [u.id, u.pos])
        .sort((a, b) => a[0] - b[0]),
    );
  }
  assert.equal(
    late!.myPlayer()?.troops(),
    first.playerByClientID("human002")?.troops(),
  );
  console.log(
    JSON.stringify(
      {
        ticks,
        map: start.config.gameMap,
        mapsDir,
        width: first.width(),
        height: first.height(),
        tiles: first.width() * first.height(),
        bots,
        nations: "default",
        elapsedMs: performance.now() - wall,
        serverTickMs: describe(server),
        clientDecodeAndViewMs: describe(clients),
        uncompressedFrameBytes: describe(wire),
        sampledCompressedFrameBytes: describe(compressedSamples),
        lateJoin: snapshotResult,
        bothViewsEqual: true,
        peakProcessRssBytes: peakRss,
        estimatedSerialCapacityTPS: 1000 / describe(server).mean,
        overBudgetTicks: server.filter((ms) => ms > 100).length,
        finalSimulationDebtMs: debtMs,
        maxSimulationDebtMs: maxDebtMs,
        note: "Headless CPU benchmark, excludes DOM, GPU, network latency and socket compression.",
      },
      null,
      2,
    ),
  );
} finally {
  host.stop();
}
