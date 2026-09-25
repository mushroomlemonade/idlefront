import path from "node:path";
import { expect, it } from "vitest";
import { GameView } from "../../src/client/view/GameView";
import { Config } from "../../src/core/configuration/Config";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import { loadTerrainMap } from "../../src/core/game/TerrainMapLoader";
import { decodeViewPacket } from "../../src/core/network/ViewProtocol";
import type { GameStartInfo, Turn } from "../../src/core/Schemas";
import type { WorkerClient } from "../../src/core/worker/WorkerClient";
import { NodeGameMapLoader } from "../../src/server/simulation/NodeGameMapLoader";
import { SimulationHost } from "../../src/server/simulation/SimulationHost";

it("isolates participant streams and reconstructs the same fog on a new device and worker", async () => {
  const start: GameStartInfo = {
    gameID: "fogTest1",
    lobbyCreatedAt: 0,
    config: {
      fogOfWar: "v0.2",
      serverSimulation: true,
      gameMap: GameMapType.World,
      gameMapSize: GameMapSize.Normal,
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Medium,
      nations: "disabled",
      bots: 0,
      randomSpawn: false,
      donateGold: false,
      donateTroops: false,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
    },
    players: [
      { clientID: "human001", username: "First", clanTag: null },
      { clientID: "human002", username: "Second", clanTag: null },
    ],
  };
  const loader = new NodeGameMapLoader(path.resolve("resources/maps"));
  const terrain = await loadTerrainMap(
    GameMapType.World,
    GameMapSize.Normal,
    loader,
    false,
  );
  const land: number[] = [];
  terrain.gameMap.forEachTile((tile) => {
    if (
      land.length < 2 &&
      terrain.gameMap.isLand(tile) &&
      !terrain.gameMap.isImpassable(tile) &&
      (!land.length ||
        Math.abs(terrain.gameMap.x(tile) - terrain.gameMap.x(land[0])) > 600)
    )
      land.push(tile);
  });
  expect(land).toHaveLength(2);
  const host = new SimulationHost(start);
  let recovered: SimulationHost | undefined;
  const turns: Turn[] = [
    {
      turnNumber: 0,
      intents: land.map((tile, index) => ({
        type: "spawn" as const,
        tile,
        clientID: index === 0 ? "human001" : "human002",
      })),
    },
  ];
  const makeView = async () =>
    new GameView(
      {} as WorkerClient,
      new Config(start.config, null, false),
      await loadTerrainMap(
        GameMapType.World,
        GameMapSize.Normal,
        loader,
        false,
      ),
      "human001",
      "First",
      null,
      start.gameID,
      start.players,
    );
  const apply = async (source: SimulationHost) => {
    const view = await makeView();
    const snapshot = await source.snapshot("human001");
    for (const bytes of snapshot.packets) {
      const packet = decodeViewPacket(bytes.buffer as ArrayBuffer);
      if (packet.kind !== "update") throw new Error("Unexpected packet");
      packet.update.snapshotPhase = packet.snapshot;
      view.update(packet.update);
    }
    return view;
  };
  try {
    await host.ready;
    await host.turn(turns[0]);
    turns.push({ turnNumber: 1, intents: [] });
    await host.turn(turns[1]);
    await expect(host.snapshot("not-a-seat")).rejects.toThrow();
    const first = await apply(host);
    expect(first.isTileVisible(land[0])).toBe(true);
    expect(first.isTileVisible(land[1])).toBe(false);
    expect(first.ownerID(land[1])).toBe(0);
    expect(
      first.players().some((player) => player.clientID() === "human002"),
    ).toBe(false);
    const secondDevice = await apply(host);
    expect(
      Buffer.from(secondDevice.tileStateBuffer().buffer).equals(
        Buffer.from(first.tileStateBuffer().buffer),
      ),
    ).toBe(true);
    await host.snapshot("human002");
    const next: Turn = { turnNumber: 2, intents: [] };
    turns.push(next);
    const live = await host.turn(next);
    expect(live.bytes).toHaveLength(0);
    expect(live.views?.map((view) => view.clientID).sort()).toEqual([
      "human001",
      "human002",
    ]);
    recovered = new SimulationHost(start, turns);
    await recovered.ready;
    const afterRecovery = await apply(recovered);
    expect(
      Buffer.from(afterRecovery.tileStateBuffer().buffer).equals(
        Buffer.from(first.tileStateBuffer().buffer),
      ),
    ).toBe(true);
    expect(afterRecovery.isTileVisible(land[1])).toBe(false);
  } finally {
    host.stop();
    recovered?.stop();
  }
}, 120000);
