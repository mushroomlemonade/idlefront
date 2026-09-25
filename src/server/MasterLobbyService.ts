import { Worker } from "cluster";
import winston from "winston";
import {
  MAX_HOSTED_LOBBIES,
  PublicGameType,
  SCHEDULED_PUBLIC_GAME_TYPES,
} from "../core/Schemas";
import { generateID } from "../core/Util";
import {
  InternalGameInfo,
  InternalGameInfoSchema,
  MasterCreateGame,
  MasterCreateManagedGame,
  MasterLobbiesBroadcast,
  MasterUpdateGame,
  WorkerManagedGameReady,
  WorkerManagedGameStats,
  WorkerManagedGameTurns,
  WorkerMessageSchema,
  type MasterEndManagedGame,
  type WorkerDeploymentDrainStatus,
} from "./IPCBridgeSchema";
import { logger } from "./Logger";
import { MapPlaylist } from "./MapPlaylist";
import { startPolling } from "./PollingLoop";
import { ServerEnv } from "./ServerEnv";

export interface MasterLobbyServiceOptions {
  playlist: MapPlaylist;
  log: typeof logger;
}

export interface DeploymentDrainStatus {
  draining: boolean;
  ready: boolean;
  workersExpected: number;
  workersReported: number;
  blockingGames: number;
  managedGames: number;
  lobbyGames: number;
  activeClients: number;
  pendingAdmissions: number;
}

export class MasterLobbyService {
  private readonly workers = new Map<number, Worker>();
  // Worker id => the lobbies it owns.
  private readonly workerLobbies = new Map<number, InternalGameInfo[]>();
  private readonly readyWorkers = new Set<number>();
  // gameID => consecutive broadcast cycles a hosted lobby has lost the
  // per-creator dedup or overflowed the cluster-wide cap. Losing once can be
  // a stale worker report (a delisted lobby lingers for one report
  // round-trip); losing twice means the conflict is real, and the loser gets
  // delisted.
  private readonly loserStreaks = new Map<string, number>();
  private readonly pendingManagedGames = new Map<
    string,
    {
      gameID: string;
      workerId: number;
      promise: Promise<WorkerManagedGameReady>;
      resolve: (message: WorkerManagedGameReady) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private managedGameTurnHandler?: (message: WorkerManagedGameTurns) => void;
  private managedGameStatsHandler?: (message: WorkerManagedGameStats) => void;
  private deploymentDraining = false;
  private readonly workerDrainStatuses = new Map<
    number,
    WorkerDeploymentDrainStatus
  >();
  private deploymentDrainStatusHandler?: (
    status: DeploymentDrainStatus,
  ) => void;
  private started = false;

  constructor(
    private playlist: MapPlaylist,
    private log: winston.Logger,
  ) {}

  registerWorker(workerId: number, worker: Worker) {
    this.workers.set(workerId, worker);

    worker.on("message", (raw: unknown) => {
      const result = WorkerMessageSchema.safeParse(raw);
      if (!result.success) {
        this.log.error("Invalid IPC message from worker:", raw);
        return;
      }

      const msg = result.data;
      switch (msg.type) {
        case "workerReady":
          this.handleWorkerReady(msg.workerId);
          break;
        case "lobbyList":
          this.workerLobbies.set(workerId, this.validLobbies(msg.lobbies));
          break;
        case "managedGameReady":
          this.handleManagedGameReady(workerId, msg);
          break;
        case "managedGameTurns":
          this.handleManagedGameTurns(workerId, msg);
          break;
        case "managedGameStats":
          this.handleManagedGameStats(workerId, msg);
          break;
        case "deploymentDrainStatus":
          this.handleDeploymentDrainStatus(workerId, msg);
          break;
      }
    });
  }

  setDeploymentDrainStatusHandler(
    handler: ((status: DeploymentDrainStatus) => void) | undefined,
  ): void {
    this.deploymentDrainStatusHandler = handler;
  }

  beginDeploymentDrain(): DeploymentDrainStatus {
    if (!this.deploymentDraining) {
      this.deploymentDraining = true;
      this.workerDrainStatuses.clear();
      this.broadcastDeploymentDrain(true);
    }
    return this.emitDeploymentDrainStatus();
  }

  cancelDeploymentDrain(): DeploymentDrainStatus {
    if (this.deploymentDraining) this.broadcastDeploymentDrain(false);
    this.deploymentDraining = false;
    this.workerDrainStatuses.clear();
    return this.emitDeploymentDrainStatus();
  }

  deploymentDrainStatus(): DeploymentDrainStatus {
    const workersExpected = this.workers.size;
    const statuses = [...this.workerDrainStatuses.values()].filter(
      (status) => status.draining,
    );
    const totals = statuses.reduce(
      (total, status) => ({
        blockingGames: total.blockingGames + status.blockingGames,
        managedGames: total.managedGames + status.managedGames,
        lobbyGames: total.lobbyGames + status.lobbyGames,
        activeClients: total.activeClients + status.activeClients,
        pendingAdmissions: total.pendingAdmissions + status.pendingAdmissions,
      }),
      {
        blockingGames: 0,
        managedGames: 0,
        lobbyGames: 0,
        activeClients: 0,
        pendingAdmissions: 0,
      },
    );
    const workersReported = statuses.length;
    return {
      draining: this.deploymentDraining,
      ready:
        this.deploymentDraining &&
        workersExpected > 0 &&
        workersReported === workersExpected &&
        totals.blockingGames === 0 &&
        totals.lobbyGames === 0 &&
        totals.pendingAdmissions === 0,
      workersExpected,
      workersReported,
      ...totals,
    };
  }

  private broadcastDeploymentDrain(enabled: boolean): void {
    for (const worker of this.workers.values()) {
      worker.send({ type: "deploymentDrain", enabled }, (error) => {
        if (!error) return;
        this.log.error("Failed to update worker deployment-drain state", {
          enabled,
          error: error.message,
        });
        worker.kill();
      });
    }
  }

  private handleDeploymentDrainStatus(
    registeredWorkerId: number,
    status: WorkerDeploymentDrainStatus,
  ): void {
    if (status.workerId !== registeredWorkerId) {
      this.log.error("Ignoring deployment-drain status from the wrong worker", {
        registeredWorkerId,
        claimedWorkerId: status.workerId,
      });
      return;
    }
    this.workerDrainStatuses.set(registeredWorkerId, status);
    this.emitDeploymentDrainStatus();
  }

  private emitDeploymentDrainStatus(): DeploymentDrainStatus {
    const status = this.deploymentDrainStatus();
    this.deploymentDrainStatusHandler?.(status);
    return status;
  }

  /**
   * Registers the master-owned durable sink for worker turn batches. The
   * handler is deliberately generic: application composition decides where
   * managed-game journals live.
   */
  setManagedGameTurnHandler(
    handler: ((message: WorkerManagedGameTurns) => void) | undefined,
  ): void {
    this.managedGameTurnHandler = handler;
  }

  setManagedGameStatsHandler(
    handler: ((message: WorkerManagedGameStats) => void) | undefined,
  ): void {
    this.managedGameStatsHandler = handler;
  }

  /**
   * Creates an externally scheduled match on its deterministic shard and
   * resolves only after that worker confirms the managed GameServer exists.
   * Repeating an in-flight request ID shares the same promise.
   */
  createManagedGame(
    command: MasterCreateManagedGame,
  ): Promise<WorkerManagedGameReady> {
    const pending = this.pendingManagedGames.get(command.requestId);
    if (pending) {
      if (pending.gameID !== command.gameID) {
        return Promise.reject(
          new Error(
            `Managed request ${command.requestId} is already bound to ${pending.gameID}`,
          ),
        );
      }
      return pending.promise;
    }

    const workerId = ServerEnv.workerIndex(command.gameID);
    const worker = this.workers.get(workerId);
    if (!worker || !this.readyWorkers.has(workerId)) {
      return Promise.reject(
        new Error(`Worker ${workerId} is not ready for managed game creation`),
      );
    }

    let resolvePromise!: (message: WorkerManagedGameReady) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<WorkerManagedGameReady>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // The worker owns the authoritative initialization deadline. The master
    // keeps a slightly wider IPC envelope so its request cannot expire first
    // while a large durable journal is still reconstructing.
    const recoveryTimeoutMs = Math.min(
      61 * 60_000,
      Math.max(210_000, (command.initialTurns?.length ?? 0) * 75 + 30_000),
    );
    const timeout = setTimeout(() => {
      this.rejectManagedGame(
        command.requestId,
        new Error(`Timed out creating managed game ${command.gameID}`),
      );
    }, recoveryTimeoutMs);
    timeout.unref?.();
    this.pendingManagedGames.set(command.requestId, {
      gameID: command.gameID,
      workerId,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout,
    });

    try {
      worker.send(command, (error) => {
        if (!error) return;
        this.rejectManagedGame(command.requestId, error);
        this.log.error(
          `Failed to send managed game ${command.gameID} to worker ${workerId}, killing worker:`,
          error,
        );
        worker.kill();
      });
    } catch (error) {
      this.rejectManagedGame(
        command.requestId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return promise;
  }

  /** Instruct the owning worker to close a managed simulation immediately. */
  endManagedGame(gameID: string): void {
    const worker = this.workers.get(ServerEnv.workerIndex(gameID));
    if (!worker) return;
    const message: MasterEndManagedGame = { type: "endManagedGame", gameID };
    worker.send(message, (error) => {
      if (error) {
        this.log.warn("Failed to end managed game on worker", {
          gameID,
          error: error.message,
        });
      }
    });
  }

  private handleManagedGameReady(
    registeredWorkerId: number,
    message: WorkerManagedGameReady,
  ): void {
    const pending = this.pendingManagedGames.get(message.requestId);
    if (!pending) {
      this.log.warn("Ignoring unexpected managed-game acknowledgement", {
        requestId: message.requestId,
        gameID: message.gameID,
      });
      return;
    }
    if (
      message.workerId !== registeredWorkerId ||
      pending.workerId !== registeredWorkerId ||
      pending.gameID !== message.gameID
    ) {
      this.rejectManagedGame(
        message.requestId,
        new Error("Managed-game acknowledgement did not match its request"),
      );
      return;
    }
    if (message.outcome === "conflict") {
      this.rejectManagedGame(
        message.requestId,
        new Error(`Game ID ${message.gameID} is already owned by another game`),
      );
      return;
    }
    if (message.outcome === "failed") {
      this.rejectManagedGame(
        message.requestId,
        new Error(
          message.error ?? `Managed game ${message.gameID} failed to start`,
        ),
      );
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingManagedGames.delete(message.requestId);
    pending.resolve(message);
  }

  private handleManagedGameTurns(
    registeredWorkerId: number,
    message: WorkerManagedGameTurns,
  ): void {
    if (
      message.workerId !== registeredWorkerId ||
      ServerEnv.workerIndex(message.gameID) !== registeredWorkerId
    ) {
      this.log.error("Ignoring managed turns from the wrong worker", {
        requestId: message.requestId,
        gameID: message.gameID,
        registeredWorkerId,
        claimedWorkerId: message.workerId,
      });
      return;
    }
    if (!this.managedGameTurnHandler) {
      this.log.error("Managed turn batch has no durable handler", {
        requestId: message.requestId,
        gameID: message.gameID,
      });
      return;
    }
    try {
      this.managedGameTurnHandler(message);
    } catch (error) {
      this.log.error("Failed to persist managed turn batch", {
        requestId: message.requestId,
        gameID: message.gameID,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleManagedGameStats(
    registeredWorkerId: number,
    message: WorkerManagedGameStats,
  ): void {
    if (
      message.workerId !== registeredWorkerId ||
      ServerEnv.workerIndex(message.gameID) !== registeredWorkerId
    ) {
      this.log.error("Ignoring managed stats from the wrong worker", {
        requestId: message.requestId,
        gameID: message.gameID,
        registeredWorkerId,
        claimedWorkerId: message.workerId,
      });
      return;
    }
    if (!this.managedGameStatsHandler) {
      this.log.error("Managed stats have no durable handler", {
        requestId: message.requestId,
        gameID: message.gameID,
      });
      return;
    }
    try {
      this.managedGameStatsHandler(message);
    } catch (error) {
      this.log.error("Failed to persist managed stats", {
        requestId: message.requestId,
        gameID: message.gameID,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private rejectManagedGame(requestId: string, error: Error): void {
    const pending = this.pendingManagedGames.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingManagedGames.delete(requestId);
    pending.reject(error);
  }

  // Lobby entries are validated individually so one malformed entry only
  // drops itself. Rejecting the whole report would freeze this worker's
  // lobbies in the master's view for as long as the bad entry exists —
  // stale broadcasts to every client, countdown resets, and duplicate
  // scheduling.
  private validLobbies(lobbies: unknown[]): InternalGameInfo[] {
    const valid: InternalGameInfo[] = [];
    for (const lobby of lobbies) {
      const result = InternalGameInfoSchema.safeParse(lobby);
      if (result.success) {
        valid.push(result.data);
      } else {
        this.log.error("Dropping invalid lobby in worker report:", lobby);
      }
    }
    return valid;
  }

  removeWorker(workerId: number) {
    this.workers.delete(workerId);
    this.workerLobbies.delete(workerId);
    this.readyWorkers.delete(workerId);
    this.workerDrainStatuses.delete(workerId);
    if (this.deploymentDraining) this.emitDeploymentDrainStatus();
    for (const [requestId, pending] of this.pendingManagedGames) {
      if (pending.workerId === workerId) {
        this.rejectManagedGame(
          requestId,
          new Error(`Worker ${workerId} exited during managed game creation`),
        );
      }
    }
  }

  isHealthy(): boolean {
    // We consider the lobby service healthy if at least half of the workers are ready.
    // This allows for some leeway if a worker crashes.
    const minWorkers = Math.max(ServerEnv.numWorkers() / 2, 1);
    return this.started && this.readyWorkers.size >= minWorkers;
  }

  private handleWorkerReady(workerId: number) {
    this.readyWorkers.add(workerId);
    this.log.info(
      `Worker ${workerId} is ready. (${this.readyWorkers.size}/${ServerEnv.numWorkers()} ready)`,
    );
    if (this.deploymentDraining) {
      const worker = this.workers.get(workerId);
      worker?.send({ type: "deploymentDrain", enabled: true });
    }
    if (this.readyWorkers.size === ServerEnv.numWorkers() && !this.started) {
      this.started = true;
      this.log.info("All workers ready, starting game scheduling");
      startPolling(async () => this.broadcastLobbies(), 500);
      startPolling(async () => await this.maybeScheduleLobby(), 1000);
    }
  }

  private getAllLobbies(): {
    games: Record<PublicGameType, InternalGameInfo[]>;
    losers: string[];
  } {
    const lobbies = Array.from(this.workerLobbies.values()).flat();

    const result: Record<PublicGameType, InternalGameInfo[]> = {
      ffa: [],
      team: [],
      special: [],
      hosted: [],
    };

    for (const lobby of lobbies) {
      result[lobby.publicGameType].push(lobby);
    }

    for (const type of Object.keys(result) as PublicGameType[]) {
      result[type].sort((a, b) => {
        if (a.startsAt === undefined && b.startsAt === undefined) {
          // Sort by game id for stability.
          return a.gameID > b.gameID ? 1 : -1;
        }
        // If a lobby has startsAt set, we assume it's the active one.
        if (a.startsAt === undefined) return 1;
        if (b.startsAt === undefined) return -1;
        return a.startsAt - b.startsAt;
      });
    }

    // One listed lobby per creator, cluster-wide. Workers enforce this at
    // listing time, but two workers can list concurrently between broadcasts;
    // dropping duplicates here (deterministically, after the sort above)
    // keeps the extra lobby from ever being advertised. Losers are reported
    // so broadcastLobbies can tell the owning worker to clear the loser's
    // listed flag — otherwise it would stay flagged Public on its worker
    // while never appearing in any browser.
    const seenCreators = new Set<string>();
    const losers: string[] = [];
    result.hosted = result.hosted.filter((lobby) => {
      if (lobby.creatorID === undefined) return true;
      if (seenCreators.has(lobby.creatorID)) {
        losers.push(lobby.gameID);
        return false;
      }
      seenCreators.add(lobby.creatorID);
      return true;
    });

    // Cluster-wide cap to prevent listing spam. Workers reject listings past
    // the cap too, but their view lags by a broadcast round-trip; overflow
    // (deterministically the sort losers) is delisted like dedup losers.
    if (result.hosted.length > MAX_HOSTED_LOBBIES) {
      for (const lobby of result.hosted.slice(MAX_HOSTED_LOBBIES)) {
        losers.push(lobby.gameID);
      }
      result.hosted = result.hosted.slice(0, MAX_HOSTED_LOBBIES);
    }

    return { games: result, losers };
  }

  // Losers (creator dedup or cap overflow) are only delisted after losing
  // two consecutive broadcast cycles: a single loss can be a stale worker
  // report (a just-delisted lobby lingers for one report round-trip), and
  // delisting on it would clear a legitimately listed lobby.
  private delistGameIDs(losers: string[]): string[] {
    const loserSet = new Set(losers);
    for (const gameID of this.loserStreaks.keys()) {
      if (!loserSet.has(gameID)) this.loserStreaks.delete(gameID);
    }
    const delist: string[] = [];
    for (const gameID of losers) {
      const streak = (this.loserStreaks.get(gameID) ?? 0) + 1;
      this.loserStreaks.set(gameID, streak);
      if (streak >= 2) delist.push(gameID);
    }
    if (delist.length > 0) {
      this.log.info(
        `delisting hosted lobbies (duplicate creator or over cap): ${delist.join(", ")}`,
      );
    }
    return delist;
  }

  private broadcastLobbies() {
    const { games, losers } = this.getAllLobbies();
    const delist = this.delistGameIDs(losers);
    const msg = {
      type: "lobbiesBroadcast",
      publicGames: {
        serverTime: Date.now(),
        games,
      },
      delistGameIDs: delist.length > 0 ? delist : undefined,
    } satisfies MasterLobbiesBroadcast;
    for (const [workerId, worker] of this.workers.entries()) {
      worker.send(msg, (e) => {
        if (e) {
          this.log.error(
            `Failed to send lobbies broadcast to worker ${workerId}, killing worker:`,
            e,
          );
          worker.kill();
        }
      });
    }
  }

  private async maybeScheduleLobby() {
    // Dedicated persistent-world development should not spend simulation CPU
    // continuously creating empty rolling public matches beside a playtest.
    if (
      this.deploymentDraining ||
      process.env.IDLE_DISABLE_PUBLIC_LOBBIES === "1"
    )
      return;
    const lobbiesByType = this.getAllLobbies().games;

    // Scheduled types only: hosted lobbies are started by their host, never
    // given a countdown or replaced by the master.
    for (const type of SCHEDULED_PUBLIC_GAME_TYPES) {
      const lobbies = lobbiesByType[type];

      // Always ensure the next lobby has a timer, even if we already have 2+
      // lobbies. This prevents a race where two lobbies are created before
      // either receives a startsAt (IPC round-trip delay), leaving both stuck
      // without a countdown.
      const nextLobby = lobbies[0];
      if (nextLobby && nextLobby.startsAt === undefined) {
        this.sendMessageToWorker({
          type: "updateLobby",
          gameID: nextLobby.gameID,
          startsAt: Date.now() + ServerEnv.gameCreationRate(),
        });
      }

      if (lobbies.length >= 2) {
        continue;
      }

      this.sendMessageToWorker({
        type: "createGame",
        gameID: generateID(),
        gameConfig: await this.playlist.gameConfig(type),
        publicGameType: type,
      } satisfies MasterCreateGame);
    }
  }

  private sendMessageToWorker(msg: MasterCreateGame | MasterUpdateGame): void {
    const workerId = ServerEnv.workerIndex(msg.gameID);
    const worker = this.workers.get(workerId);
    if (!worker) {
      this.log.error(`Worker ${workerId} not found`);
      return;
    }
    worker.send(msg, (e) => {
      if (e) {
        this.log.error(
          `Failed to send message to worker ${workerId}, killing worker:`,
          e,
        );
        worker.kill();
      }
    });
  }
}
