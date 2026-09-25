import { createHash } from "crypto";
import { Difficulty, GameMapSize, GameMode, GameType } from "../core/game/Game";
import {
  persistentWorldDurationMs,
  type PersistentWorld,
} from "../core/PersistentWorldSchemas";
import { GameConfigSchema, UsernameSchema } from "../core/Schemas";
import { generateID } from "../core/Util";
import { WORLD_PRESETS } from "../core/WorldPresets";
import type {
  ManagedReservedSeat,
  MasterCreateManagedGame,
  WorkerManagedGameReady,
  WorkerManagedGameStats,
  WorkerManagedGameTurns,
} from "./IPCBridgeSchema";
import type { MapPlaylist } from "./MapPlaylist";
import type {
  PersistentWorldRepository,
  PersistentWorldRuntime,
  PersistentWorldRuntimeSeat,
} from "./persistent/PersistentWorldRepository";
import type { PersistentWorldRuntimeCoordinator } from "./persistent/PersistentWorldService";

export type ManagedGameDispatcher = (
  command: MasterCreateManagedGame,
) => Promise<WorkerManagedGameReady>;
export type ManagedGameStopper = (gameID: string) => void;

/**
 * Application-level adapter between durable invitation metadata and the
 * generic managed-game IPC contract. It deliberately owns only the envelope:
 * the actual map, economy, structures, combat, and AI continue to come from
 * the normal OpenFront playlist and simulation.
 */
export class PersistentWorldRuntimeBridge implements PersistentWorldRuntimeCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly attached = new Set<string>();
  private reconciliation: Promise<void> | undefined;
  private readonly retryState = new Map<
    string,
    { failures: number; retryAt: number }
  >();

  constructor(
    private readonly repository: PersistentWorldRepository,
    private readonly playlist: MapPlaylist,
    private readonly dispatch: ManagedGameDispatcher,
    private readonly stopManagedGame?: ManagedGameStopper,
  ) {}

  stop(worldId: string): void {
    const runtime = this.repository.getRuntime(worldId);
    if (runtime) this.stopManagedGame?.(runtime.gameId);
    this.attached.delete(worldId);
  }

  ensure(world: PersistentWorld): Promise<void> {
    const existing = this.inFlight.get(world.id);
    if (existing) return existing;
    const retry = this.retryState.get(world.id);
    if (retry && retry.retryAt > Date.now()) return Promise.resolve();
    const operation = this.ensureOnce(world)
      .then(() => {
        this.retryState.delete(world.id);
      })
      .catch((error) => {
        const failures = (this.retryState.get(world.id)?.failures ?? 0) + 1;
        // A failed expanded-world replay is expensive. Back off rather than
        // letting the one-second reconciliation scheduler launch a CPU- and
        // log-saturating recovery storm.
        const delay = Math.min(15 * 60_000, 30_000 * 2 ** (failures - 1));
        this.retryState.set(world.id, {
          failures,
          retryAt: Date.now() + delay,
        });
        throw error;
      })
      .finally(() => {
        if (this.inFlight.get(world.id) === operation) {
          this.inFlight.delete(world.id);
        }
      });
    this.inFlight.set(world.id, operation);
    return operation;
  }

  reconcile(): Promise<void> {
    // Scheduler ticks must share one recovery operation, not accumulate
    // thousands of waiters while a large journal replays.
    return (this.reconciliation ??= this.reconcileOnce().finally(() => {
      this.reconciliation = undefined;
    }));
  }

  private async reconcileOnce(): Promise<void> {
    const worlds = new Map<string, PersistentWorld>();
    for (const world of this.repository.listActiveWithoutRuntime()) {
      worlds.set(world.id, world);
    }
    for (const runtime of [
      ...this.repository.listRuntimeProvisioning(),
      ...this.repository.listRuntimeReady(),
    ]) {
      if (runtime.state === "ready" && this.attached.has(runtime.worldId)) {
        continue;
      }
      const world = this.repository.getWorld(runtime.worldId);
      if (world) worlds.set(world.id, world);
    }
    // Replay one old world at a time. Starting all large maps concurrently
    // multiplies memory/CPU pressure and can starve already-live games.
    const failures: unknown[] = [];
    for (const world of worlds.values()) {
      try {
        await this.ensure(world);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }

  /** Call after a worker replacement so ready runtimes are reattached. */
  invalidateWorker(workerGameIds: Iterable<string>): void {
    for (const gameId of workerGameIds) {
      for (const runtime of this.repository.listRuntimeReady()) {
        if (runtime.gameId === gameId) this.attached.delete(runtime.worldId);
      }
    }
  }

  /** Reattach every ready runtime, used when worker membership changes. */
  invalidateAll(): void {
    this.attached.clear();
  }

  isRuntimeReady(worldId: string): boolean {
    return this.attached.has(worldId);
  }

  /**
   * Durable sink for a shard-authenticated worker turn batch. The request ID
   * resolves the owning world; the game ID is checked again here so a stale
   * or crossed IPC message cannot poison another runtime's replay stream.
   */
  persistTurns(message: WorkerManagedGameTurns): void {
    const runtime = this.repository.getRuntimeByRequestId(message.requestId);
    if (!runtime || runtime.gameId !== message.gameID) {
      throw new Error(
        `Managed turn batch does not match runtime ${message.requestId}`,
      );
    }
    this.repository.appendRuntimeTurns(
      runtime.worldId,
      runtime.requestId,
      message.turns,
    );
  }

  /** Persists consensus simulation state so the hub can warn eliminated RSVPs. */
  persistStats(message: WorkerManagedGameStats): void {
    const runtime = this.repository.getRuntimeByRequestId(message.requestId);
    if (!runtime || runtime.gameId !== message.gameID) {
      throw new Error(
        `Managed stats do not match runtime ${message.requestId}`,
      );
    }
    const world = this.repository.getWorld(runtime.worldId);
    if (!world) throw new Error(`Managed world ${runtime.worldId} is missing`);

    const seats = this.repository.runtimeSeats(world.id);
    const managedSeats = this.managedSeats(world, seats);
    const identityByClientId = new Map(
      managedSeats.map((seat, index) => [
        seat.clientID,
        seats[index].identityId,
      ]),
    );
    const statuses = message.stats.players.flatMap((player) => {
      const identityId = identityByClientId.get(player.clientID);
      return identityId
        ? [
            {
              identityId,
              clientId: player.clientID,
              isAlive: player.isAlive,
              killedBy: player.killedBy,
              deathPosition: player.deathPosition,
            },
          ]
        : [];
    });
    this.repository.recordRuntimePlayerStatuses(
      world.id,
      runtime.requestId,
      message.stats.turn,
      statuses,
    );
  }

  private async ensureOnce(world: PersistentWorld): Promise<void> {
    if (world.phase !== "active") return;

    const seats = this.repository.runtimeSeats(world.id);
    // The worker must receive the entire deterministic roster in one command.
    // Updated clients bind before creating/RSVPing; legacy identities remain
    // in a visible "Preparing map" state until they bind rather than silently
    // becoming unplayable spectators.
    if (
      seats.length === 0 ||
      seats.some((seat) => seat.gameplayPersistentIdHash === null)
    ) {
      return;
    }

    let runtime = this.repository.getRuntime(world.id);
    if (!runtime) {
      const gameConfig = await this.createGameConfig(world);
      runtime = this.repository.reserveRuntime(
        world.id,
        this.runtimeRequestId(world),
        generateID(),
        gameConfig,
        world.startsAt,
        world.startsAt + persistentWorldDurationMs(world.targetDuration),
      );
    }

    const response = await this.dispatch(
      this.command(world, runtime, this.managedSeats(world, seats)),
    );
    if (
      response.requestId !== runtime.requestId ||
      response.gameID !== runtime.gameId
    ) {
      throw new Error("Managed-game acknowledgement did not match its request");
    }
    if (response.outcome === "conflict") {
      throw new Error(`Managed game ${runtime.gameId} conflicts on its worker`);
    }
    this.repository.markRuntimeReady(
      world.id,
      runtime.requestId,
      runtime.gameId,
    );
    this.attached.add(world.id);
    this.retryState.delete(world.id);
  }

  private async createGameConfig(world: PersistentWorld) {
    const upstream = await this.playlist.gameConfig(
      world.mode === "ffa" ? "ffa" : "team",
    );
    // Never infer rules from a display name or an operator's scale override.
    // Existing runtime records bypass this method and retain their exact config.
    const preset = WORLD_PRESETS[world.gamePreset ?? "scheduled-earth"];
    return GameConfigSchema.parse({
      ...upstream,
      pressurePacing: world.pressurePacing,
      ...("allianceProtectionMinutes" in preset
        ? {
            continuousPressure: "v1",
            fleetAutomation: "v26.3",
            nationStrategy: "v2",
            allianceProtectionMinutes: preset.allianceProtectionMinutes,
            pressureGraceSeconds: preset.pressureGraceSeconds,
            passiveWildernessExpansion: true,
            donateTroops: true,
            donateGold: true,
          }
        : {}),
      // The seamless-world branch changes only the physical board and its
      // population. Every economy, AI, structure and combat rule continues
      // to come from the current OpenFront configuration.
      // Operator-selected for NEW worlds only; persisted runtimes retain their
      // original map/config. Never swap terrain beneath an existing session.
      gameMap: preset.map,
      tradeShipTrafficMultiplier: preset.trade,
      trainTrafficMultiplier: preset.trains,
      territoryAttackSpeedDivisor: preset.attackDivisor,
      ...("fog" in preset
        ? { fogOfWar: preset.fog, fogBotActivity: preset.fog }
        : {}),
      serverSimulation: process.env.IDLE_SERVER_SIMULATION !== "0",
      // User-approved lifecycle exception for long playtests. Normal conquest,
      // economy, AI, combat, structures and explicit timers remain unchanged.
      disableForcedTimeLimit: world.targetDuration !== "1h",
      gameMapSize: GameMapSize.Normal,
      bots: world.gamePreset === "quickplay" ? 200 : 2000,
      nations: "default",
      difficulty: Difficulty.Medium,
      gameType: GameType.Private,
      gameMode: world.mode === "ffa" ? GameMode.FFA : GameMode.Team,
      maxPlayers: world.maxHumans,
      // Use the existing manual placement rules and their 300-tick (30s)
      // opening phase. Players must join at the start to choose their spawn;
      // persisted runtimes keep whichever mode they originally started with.
      randomSpawn: "fog" in preset,
      publicGameModifiers: {
        ...upstream.publicGameModifiers,
        // The selected terrain is always full-size, not the playlist's compact roll.
        isCompact: false,
        isRandomSpawn: false,
      },
      // In-sync clients vote on deterministic player state. The master stores
      // the agreed result so elimination survives worker and web restarts.
      liveStatsEnabled: true,
      // Team choices are pinned into the roster below. Two named sides are
      // the wizard's present contract; the rest of the upstream team rules
      // (donations, nations, structures, etc.) remain untouched.
      playerTeams: world.mode === "teams" ? 2 : undefined,
    });
  }

  private command(
    _world: PersistentWorld,
    runtime: PersistentWorldRuntime,
    reservedSeats: ManagedReservedSeat[],
  ): MasterCreateManagedGame {
    return {
      type: "createManagedGame",
      requestId: runtime.requestId,
      gameID: runtime.gameId,
      gameConfig: runtime.gameConfig,
      startsAt: runtime.startsAt,
      expiresAt: runtime.expiresAt,
      reservedSeats,
      initialTurns: this.repository.loadRuntimeTurns(runtime.worldId),
    };
  }

  private managedSeats(
    world: PersistentWorld,
    seats: PersistentWorldRuntimeSeat[],
  ): ManagedReservedSeat[] {
    const teamIds = [
      ...new Set(
        seats
          .map((seat) => seat.teamId)
          .filter((teamId): teamId is string => teamId !== null),
      ),
    ].sort();
    const usedClientIds = new Set<string>();
    return seats.map((seat, index) => ({
      clientID: this.clientId(world.id, seat.identityId, usedClientIds),
      persistentIdHash: seat.gameplayPersistentIdHash!,
      username: this.gameplayName(seat.displayName, index),
      clanTag: null,
      teamIndex:
        world.mode === "teams"
          ? Math.max(0, teamIds.indexOf(seat.teamId ?? "")) % 2
          : undefined,
    }));
  }

  private clientId(
    worldId: string,
    identityId: string,
    used: Set<string>,
  ): string {
    for (let salt = 0; salt < 100; salt++) {
      const id = createHash("sha256")
        .update(`${worldId}:${identityId}:${salt}`)
        .digest("hex")
        .slice(0, 8);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error("Could not allocate a unique managed client ID");
  }

  private runtimeRequestId(world: PersistentWorld): string {
    return `runtime_${createHash("sha256")
      .update(`${world.id}:${world.startsAt}:${world.createdAt}`)
      .digest("hex")
      .slice(0, 24)}`;
  }

  private gameplayName(displayName: string, index: number): string {
    // Preserve valid submitted names exactly; normalization is legacy fallback only.
    const original = UsernameSchema.safeParse(displayName);
    if (original.success) return original.data;
    const cleaned = displayName
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9_ üÜ.]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 27);
    const candidate = cleaned.length >= 3 ? cleaned : `Cmd ${cleaned}`.trim();
    const parsed = UsernameSchema.safeParse(candidate);
    return parsed.success ? parsed.data : `Commander ${index + 1}`;
  }
}
