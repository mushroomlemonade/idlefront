import { parentPort, workerData } from "node:worker_threads";
import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../../core/game/GameUpdates";
import { PlayerImpl } from "../../core/game/PlayerImpl";
import { createGameRunner } from "../../core/GameRunner";
import {
  encodeViewPacket,
  type ViewQuery,
} from "../../core/network/ViewProtocol";
import type { GameStartInfo, Turn } from "../../core/Schemas";
import type { WorkerMessage } from "../../core/worker/WorkerMessages";
import { BotActivity } from "./BotActivity";
import { fogPermittedIntents } from "./FogIntentPolicy";
import { encodeFogUpdate } from "./FogUpdatePackets";
import { FogViewProjection } from "./FogViewProjection";
import { GameFog } from "./GameFog";
import { NodeGameMapLoader } from "./NodeGameMapLoader";
import { ParallelWaterRoutes } from "./ParallelWaterRoutes";
import {
  authorizeViewQuery,
  projectViewQueryResult,
} from "./ViewQueryAuthority";
import { ViewSnapshot } from "./ViewSnapshot";

const port = parentPort!;
console.debug = () => {};
let latest: GameUpdateViewData;
let failure: string | undefined;
const runner = await createGameRunner(
  workerData.start as GameStartInfo,
  undefined,
  new NodeGameMapLoader(workerData.mapsDir),
  (update) => {
    if ("errMsg" in update) failure = update.errMsg;
    else latest = update;
  },
);
const snapshot = new ViewSnapshot(runner);
const navigation = new ParallelWaterRoutes(
  runner.game,
  process.env.IDLE_ROUTE_WORKERS === undefined
    ? undefined
    : Math.max(1, Math.min(8, Number(process.env.IDLE_ROUTE_WORKERS) || 1)),
);
// Pay worker startup before the live simulation begins, not on its first fleet.
await navigation.warm();
const fog = (workerData.start as GameStartInfo).config.fogOfWar
  ? new GameFog(runner.game, workerData.start.gameID)
  : undefined;
const viewers = new Map<string, FogViewProjection>();
const botActivity =
  fog && (workerData.start as GameStartInfo).config.fogBotActivity === "v0.2"
    ? new BotActivity(runner.game, fog)
    : undefined;
function tick(turn: Turn) {
  if (turn.turnNumber !== runner.game.ticks())
    throw new Error("Simulation turn gap");
  botActivity?.beginTurn();
  runner.addTurn(fog ? fogPermittedIntents(runner.game, fog, turn) : turn);
  if (!runner.executeNextTick() || failure)
    throw new Error(failure ?? "Simulation tick failed");
  snapshot.record(latest);
  fog?.advance();
}
const recoveryTurns = workerData.turns as Turn[];
const recoveryStartedAt = performance.now();
let lastRecoveryReportAt = recoveryStartedAt;

function reportRecoveryProgress(completedTurns: number, force = false) {
  const now = performance.now();
  if (!force && now - lastRecoveryReportAt < 250) return;
  lastRecoveryReportAt = now;
  port.postMessage({
    recoveryProgress: {
      completedTurns,
      totalTurns: recoveryTurns.length,
      elapsedMs: now - recoveryStartedAt,
    },
  });
}

if (recoveryTurns.length > 0) reportRecoveryProgress(0, true);
for (let index = 0; index < recoveryTurns.length; index++) {
  await navigation.prepare();
  tick(recoveryTurns[index]);
  reportRecoveryProgress(index + 1, index + 1 === recoveryTurns.length);
}

function query(q: ViewQuery): WorkerMessage {
  const game = runner.game;
  if (q.x !== undefined && q.y !== undefined && !game.isValidCoord(q.x, q.y))
    throw new Error("Invalid map position");
  if (q.targetTile !== undefined && !game.isValidRef(q.targetTile))
    throw new Error("Invalid target tile");
  switch (q.type) {
    case "player_actions":
      return {
        type: "player_actions_result",
        id: q.id,
        result: runner.playerActions(String(q.playerID), q.x, q.y, q.units),
      };
    case "player_buildables":
      return {
        type: "player_buildables_result",
        id: q.id,
        result: runner.playerBuildables(
          String(q.playerID),
          q.x,
          q.y,
          q.units ?? undefined,
        ),
      };
    case "player_profile":
      return {
        type: "player_profile_result",
        id: q.id,
        result: runner.playerProfile(Number(q.playerID)),
      };
    case "player_border_tiles":
      return {
        type: "player_border_tiles_result",
        id: q.id,
        result: runner.playerBorderTiles(String(q.playerID)),
      };
    case "transport_ship_spawn":
      return {
        type: "transport_ship_spawn_result",
        id: q.id,
        result:
          q.targetTile === undefined
            ? false
            : runner.bestTransportShipSpawn(String(q.playerID), q.targetTile),
      };
    case "attack_clustered_positions":
      return {
        type: "attack_clustered_positions_result",
        id: q.id,
        attacks: runner.attackClusteredPositions(
          Number(q.playerID),
          q.attackID,
        ),
      };
  }
}
// Serialize ALL commands across the async preparation barrier. A later query
// or turn must never interleave with an earlier authoritative operation.
let commands = Promise.resolve();
port.on("message", (command) => {
  commands = commands.then(() => handleCommand(command));
});
async function handleCommand(command: any) {
  try {
    if (command.type === "turn") {
      const started = performance.now();
      await navigation.prepare();
      const navigationPreparationMs = performance.now() - started;
      tick(command.turn);
      // Preserve the engine's compact motion plans. The authoritative worker
      // still simulates every ship and train; render clients only derive their
      // visual position from the server-issued path and tick. Sending a full
      // JSON UnitUpdate for every moving unit on every turn made high-traffic
      // worlds produce multi-megabyte frames and eventually pulled server TPS
      // below real time. Non-plan-driven movement (for example warships) and
      // all lifecycle/state changes continue through the ordinary Unit stream.
      latest.pendingTurns = 0;
      latest.serverTickExecutionDuration = performance.now() - started;
      const encodingStarted = performance.now();
      const bytes = fog
        ? new Uint8Array(0)
        : encodeViewPacket({ kind: "update", update: latest });
      const views = fog
        ? [...viewers].map(([clientID, projection]) =>
            projection.needsGlobalSnapshot()
              ? {
                  clientID,
                  bytes: new Uint8Array(0),
                  packets: snapshot.fogPackets(projection),
                }
              : {
                  clientID,
                  bytes: new Uint8Array(0),
                  packets: encodeFogUpdate(projection.project(latest)),
                },
          )
        : undefined;
      const encodingDuration = performance.now() - encodingStarted;
      const stats =
        latest.tick % 100 === 0
          ? {
              turn: latest.tick,
              players: runner.game
                .allPlayers()
                .filter((p) => p.clientID() !== null)
                .map((p) => {
                  const full = (p as PlayerImpl).toFullUpdate();
                  return {
                    clientID: p.clientID()!,
                    tilesOwned: p.numTilesOwned(),
                    troops: p.troops(),
                    gold: String(p.gold()),
                    isAlive: p.isAlive(),
                    team: p.team(),
                    killedBy: full.killedBy ?? null,
                    deathPosition: full.deathPosition ?? null,
                  };
                }),
            }
          : undefined;
      port.postMessage(
        {
          id: command.id,
          bytes,
          views,
          tick: latest.tick,
          duration: performance.now() - started,
          coreDuration: latest.tickExecutionDuration ?? 0,
          encodingDuration,
          navigationPreparationMs,
          navigationMetrics:
            latest.tick % 100 === 0 ? navigation.metrics : undefined,
          tileDeltaCount: latest.packedTileUpdates.length / 2,
          motionPlanBytes: latest.packedMotionPlans?.byteLength ?? 0,
          unitUpdateCount: latest.updates[GameUpdateType.Unit].length,
          stats,
          win: latest.updates[GameUpdateType.Win][0],
        },
        [
          bytes.buffer,
          ...(views?.flatMap((view) => [
            view.bytes.buffer,
            ...(view.packets?.map((packet) => packet.buffer) ?? []),
          ]) ?? []),
        ],
      );
    } else if (command.type === "snapshot") {
      let packets: Uint8Array<ArrayBuffer>[];
      if (fog) {
        const projection = new FogViewProjection(
          runner.game,
          fog.forClient(command.viewerClientID),
        );
        packets = snapshot.fogPackets(projection);
        viewers.set(command.viewerClientID, projection);
      } else packets = snapshot.packets();
      port.postMessage(
        { id: command.id, tick: runner.game.ticks(), packets },
        packets.map((p) => p.buffer),
      );
    } else if (command.type === "query") {
      if (typeof command.viewerClientID !== "string")
        throw new Error("Missing authenticated view identity");
      authorizeViewQuery(
        runner.game,
        command.viewerClientID,
        command.query,
        fog?.forClient(command.viewerClientID),
      );
      const bytes = encodeViewPacket({
        kind: "result",
        message: fog
          ? projectViewQueryResult(
              runner.game,
              fog.forClient(command.viewerClientID),
              query(command.query),
            )
          : query(command.query),
      });
      port.postMessage({ id: command.id, bytes }, [bytes.buffer]);
    } else if (command.type === "forget_viewer") {
      viewers.delete(command.viewerClientID);
      port.postMessage({ id: command.id });
    }
  } catch (error) {
    port.postMessage({
      id: command.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
port.postMessage({ ready: true });
