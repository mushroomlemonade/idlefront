import path from "node:path";
import { describe, expect, it } from "vitest";
import { RemoteViewIdentity } from "../../src/client/RemoteViewIdentity";
import { GameView } from "../../src/client/view/GameView";
import { createGameRunner } from "../../src/core/GameRunner";
import type { GameStartInfo, Turn } from "../../src/core/Schemas";
import { Config } from "../../src/core/configuration/Config";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../../src/core/game/GameUpdates";
import { loadTerrainMap } from "../../src/core/game/TerrainMapLoader";
import { decodeViewPacket } from "../../src/core/network/ViewProtocol";
import type { WorkerClient } from "../../src/core/worker/WorkerClient";
import { NodeGameMapLoader } from "../../src/server/simulation/NodeGameMapLoader";
import { SimulationHost } from "../../src/server/simulation/SimulationHost";
import { simulationStartInfo } from "../../src/server/simulation/SimulationPolicy";

export const authorityTestStart: GameStartInfo = {
  gameID: "authTest",
  lobbyCreatedAt: 0,
  config: {
    gameMap: GameMapType.World,
    gameMapSize: GameMapSize.Normal,
    gameType: GameType.Private,
    gameMode: GameMode.FFA,
    difficulty: Difficulty.Medium,
    nations: "disabled",
    bots: 20,
    randomSpawn: true,
    donateGold: false,
    donateTroops: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
  },
  players: [
    { clientID: "human001", username: "First player", clanTag: null },
    { clientID: "human002", username: "Second player", clanTag: null },
  ],
};

describe("headless simulation and rendering parity", () => {
  it("preserves anonymous team rules and exact permitted name placement without sending real identities", async () => {
    const wire: GameStartInfo = {
      ...authorityTestStart,
      listed: true,
      config: {
        ...authorityTestStart.config,
        anonymizeNames: true,
        gameMode: GameMode.Team,
        playerTeams: 2,
      },
      players: Array.from({ length: 4 }, (_, index) => ({
        clientID: `human00${index}`,
        username: `Secret Name ${index}`,
        clanTag: "SECRET",
        friends: [`human00${(index + 1) % 4}`],
      })),
    };
    const permitted: GameStartInfo = {
      ...wire,
      players: wire.players.map((p, index) => ({
        ...p,
        username: index === 0 ? p.username : `Anonymous Player ${index}`,
        clanTag: null,
        friends: undefined,
      })),
    };
    const host = new SimulationHost(simulationStartInfo(wire));
    const identity = new RemoteViewIdentity(permitted);
    let expected: GameUpdateViewData;
    const reference = await createGameRunner(
      permitted,
      undefined,
      new NodeGameMapLoader(path.resolve("resources/maps")),
      (u) => {
        if ("errMsg" in u) throw new Error(u.errMsg);
        expected = u;
      },
    );
    try {
      await host.ready;
      for (let turnNumber = 0; turnNumber < 330; turnNumber++) {
        const turn: Turn = { turnNumber, intents: [] };
        reference.addTurn(turn);
        reference.executeNextTick();
        const result = await host.turn(turn);
        const packet = decodeViewPacket(result.bytes.buffer as ArrayBuffer);
        if (packet.kind !== "update") throw new Error("Expected update");
        expect(new TextDecoder().decode(result.bytes)).not.toContain(
          "Secret Name",
        );
        expect(new TextDecoder().decode(result.bytes)).not.toContain("SECRET");
        expect(packet.update.updates[GameUpdateType.Hash]).toEqual(
          expected!.updates[GameUpdateType.Hash],
        );
        expect(packet.update.packedTileUpdates).toEqual(
          expected!.packedTileUpdates,
        );
        identity.apply(packet.update);
        expect(packet.update.playerNameViewData).toEqual(
          expected!.playerNameViewData,
        );
      }
      const snapshot = await host.snapshot();
      for (const bytes of snapshot.packets) {
        expect(new TextDecoder().decode(bytes)).not.toContain("Secret Name");
        expect(new TextDecoder().decode(bytes)).not.toContain("SECRET");
      }
    } finally {
      host.stop();
    }
  }, 120_000);

  it("runs unchanged rules, restores a late view, and continues both views identically", async () => {
    const host = new SimulationHost(authorityTestStart);
    const loader = new NodeGameMapLoader(path.resolve("resources/maps"));
    let expected: GameUpdateViewData;
    const reference = await createGameRunner(
      authorityTestStart,
      undefined,
      loader,
      (update) => {
        if ("errMsg" in update) throw new Error(update.errMsg);
        expected = update;
      },
    );
    const makeView = async (clientID: string) =>
      new GameView(
        {} as WorkerClient,
        new Config(authorityTestStart.config, null, false),
        await loadTerrainMap(
          GameMapType.World,
          GameMapSize.Normal,
          loader,
          false,
        ),
        clientID,
        clientID,
        null,
        authorityTestStart.gameID,
        authorityTestStart.players,
      );
    const first = await makeView("human001");
    const late = await makeView("human002");
    const turns: Turn[] = [];
    try {
      await host.ready;
      for (let turnNumber = 0; turnNumber < 350; turnNumber++) {
        const turn: Turn = {
          turnNumber,
          intents:
            turnNumber === 315
              ? [
                  {
                    type: "attack",
                    clientID: "human001",
                    targetID: null,
                    troops: 1000,
                  },
                ]
              : [],
        };
        turns.push(turn);
        reference.addTurn(turn);
        reference.executeNextTick();
        const result = await host.turn(turn);
        const packet = decodeViewPacket(result.bytes.buffer as ArrayBuffer);
        if (packet.kind !== "update") throw new Error("Expected update");
        expect(packet.update.updates[GameUpdateType.Hash]).toEqual(
          expected!.updates[GameUpdateType.Hash],
        );
        expect(packet.update.packedTileUpdates).toEqual(
          expected!.packedTileUpdates,
        );
        first.update(packet.update);
      }
      const snap = await host.snapshot();
      expect(snap.tick).toBe(350);
      for (const bytes of snap.packets) {
        const packet = decodeViewPacket(bytes.buffer as ArrayBuffer);
        if (packet.kind !== "update") throw new Error("Expected snapshot");
        late.update(packet.update);
      }
      expect(late.tileStateBuffer()).toEqual(first.tileStateBuffer());
      expect(late.inSpawnPhase()).toBe(false);
      expect(late.myPlayer()?.clientID()).toBe("human002");
      expect(late.myPlayer()?.troops()).toBe(
        first.playerByClientID("human002")?.troops(),
      );
      const actions = decodeViewPacket(
        (
          await host.query({
            type: "player_actions",
            id: "query1",
            playerID: reference.game.playerByClientID("human001")!.id(),
            units: null,
          }, "human001")
        ).bytes.buffer as ArrayBuffer,
      );
      expect(actions.kind).toBe("result");
      for (let turnNumber = 350; turnNumber < 365; turnNumber++) {
        const turn = { turnNumber, intents: [] };
        reference.addTurn(turn);
        reference.executeNextTick();
        const result = await host.turn(turn);
        for (const view of [first, late]) {
          const packet = decodeViewPacket(result.bytes.buffer as ArrayBuffer);
          if (packet.kind === "update") {
            expect(packet.update.updates[GameUpdateType.Hash]).toEqual(
              expected!.updates[GameUpdateType.Hash],
            );
            expect(packet.update.packedTileUpdates).toEqual(
              expected!.packedTileUpdates,
            );
            view.update(packet.update);
          }
        }
      }
      expect(late.tileStateBuffer()).toEqual(first.tileStateBuffer());
      expect(late.playerByClientID("human001")?.troops()).toBe(
        first.myPlayer()?.troops(),
      );
      const recoveryProgress: Array<{
        completedTurns: number;
        totalTurns: number;
        elapsedMs: number;
      }> = [];
      const recovering = new SimulationHost(
        authorityTestStart,
        turns,
        undefined,
        (progress) => recoveryProgress.push(progress),
      );
      try {
        await recovering.ready;
        expect(recoveryProgress[0]).toMatchObject({
          completedTurns: 0,
          totalTurns: turns.length,
        });
        expect(recoveryProgress[recoveryProgress.length - 1]).toMatchObject({
          completedTurns: turns.length,
          totalTurns: turns.length,
        });
        expect(
          recoveryProgress.every(
            (progress, index) =>
              index === 0 ||
              progress.completedTurns >=
                recoveryProgress[index - 1].completedTurns,
          ),
        ).toBe(true);
        const restored = await recovering.snapshot();
        expect(restored.tick).toBe(350);
        expect(restored.packets.map((p) => [...p])).toEqual(
          snap.packets.map((p) => [...p]),
        );
      } finally {
        recovering.stop();
      }
    } finally {
      host.stop();
    }
  }, 120_000);
});
