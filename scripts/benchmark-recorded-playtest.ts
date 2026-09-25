// Run baseline and optimized in SEPARATE processes, never concurrently with a
// live playtest. Uses frozen real inputs; does not touch databases or servers.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGameRunner } from "../src/core/GameRunner";
import {
  GameStartInfoSchema,
  TurnSchema,
  type Turn,
} from "../src/core/Schemas";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import type { Game, Player } from "../src/core/game/Game";
import { GameImpl } from "../src/core/game/GameImpl";
import type { GameMap } from "../src/core/game/GameMap";
import type { GameUpdateViewData } from "../src/core/game/GameUpdates";
import { PlayerImpl } from "../src/core/game/PlayerImpl";
import { tileTraversalScratch } from "../src/core/game/TileTraversalScratch";
import { railSearchMetrics } from "../src/core/pathfinding/PathFinder";
import { ExactRouteCache } from "../src/core/pathfinding/transformers/ExactRouteCache";
import { FailedRouteCache } from "../src/core/pathfinding/transformers/FailedRouteCache";
import { WaterRefinementTransformer } from "../src/core/pathfinding/transformers/WaterRefinementTransformer";
import { BotActivity } from "../src/server/simulation/BotActivity";
import { fogPermittedIntents } from "../src/server/simulation/FogIntentPolicy";
import { GameFog } from "../src/server/simulation/GameFog";
import { NodeGameMapLoader } from "../src/server/simulation/NodeGameMapLoader";
import { ParallelWaterRoutes } from "../src/server/simulation/ParallelWaterRoutes";
import { ViewSnapshot } from "../src/server/simulation/ViewSnapshot";
import { referenceBorderClusters } from "../tests/util/referenceBorderClusters";
import { referenceNearby } from "../tests/util/referenceNearby";
import { ReferenceWaterRefinementTransformer } from "../tests/util/referenceWaterRefinement";
import { installWildernessAttackShadow } from "./lib/ShadowAttackVerifier";

const [inputFile, outputFile, mode = "optimized", lastTurnArg] =
  process.argv.slice(2);
if (!inputFile || inputFile === "--help") {
  console.log(
    "Usage: INPUT_REPLAY_JSON OUTPUT_REPORT_JSON baseline|optimized [MAX_TURNS]",
  );
  console.log(
    "Separate sequential runs only. No client/network pacing is simulated; reports measure compute headroom and deterministic update hashes.",
  );
  process.exit(0);
}
if (!outputFile || !["baseline", "optimized"].includes(mode))
  throw new Error("Invalid benchmark arguments");
if (fs.existsSync(outputFile))
  throw new Error("Refusing to overwrite a report");
const frozen = JSON.parse(fs.readFileSync(inputFile, "utf8"));
const guardDB = fs.existsSync(".data/persistent-worlds.sqlite")
  ? new DatabaseSync(".data/persistent-worlds.sqlite", { readOnly: true })
  : undefined;
const activeGame = guardDB?.prepare(
  "SELECT id FROM persistent_worlds WHERE phase='active' LIMIT 1",
);
if (activeGame?.get())
  throw new Error("A user match is active; refusing competing replay");
const start = GameStartInfoSchema.parse(frozen.start);
let turns: Turn[] = frozen.turns.map((t: unknown, i: number) => {
  const turn = TurnSchema.parse(t);
  if (turn.turnNumber !== i) throw new Error(`Journal gap at ${i}`);
  return turn;
});
if (lastTurnArg !== undefined) {
  const limit = Number(lastTurnArg);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > turns.length)
    throw new Error("Invalid turn limit");
  turns = turns.slice(0, limit);
}
if (mode === "baseline") {
  Object.assign(GameImpl.prototype, {
    updateBorders(this: Game, tile: number) {
      const check = (t: number) => {
        if (!this.hasOwner(t)) return;
        const player = this.owner(t) as PlayerImpl;
        if (this.map().isBorder(t)) player._borderTiles.add(t);
        else player._borderTiles.delete(t);
      };
      check(tile);
      this.forEachNeighbor(tile, check);
    },
  });
  Object.assign(PlayerImpl.prototype, {
    nearby(this: PlayerImpl & { mg: Game }) {
      return referenceNearby(this.mg, this);
    },
  });
  Object.assign(ExactRouteCache.prototype, {
    findPath(
      this: {
        inner: {
          findPath: (from: number | number[], to: number) => number[] | null;
        };
      },
      from: number | number[],
      to: number,
    ) {
      return this.inner.findPath(from, to);
    },
  });
  // Frozen pre-optimization implementations, used ONLY inside this process.
  Object.assign(PlayerExecution.prototype, {
    calculateClusters(this: { mg: Game; map: GameMap; player: Player }) {
      return referenceBorderClusters(
        this.map,
        this.player.borderTiles(),
        tileTraversalScratch(this.mg),
      );
    },
  });
  WaterRefinementTransformer.prototype.findPath =
    ReferenceWaterRefinementTransformer.prototype.findPath;
  Object.assign(FailedRouteCache.prototype, {
    findPath(
      this: {
        inner: {
          findPath: (from: number | number[], to: number) => number[] | null;
        };
      },
      from: number | number[],
      to: number,
    ) {
      return this.inner.findPath(from, to);
    },
  });
}
console.debug = () => {};
const routeStats = {
  queries: 0,
  failures: 0,
  negativeCacheHits: 0,
  exactCacheHits: 0,
  totalMs: 0,
  maxMs: 0,
};
const exactFind = ExactRouteCache.prototype.findPath;
ExactRouteCache.prototype.findPath = function (from, to) {
  const hits = this.metrics.hits;
  const result = exactFind.call(this, from, to);
  routeStats.exactCacheHits += this.metrics.hits - hits;
  return result;
};
const benchmarkFindPath = FailedRouteCache.prototype.findPath;
FailedRouteCache.prototype.findPath = function (from, to) {
  const before = performance.now(),
    hits = this.metrics.hits;
  const result = benchmarkFindPath.call(this, from, to);
  const elapsed = performance.now() - before;
  routeStats.queries++;
  if (result === null) routeStats.failures++;
  routeStats.negativeCacheHits += this.metrics.hits - hits;
  routeStats.totalMs += elapsed;
  routeStats.maxMs = Math.max(routeStats.maxMs, elapsed);
  return result;
};
let latest: GameUpdateViewData | undefined, failure: string | undefined;
const boot = performance.now();
const runner = await createGameRunner(
  start,
  undefined,
  new NodeGameMapLoader(
    path.resolve(process.env.IDLE_BENCH_MAPS_DIR ?? "resources/maps"),
    mode === "baseline" ? "paged" : undefined,
  ),
  (update) => {
    if ("errMsg" in update) failure = update.errMsg;
    else latest = update;
  },
);
const snapshot = new ViewSnapshot(runner);
const navigation =
  mode === "optimized" ? new ParallelWaterRoutes(runner.game) : undefined;
await navigation?.warm();
const fog = start.config.fogOfWar
  ? new GameFog(runner.game, start.gameID)
  : undefined;
const activity =
  fog && start.config.fogBotActivity === "v0.2"
    ? new BotActivity(runner.game, fog)
    : undefined;
const loadMs = performance.now() - boot;
const times: number[] = [],
  coreTimes: number[] = [],
  fogTimes: number[] = [];
const cpuAccounting = process.env.IDLE_BENCH_CPU_ACCOUNTING === "1";
const threadCpuTimes: number[] = [];
const attackAccounting = process.env.IDLE_BENCH_ATTACK_ACCOUNTING === "1";
const attackWork = {
  wildernessMs: 0,
  playerMs: 0,
  wildernessCalls: 0,
  playerCalls: 0,
};
const attackWorkSamples: Array<typeof attackWork> = [];
if (attackAccounting) {
  const originalTick = AttackExecution.prototype.tick;
  AttackExecution.prototype.tick = function (tick: number) {
    const playerTarget = (
      this as unknown as { target: { isPlayer(): boolean } }
    ).target.isPlayer();
    const start = performance.now();
    try {
      return originalTick.call(this, tick);
    } finally {
      if (playerTarget) {
        attackWork.playerMs += performance.now() - start;
        attackWork.playerCalls++;
      } else {
        attackWork.wildernessMs += performance.now() - start;
        attackWork.wildernessCalls++;
      }
    }
  };
}
const checkpoints: Array<{ turn: number; sha256: string }> = [];
const shadow =
  process.env.IDLE_BENCH_ATTACK_SHADOW === "1"
    ? installWildernessAttackShadow(
        runner.game,
        Number(process.env.IDLE_BENCH_SHADOW_STRIDE ?? 32),
        process.env.IDLE_BENCH_SHADOW_KERNEL === "1",
        process.env.IDLE_BENCH_SHADOW_AHEAD === "1",
        Number(process.env.IDLE_BENCH_SHADOW_REVISIONS ?? 0),
        (process.env.IDLE_BENCH_SHADOW_REVISION_COMPARISONS ?? "").split(",").filter(Boolean).map(Number),
        process.env.IDLE_BENCH_APPLY_PLANS === "1",
      )
    : undefined;
const digest = createHash("sha256");
let lastReport = performance.now(),
  peakRss = process.memoryUsage().rss;
const measuredAt = performance.now();
const profileFrom = Number(process.env.IDLE_BENCH_PROFILE_FROM ?? -1);
const phaseClocks: Array<{
  turn: number;
  start: number;
  navigationEnd: number;
  coreEnd: number;
  end: number;
}> = [];
const profileClock = {
  hrtimeUs: Number(process.hrtime.bigint() / 1000n),
  performanceMs: performance.now(),
};
const profiler = profileFrom >= 0 ? new Session() : undefined;
profiler?.connect();
for (const turn of turns) {
  if (turn.turnNumber % 100 === 0 && activeGame?.get()) {
    await navigation?.close();
    guardDB?.close();
    profiler?.disconnect();
    throw new Error("A user match started; stopped competing replay");
  }
  if (turn.turnNumber === profileFrom) {
    await profiler!.post("Profiler.enable");
    await profiler!.post("Profiler.setSamplingInterval", { interval: 1000 });
    await profiler!.post("Profiler.start");
  }
  const cpuStart = cpuAccounting ? process.threadCpuUsage() : undefined;
  if (attackAccounting) {
    attackWork.wildernessMs = attackWork.playerMs = 0;
    attackWork.wildernessCalls = attackWork.playerCalls = 0;
  }
  const at = performance.now();
  await navigation?.prepare();
  const navigationEnd = performance.now();
  activity?.beginTurn();
  runner.addTurn(fog ? fogPermittedIntents(runner.game, fog, turn) : turn);
  if (!runner.executeNextTick() || failure || !latest)
    throw new Error(failure ?? "Missing simulation tick");
  const coreDone = performance.now();
  snapshot.record(latest);
  fog?.advance();
  const complete = performance.now();
  if (attackAccounting) attackWorkSamples.push({ ...attackWork });
  if (cpuStart) {
    const used = process.threadCpuUsage(cpuStart);
    threadCpuTimes.push((used.user + used.system) / 1000);
  }
  if (profileFrom >= 0 && turn.turnNumber >= profileFrom)
    phaseClocks.push({
      turn: turn.turnNumber + 1,
      start: at,
      navigationEnd,
      coreEnd: coreDone,
      end: complete,
    });
  times.push(complete - at);
  coreTimes.push(coreDone - at);
  fogTimes.push(complete - coreDone);
  // Excludes wall-clock durations. Includes ordered ownership/terrain changes,
  // motion plans, structures/player updates and attack state, every single tick.
  digest.update(
    JSON.stringify({ tick: latest.tick, updates: latest.updates }, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
  for (const field of [
    "packedTileUpdates",
    "packedTerrainUpdates",
    "packedMotionPlans",
    "packedPlayerUpdates",
    "packedAttackUpdates",
    "packedNukeImpacts",
  ] as const) {
    const value = latest[field];
    digest.update(field + ":" + (value?.byteLength ?? 0) + ":");
    if (value)
      digest.update(
        Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      );
  }
  if (latest.tick % 100 === 0)
    checkpoints.push({
      turn: latest.tick,
      sha256: digest.copy().digest("hex"),
    });
  if (complete - lastReport > 5000) {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    console.log(
      JSON.stringify({
        mode,
        completed: turn.turnNumber + 1,
        total: turns.length,
        lastTickMs: complete - at,
        rssMB: Math.round(peakRss / 1048576),
      }),
    );
    lastReport = complete;
  }
}
if (profiler) {
  const { profile } = await profiler.post("Profiler.stop");
  fs.writeFileSync(outputFile + ".cpuprofile", JSON.stringify(profile), {
    flag: "wx",
  });
  profiler.disconnect();
}
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  const meanMs = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    samples: values.length,
    meanMs,
    p50Ms: q(0.5),
    p95Ms: q(0.95),
    p99Ms: q(0.99),
    maxMs: sorted[sorted.length - 1],
    computeTPS: 1000 / meanMs,
    over100ms: values.filter((t) => t > 100).length,
  };
};
const report = {
  shadow: shadow?.metrics,
  storage: runner.game.isPaged() ? "paged" : "linear",
  ownershipStorage: [
    ...new Set(
      runner.game
        .allPlayers()
        .map((player) => (player as PlayerImpl)._tiles.constructor.name),
    ),
  ],
  threadCpu: cpuAccounting
    ? {
        note: "OS thread CPU accounting, potentially coarse on Windows. Wall minus CPU includes waiting/other-thread GC/scheduling; it does not uniquely measure hypervisor steal. Navigation workers are not included in thread CPU.",
        all: stats(threadCpuTimes),
        last1000: stats(threadCpuTimes.slice(-1000)),
        times: threadCpuTimes,
      }
    : undefined,
  attacks: attackAccounting
    ? {
        note: "Diagnostic tick wrappers include both planning and authoritative mutations. These times are not all parallelizable, and wrapper overhead makes this a diagnostic rather than an acceptance benchmark.",
        samples: attackWorkSamples,
        last1000: {
          wilderness: stats(
            attackWorkSamples.slice(-1000).map((s) => s.wildernessMs),
          ),
          player: stats(attackWorkSamples.slice(-1000).map((s) => s.playerMs)),
          wildernessCalls: attackWorkSamples
            .slice(-1000)
            .reduce((sum, s) => sum + s.wildernessCalls, 0),
          playerCalls: attackWorkSamples
            .slice(-1000)
            .reduce((sum, s) => sum + s.playerCalls, 0),
        },
      }
    : undefined,
  navigation: navigation?.metrics,
  rail: railSearchMetrics(runner.game),
  mode,
  gameID: start.gameID,
  inputSha256: createHash("sha256")
    .update(fs.readFileSync(inputFile))
    .digest("hex"),
  turns: turns.length,
  loadMs,
  totalElapsedMs: performance.now() - measuredAt,
  peakRss,
  routeStats,
  all: stats(times),
  last1000: stats(times.slice(-1000)),
  core: stats(coreTimes),
  snapshotAndFog: stats(fogTimes),
  sha256: digest.digest("hex"),
  checkpoints,
  times,
  coreTimes,
  fogTimes,
  profileClock,
  phaseClocks,
};
await navigation?.close();
shadow?.dispose();
if (shadow && !shadow.metrics.verified && !shadow.metrics.applied)
  throw new Error("No shadow plans were verified");
guardDB?.close();
fs.writeFileSync(outputFile, JSON.stringify(report), { flag: "wx" });
console.log(
  JSON.stringify({
    file: outputFile,
    mode,
    turns: turns.length,
    all: report.all,
    last1000: report.last1000,
    sha256: report.sha256,
  }),
);
