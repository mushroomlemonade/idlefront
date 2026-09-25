import EventEmitter from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import type { GameConfig } from "../../src/core/Schemas";
import { Client } from "../../src/server/Client";
import {
  GamePhase,
  GameServer,
  hashPersistentID,
} from "../../src/server/GameServer";
import {
  MasterMessageSchema,
  type MasterCreateManagedGame,
} from "../../src/server/IPCBridgeSchema";
import { MasterLobbyService } from "../../src/server/MasterLobbyService";
import { ServerEnv } from "../../src/server/ServerEnv";
import { WorkerLobbyService } from "../../src/server/WorkerLobbyService";

vi.mock("../../src/server/PollingLoop", () => ({
  startPolling: vi.fn(),
}));

const log: any = {
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const NOW = 2_000_000_000_000;
const FIRST_PERSISTENT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_PERSISTENT_ID = "22222222-2222-4222-8222-222222222222";

const gameConfig: GameConfig = {
  serverSimulation: false, // Explicitly exercise legacy journal delivery here.
  donateGold: false,
  donateTroops: false,
  gameMap: GameMapType.World,
  gameType: GameType.Private,
  gameMapSize: GameMapSize.Normal,
  difficulty: Difficulty.Easy,
  nations: "default",
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
  gameMode: GameMode.FFA,
  bots: 20,
  disabledUnits: [],
  maxPlayers: 2,
};

const managedCommand: MasterCreateManagedGame = {
  type: "createManagedGame",
  requestId: "request_managed_1",
  gameID: "gameABCD",
  gameConfig,
  startsAt: NOW + 60_000,
  expiresAt: NOW + 86_400_000,
  reservedSeats: [
    {
      clientID: "seatAAA1",
      persistentIdHash: hashPersistentID(FIRST_PERSISTENT_ID),
      username: "Atlas One",
      clanTag: null,
    },
    {
      clientID: "seatBBB2",
      persistentIdHash: hashPersistentID(SECOND_PERSISTENT_ID),
      username: "Atlas Two",
      clanTag: null,
    },
  ],
};

function mockWebSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    removeAllListeners: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  };
}

function managedGame(): GameServer {
  return new GameServer(
    managedCommand.gameID,
    log,
    NOW,
    gameConfig,
    undefined,
    managedCommand.startsAt,
    undefined,
    undefined,
    undefined,
    "test-build",
    {
      requestId: managedCommand.requestId,
      expiresAt: managedCommand.expiresAt,
      reservedSeats: managedCommand.reservedSeats,
    },
  );
}

describe("managed-game IPC schema", () => {
  it("accepts a frozen roster and rejects duplicate seat identities", () => {
    expect(MasterMessageSchema.safeParse(managedCommand).success).toBe(true);
    expect(
      MasterMessageSchema.safeParse({
        ...managedCommand,
        reservedSeats: [
          managedCommand.reservedSeats[0],
          {
            ...managedCommand.reservedSeats[1],
            persistentIdHash: managedCommand.reservedSeats[0].persistentIdHash,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("managed GameServer lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps its frozen offline roster and lets a late claimant take the assigned client ID", () => {
    const game = managedGame();
    expect(game.managedClientIDForPersistentId(FIRST_PERSISTENT_ID)).toBe(
      "seatAAA1",
    );
    expect(game.managedClientIDForPersistentId("not-reserved")).toBeNull();

    game.start();
    const ws = mockWebSocket();
    const client = new Client(
      "seatAAA1",
      FIRST_PERSISTENT_ID,
      null,
      null,
      undefined,
      "127.0.0.1",
      "Different Name",
      null,
      ws as any,
      undefined,
      undefined,
      [],
    );
    expect(game.joinClient(client)).toBe("joined");
    expect(client.username).toBe("Atlas One");

    const start = ws.send.mock.calls
      .map(([value]) => JSON.parse(String(value)))
      .find((message) => message.type === "start");
    expect(start).toMatchObject({
      myClientID: "seatAAA1",
      gameStartInfo: {
        players: [
          { clientID: "seatAAA1", username: "Atlas One" },
          { clientID: "seatBBB2", username: "Atlas Two" },
        ],
      },
    });

    const intruder = new Client(
      "randomC1",
      "not-reserved",
      null,
      null,
      undefined,
      "127.0.0.1",
      "Intruder",
      null,
      mockWebSocket() as any,
      undefined,
      undefined,
      [],
    );
    expect(game.joinClient(intruder)).toBe("rejected");
  });

  it("honors its external start and treats duration as pacing, not forced teardown", () => {
    const game = managedGame();
    expect(game.phase()).toBe(GamePhase.Lobby);

    vi.setSystemTime(managedCommand.startsAt + 31_000);
    expect(game.phase()).toBe(GamePhase.Active);

    vi.setSystemTime(managedCommand.expiresAt + 1);
    expect(game.phase()).toBe(GamePhase.Active);
  });

  it("continues at the restored turn high-watermark and journals intents immediately", () => {
    const onTurnsCommitted = vi.fn();
    const initialTurns = [
      { turnNumber: 0, intents: [] },
      { turnNumber: 1, intents: [] },
    ];
    const game = new GameServer(
      managedCommand.gameID,
      log,
      NOW,
      gameConfig,
      undefined,
      managedCommand.startsAt,
      undefined,
      undefined,
      undefined,
      "test-build",
      {
        requestId: managedCommand.requestId,
        expiresAt: managedCommand.expiresAt,
        reservedSeats: managedCommand.reservedSeats,
        initialTurns,
      },
      { onTurnsCommitted },
    );

    game.start();
    (game as any).endTurn();

    expect(onTurnsCommitted).toHaveBeenCalledOnce();
    expect(onTurnsCommitted.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        turnNumber: 2,
        intents: expect.arrayContaining([
          expect.objectContaining({ type: "mark_disconnected" }),
        ]),
      }),
    ]);

    const ws = mockWebSocket();
    const coldClient = new Client(
      "seatAAA1",
      FIRST_PERSISTENT_ID,
      null,
      null,
      undefined,
      "127.0.0.1",
      "Atlas One",
      null,
      ws as any,
      undefined,
      undefined,
      [],
    );
    expect(game.joinClient(coldClient, 2)).toBe("joined");
    const catchup = ws.send.mock.calls
      .map(([value]) => JSON.parse(String(value)))
      .find((message) => message.type === "start");
    expect(
      catchup.turns.map((turn: { turnNumber: number }) => turn.turnNumber),
    ).toEqual([2]);
  });
});

describe("managed-game master/worker bridge", () => {
  beforeEach(() => {
    vi.spyOn(ServerEnv, "numWorkers").mockReturnValue(1);
    vi.spyOn(ServerEnv, "workerIndex").mockReturnValue(0);
    vi.spyOn(ServerEnv, "workerId").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for the owning worker acknowledgement", async () => {
    const worker = new EventEmitter() as EventEmitter & {
      send: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    };
    worker.send = vi.fn((_message, callback) => callback?.());
    worker.kill = vi.fn();
    const master = new MasterLobbyService({} as any, log);
    const turnHandler = vi.fn();
    const statsHandler = vi.fn();
    master.setManagedGameTurnHandler(turnHandler);
    master.setManagedGameStatsHandler(statsHandler);
    master.registerWorker(0, worker as any);
    worker.emit("message", { type: "workerReady", workerId: 0 });

    const ready = master.createManagedGame(managedCommand);
    expect(worker.send).toHaveBeenCalledWith(
      managedCommand,
      expect.any(Function),
    );
    worker.emit("message", {
      type: "managedGameReady",
      requestId: managedCommand.requestId,
      gameID: managedCommand.gameID,
      workerId: 0,
      outcome: "created",
    });
    await expect(ready).resolves.toMatchObject({ outcome: "created" });

    const turnBatch = {
      type: "managedGameTurns",
      requestId: managedCommand.requestId,
      gameID: managedCommand.gameID,
      workerId: 0,
      turns: [{ turnNumber: 0, intents: [] }],
    };
    worker.emit("message", turnBatch);
    expect(turnHandler).toHaveBeenCalledWith(turnBatch);

    const stats = {
      type: "managedGameStats",
      requestId: managedCommand.requestId,
      gameID: managedCommand.gameID,
      workerId: 0,
      stats: { turn: 10, players: [] },
    };
    worker.emit("message", stats);
    expect(statsHandler).toHaveBeenCalledWith(stats);
  });

  it("aggregates worker drain reports and resumes scheduling when cancelled", () => {
    const worker = new EventEmitter() as EventEmitter & {
      send: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    };
    worker.send = vi.fn((_message, callback) => callback?.());
    worker.kill = vi.fn();
    const master = new MasterLobbyService({} as any, log);
    const statusHandler = vi.fn();
    master.setDeploymentDrainStatusHandler(statusHandler);
    master.registerWorker(0, worker as any);
    worker.emit("message", { type: "workerReady", workerId: 0 });

    expect(master.beginDeploymentDrain()).toMatchObject({
      draining: true,
      ready: false,
      workersExpected: 1,
      workersReported: 0,
    });
    expect(worker.send).toHaveBeenCalledWith(
      { type: "deploymentDrain", enabled: true },
      expect.any(Function),
    );

    worker.emit("message", {
      type: "deploymentDrainStatus",
      workerId: 0,
      draining: true,
      blockingGames: 1,
      managedGames: 2,
      lobbyGames: 0,
      activeClients: 3,
      pendingAdmissions: 0,
    });
    expect(master.deploymentDrainStatus()).toMatchObject({
      ready: false,
      blockingGames: 1,
      managedGames: 2,
    });

    worker.emit("message", {
      type: "deploymentDrainStatus",
      workerId: 0,
      draining: true,
      blockingGames: 0,
      managedGames: 2,
      lobbyGames: 0,
      activeClients: 2,
      pendingAdmissions: 0,
    });
    expect(master.deploymentDrainStatus()).toMatchObject({
      ready: true,
      blockingGames: 0,
      managedGames: 2,
    });

    expect(master.cancelDeploymentDrain()).toMatchObject({
      draining: false,
      ready: false,
    });
    expect(statusHandler).toHaveBeenCalled();
  });

  it("creates a managed GameServer once and acknowledges only after simulation recovery", async () => {
    let resolveReady!: () => void;
    const recovered = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const created = {
      managedRequestId: () => managedCommand.requestId,
      whenSimulationReady: () => recovered,
    };
    const gm = {
      game: vi.fn().mockReturnValueOnce(null).mockReturnValue(created),
      createGame: vi.fn().mockReturnValue(created),
      publicLobbies: vi.fn().mockReturnValue([]),
      listedLobbies: vi.fn().mockReturnValue([]),
      discardGame: vi.fn(),
    };
    const server = new EventEmitter();
    const worker = new WorkerLobbyService(
      server as any,
      { handleUpgrade: vi.fn() } as any,
      gm as any,
      log,
    );
    const sendToMaster = vi.fn();
    (worker as any).sendToMaster = sendToMaster;

    (worker as any).handleMasterMessage(managedCommand);
    expect(gm.createGame).toHaveBeenCalledWith(
      managedCommand.gameID,
      managedCommand.gameConfig,
      undefined,
      managedCommand.startsAt,
      undefined,
      undefined,
      {
        requestId: managedCommand.requestId,
        expiresAt: managedCommand.expiresAt,
        reservedSeats: managedCommand.reservedSeats,
        initialTurns: undefined,
      },
      expect.objectContaining({
        onTurnsCommitted: expect.any(Function),
        onLiveStatsCommitted: expect.any(Function),
      }),
    );
    expect(sendToMaster).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "managedGameReady",
        outcome: "created",
      }),
    );
    resolveReady();
    await recovered;
    await Promise.resolve();
    expect(sendToMaster).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "managedGameReady",
        outcome: "created",
      }),
    );

    (worker as any).handleMasterMessage(managedCommand);
    await Promise.resolve();
    expect(gm.createGame).toHaveBeenCalledOnce();
    expect(sendToMaster).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "managedGameReady",
        outcome: "exists",
      }),
    );
  });
});
