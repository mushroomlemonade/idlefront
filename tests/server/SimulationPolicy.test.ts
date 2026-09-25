import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameStartInfo } from "../../src/core/Schemas";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import { Client } from "../../src/server/Client";
import { GameServer } from "../../src/server/GameServer";
import {
  simulationStartInfo,
  usesServerSimulation,
} from "../../src/server/simulation/SimulationPolicy";

const { hosts } = vi.hoisted(() => ({
  hosts: [] as { start: GameStartInfo; stop: ReturnType<typeof vi.fn> }[],
}));
vi.mock("../../src/server/simulation/SimulationHost", () => ({
  SimulationHost: class {
    ready = Promise.resolve();
    stop = vi.fn();
    constructor(readonly start: GameStartInfo) {
      hosts.push(this);
    }
  },
}));
vi.mock("../../src/server/Archive", () => ({
  archive: vi.fn(),
  finalizeGameRecord: (record: unknown) => record,
}));

const start: GameStartInfo = {
  gameID: "policy01",
  lobbyCreatedAt: 0,
  listed: true,
  config: {
    gameMap: GameMapType.World,
    gameMapSize: GameMapSize.Normal,
    gameType: GameType.Private,
    gameMode: GameMode.FFA,
    difficulty: Difficulty.Medium,
    nations: "disabled",
    bots: 0,
    randomSpawn: true,
    donateGold: false,
    donateTroops: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
  },
  players: [
    {
      clientID: "human001",
      username: "Hidden Alice",
      clanTag: "TEAM",
      friends: ["human002"],
      cosmetics: { flag: "fr" },
    },
    { clientID: "human002", username: "Hidden Bob", clanTag: "TEAM" },
  ],
};
const games: GameServer[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("IDLE_SERVER_SIMULATION", undefined);
  hosts.length = 0;
});
afterEach(async () => {
  for (const game of games.splice(0)) await game.end();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("server simulation rollout", () => {
  it("never rolls fog matches back to the unrestricted client simulation", () => {
    vi.stubEnv("IDLE_SERVER_SIMULATION", "0");
    expect(usesServerSimulation({ ...start, config: { ...start.config, fogOfWar: "v0.2", serverSimulation: false } })).toBe(true);
  });
  it("defaults populated games on, honors explicit rollback, and skips empty rolling lobbies", () => {
    expect(usesServerSimulation(start)).toBe(true);
    expect(
      usesServerSimulation({
        ...start,
        config: { ...start.config, anonymizeNames: true },
      }),
    ).toBe(true);
    expect(usesServerSimulation({ ...start, players: [] })).toBe(false);
    expect(
      usesServerSimulation({
        ...start,
        config: { ...start.config, serverSimulation: false },
      }),
    ).toBe(false);
    vi.stubEnv("IDLE_SERVER_SIMULATION", "0");
    expect(usesServerSimulation(start)).toBe(false);
  });

  it("strips anonymous simulation identities without changing frozen seats, listed, or archive input", () => {
    const wire = {
      ...start,
      config: { ...start.config, anonymizeNames: true },
      players: start.players.map((p, i) => ({ ...p, teamIndex: i })),
    };
    const prepared = simulationStartInfo(wire);
    expect(prepared.listed).toBe(true);
    expect(prepared.players.map((p) => p.teamIndex)).toEqual([0, 1]);
    expect(prepared.players.map((p) => p.clientID)).toEqual(
      start.players.map((p) => p.clientID),
    );
    for (const p of prepared.players) {
      expect(p.clanTag).toBeNull();
      expect(p.friends).toBeUndefined();
      expect(p.cosmetics).toBeUndefined();
    }
    expect(JSON.stringify(prepared)).not.toContain("Hidden");
    expect(wire.players[0]).toMatchObject({
      username: "Hidden Alice",
      clanTag: "TEAM",
      friends: ["human002"],
    });
  });

  it.each([GameType.Private, GameType.Public])(
    "starts a shared worker for %s, without a managed-world opt-in",
    async (gameType) => {
      const log = {
        child: vi.fn().mockReturnThis(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const game = new GameServer(start.gameID, log as any, 0, {
        ...start.config,
        gameType,
        anonymizeNames: true,
      });
      games.push(game);
      const sockets = start.players.map((player) => {
        const ws = {
          on: vi.fn(),
          removeAllListeners: vi.fn(),
          send: vi.fn(),
          close: vi.fn(),
          readyState: 1,
        };
        const client = new Client(
          player.clientID,
          `persist-${player.clientID}`,
          null,
          null,
          undefined,
          "127.0.0.1",
          player.username,
          player.clanTag,
          ws as any,
          player.cosmetics,
          undefined,
          [],
        );
        expect(game.joinClient(client)).toBe("joined");
        return ws;
      });
      game.start();
      await Promise.resolve();
      expect(hosts).toHaveLength(1);
      expect(JSON.stringify(hosts[0].start)).not.toContain("Hidden");
      expect(hosts[0].start.players.every((p) => p.clanTag === null)).toBe(
        true,
      );
      for (const [index, ws] of sockets.entries()) {
        const message = ws.send.mock.calls
          .map(([value]) => JSON.parse(value))
          .find((msg) => msg.type === "start");
        expect(message.turns).toEqual([]);
        expect(message.gameStartInfo.simulationMode).toBe("server-v1");
        expect(message.gameStartInfo.players[index].username).toBe(
          start.players[index].username,
        );
        expect(message.gameStartInfo.players[1 - index].username).not.toBe(
          start.players[1 - index].username,
        );
      }
      expect((game as any).gameStartInfo.players[0].username).toBe(
        "Hidden Alice",
      );
    },
  );

  it("feeds the same disabled-clan roster to the worker as to ordinary clients, with listed retained", async () => {
    const log = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const game = new GameServer(start.gameID, log as any, 0, {
      ...start.config,
      disableClanTags: true,
      gameMode: GameMode.Team,
    });
    games.push(game);
    (game as any).listed = true;
    for (const player of start.players) {
      const ws = {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        readyState: 1,
      };
      game.joinClient(
        new Client(
          player.clientID,
          `persist-${player.clientID}`,
          null,
          null,
          undefined,
          "127.0.0.1",
          player.username,
          player.clanTag,
          ws as any,
          undefined,
          undefined,
          [],
        ),
      );
    }
    game.start();
    await Promise.resolve();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].start.listed).toBe(true);
    expect(hosts[0].start.players.map((p) => p.clanTag)).toEqual([null, null]);
    expect((game as any).gameStartInfo.players[0].clanTag).toBe("TEAM");
  });
});
