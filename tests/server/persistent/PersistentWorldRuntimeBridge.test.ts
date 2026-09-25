import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/core/configuration/Config";
import {
  DEBUG_ENORMOUS_EARTH_PREFIX,
  DEBUG_HD_EARTH_PREFIX,
  DEBUG_QUICK_START_PREFIX,
} from "../../../src/core/DebugPlaytest";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../../src/core/game/Game";
import type { GameConfig } from "../../../src/core/Schemas";
import type {
  MasterCreateManagedGame,
  WorkerManagedGameReady,
  WorkerManagedGameStats,
  WorkerManagedGameTurns,
} from "../../../src/server/IPCBridgeSchema";
import type { MapPlaylist } from "../../../src/server/MapPlaylist";
import { PersistentWorldRepository } from "../../../src/server/persistent/PersistentWorldRepository";
import { PersistentWorldService } from "../../../src/server/persistent/PersistentWorldService";
import { PersistentWorldRuntimeBridge } from "../../../src/server/PersistentWorldRuntimeBridge";

const MINUTE = 60_000;
const UPSTREAM_CONFIG: GameConfig = {
  donateGold: false,
  donateTroops: false,
  gameMap: GameMapType.World,
  gameType: GameType.Public,
  gameMapSize: GameMapSize.Normal,
  difficulty: Difficulty.Medium,
  nations: "default",
  infiniteGold: false,
  infiniteTroops: false,
  maxTimerValue: undefined,
  instantBuild: false,
  randomSpawn: false,
  gameMode: GameMode.FFA,
  bots: 400,
  disabledUnits: [],
};

describe("persistent-world runtime bridge", () => {
  let now: number;
  let repository: PersistentWorldRepository;
  let service: PersistentWorldService;

  beforeEach(() => {
    now = Date.UTC(2026, 8, 2, 12);
    repository = new PersistentWorldRepository({
      dbPath: ":memory:",
      now: () => now,
    });
    service = new PersistentWorldService(repository, { now: () => now });
  });

  afterEach(() => service.close());
  afterEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllEnvs());

  function setup() {
    const host = service.createGuestSession({ displayName: "Map Keeper" });
    const gameplayHash = createHash("sha256")
      .update("play-identity")
      .digest("hex");
    service.bindGameplayIdentity(host.bearerToken, gameplayHash);
    const created = service.createWorld(host.bearerToken, {
      name: "One Day Test",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt: now + MINUTE,
    });
    now += MINUTE;
    const world = repository.markActive(created.snapshot.world.id, now);
    return { host, gameplayHash, world };
  }

  it.each(["quickplay", "longplay", "idlefront"] as const)(
    "enables strategic nations for every new %s runtime",
    async (gamePreset) => {
      const host = service.createGuestSession({
        displayName: "Strategy Tester",
      });
      service.bindGameplayIdentity(
        host.bearerToken,
        createHash("sha256").update(gamePreset).digest("hex"),
      );
      const created = service.createWorld(host.bearerToken, {
        name: "Strategy Preview",
        gamePreset,
        targetDuration: "1h",
        access: "private",
        mode: "ffa",
        maxHumans: 4,
        startsAt: now + MINUTE,
      });
      now += MINUTE;
      const world = repository.markActive(created.snapshot.world.id, now);
      const dispatch = vi.fn(
        async (
          command: MasterCreateManagedGame,
        ): Promise<WorkerManagedGameReady> => ({
          type: "managedGameReady",
          requestId: command.requestId,
          gameID: command.gameID,
          workerId: 0,
          outcome: "created",
        }),
      );
      await new PersistentWorldRuntimeBridge(
        repository,
        { gameConfig: async () => UPSTREAM_CONFIG } as unknown as MapPlaylist,
        dispatch,
      ).ensure(world);
      expect(repository.getRuntime(world.id)?.gameConfig.nationStrategy).toBe(
        "v2",
      );
      expect(dispatch.mock.calls[0][0].gameConfig.nationStrategy).toBe("v2");
    },
  );

  it("shares scheduler reconciliation and recovers old worlds sequentially", async () => {
    const { world } = setup();
    const second = { ...world, id: "second-world" };
    vi.spyOn(repository, "listActiveWithoutRuntime").mockReturnValue([
      world,
      second,
    ]);
    const bridge = new PersistentWorldRuntimeBridge(
      repository,
      {} as never,
      vi.fn(),
    );
    let release!: () => void;
    const ensure = vi
      .spyOn(bridge, "ensure")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const first = bridge.reconcile();
    expect(bridge.reconcile()).toBe(first);
    expect(ensure).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(ensure.mock.calls[1][0].id).toBe(second.id);
  });

  it("pins new one-day scheduled worlds to 9x regardless of operator scale, retaining persisted maps", async () => {
    const { world } = setup();
    const dispatch = vi.fn(
      async (
        command: MasterCreateManagedGame,
      ): Promise<WorkerManagedGameReady> => ({
        type: "managedGameReady",
        requestId: command.requestId,
        gameID: command.gameID,
        workerId: 0,
        outcome: "created",
      }),
    );
    const playlist = {
      gameConfig: async () => UPSTREAM_CONFIG,
    } as unknown as MapPlaylist;
    vi.stubEnv("IDLE_WORLD_MAP_SCALE", "3");
    await new PersistentWorldRuntimeBridge(
      repository,
      playlist,
      dispatch,
    ).ensure(world);
    expect(repository.getRuntime(world.id)?.gameConfig.gameMap).toBe(
      GameMapType.ExpandedGiantWorldLargeHDv1,
    );
    vi.stubEnv("IDLE_WORLD_MAP_SCALE", "2");
    await new PersistentWorldRuntimeBridge(
      repository,
      playlist,
      dispatch,
    ).ensure(world);
    expect(dispatch.mock.calls[1][0].gameConfig.gameMap).toBe(
      GameMapType.ExpandedGiantWorldLargeHDv1,
    );
  });

  it("does not let the scale-4 environment change scheduled mode", async () => {
    const { world } = setup();
    const dispatch = vi.fn(
      async (
        command: MasterCreateManagedGame,
      ): Promise<WorkerManagedGameReady> => ({
        type: "managedGameReady",
        requestId: command.requestId,
        gameID: command.gameID,
        workerId: 0,
        outcome: "created",
      }),
    );
    const playlist = {
      gameConfig: async () => UPSTREAM_CONFIG,
    } as unknown as MapPlaylist;
    vi.stubEnv("IDLE_WORLD_MAP_SCALE", "4");
    await new PersistentWorldRuntimeBridge(
      repository,
      playlist,
      dispatch,
    ).ensure(world);
    expect(repository.getRuntime(world.id)?.gameConfig.gameMap).toBe(
      GameMapType.ExpandedGiantWorldLargeHDv1,
    );
  });

  it("gives custom Great Lakes 10x ships and trains with normal attacks", async () => {
    const host = service.createGuestSession({ displayName: "Trade Tester" });
    service.bindGameplayIdentity(
      host.bearerToken,
      createHash("sha256").update("trade-play-identity").digest("hex"),
    );
    const created = service.createWorld(host.bearerToken, {
      name: `${DEBUG_QUICK_START_PREFIX}12:00 PM`,
      startMode: "host",
      gamePreset: "great-lakes",
      targetDuration: "1h",
      access: "public",
      mode: "ffa",
      maxHumans: 8,
      startsAt: now + MINUTE,
    });
    now += MINUTE;
    const world = repository.startCustomWorld(
      created.snapshot.world.id,
      host.session.identity.id,
    );
    const dispatch = vi.fn(
      async (
        command: MasterCreateManagedGame,
      ): Promise<WorkerManagedGameReady> => ({
        type: "managedGameReady",
        requestId: command.requestId,
        gameID: command.gameID,
        workerId: 0,
        outcome: "created",
      }),
    );
    await new PersistentWorldRuntimeBridge(
      repository,
      { gameConfig: async () => UPSTREAM_CONFIG } as unknown as MapPlaylist,
      dispatch,
    ).ensure(world);

    expect(repository.getRuntime(world.id)?.gameConfig).toMatchObject({
      gameMap: GameMapType.GreatLakes,
      tradeShipTrafficMultiplier: 10,
      trainTrafficMultiplier: 10,
      territoryAttackSpeedDivisor: 1,
    });
  });

  it.each([
    [DEBUG_ENORMOUS_EARTH_PREFIX, GameMapType.ExpandedGiantWorldUltra],
    [DEBUG_HD_EARTH_PREFIX, GameMapType.ExpandedGiantWorldLargeHDv1],
  ])("selects the exact Earth preset for %s", async (prefix, expectedMap) => {
    const host = service.createGuestSession({ displayName: "Earth Tester" });
    service.bindGameplayIdentity(
      host.bearerToken,
      createHash("sha256").update("earth-play-identity").digest("hex"),
    );
    const created = service.createWorld(host.bearerToken, {
      name: `${prefix}12:01 PM`,
      startMode: "host",
      gamePreset:
        prefix === DEBUG_HD_EARTH_PREFIX ? "hd-earth-9x" : "enormous-earth",
      targetDuration: "1h",
      access: "public",
      mode: "ffa",
      maxHumans: 8,
      startsAt: now + MINUTE,
    });
    now += MINUTE;
    const world = repository.startCustomWorld(
      created.snapshot.world.id,
      host.session.identity.id,
    );
    const dispatch = vi.fn(
      async (
        command: MasterCreateManagedGame,
      ): Promise<WorkerManagedGameReady> => ({
        type: "managedGameReady",
        requestId: command.requestId,
        gameID: command.gameID,
        workerId: 0,
        outcome: "created",
      }),
    );
    await new PersistentWorldRuntimeBridge(
      repository,
      { gameConfig: async () => UPSTREAM_CONFIG } as unknown as MapPlaylist,
      dispatch,
    ).ensure(world);

    expect(repository.getRuntime(world.id)?.gameConfig).toMatchObject({
      gameMap: expectedMap,
      tradeShipTrafficMultiplier: 5,
      trainTrafficMultiplier: 5,
      territoryAttackSpeedDivisor: 1,
    });
  });

  it("freezes bound RSVP seats and exposes only an acknowledged runtime", async () => {
    const { host, gameplayHash, world } = setup();
    const gameConfig = vi.fn(async () => UPSTREAM_CONFIG);
    const commands: MasterCreateManagedGame[] = [];
    const dispatch = vi.fn(
      async (
        command: MasterCreateManagedGame,
      ): Promise<WorkerManagedGameReady> => {
        commands.push(command);
        return {
          type: "managedGameReady",
          requestId: command.requestId,
          gameID: command.gameID,
          workerId: 0,
          outcome: "created",
        };
      },
    );
    const bridge = new PersistentWorldRuntimeBridge(
      repository,
      { gameConfig } as unknown as MapPlaylist,
      dispatch,
    );

    expect(service.getSnapshot(world.id, host.bearerToken).runtimeGameId).toBe(
      null,
    );
    await bridge.ensure(world);

    const runtime = repository.getRuntime(world.id)!;
    expect(runtime.state).toBe("ready");
    expect(runtime.expiresAt - runtime.startsAt).toBe(24 * 60 * 60 * 1000);
    expect(runtime.gameConfig).toMatchObject({
      pressurePacing: {
        populationDoublingSeconds: 7200,
        mobilisationHalfLifeSeconds: 10,
      },
      gameType: GameType.Private,
      maxPlayers: 4,
      gameMode: GameMode.FFA,
      gameMap: GameMapType.ExpandedGiantWorldLargeHDv1,
      bots: 2000,
      randomSpawn: false,
      publicGameModifiers: expect.objectContaining({ isRandomSpawn: false }),
      liveStatsEnabled: true,
      disableForcedTimeLimit: true,
    });
    const spawnConfig = new Config(runtime.gameConfig, null, false);
    expect(spawnConfig.isRandomSpawn()).toBe(false);
    expect(spawnConfig.numSpawnPhaseTurns() * spawnConfig.msPerTick()).toBe(
      30_000,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0].initialTurns).toEqual([]);
    expect(commands[0].reservedSeats).toEqual([
      expect.objectContaining({
        persistentIdHash: gameplayHash,
        username: "Map Keeper",
        clanTag: null,
      }),
    ]);
    expect(service.getSnapshot(world.id, host.bearerToken).runtimeGameId).toBe(
      runtime.gameId,
    );

    const statsMessage: WorkerManagedGameStats = {
      type: "managedGameStats",
      requestId: runtime.requestId,
      gameID: runtime.gameId,
      workerId: 0,
      stats: {
        turn: 240,
        players: [
          {
            clientID: commands[0].reservedSeats[0].clientID,
            tilesOwned: 0,
            troops: 0,
            gold: "0",
            isAlive: false,
            team: null,
            killedBy: null,
            deathPosition: 2,
          },
        ],
      },
    };
    bridge.persistStats(statsMessage);
    expect(service.listMine(host.bearerToken)[0]).toMatchObject({
      viewerEliminated: true,
    });
    expect(
      repository.runtimePlayerStatus(world.id, host.session.identity.id),
    ).toMatchObject({
      clientId: commands[0].reservedSeats[0].clientID,
      isAlive: false,
      observedTurn: 240,
    });

    await bridge.reconcile();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("persists worker turns and replays the same runtime after a master restart", async () => {
    const { world } = setup();
    const firstDispatch = vi.fn(
      async (
        command: MasterCreateManagedGame,
      ): Promise<WorkerManagedGameReady> => ({
        type: "managedGameReady",
        requestId: command.requestId,
        gameID: command.gameID,
        workerId: 0,
        outcome: "created",
      }),
    );
    const bridge = new PersistentWorldRuntimeBridge(
      repository,
      {
        gameConfig: vi.fn(async () => UPSTREAM_CONFIG),
      } as unknown as MapPlaylist,
      firstDispatch,
    );

    await bridge.ensure(world);
    const runtime = repository.getRuntime(world.id)!;
    const turnMessage: WorkerManagedGameTurns = {
      type: "managedGameTurns",
      requestId: runtime.requestId,
      gameID: runtime.gameId,
      workerId: 0,
      turns: [
        { turnNumber: 0, intents: [] },
        { turnNumber: 1, intents: [], hash: 17 },
      ],
    };
    bridge.persistTurns(turnMessage);
    expect(repository.loadRuntimeTurns(world.id)).toEqual(turnMessage.turns);

    expect(() =>
      bridge.persistTurns({ ...turnMessage, gameID: "Wrong123" }),
    ).toThrow("does not match runtime");
    expect(repository.loadRuntimeTurns(world.id)).toEqual(turnMessage.turns);

    const recoveredCommands: MasterCreateManagedGame[] = [];
    const recoveredDispatch = vi.fn(
      async (
        command: MasterCreateManagedGame,
      ): Promise<WorkerManagedGameReady> => {
        recoveredCommands.push(command);
        return {
          type: "managedGameReady",
          requestId: command.requestId,
          gameID: command.gameID,
          workerId: 1,
          outcome: "created",
        };
      },
    );
    const gameConfig = vi.fn(async () => {
      throw new Error("A recovered runtime must use its persisted config");
    });
    const recoveredBridge = new PersistentWorldRuntimeBridge(
      repository,
      { gameConfig } as unknown as MapPlaylist,
      recoveredDispatch,
    );

    await recoveredBridge.reconcile();

    expect(gameConfig).not.toHaveBeenCalled();
    expect(recoveredDispatch).toHaveBeenCalledTimes(1);
    expect(recoveredCommands[0]).toMatchObject({
      requestId: runtime.requestId,
      gameID: runtime.gameId,
      gameConfig: runtime.gameConfig,
      initialTurns: turnMessage.turns,
    });
  });

  it("backs off a failed recovery instead of retrying every scheduler tick", async () => {
    const { world } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let shouldFail = true;
    const dispatch = vi.fn(
      async (
        command: MasterCreateManagedGame,
      ): Promise<WorkerManagedGameReady> => {
        if (shouldFail) throw new Error("replay failed");
        return {
          type: "managedGameReady",
          requestId: command.requestId,
          gameID: command.gameID,
          workerId: 0,
          outcome: "created",
        };
      },
    );
    const bridge = new PersistentWorldRuntimeBridge(
      repository,
      { gameConfig: async () => UPSTREAM_CONFIG } as unknown as MapPlaylist,
      dispatch,
    );

    await expect(bridge.ensure(world)).rejects.toThrow("replay failed");
    await bridge.ensure(world);
    await bridge.reconcile();
    expect(dispatch).toHaveBeenCalledTimes(1);

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await bridge.reconcile();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(bridge.isRuntimeReady(world.id)).toBe(true);
  });

  it("waits rather than creating an unusable game when an RSVP is unbound", async () => {
    const host = service.createGuestSession({ displayName: "Legacy Host" });
    const created = service.createWorld(host.bearerToken, {
      name: "Waiting World",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 2,
      startsAt: now + MINUTE,
    });
    now += MINUTE;
    const world = repository.markActive(created.snapshot.world.id, now);
    const dispatch = vi.fn();
    const bridge = new PersistentWorldRuntimeBridge(
      repository,
      {
        gameConfig: vi.fn(async () => UPSTREAM_CONFIG),
      } as unknown as MapPlaylist,
      dispatch,
    );

    await bridge.ensure(world);

    expect(repository.getRuntime(world.id)).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(service.getSnapshot(world.id, host.bearerToken).runtimeGameId).toBe(
      null,
    );
  });
});
