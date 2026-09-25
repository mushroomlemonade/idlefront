import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createGameRunner } from "../src/core/GameRunner";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
} from "../src/core/game/Game";
import type { GameUpdateViewData } from "../src/core/game/GameUpdates";
import { encodeViewPacket } from "../src/core/network/ViewProtocol";
import { BotActivity } from "../src/server/simulation/BotActivity";
import { FogViewProjection } from "../src/server/simulation/FogViewProjection";
import { GameFog } from "../src/server/simulation/GameFog";
import { ViewSnapshot } from "../src/server/simulation/ViewSnapshot";

// Independent process per map; never joins or mutates live worlds.
const dir = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const ticks = Number(process.argv[4] ?? 900);
const withFog = process.env.IDLE_BENCH_FOG === "1";
const withHuman = withFog || process.env.IDLE_BENCH_HUMAN === "1";
const withBotActivity = withFog && process.env.IDLE_BENCH_BOT_ACTIVITY === "1";
if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 10000)
  throw new Error("Invalid tick budget");
if (fs.existsSync(output)) throw new Error("Choose a fresh report file");
const manifest = JSON.parse(
  fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
);
const read = async (file: string) =>
  new Uint8Array(await fs.promises.readFile(path.join(dir, file)));
let update: GameUpdateViewData;
let failure = "";
const loadStarted = performance.now();
const runner = await createGameRunner(
  {
    gameID: "UHDbench",
    lobbyCreatedAt: 0,
    players: withHuman
      ? [{ clientID: "bench001", username: "Benchmark", clanTag: null }]
      : [],
    config: {
      gameMap: GameMapType.GiantWorldMap,
      gameMapSize: GameMapSize.Normal,
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Medium,
      nations: "default",
      bots: 2000,
      donateGold: false,
      donateTroops: false,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: withHuman,
      disableForcedTimeLimit: true,
      tradeShipTrafficMultiplier: 5,
      trainTrafficMultiplier: 5,
      territoryAttackSpeedDivisor: Number(
        process.env.IDLE_BENCH_ATTACK_DIVISOR ?? 15,
      ),
      serverSimulation: true,
    },
  },
  undefined,
  {
    getMapData: () => ({
      manifest: async () => manifest,
      mapBin: () => read("map.bin"),
      map4xBin: () => read("map4x.bin"),
      map16xBin: () => read("map16x.bin"),
      mapPageBin: read,
      webpPath: "",
      layerPng: async () => {
        throw new Error("No rendering");
      },
    }),
  },
  (next) => {
    if ("errMsg" in next) failure = next.errMsg;
    else update = next;
  },
);
const loadMs = performance.now() - loadStarted;
const snapshot = new ViewSnapshot(runner);
const fog = withFog ? new GameFog(runner.game, "UHDbench") : undefined;
const activity =
  fog && withBotActivity ? new BotActivity(runner.game, fog) : undefined;
const projection = fog
  ? new FogViewProjection(runner.game, fog.forClient("bench001"))
  : undefined;
const visibilityMs: number[] = [],
  projectionMs: number[] = [];
let projectedBytes = 0,
  skippedExpansions = 0,
  consideredExpansions = 0;
const execution: number[] = [],
  snapshots: number[] = [];
let peakRss = process.memoryUsage().rss;
const parityHash =
  process.env.IDLE_BENCH_PARITY === "1" ? createHash("sha256") : null;
for (let i = 0; i < ticks; i++) {
  const started = performance.now();
  activity?.beginTurn();
  const human = withHuman
    ? runner.game.playerByClientID("bench001")
    : undefined;
  runner.addTurn({
    turnNumber: runner.game.ticks(),
    intents:
      process.env.IDLE_BENCH_HUMAN_ATTACKS === "1" &&
      human?.isAlive() &&
      !runner.game.inSpawnPhase() &&
      i % 40 === 0
        ? [
            {
              type: "attack",
              clientID: "bench001",
              targetID: null,
              troops: human.troops() * 0.5,
            },
          ]
        : [],
  });
  if (!runner.executeNextTick() || failure)
    throw new Error(failure || "Tick did not execute");
  const executed = performance.now();
  snapshot.record(update!);
  const fogStarted = performance.now();
  fog?.advance();
  const projectionStarted = performance.now();
  if (projection)
    projectedBytes += encodeViewPacket({
      kind: "update",
      update: projection.project(update!),
    }).byteLength;
  if (i >= 302) {
    visibilityMs.push(projectionStarted - fogStarted);
    projectionMs.push(performance.now() - projectionStarted);
    skippedExpansions += activity?.skipped ?? 0;
    consideredExpansions += activity?.considered ?? 0;
  }
  if (parityHash) {
    const u = update!;
    parityHash.update(
      JSON.stringify(
        {
          tick: u.tick,
          updates: u.updates,
          tiles: u.packedTileUpdates,
          plans: u.packedMotionPlans,
          players: u.packedPlayerUpdates,
          attacks: u.packedAttackUpdates,
          names: u.playerNameViewData,
        },
        (_, value) =>
          typeof value === "bigint"
            ? String(value)
            : value instanceof Set
              ? [...value]
              : value,
      ),
    );
  }
  if (i >= 302) {
    execution.push(executed - started);
    snapshots.push(performance.now() - executed);
  }
  if (i % 100 === 0) {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    console.log(
      JSON.stringify({
        tick: i,
        ms: executed - started,
        rssMB: Math.round(peakRss / 1048576),
        protectedOwners: activity?.protectedCount,
        skipped: activity?.skipped,
        considered: activity?.considered,
        expanded: fog?.forClient("bench001").expanded,
        global: fog?.forClient("bench001").global,
        visibleOwners: fog?.forClient("bench001").owners.size,
        units: runner.game.units().length,
      }),
    );
  }
}
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
    over100ms: values.filter((v) => v > 100).length,
  };
}
const snapshotStarted = performance.now();
const packets = projection
  ? snapshot.fogPackets(projection)
  : snapshot.packets();
const report = {
  map: manifest.id,
  dimensions: [manifest.map.width, manifest.map.height],
  seed: "UHDbench",
  bots: 2000,
  parityDigest: parityHash?.digest("hex"),
  ticks,
  withFog,
  withBotActivity,
  withHuman,
  humanAttacks: process.env.IDLE_BENCH_HUMAN_ATTACKS === "1",
  humanTiles: runner.game.playerByClientID("bench001")?.numTilesOwned(),
  attackDivisor: runner.game.config().gameConfig().territoryAttackSpeedDivisor,
  fogAdvanceMs: stats(visibilityMs),
  projectionMs: stats(projectionMs),
  projectedBytes,
  skippedExpansions,
  consideredExpansions,
  loadMs,
  tickExecutionMs: stats(execution),
  snapshotRecordMs: stats(snapshots),
  snapshotEncodeMs: performance.now() - snapshotStarted,
  snapshotBytes: packets.reduce((sum, packet) => sum + packet.byteLength, 0),
  peakRssMB: Math.max(peakRss, process.memoryUsage().rss) / 1048576,
  unitCounts: Object.fromEntries(
    Object.values(UnitType).map((type) => [type, runner.game.unitCount(type)]),
  ),
  caveat:
    "Headless early-game workload. No browser FPS measurement or mature-week fleet-load certification.",
};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
