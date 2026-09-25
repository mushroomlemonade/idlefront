import { createHash } from "crypto";
import ipAnonymize from "ip-anonymize";
import { Logger } from "winston";
import WebSocket from "ws";
import { z } from "zod";
import { anonWordName } from "../core/AnonNames";
import { isAdminRole } from "../core/ApiSchemas";
import { GameEnv } from "../core/configuration/Config";
import { GameMode, GameType, RankedType } from "../core/game/Game";
import {
  ClientViewMessageSchema,
  encodeViewPacket,
} from "../core/network/ViewProtocol";
import {
  ClientID,
  ClientMessageSchema,
  ClientSendLiveStatsMessage,
  ClientSendWinnerMessage,
  GameConfig,
  GameID,
  GameInfo,
  GameStartInfo,
  GameStartInfoSchema,
  HOSTED_LOBBY_AUTO_START_MS,
  Intent,
  LiveStats,
  PlayerLiveStats,
  PlayerRecord,
  PublicGameType,
  ServerDesyncSchema,
  ServerErrorMessage,
  ServerLobbyInfoMessage,
  ServerNewLobbyMessage,
  ServerPrestartMessageSchema,
  ServerSimulationRecoveryMessage,
  ServerStartGameMessage,
  ServerTurnMessage,
  StampedIntent,
  Tribe,
  Turn,
} from "../core/Schemas";
import { createPartialGameRecord, simpleHash } from "../core/Util";
import { archive, finalizeGameRecord } from "./Archive";
import { Client } from "./Client";
import { ClientMsgRateLimiter } from "./ClientMsgRateLimiter";
import { fetchCustomTribes } from "./CustomTribes";
import type {
  ManagedGameOptions,
  ManagedReservedSeat,
} from "./IPCBridgeSchema";
import { ServerEnv } from "./ServerEnv";
import {
  SimulationHost,
  type SimulationRecoveryProgress,
  type TickResult,
} from "./simulation/SimulationHost";
import {
  simulationStartInfo,
  usesServerSimulation,
} from "./simulation/SimulationPolicy";
import { ViewConnection } from "./simulation/ViewConnection";
import {
  noopMatchTelemetryEmitter,
  type MatchTelemetryEmitter,
  type MatchTelemetryEvent,
  type MatchTelemetryPayloads,
  type MatchTelemetryType,
  type TelemetryPlayerIdentity,
} from "./telemetry/MatchTelemetry";
import { VoteRound } from "./VoteTally";
export enum GamePhase {
  Lobby = "LOBBY",
  Active = "ACTIVE",
  Finished = "FINISHED",
}

// Identity + authority for an intent, supplied by whoever dispatched it: a
// per-connection websocket client, or the trusted admin-bot HTTP API.
export interface IntentActor {
  clientID: ClientID; // stamped onto the intent
  isLobbyCreator: boolean;
  isAdmin: boolean; // role-based admin/root (also true for the admin bot)
  isAdminBot: boolean; // the trusted admin-bot HTTP API
}

// Outcome of dispatching an intent. `status` is an HTTP-style code: 200 on
// success. The admin-bot route maps a non-200 straight to its response; the
// websocket path logs it and drops the message.
export interface IntentOutcome {
  status: number;
  error?: string;
}

export interface ManagedGameHooks {
  onTurnsCommitted?: (turns: Turn[]) => void;
  onLiveStatsCommitted?: (stats: LiveStats) => void;
}

export function hashPersistentID(persistentID: string): string {
  return createHash("sha256").update(persistentID).digest("hex");
}

const KICK_REASON_DUPLICATE_SESSION = "kick_reason.duplicate_session";
const KICK_REASON_LOBBY_CREATOR = "kick_reason.lobby_creator";
const KICK_REASON_ADMIN = "kick_reason.admin";
const KICK_REASON_HOST_LEFT = "kick_reason.host_left";
const KICK_REASON_MATCH_CANCELLED = "kick_reason.match_cancelled";
const KICK_REASON_TOO_MUCH_DATA = "kick_reason.too_much_data";
const KICK_REASON_INVALID_MESSAGE = "kick_reason.invalid_message";

// Whether the host-only cheat block actually grants anything: mere presence
// isn't enough, the client can send hostCheats with every field off.
function hostCheatsEnabled(hc: GameConfig["hostCheats"]): boolean {
  return (
    hc !== undefined &&
    (hc.infiniteGold === true ||
      hc.infiniteTroops === true ||
      typeof hc.goldMultiplier === "number" ||
      typeof hc.startingGold === "number")
  );
}

export class GameServer {
  private simulation: SimulationHost | undefined;
  private simulationRecoveryProgress: SimulationRecoveryProgress | undefined;
  private simulationBusy = false;
  private simulationFailed = false;
  private simulationDeadline = 0;
  private simulationTimer: ReturnType<typeof setTimeout> | undefined;
  private simulationClockStarted = false;
  private simulationStartFallbackTimer:
    ReturnType<typeof setTimeout> | undefined;
  private viewConnections = new Map<WebSocket, ViewConnection>();
  private viewSeats = new Map<WebSocket, string>();
  private viewGeneration = new Map<WebSocket, number>();
  private viewHistory: {
    tick: number;
    bytes: Uint8Array;
    clientID?: string;
  }[] = [];
  private readonly startupReady: Promise<void>;
  private resolveStartupReady!: () => void;
  private rejectStartupReady!: (error: Error) => void;
  private startupState: "pending" | "ready" | "failed" = "pending";
  private viewHistoryBytes = 0;

  private sendViewError(
    ws: WebSocket,
    error: string,
    id?: string,
    reload = false,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      Buffer.concat([
        Buffer.alloc(4),
        encodeViewPacket({ kind: "error", error, id, reload }),
      ]),
    );
  }

  private async subscribeView(
    ws: WebSocket,
    afterTick?: number,
    viewerClientID?: string,
  ): Promise<void> {
    if (!this.simulation) return;
    if (this.gameConfig.fogOfWar && afterTick !== undefined) {
      this.sendViewError(ws, "Restoring your current view", undefined, true);
      return;
    }
    if (this.gameConfig.fogOfWar && !viewerClientID) {
      this.sendViewError(ws, "An authenticated player seat is required");
      return;
    }
    if (viewerClientID) this.viewSeats.set(ws, viewerClientID);
    if (this.simulationFailed) {
      this.sendViewError(
        ws,
        "This match stopped and needs server recovery. It is not currently running.",
      );
      return;
    }
    // A reconnect gets a new socket; duplicate requests must not enqueue
    // unbounded expensive snapshots for the same authenticated connection.
    if (this.viewGeneration.has(ws)) return;
    this.viewConnections.get(ws)?.stop();
    this.viewConnections.delete(ws);
    const generation = (this.viewGeneration.get(ws) ?? 0) + 1;
    this.viewGeneration.set(ws, generation);
    const connection = new ViewConnection(
      ws,
      () => {
        this.viewConnections.delete(ws);
        ws.close(1013, "View delivery timed out");
      },
      () => this.startInitialManagedSimulation("initial view ready"),
    );
    try {
      let baseTick: number;
      if (afterTick !== undefined) {
        baseTick = afterTick;
        if (
          baseTick > this.turns.length ||
          (baseTick < this.turns.length &&
            (!this.viewHistory.length ||
              baseTick < this.viewHistory[0].tick - 1))
        ) {
          this.sendViewError(ws, "Loading the current map", undefined, true);
          return;
        }
      } else {
        const snapshotStartedAt = performance.now();
        const snapshot = await this.simulation.snapshot(viewerClientID);
        baseTick = snapshot.tick;
        this.log.info("view snapshot prepared", {
          gameID: this.id,
          tick: snapshot.tick,
          packets: snapshot.packets.length,
          bytes: snapshot.packets.reduce(
            (total, packet) => total + packet.byteLength,
            0,
          ),
          maxPacketBytes: Math.max(
            0,
            ...snapshot.packets.map((packet) => packet.byteLength),
          ),
          preparationMs: performance.now() - snapshotStartedAt,
        });
        if (
          this.viewGeneration.get(ws) !== generation ||
          ws.readyState !== WebSocket.OPEN
        )
          return;
        connection.startSnapshot(snapshot.packets);
      }
      if (
        this.viewGeneration.get(ws) !== generation ||
        ws.readyState !== WebSocket.OPEN
      )
        return;
      for (const frame of this.viewHistory)
        if (
          frame.tick > baseTick &&
          (!this.gameConfig.fogOfWar || frame.clientID === viewerClientID)
        )
          connection.enqueue(frame.bytes, frame.tick);
      if (!connection.isClosed) this.viewConnections.set(ws, connection);
    } catch (error) {
      connection.stop();
      this.sendViewError(ws, String(error));
    }
  }

  private publishView(result: TickResult): void {
    const frames = result.views?.flatMap((view) =>
      (view.packets ?? [view.bytes]).map((bytes) => ({
        clientID: view.clientID,
        bytes,
      })),
    ) ?? [{ bytes: result.bytes, clientID: undefined }];
    for (const frame of frames) {
      this.viewHistory.push({ tick: result.tick, ...frame });
      this.viewHistoryBytes += frame.bytes.byteLength;
    }
    while (
      this.viewHistory.length > 256 ||
      this.viewHistoryBytes > 16 * 1024 * 1024
    ) {
      this.viewHistoryBytes -= this.viewHistory.shift()!.bytes.byteLength;
    }
    const scoped =
      result.views &&
      new Map(
        result.views.map((view) => [
          view.clientID,
          view.packets ?? [view.bytes],
        ]),
      );
    for (const [ws, connection] of this.viewConnections) {
      const packets = scoped
        ? scoped.get(this.viewSeats.get(ws) ?? "")
        : [result.bytes];
      if (packets) connection.enqueueBatch(packets, result.tick);
    }
    if (result.stats) {
      this.latestLiveStats = result.stats;
      this.managedHooks?.onLiveStatsCommitted?.(result.stats);
    }
    if (result.win && this.winner === null) {
      this.winner = { ...result.win, type: "winner" };
      this.archiveGame();
    }
    if (result.tick % 100 === 0)
      this.log.info("authoritative simulation", {
        tick: result.tick,
        simulationMs: result.duration,
        coreSimulationMs: result.coreDuration,
        navigationPreparationMs: result.navigationPreparationMs,
        navigation: result.navigationMetrics,
        viewEncodingMs: result.encodingDuration,
        frameBytes: frames.reduce(
          (sum, frame) => sum + frame.bytes.byteLength,
          0,
        ),
        tileDeltas: result.tileDeltaCount,
        motionPlanBytes: result.motionPlanBytes,
        unitUpdates: result.unitUpdateCount,
        views: this.viewConnections.size,
        clockDebtMs: Math.max(0, performance.now() - this.simulationDeadline),
      });
  }

  private scheduleSimulation(): void {
    if (this._hasEnded) return;
    clearTimeout(this.simulationTimer);
    this.simulationTimer = setTimeout(
      () => this.endTurn(),
      Math.max(0, this.simulationDeadline - performance.now()),
    );
  }

  private startSimulationClock(): void {
    if (this.simulationClockStarted || this._hasEnded) return;
    this.simulationClockStarted = true;
    clearTimeout(this.simulationStartFallbackTimer);
    this.simulationStartFallbackTimer = undefined;
    this.simulationDeadline = performance.now() + ServerEnv.turnIntervalMs();
    this.scheduleSimulation();
  }

  /**
   * A new managed world has a frozen roster before anybody opens its map.
   * Hold tick zero until one real viewer has loaded and acknowledged the
   * initial snapshot, so every device receives the full, unchanged 300-turn
   * spawn phase. Recovered worlds already have a journal and never wait.
   */
  private startInitialManagedSimulation(reason: string): void {
    if (
      !this.simulation ||
      !this.managedOptions ||
      this.turns.length !== 0 ||
      this.simulationClockStarted
    )
      return;
    this.log.info("starting managed simulation clock", {
      gameID: this.id,
      reason,
    });
    this.startSimulationClock();
  }
  private sentDesyncMessageClients = new Set<ClientID>();

  private intentRateLimiter = new ClientMsgRateLimiter();

  private maxGameDuration = 3 * 60 * 60 * 1000; // 3 hours

  private disconnectedTimeout = 1 * 30 * 1000; // 30 seconds

  private turns: Turn[] = [];
  private intents: StampedIntent[] = [];
  private readonly initialTurnForClient = new Map<ClientID, number>();
  private pendingManagedTurns: Turn[] = [];
  private managedTurnFlushTimer: ReturnType<typeof setTimeout> | undefined;
  public activeClients: Client[] = [];
  private allClients: Map<ClientID, Client> = new Map();
  // Map persistentID to clientID for reconnection lookup
  private persistentIdToClientId: Map<string, ClientID> = new Map();
  // persistentIDs that have passed authorization (incl. Turnstile) for this
  // game at least once. Survives lobby-phase disconnects, unlike
  // persistentIdToClientId (which is cleared to free up player slots). Lets a
  // reconnecting player skip the single-use Turnstile re-check.
  private admittedPersistentIds: Set<string> = new Set();
  private clientsDisconnectedStatus: Map<ClientID, boolean> = new Map();
  private _hasStarted = false;
  private _startTime: number | null = null;
  private hasReachedMaxPlayerCount: boolean = false;

  private endTurnIntervalID: ReturnType<typeof setInterval> | undefined;

  private lastPingUpdate = 0;

  private winner: ClientSendWinnerMessage | null = null;

  // Note: This can be undefined if accessed before the game starts.
  private gameStartInfo!: GameStartInfo;
  // Wire-only copy of gameStartInfo sent to clients. Identical to
  // gameStartInfo unless disableClanTags is set, in which case clan tags
  // are stripped from players. Archive uses the original gameStartInfo.
  private wireGameStartInfo!: GameStartInfo;

  private log: Logger;

  private _hasPrestarted = false;

  // Purchased bot tribe names drawn for this game, set when the prestart
  // fetch lands (undefined until then / on fetch failure / non-public games).
  private tribes?: Tribe[];

  private kickedPersistentIds: Set<string> = new Set();
  private outOfSyncClients: Set<ClientID> = new Set();

  private isPaused = false;

  private websockets: Set<WebSocket> = new Set();

  private winnerVotes = new VoteRound<ClientSendWinnerMessage>();

  private readonly managedSeatsByIdentityHash = new Map<
    string,
    ManagedReservedSeat
  >();
  private readonly managedSeatsByClientID = new Map<
    ClientID,
    ManagedReservedSeat
  >();

  // Per-turn consensus on the live stats snapshot (see handleLiveStats).
  // Tallies are keyed by turn number; an entry is removed once consensus is
  // reached for that turn (or a later one) so the map stays small.
  private liveStatsVotes: Map<
    number,
    { round: VoteRound<LiveStats>; voters: Set<ClientID> }
  > = new Map();
  private latestLiveStats: LiveStats | null = null;
  private static readonly MAX_PENDING_LIVE_STATS_ROUNDS = 20;

  private _hasEnded = false;

  // Whether this private lobby is visible in the public lobby browser.
  // Deliberately kept out of gameConfig so update_game_config can't set it;
  // only the authenticated /api/game/:id/listing endpoint may (it verifies
  // the creator's subscription).
  private listed = false;
  // When the lobby was listed; drives the auto-start deadline. Cleared on
  // delist, so relisting starts a fresh deadline.
  private listedAt?: number;

  private lobbyInfoIntervalId: ReturnType<typeof setInterval> | null = null;

  private visibleAt?: number;

  // The successor lobby this game has already spawned, if any. Kept so a
  // repeated create_game?previous= call (e.g. a double click) reuses the same
  // id instead of minting another lobby.
  private successorLobbyId: GameID | null = null;

  private telemetrySequence = 0;
  private telemetryTickCounts = new Map<
    number,
    { observed: number; enqueued: number; dropped: number }
  >();
  private replayArchiveAttempted = false;
  private telemetryFinished = false;

  constructor(
    public readonly id: string,
    readonly log_: Logger,
    public readonly createdAt: number,
    public gameConfig: GameConfig,
    private creatorPersistentID?: string,
    private startsAt?: number,
    private publicGameType?: PublicGameType,
    // Matchmade team split from the matchmaking assignment: publicIds per
    // team. At start each client is stamped with its team's index.
    private matchmakingTeams?: string[][],
    private readonly telemetry: MatchTelemetryEmitter = noopMatchTelemetryEmitter,
    private readonly telemetryBuildHash: string = "DEV",
    private readonly managedOptions?: ManagedGameOptions,
    private readonly managedHooks?: ManagedGameHooks,
  ) {
    this.startupReady = new Promise<void>((resolve, reject) => {
      this.resolveStartupReady = resolve;
      this.rejectStartupReady = reject;
    });
    // Managed-game creation observes this promise. The catch also prevents an
    // ordinary malformed lobby from producing an unhandled rejection.
    void this.startupReady.catch(() => undefined);
    this.log = log_.child({ gameID: id });
    this.turns = [...(managedOptions?.initialTurns ?? [])];
    for (const seat of managedOptions?.reservedSeats ?? []) {
      this.managedSeatsByIdentityHash.set(seat.persistentIdHash, seat);
      this.managedSeatsByClientID.set(seat.clientID, seat);
      this.clientsDisconnectedStatus.set(seat.clientID, true);
    }
    if (startsAt !== undefined) {
      this.visibleAt = Date.now();
    }
    this.emitTelemetry("match_opened", {
      lobbyCreatedAt: createdAt,
      config: gameConfig,
      publicGameType,
      buildHash: telemetryBuildHash,
      instanceId: ServerEnv.instanceId(),
      workerId: ServerEnv.workerId(),
      turnIntervalMs: ServerEnv.turnIntervalMs(),
    });
  }

  public whenSimulationReady(): Promise<void> {
    return this.startupReady;
  }

  public simulationStartupState(): "pending" | "ready" | "failed" {
    return this.startupState;
  }

  private markSimulationReady(): void {
    if (this.startupState !== "pending") return;
    this.startupState = "ready";
    this.resolveStartupReady();
  }

  private markSimulationFailed(error: unknown): void {
    if (this.startupState !== "pending") return;
    this.startupState = "failed";
    this.rejectStartupReady(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private emitTelemetry<K extends MatchTelemetryType>(
    type: K,
    payload: MatchTelemetryPayloads[K],
    serverTick: number = this.turns.length,
  ): "enqueued" | "dropped" {
    const event = {
      schemaVersion: 1,
      type,
      matchId: this.id,
      sequence: this.telemetrySequence++,
      observedAt: Date.now(),
      serverTick,
      payload,
    } as MatchTelemetryEvent;
    try {
      return this.telemetry.emit(event);
    } catch {
      return "dropped";
    }
  }

  private identityFor(client: Client): TelemetryPlayerIdentity {
    // persistentID is deliberately excluded from telemetry identity.
    return {
      clientId: client.clientID,
      publicId: client.publicId,
    };
  }

  private emitIntentObserved(
    client: Client,
    intent: unknown,
    intentType: string | null,
    outcome: "accepted" | "rejected",
    serverTick: number,
    reasonCode?: string,
    reasonDetail?: string,
  ): void {
    const counts = this.telemetryTickCounts.get(serverTick) ?? {
      observed: 0,
      enqueued: 0,
      dropped: 0,
    };
    counts.observed++;
    const result = this.emitTelemetry(
      "intent_observed",
      {
        identity: this.identityFor(client),
        intentType,
        outcome,
        reasonCode,
        reasonDetail,
        intent,
      },
      serverTick,
    );
    counts[result === "enqueued" ? "enqueued" : "dropped"]++;
    this.telemetryTickCounts.set(serverTick, counts);
  }

  private emitMatchFinished(): void {
    if (this.telemetryFinished) {
      return;
    }
    this.telemetryFinished = true;
    this.emitTelemetry("match_finished", {
      endedAt: Date.now(),
      totalTurns: this.turns.length,
      buildHash: this.telemetryBuildHash,
      replayArchiveAttempted: this.replayArchiveAttempted,
    });
  }

  private get lobbyCreatorID(): ClientID | undefined {
    return this.creatorPersistentID
      ? this.persistentIdToClientId.get(this.creatorPersistentID)
      : undefined;
  }

  // anonymizeNames: only players the host granted (nameReveals, or by account via
  // nameRevealPublicIds) see real names. Nobody is exempt by default, not even the
  // host, until he grants them.
  private viewerSeesAllNames(viewer: ClientID | undefined): boolean {
    if (viewer === undefined) return false;
    if (this.gameConfig.nameReveals?.includes(viewer) ?? false) return true;
    // Resolve the per-game clientID to its stable account publicId so a host that
    // only knows publicIds (the admin bot) can grant reveal access at create_game.
    const publicId = this.allClients.get(viewer)?.publicId;
    return (
      publicId !== undefined &&
      (this.gameConfig.nameRevealPublicIds?.includes(publicId) ?? false)
    );
  }

  // Same (viewer, target) -> same name in the lobby and in-game.
  //
  // The target's slot is its join-order position in allClients (an
  // insertion-ordered Map): stable for the whole game, and late-joiners simply
  // append, so existing players' names never shift. Distinct targets have
  // distinct slots, and anonWordName maps distinct slots (at a fixed offset) to
  // distinct handles — so within any one viewer's view no two players ever share
  // a name. The per-viewer offset rotates the animal assignment, so different
  // viewers still see different names for the same player (the anti-team point).
  // Display-only: this feeds per-viewer wire payloads (startInfoFor / gameInfo),
  // never the simulation or the archived record, so it cannot desync (see #4426).
  private anonName(viewer: ClientID | undefined, target: ClientID): string {
    let slot = 0;
    const roster = this.managedOptions
      ? this.managedOptions.reservedSeats.map((seat) => seat.clientID)
      : this.allClients.keys();
    for (const id of roster) {
      if (id === target) break;
      slot++;
    }
    return anonWordName(slot, viewer ? simpleHash(viewer) : 0);
  }

  // Whether `viewer` should see `target`'s real identity: when names aren't
  // Teammates in a matchmade game. Anonymizing a player from their own team makes
  // the team unplayable — you cannot coordinate with someone you cannot identify —
  // so a pinned team sees itself, exactly as a player already sees themselves.
  // Only PINNED teams: those are assigned server-side, so the server knows them
  // here. A team game that groups by clanTag/friends is resolved on the clients,
  // and the server has no answer to give.
  private sameMatchmadeTeam(
    viewer: ClientID | undefined,
    target: ClientID,
  ): boolean {
    if (viewer === undefined) return false;
    const viewerTeam = this.teamIndexForClientID(viewer);
    return (
      viewerTeam !== undefined &&
      viewerTeam === this.teamIndexForClientID(target)
    );
  }

  private teamIndexForClientID(clientID: ClientID): number | undefined {
    const reserved = this.managedSeatsByClientID.get(clientID);
    if (reserved !== undefined) return reserved.teamIndex;
    const client = this.allClients.get(clientID);
    if (client === undefined || client.publicId === undefined) return undefined;
    const idx = this.matchmakingTeams?.findIndex((team) =>
      team.includes(client.publicId!),
    );
    return idx === undefined || idx === -1 ? undefined : idx;
  }

  // The reveal reasons that predate teammate visibility: names are not
  // anonymized at all, the viewer is looking at themselves, or the host granted
  // reveal access (nameReveals). Split out because these carry the FULL identity,
  // while a teammate reveal is deliberately narrower — see gameInfo.
  private seesRealBeyondTeam(
    viewer: ClientID | undefined,
    target: ClientID,
  ): boolean {
    return (
      !this.gameConfig.anonymizeNames ||
      target === viewer ||
      this.viewerSeesAllNames(viewer)
    );
  }

  // Whether the viewer should see the target's real identity: names aren't
  // anonymized, when looking at themselves, when on the same pinned team, or when
  // the host granted the viewer reveal access (nameReveals).
  private seesReal(viewer: ClientID | undefined, target: ClientID): boolean {
    return (
      this.seesRealBeyondTeam(viewer, target) ||
      this.sameMatchmadeTeam(viewer, target)
    );
  }

  public updateGameConfig(gameConfig: Partial<GameConfig>): void {
    if (gameConfig.gameMap !== undefined) {
      this.gameConfig.gameMap = gameConfig.gameMap;
    }
    if (gameConfig.gameMapSize !== undefined) {
      this.gameConfig.gameMapSize = gameConfig.gameMapSize;
    }
    if (gameConfig.difficulty !== undefined) {
      this.gameConfig.difficulty = gameConfig.difficulty;
    }
    if (gameConfig.nations !== undefined) {
      this.gameConfig.nations = gameConfig.nations;
    }
    if (gameConfig.bots !== undefined) {
      this.gameConfig.bots = gameConfig.bots;
    }
    if (gameConfig.infiniteGold !== undefined) {
      this.gameConfig.infiniteGold = gameConfig.infiniteGold;
    }
    if (gameConfig.donateGold !== undefined) {
      this.gameConfig.donateGold = gameConfig.donateGold;
    }
    if (gameConfig.infiniteTroops !== undefined) {
      this.gameConfig.infiniteTroops = gameConfig.infiniteTroops;
    }
    if (gameConfig.donateTroops !== undefined) {
      this.gameConfig.donateTroops = gameConfig.donateTroops;
    }
    if (gameConfig.maxTimerValue !== undefined) {
      this.gameConfig.maxTimerValue = gameConfig.maxTimerValue ?? undefined;
    }
    if (gameConfig.startDelay !== undefined) {
      this.gameConfig.startDelay = gameConfig.startDelay ?? undefined;
    }
    if (gameConfig.instantBuild !== undefined) {
      this.gameConfig.instantBuild = gameConfig.instantBuild;
    }
    if (gameConfig.randomSpawn !== undefined) {
      this.gameConfig.randomSpawn = gameConfig.randomSpawn;
    }
    if (gameConfig.spawnImmunityDuration !== undefined) {
      this.gameConfig.spawnImmunityDuration =
        gameConfig.spawnImmunityDuration ?? undefined;
    }
    if (gameConfig.gameMode !== undefined) {
      this.gameConfig.gameMode = gameConfig.gameMode;
    }
    if (gameConfig.disabledUnits !== undefined) {
      this.gameConfig.disabledUnits = gameConfig.disabledUnits;
    }
    if (gameConfig.playerTeams !== undefined) {
      this.gameConfig.playerTeams = gameConfig.playerTeams;
    }
    if (gameConfig.goldMultiplier !== undefined) {
      this.gameConfig.goldMultiplier = gameConfig.goldMultiplier ?? undefined;
    }
    if (gameConfig.startingGold !== undefined) {
      this.gameConfig.startingGold = gameConfig.startingGold ?? undefined;
    }
    if (gameConfig.disableAlliances !== undefined) {
      this.gameConfig.disableAlliances =
        gameConfig.disableAlliances ?? undefined;
    }
    if (gameConfig.customAllianceDuration !== undefined) {
      this.gameConfig.customAllianceDuration =
        gameConfig.customAllianceDuration ?? undefined;
    }
    if (gameConfig.allowedPublicIds !== undefined) {
      this.gameConfig.allowedPublicIds = gameConfig.allowedPublicIds;
      // A join whitelist and public listing are mutually exclusive: a listed
      // lobby must be joinable by anyone who finds it in the lobby browser.
      if (this.listed && this.hasJoinWhitelist()) {
        this.setListed(false);
        this.log.info("delisted lobby: join whitelist enabled");
      }
    }
    if (gameConfig.waterNukes !== undefined) {
      this.gameConfig.waterNukes = gameConfig.waterNukes ?? undefined;
    }
    if (gameConfig.doomsdayClock !== undefined) {
      this.gameConfig.doomsdayClock = gameConfig.doomsdayClock;
    }
    if (gameConfig.anonymizeNames !== undefined) {
      this.gameConfig.anonymizeNames = gameConfig.anonymizeNames;
    }
    if (gameConfig.nameReveals !== undefined) {
      this.gameConfig.nameReveals = gameConfig.nameReveals;
    }
    if (gameConfig.nameRevealPublicIds !== undefined) {
      this.gameConfig.nameRevealPublicIds = gameConfig.nameRevealPublicIds;
    }
    // Unconditional on purpose: the host clears cheats by omitting hostCheats
    // (the full config it sends has hostCheats: undefined when the toggle is
    // off), so `undefined` here means "clear", not "leave unchanged".
    this.gameConfig.hostCheats = gameConfig.hostCheats;
  }

  // Dispatch a control/gameplay intent from either a websocket client or the
  // trusted admin-bot HTTP API. `actor` carries the authority; the per-intent
  // actions and game-state guards live here. Returns an HTTP-style outcome the
  // caller maps (the bot route -> response, the websocket path -> a log).
  public handleIntent(intent: Intent, actor: IntentActor): IntentOutcome {
    const serverTick = this.turns.length;
    const stamped: StampedIntent = { ...intent, clientID: actor.clientID };
    const finish = (
      outcome: IntentOutcome,
      acceptedReasonCode?: string,
    ): IntentOutcome => {
      if (!actor.isAdminBot) {
        const client = this.allClients.get(actor.clientID);
        if (client !== undefined) {
          const accepted = outcome.status === 200;
          this.emitIntentObserved(
            client,
            stamped,
            stamped.type,
            accepted ? "accepted" : "rejected",
            serverTick,
            accepted ? acceptedReasonCode : String(outcome.status),
            accepted ? undefined : outcome.error,
          );
        }
      }
      return outcome;
    };

    // The admin bot only manages private games.
    if (actor.isAdminBot && this.isPublic()) {
      return finish({
        status: 403,
        error: "admin bot cannot act on public games",
      });
    }

    switch (stamped.type) {
      case "mark_disconnected":
        return finish({
          status: 400,
          error: "mark_disconnected is server-internal",
        });

      case "kick_player": {
        if (!actor.isLobbyCreator && !actor.isAdmin) {
          return finish({
            status: 403,
            error: "only the lobby creator or an admin can kick players",
          });
        }
        // A listed lobby recruits strangers from the public browser; letting
        // the host kick them is a griefing vector. Admins keep the power for
        // moderation. The listed flag survives game start on purpose, so a
        // publicly recruited game stays kick-free like a real public game.
        if (this.isListed() && !actor.isAdmin) {
          return finish({
            status: 403,
            error: "the host cannot kick players in a publicly listed lobby",
          });
        }
        // Resolve the target to a clientID: an explicit clientID, or an account
        // publicId matched against allClients (a superset of activeClients that
        // retains disconnected players), so a disconnected account can still be
        // kicked — its persistentID is banned, blocking rejoin/reconnect.
        let target = stamped.targetClientID;
        if (target === undefined && stamped.targetPublicID !== undefined) {
          target = [...this.allClients.values()].find(
            (c) => c.publicId === stamped.targetPublicID,
          )?.clientID;
        }
        if (target === undefined) {
          return finish({ status: 404, error: "no matching player to kick" });
        }
        if (stamped.clientID === target) {
          return finish({ status: 400, error: "cannot kick yourself" });
        }
        const reason =
          actor.isAdmin && !actor.isLobbyCreator
            ? KICK_REASON_ADMIN
            : KICK_REASON_LOBBY_CREATOR;
        this.log.info("player kicked", {
          kicker: stamped.clientID,
          target,
          isAdmin: actor.isAdmin,
          isAdminBot: actor.isAdminBot,
          gameID: this.id,
        });
        this.kickClient(target, reason);
        return finish({ status: 200 });
      }

      case "update_game_config": {
        if (!actor.isLobbyCreator && !actor.isAdminBot) {
          return finish({
            status: 403,
            error: "only the lobby creator can update game config",
          });
        }
        if (this.isPublic()) {
          return finish({ status: 403, error: "cannot update a public game" });
        }
        if (this.hasStarted()) {
          return finish({ status: 409, error: "game already started" });
        }
        if (stamped.config.gameType === GameType.Public) {
          return finish({
            status: 400,
            error: "cannot change a game to public",
          });
        }
        // Host cheats give the host an asymmetric advantage over players
        // recruited from the lobby browser. Listing is likewise rejected
        // while cheats are on (Worker's listing endpoint), so a listed
        // lobby can never have them.
        if (this.isListed() && hostCheatsEnabled(stamped.config.hostCheats)) {
          return finish({
            status: 409,
            error: "cannot enable host cheats in a publicly listed lobby",
          });
        }
        this.updateGameConfig(stamped.config);
        return finish({ status: 200 });
      }

      case "toggle_game_start_timer": {
        if (!actor.isLobbyCreator && !actor.isAdminBot) {
          return finish({
            status: 403,
            error: "only the lobby creator can start",
          });
        }
        if (this.isPublic()) {
          return finish({ status: 403, error: "cannot start a public game" });
        }
        if (this.hasStarted()) {
          return finish({ status: 409, error: "game already started" });
        }
        if (this.startsAt) {
          this.startsAt = undefined;
        } else {
          this.setStartsAt(
            Date.now() + (this.gameConfig.startDelay ?? 0) * 1000,
          );
        }
        return finish({ status: 200 });
      }

      case "toggle_pause": {
        if (!actor.isLobbyCreator && !actor.isAdminBot) {
          return finish({
            status: 403,
            error: "only the lobby creator can pause",
          });
        }
        if (this.isListed() && !actor.isAdminBot) {
          return finish({
            status: 403,
            error: "the host cannot pause a publicly listed game",
          });
        }
        // Pausing only makes sense once the game is running.
        if (!this.hasStarted()) {
          return finish({ status: 409, error: "game not started" });
        }
        const outcome = finish({ status: 200 });
        // Pausing: flush the intent into a turn before isPaused short-circuits
        // endTurn(). Unpausing: clear the flag first so the next turn runs.
        if (stamped.paused) {
          this.addIntent(stamped);
          this.endTurn();
          this.isPaused = true;
        } else {
          this.isPaused = false;
          this.addIntent(stamped);
          this.endTurn();
        }
        return outcome;
      }

      default: {
        // Gameplay intents: websocket players only, into the turn queue.
        if (actor.isAdminBot) {
          return finish({
            status: 400,
            error: "intent not permitted for admin bot",
          });
        }
        // While paused the intent is accepted at ingress but not queued into a
        // turn; tag it so telemetry can tell it apart from a queued intent.
        const paused = this.isPaused;
        const outcome = finish({ status: 200 }, paused ? "paused" : undefined);
        if (!paused) this.addIntent(stamped);
        return outcome;
      }
    }
  }

  private isKicked(clientID: ClientID): boolean {
    const persistentID = this.allClients.get(clientID)?.persistentID;
    return (
      persistentID !== undefined && this.kickedPersistentIds.has(persistentID)
    );
  }

  // Get existing clientID for this persistentID, or null if new player
  public getClientIdForPersistentId(persistentID: string): ClientID | null {
    const clientID = this.persistentIdToClientId.get(persistentID);
    if (!clientID) return null;
    if (this.kickedPersistentIds.has(persistentID)) return null;
    return clientID;
  }

  /**
   * Returns the frozen seat assigned to an authenticated identity. `undefined`
   * means this is an ordinary match; `null` means a managed match has no seat
   * for that identity. Workers call this before constructing Client so a late
   * arrival receives the same client ID already present in GameStartInfo.
   */
  public managedClientIDForPersistentId(
    persistentID: string,
  ): ClientID | null | undefined {
    if (!this.managedOptions) return undefined;
    return (
      this.managedSeatsByIdentityHash.get(hashPersistentID(persistentID))
        ?.clientID ?? null
    );
  }

  public managedRequestId(): string | undefined {
    return this.managedOptions?.requestId;
  }

  /**
   * Closes an ordinary lobby before a deployment drain. A game that has
   * prestarted is already an in-progress match and must be allowed to finish;
   * managed games are journaled and are recovered by the master after restart.
   */
  public cancelForDeploymentDrain(): boolean {
    if (this.managedOptions || this.hasStarted() || this._hasEnded)
      return false;
    this.log.info("closing unstarted lobby for deployment drain", {
      gameID: this.id,
    });
    this._hasEnded = true;
    for (const client of [...this.activeClients]) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close(1012, "Server deployment pending");
      }
    }
    return true;
  }

  public managedSeatForPersistentId(
    persistentID: string,
  ): ManagedReservedSeat | null | undefined {
    if (!this.managedOptions) return undefined;
    return (
      this.managedSeatsByIdentityHash.get(hashPersistentID(persistentID)) ??
      null
    );
  }

  // Whether this persistentID has already been admitted (passed Turnstile and
  // other join authorization) for this game. Used to skip the single-use
  // Turnstile re-check when an already-admitted player reconnects. Kicked
  // players are excluded so a kick still forces them back through the gate.
  public wasAdmitted(persistentID: string): boolean {
    if (this.kickedPersistentIds.has(persistentID)) return false;
    return this.admittedPersistentIds.has(persistentID);
  }

  // Screened identity stored for this player's client record, or null if
  // the record (or its reconnect mapping) is gone. Lets the join path skip
  // re-screening a reconnect whose submitted identity is unchanged.
  public storedIdentity(
    persistentID: string,
  ): { username: string; clanTag: string | null } | null {
    const clientID = this.getClientIdForPersistentId(persistentID);
    if (clientID === null) return null;
    const client = this.allClients.get(clientID);
    if (client === undefined) return null;
    return { username: client.username, clanTag: client.clanTag };
  }

  public joinClient(
    client: Client,
    lastTurn: number = 0,
  ): "joined" | "kicked" | "rejected" | "not_allowlisted" {
    // e.g. the host left an unstarted lobby and GameManager hasn't pruned
    // it yet.
    if (this._hasEnded) {
      return "rejected";
    }
    if (this.kickedPersistentIds.has(client.persistentID)) {
      return "kicked";
    }
    const existingId = this.getClientIdForPersistentId(client.persistentID);
    const existing = existingId ? this.allClients.get(existingId) : undefined;
    if (existing && this.rejectDuplicateController(existing, client.ws))
      return "rejected";

    const managedClientID = this.managedClientIDForPersistentId(
      client.persistentID,
    );
    if (
      managedClientID !== undefined &&
      (managedClientID === null || managedClientID !== client.clientID)
    ) {
      this.log.warn("client does not own a reserved managed-game seat", {
        clientID: client.clientID,
      });
      return "rejected";
    }
    if (managedClientID !== undefined) {
      const seat = this.managedSeatsByClientID.get(managedClientID)!;
      if (client.username !== seat.username && client.cosmetics?.verified) {
        delete client.cosmetics.verified;
      }
      client.username = seat.username;
      client.clanTag = seat.clanTag;
    }

    // OFM: if an allowlist is set, only those publicIds may join. Re-checked on
    // every join attempt. Admins/root bypass it so moderation can reach any
    // private lobby; a kick still applies (checked above).
    const allowedPublicIds = this.gameConfig.allowedPublicIds;
    if (
      allowedPublicIds !== undefined &&
      allowedPublicIds.length > 0 &&
      !isAdminRole(client.role) &&
      (client.publicId === undefined ||
        !allowedPublicIds.includes(client.publicId))
    ) {
      this.log.warn("client not on allowlist, rejecting", {
        clientID: client.clientID,
      });
      return "not_allowlisted";
    }

    if (
      this.gameConfig.maxPlayers &&
      this.activeClients.length >= this.gameConfig.maxPlayers
    ) {
      this.log.warn(`cannot add client, game full`, {
        clientID: client.clientID,
      });

      client.ws.send(
        JSON.stringify({
          type: "error",
          error: "full-lobby",
        } satisfies ServerErrorMessage),
      );
      return "rejected";
    }

    this.log.info("client joining game", {
      clientID: client.clientID,
      persistentID: client.persistentID,
      clientIP: ipAnonymize(client.ip),
    });

    // Skipped in dev: local testing (multi-tab, the matchmaking e2e) is
    // inherently same-IP.
    if (
      ServerEnv.env() !== GameEnv.Dev &&
      !this.managedOptions &&
      this.gameConfig.gameType === GameType.Public &&
      this.activeClients.filter(
        (c) => c.ip === client.ip && c.clientID !== client.clientID,
      ).length >= 3
    ) {
      this.log.warn("cannot add client, already have 3 ips", {
        clientID: client.clientID,
        clientIP: ipAnonymize(client.ip),
      });
      return "rejected";
    }

    if (ServerEnv.env() === GameEnv.Prod) {
      // Prevent multiple clients from using the same account in prod
      const conflicting = this.activeClients.find(
        (c) =>
          c.persistentID === client.persistentID &&
          c.clientID !== client.clientID,
      );
      if (conflicting !== undefined) {
        this.log.warn("client ids do not match", {
          clientID: client.clientID,
          clientIP: ipAnonymize(client.ip),
          clientPersistentID: client.persistentID,
          existingIP: ipAnonymize(conflicting.ip),
          existingPersistentID: conflicting.persistentID,
        });
        // Kick the existing client instead of the new one, because this was causing issues when
        // a client wanted to replay the game afterwards.
        this.kickClient(conflicting.clientID, KICK_REASON_DUPLICATE_SESSION);
      }
    }

    // Client connection accepted
    this.websockets.add(client.ws);
    this.persistentIdToClientId.set(client.persistentID, client.clientID);
    this.admittedPersistentIds.add(client.persistentID);
    this.activeClients.push(client);
    this.initialTurnForClient.set(client.clientID, lastTurn);
    client.lastPing = Date.now();
    this.markClientDisconnected(client.clientID, false);
    this.allClients.set(client.clientID, client);
    this.emitTelemetry("player_joined", {
      identity: this.identityFor(client),
      joinedAt: Date.now(),
      username: client.username,
      playerType: "human",
      teamIndex: this.matchmakingTeamIndex(client),
    });
    this.addListeners(client);
    this.startLobbyInfoBroadcast();

    if (this.activeClients.length >= (this.gameConfig.maxPlayers ?? Infinity)) {
      this.hasReachedMaxPlayerCount = true;
    }

    // In case a client joined the game late and missed the start message.
    if (this._hasStarted) {
      this.sendSimulationRecoveryProgress(client.ws);
      this.sendStartGameMsg(client.ws, lastTurn);
    }

    return "joined";
  }

  // Attempt to reconnect a client by persistentID. Returns true if successful.
  // WebSocket is always updated. Identity updates — already screened by the
  // caller (join_verify, or the local fallback censor) — are applied only
  // before the game has started.
  public rejoinClient(
    ws: WebSocket,
    persistentID: string,
    lastTurn: number = 0,
    identityUpdate?: { username: string; clanTag: string | null },
  ): boolean {
    const clientID = this.getClientIdForPersistentId(persistentID);
    if (!clientID) return false;
    const client = this.allClients.get(clientID);
    if (!client) return false;

    if (this.rejectDuplicateController(client, ws)) return true;

    this.websockets.add(ws);
    this.log.info("client rejoining", { clientID, lastTurn });

    // Close old WebSocket to prevent resource leaks
    if (client.ws !== ws) {
      this.viewConnections.get(client.ws)?.stop();
      this.viewConnections.delete(client.ws);
      this.viewGeneration.delete(client.ws);
      this.viewSeats.delete(client.ws);
      this.websockets.delete(client.ws);
      client.ws.removeAllListeners();
      client.ws.close();
    }

    this.activeClients = this.activeClients.filter(
      (c) => c.clientID !== client.clientID,
    );
    this.activeClients.push(client);
    this.initialTurnForClient.set(client.clientID, lastTurn);
    if (identityUpdate && !this.hasStarted() && !this.managedOptions) {
      // The verified badge vouches for the exact join name — a pre-start
      // identity change under it must drop the badge (the rejoin path skips
      // the Worker's join-time badge validation).
      if (
        identityUpdate.username !== client.username &&
        client.cosmetics?.verified
      ) {
        delete client.cosmetics.verified;
      }
      client.username = identityUpdate.username;
      client.clanTag = identityUpdate.clanTag;
    }
    client.lastPing = Date.now();
    this.markClientDisconnected(client.clientID, false);

    client.ws = ws;
    this.addListeners(client);
    this.startLobbyInfoBroadcast();

    if (this._hasStarted) {
      this.sendSimulationRecoveryProgress(client.ws);
      this.sendStartGameMsg(client.ws, lastTurn);
    }
    return true;
  }

  private rejectDuplicateController(client: Client, ws: WebSocket): boolean {
    if (
      !this.managedOptions ||
      client.ws === ws ||
      client.ws.readyState !== WebSocket.OPEN ||
      Date.now() - client.lastPing >= 30_000
    )
      return false;
    ws.send(
      JSON.stringify({
        type: "error",
        error:
          "Someone with that username is currently playing. Disconnect on your other device, then try again.",
      } satisfies ServerErrorMessage),
    );
    ws.close(4009, "Username is playing on another device");
    return true;
  }

  private addListeners(client: Client) {
    client.ws.removeAllListeners("message");
    client.ws.on("message", async (message: string) => {
      try {
        let json: unknown;
        try {
          json = JSON.parse(message);
        } catch (e) {
          this.log.warn(`Failed to parse client message JSON, kicking`, {
            clientID: client.clientID,
            error: String(e),
          });
          this.kickClient(client.clientID, KICK_REASON_INVALID_MESSAGE);
          return;
        }
        const viewMessage = ClientViewMessageSchema.safeParse(json);
        if (viewMessage.success && this.simulation) {
          const message = viewMessage.data;
          // View acknowledgements and queries prove the connection is alive as
          // surely as a timer ping. During a large reconnect snapshot the main
          // thread is intentionally busy applying bounded chunks, and browser
          // timers may be throttled; never evict an actively-acking viewer.
          this.lastPingUpdate = Date.now();
          client.lastPing = Date.now();
          if (message.type === "view_ack") {
            this.viewConnections.get(client.ws)?.acknowledge(message.sequence);
          } else if (message.type === "view_subscribe") {
            await this.subscribeView(
              client.ws,
              message.afterTick,
              client.clientID,
            );
          } else {
            // Bound expensive queries separately from gameplay intent budgets.
            const now = Date.now();
            const budget = this.viewQueryBudgets.get(client.clientID);
            if (budget && now - budget.at < 1000 && budget.count >= 30) {
              this.sendViewError(
                client.ws,
                "Too many action queries",
                message.query.id,
              );
              return;
            }
            this.viewQueryBudgets.set(
              client.clientID,
              budget && now - budget.at < 1000
                ? { at: budget.at, count: budget.count + 1 }
                : { at: now, count: 1 },
            );
            try {
              const result = await this.simulation.query(
                message.query,
                client.clientID,
              );
              if (client.ws.readyState === WebSocket.OPEN)
                client.ws.send(Buffer.concat([Buffer.alloc(4), result.bytes]));
            } catch (error) {
              this.sendViewError(client.ws, String(error), message.query.id);
            }
          }
          return;
        }
        const parsed = ClientMessageSchema.safeParse(json);
        if (!parsed.success) {
          const reasonDetail = z.prettifyError(parsed.error);
          if (
            typeof json === "object" &&
            json !== null &&
            "type" in json &&
            json.type === "intent" &&
            "intent" in json
          ) {
            const rawIntent = json.intent;
            const intentType =
              typeof rawIntent === "object" &&
              rawIntent !== null &&
              "type" in rawIntent &&
              typeof rawIntent.type === "string"
                ? rawIntent.type
                : null;
            this.emitIntentObserved(
              client,
              rawIntent,
              intentType,
              "rejected",
              this.turns.length,
              KICK_REASON_INVALID_MESSAGE,
              reasonDetail,
            );
          }
          this.log.warn(`Failed to parse client message, kicking`, {
            clientID: client.clientID,
            error: reasonDetail,
          });
          this.kickClient(client.clientID, KICK_REASON_INVALID_MESSAGE);
          return;
        }
        const clientMsg = parsed.data;
        const bytes = Buffer.byteLength(message, "utf8");
        const rateResult = this.intentRateLimiter.check(
          client.clientID,
          clientMsg.type,
          bytes,
        );
        if (rateResult === "kick") {
          if (clientMsg.type === "intent") {
            this.emitIntentObserved(
              client,
              { ...clientMsg.intent, clientID: client.clientID },
              clientMsg.intent.type,
              "rejected",
              this.turns.length,
              KICK_REASON_TOO_MUCH_DATA,
            );
          }
          this.log.warn(`Client rate limit exceeded, kicking`, {
            clientID: client.clientID,
            type: clientMsg.type,
          });
          this.kickClient(client.clientID, KICK_REASON_TOO_MUCH_DATA);
          return;
        }
        if (rateResult === "limit") {
          if (clientMsg.type === "intent") {
            this.emitIntentObserved(
              client,
              { ...clientMsg.intent, clientID: client.clientID },
              clientMsg.intent.type,
              "rejected",
              this.turns.length,
              "limit",
            );
          }
          this.log.warn(`Client message rate limit exceeded, dropping`, {
            clientID: client.clientID,
            type: clientMsg.type,
          });
          return;
        }
        switch (clientMsg.type) {
          case "rejoin": {
            // Client is already connected, no auth required, send start game message if game has started
            if (this._hasStarted) {
              this.sendStartGameMsg(client.ws, clientMsg.lastTurn);
            }
            break;
          }
          case "intent": {
            // Server stamps clientID from the authenticated connection.
            const outcome = this.handleIntent(clientMsg.intent, {
              clientID: client.clientID,
              isLobbyCreator: client.clientID === this.lobbyCreatorID,
              isAdmin: isAdminRole(client.role),
              isAdminBot: false,
            });
            if (outcome.status !== 200) {
              this.log.warn(`intent rejected`, {
                type: clientMsg.intent.type,
                clientID: client.clientID,
                gameID: this.id,
                reason: outcome.error,
              });
            }
            break;
          }
          case "ping": {
            this.lastPingUpdate = Date.now();
            client.lastPing = Date.now();
            // Keep the transport alive during a snapshot or server recovery;
            // this is connection health, not evidence the simulation advanced.
            if (this.simulation && client.ws.readyState === WebSocket.OPEN)
              client.ws.send(JSON.stringify({ type: "ping" }));
            break;
          }
          case "hash": {
            if (this.simulation) break;
            client.hashes.set(clientMsg.turnNumber, clientMsg.hash);
            break;
          }
          case "winner": {
            if (this.simulation) break;
            this.handleWinner(client, clientMsg);
            break;
          }
          case "live_stats": {
            if (this.simulation) break;
            this.handleLiveStats(client, clientMsg);
            break;
          }
          default: {
            this.log.warn(`Unknown message type: ${(clientMsg as any).type}`, {
              clientID: client.clientID,
            });
            break;
          }
        }
      } catch (error) {
        this.log.info(
          `error handling websocket request in game server: ${error}`,
          {
            clientID: client.clientID,
          },
        );
      }
    });
    client.ws.on("close", () => {
      this.viewConnections.get(client.ws)?.stop();
      this.viewConnections.delete(client.ws);
      this.viewGeneration.delete(client.ws);
      this.viewSeats.delete(client.ws);
      if (this.gameConfig.fogOfWar)
        void this.simulation?.forgetViewer(client.clientID).catch(() => {});
      this.log.info("client disconnected", {
        clientID: client.clientID,
        persistentID: client.persistentID,
      });
      this.handleClientDisconnect(client);
    });
    client.ws.on("error", (error: Error) => {
      if ((error as any).code === "WS_ERR_UNEXPECTED_RSV_1") {
        client.ws.close(1002, "WS_ERR_UNEXPECTED_RSV_1");
      }
    });

    // Check if WebSocket already closed before we added the listener (race
    // condition) — the 'close' event has already fired, so the handler above
    // will never run for this client.
    if (client.ws.readyState >= 2) {
      this.log.info("client WebSocket already closing/closed, removing", {
        clientID: client.clientID,
        readyState: client.ws.readyState,
      });
      this.handleClientDisconnect(client);
    }
  }

  private handleClientDisconnect(client: Client) {
    this.activeClients = this.activeClients.filter(
      (c) => c.clientID !== client.clientID,
    );

    // hasStarted() includes prestart: during the lobby -> game transition
    // clients reconnect, and a host socket closing then must not tear the
    // starting game down.
    if (this.hasStarted()) {
      return;
    }
    // Remove persistentId if the game has not started to prevent going over max players
    this.persistentIdToClientId.delete(client.persistentID);
    // Close lobby when host leaves before game starts: without a host it can
    // never start, and a listed one would haunt the lobby browser and hold
    // the creator's one-listing quota. phase() reports Finished once ended,
    // so GameManager's next tick prunes it.
    if (!this.isPublic() && client.persistentID === this.creatorPersistentID) {
      this.log.info("Host left, closing lobby", {
        gameID: this.id,
      });
      for (const c of [...this.activeClients]) {
        this.kickClient(c.clientID, KICK_REASON_HOST_LEFT);
      }
      this._hasEnded = true;
    }
  }

  public setStartsAt(startsAt: number) {
    this.startsAt = startsAt;
    // Record when the lobby first became visible to players, used to measure lobby fill time.
    this.visibleAt ??= Date.now();
  }

  public numClients(): number {
    return this.activeClients.length;
  }

  public numDesyncedClients(): number {
    return this.outOfSyncClients.size;
  }

  // Matchmade ranked games (1v1/2v2) must start with full attendance: the
  // roster freezes at start(), so a game missing a player would run
  // short-handed only to be voided by the sim (2v2) or hand out a walkover
  // the absent player never contested (1v1). Called at the start deadline;
  // cancels the game and returns true when a matched player never connected.
  public cancelShortHandedMatch(): boolean {
    // Explicitly 1v1/2v2 only — a future ranked type must opt in rather
    // than inherit pre-start cancellation.
    const rankedType = this.gameConfig.rankedType;
    if (
      rankedType !== RankedType.OneVOne &&
      rankedType !== RankedType.TwoVTwo
    ) {
      return false;
    }
    const expected = this.gameConfig.maxPlayers;
    if (expected === undefined || this.activeClients.length >= expected) {
      return false;
    }
    this.log.info("cancelling matchmade game, missing players at deadline", {
      gameID: this.id,
      connected: this.activeClients.length,
      expected,
    });
    for (const c of [...this.activeClients]) {
      this.kickClient(c.clientID, KICK_REASON_MATCH_CANCELLED);
    }
    // phase() reports Finished once ended, so GameManager's next tick prunes.
    this._hasEnded = true;
    return true;
  }

  public prestart() {
    if (this.hasStarted()) {
      return;
    }
    this._hasPrestarted = true;
    this.fetchTribes();

    const prestartMsg = ServerPrestartMessageSchema.safeParse({
      type: "prestart",
      gameMap: this.gameConfig.gameMap,
      gameMapSize: this.gameConfig.gameMapSize,
    });

    if (!prestartMsg.success) {
      console.error(
        `error creating prestart message for game ${this.id}, ${prestartMsg.error}`.substring(
          0,
          250,
        ),
      );
      return;
    }

    const msg = JSON.stringify(prestartMsg.data);
    this.activeClients.forEach((c) => {
      this.log.info("sending prestart message", {
        clientID: c.clientID,
        persistentID: c.persistentID,
      });
      if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(msg);
      }
    });
  }

  // Public games draw purchased bot tribe names from the API at prestart —
  // its 1.5s timeout fits the 2s prestart->start gap, so the pool is
  // normally in hand when start() builds the game start info. Best effort:
  // on timeout/error the game starts with organic bot names.
  private fetchTribes(): void {
    if (!this.isPublic() || this.gameConfig.bots === 0) {
      return;
    }
    // Logged-in humans only — guests can't own tribe names.
    const players = this.activeClients.flatMap((c) =>
      c.publicId !== undefined
        ? [{ clientId: c.clientID, publicId: c.publicId }]
        : [],
    );
    fetchCustomTribes(players)
      .then((tribes) => {
        // One tribe per bot: with fewer bots than tribes, drop from the
        // tail (the global-pool slice).
        const used = tribes.slice(0, this.gameConfig.bots);
        if (used.length > 0) {
          this.tribes = used;
        }
      })
      .catch((error) => {
        this.log.warn(`failed to fetch custom tribes: ${error}`);
      });
  }

  private startLobbyInfoBroadcast() {
    if (this._hasStarted || this._hasEnded) {
      return;
    }
    if (this.lobbyInfoIntervalId !== null) {
      return;
    }
    this.broadcastLobbyInfo();
    this.lobbyInfoIntervalId = setInterval(() => {
      if (
        this._hasStarted ||
        this._hasEnded ||
        this.activeClients.length === 0
      ) {
        this.stopLobbyInfoBroadcast();
        return;
      }
      this.broadcastLobbyInfo();
    }, 1000);
  }

  private stopLobbyInfoBroadcast() {
    if (this.lobbyInfoIntervalId === null) {
      return;
    }
    clearInterval(this.lobbyInfoIntervalId);
    this.lobbyInfoIntervalId = null;
  }

  private broadcastLobbyInfo() {
    // Off: same payload for everyone (build once). On: per-recipient.
    const shared = this.gameConfig.anonymizeNames ? null : this.gameInfo();
    this.activeClients.forEach((c) => {
      if (c.ws.readyState === WebSocket.OPEN) {
        const msg = JSON.stringify({
          type: "lobby_info",
          lobby: shared ?? this.gameInfo(c.clientID),
          myClientID: c.clientID,
        } satisfies ServerLobbyInfoMessage);
        c.ws.send(msg);
      }
    });
  }

  // The worker created a successor lobby for this game (the host asked to
  // reuse the private lobby via create_game?previous=). Remember it so repeat
  // requests reuse the same lobby, and tell everyone still connected its id so
  // they can hop over without re-sharing a link.
  public setSuccessorLobby(gameID: GameID) {
    this.successorLobbyId = gameID;
    this.log.info("successor lobby created", {
      gameID: this.id,
      successorID: gameID,
    });
    this.broadcastNewLobby(gameID);
  }

  public successorLobby(): GameID | null {
    return this.successorLobbyId;
  }

  private broadcastNewLobby(gameID: GameID) {
    const msg = JSON.stringify({
      type: "new_lobby",
      gameID,
    } satisfies ServerNewLobbyMessage);
    this.activeClients.forEach((c) => {
      if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(msg);
      }
    });
  }

  public start() {
    if (this._hasStarted || this._hasEnded) {
      return;
    }
    this._hasStarted = true;
    this._startTime = Date.now();
    // Set last ping to start so we don't immediately stop the game
    // if no client connects/pings.
    this.lastPingUpdate = Date.now();

    const friendsFor = this.buildFriendsLookup();
    const players = this.managedOptions
      ? this.managedOptions.reservedSeats.map((seat) => {
          const client = this.allClients.get(seat.clientID);
          return {
            username: seat.username,
            clanTag: seat.clanTag,
            clientID: seat.clientID,
            cosmetics: client?.cosmetics,
            friends: client ? friendsFor(client) : undefined,
            teamIndex: seat.teamIndex,
          };
        })
      : this.activeClients.map((client) => ({
          username: client.username,
          clanTag: client.clanTag ?? null,
          clientID: client.clientID,
          cosmetics: client.cosmetics,
          isLobbyCreator: this.lobbyCreatorID === client.clientID,
          friends: friendsFor(client),
          teamIndex: this.matchmakingTeamIndex(client),
        }));

    // allowedPublicIds / nameRevealPublicIds hold account publicIds and are
    // enforced server-side against this.gameConfig (joinClient / seesReal).
    // Keep them out of gameStartInfo: its config goes to every client in the
    // start message and into the publicly downloadable game record.
    const config = { ...this.gameConfig };
    delete config.allowedPublicIds;
    delete config.nameRevealPublicIds;

    const result = GameStartInfoSchema.safeParse({
      gameID: this.id,
      lobbyCreatedAt: this.createdAt,
      visibleAt: this.visibleAt,
      config,
      players,
      tribes: this.tribes,
    });
    if (!result.success) {
      const error = z.prettifyError(result.error);
      this.log.error("Error parsing game start info", { message: error });
      this.markSimulationFailed(new Error(error));
      return;
    }
    this.gameStartInfo = result.data satisfies GameStartInfo;
    this.emitTelemetry("match_started", {
      startedAt: this._startTime,
      gameStartInfo: this.gameStartInfo,
      buildHash: this.telemetryBuildHash,
      turnIntervalMs: ServerEnv.turnIntervalMs(),
    });
    const wireGameStartInfo = {
      ...this.gameStartInfo,
      listed: this.listed,
    };
    this.wireGameStartInfo = this.gameConfig.disableClanTags
      ? {
          ...wireGameStartInfo,
          players: this.gameStartInfo.players.map((p) => ({
            ...p,
            clanTag: null,
          })),
        }
      : wireGameStartInfo;

    // The frozen roster exists before every player connects. Stamp its
    // current online state into the first authoritative turn so offline seats
    // do not masquerade as live connections, and a later claimant can flip
    // the same player back online without changing the roster.
    const connectedClientIDs = new Set(
      this.activeClients.map((client) => client.clientID),
    );
    for (const seat of this.managedOptions?.reservedSeats ?? []) {
      this.markClientDisconnected(
        seat.clientID,
        !connectedClientIDs.has(seat.clientID),
      );
    }

    if (usesServerSimulation(this.wireGameStartInfo)) {
      this.gameStartInfo.simulationMode = "server-v1";
      this.wireGameStartInfo.simulationMode = "server-v1";
      this.simulation = new SimulationHost(
        simulationStartInfo(this.wireGameStartInfo),
        this.turns,
        undefined,
        (progress) => this.broadcastSimulationRecoveryProgress(progress),
      );
      void this.simulation.ready
        .then(() => {
          this.broadcastSimulationRecoveryReady();
          this.markSimulationReady();
          if (this.managedOptions && this.turns.length === 0) {
            // Offline invitations must still begin eventually. A connected
            // viewer normally releases this as soon as its snapshot is ready.
            this.simulationStartFallbackTimer = setTimeout(
              () =>
                this.startInitialManagedSimulation("viewer readiness timeout"),
              60_000,
            );
            this.simulationStartFallbackTimer.unref?.();
          } else {
            this.startSimulationClock();
          }
        })
        .catch((error) => {
          this.markSimulationFailed(error);
          this.log.error("Simulation startup failed", {
            error: String(error),
            gameID: this.id,
          });
          for (const c of this.activeClients)
            this.sendViewError(
              c.ws,
              "The server could not prepare this map. Please try another match.",
            );
        });
    } else {
      this.endTurnIntervalID = setInterval(
        () => this.endTurn(),
        ServerEnv.turnIntervalMs(),
      );
      this.markSimulationReady();
    }
    this.activeClients.forEach((c) => {
      this.log.info("sending start message", {
        clientID: c.clientID,
        persistentID: c.persistentID,
      });
      this.sendStartGameMsg(
        c.ws,
        this.initialTurnForClient.get(c.clientID) ?? 0,
      );
    });
  }

  // Resolves a client to its matchmade team slot (index into
  // matchmakingTeams), or undefined when the game isn't matchmade / the
  // client isn't in the assignment.
  private matchmakingTeamIndex(c: Client): number | undefined {
    const managedTeamIndex = this.managedSeatsByClientID.get(
      c.clientID,
    )?.teamIndex;
    if (managedTeamIndex !== undefined) return managedTeamIndex;
    const publicId = c.publicId;
    if (this.matchmakingTeams === undefined || publicId === undefined) {
      return undefined;
    }
    const idx = this.matchmakingTeams.findIndex((team) =>
      team.includes(publicId),
    );
    return idx === -1 ? undefined : idx;
  }

  private addIntent(intent: StampedIntent) {
    this.intents.push(intent);
  }

  // Per-viewer start info. The real gameStartInfo is untouched, so the
  // archived record keeps real identities. clanTag and friends feed the
  // deterministic team assignment (TeamAssignment.ts), so they are blanked
  // for every player here, identical on every client, never per-viewer, or
  // clients desync. Only the username of players this viewer can't see is
  // anonymized, and their cosmetics hidden, neither of which the simulation
  // reads.
  //
  // Exception: admins in FFA get the real clan tags (the display pipeline then
  // shows them everywhere) so they can spot teaming live. Safe ONLY in FFA —
  // that mode never runs assignTeams, so clanTag never reaches the simulation,
  // and the desync hash (Player.hash) excludes names. Gated on FFA, NOT
  // disableClanTags: a Team game with tags disabled DOES assign teams by
  // clanTag, so a per-viewer reveal there would desync.
  private startInfoFor(viewer: ClientID, isAdmin: boolean): GameStartInfo {
    const revealClanTags = isAdmin && this.gameConfig.gameMode === GameMode.FFA;
    if (!this.gameConfig.anonymizeNames) {
      return revealClanTags ? this.gameStartInfo : this.wireGameStartInfo;
    }
    return {
      ...this.wireGameStartInfo,
      players: this.wireGameStartInfo.players.map((p, i) => {
        const real = this.seesReal(viewer, p.clientID);
        return {
          ...p,
          username: real ? p.username : this.anonName(viewer, p.clientID),
          clanTag: revealClanTags
            ? this.gameStartInfo.players[i].clanTag
            : null,
          friends: undefined,
          cosmetics: real ? p.cosmetics : undefined,
        };
      }),
    };
  }

  private sendStartGameMsg(ws: WebSocket, lastTurn: number) {
    if (this.simulationFailed) {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            type: "error",
            error:
              "This match stopped and needs server recovery. It is not currently running.",
          } satisfies ServerErrorMessage),
        );
      return;
    }
    // Find which client this websocket belongs to
    const client = this.activeClients.find((c) => c.ws === ws);
    if (!client) {
      this.log.warn("Could not find client for websocket in sendStartGameMsg");
      return;
    }

    this.log.info(`Sending start message to client`, {
      clientID: client.clientID,
      lobbyCreatorID: this.lobbyCreatorID,
      isLobbyCreator: this.lobbyCreatorID === client.clientID,
    });

    try {
      if (ws.readyState !== WebSocket.OPEN) {
        this.log.warn(`WebSocket not open, skipping start message`, {
          clientID: client.clientID,
          readyState: ws.readyState,
        });
        return;
      }
      ws.send(
        JSON.stringify({
          type: "start",
          turns: this.simulation ? [] : this.turns.slice(lastTurn),
          gameStartInfo: this.startInfoFor(
            client.clientID,
            isAdminRole(client.role),
          ),
          lobbyCreatedAt: this.createdAt,
          myClientID: client.clientID,
        } satisfies ServerStartGameMessage),
      );
    } catch (error) {
      this.log.error(`error sending start message for game ${this.id}`, {
        clientID: client.clientID,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private simulationRecoveryMessage(
    status: "replaying" | "ready",
    progress: SimulationRecoveryProgress,
  ): ServerSimulationRecoveryMessage {
    return {
      type: "simulation_recovery",
      status,
      completedTurns: progress.completedTurns,
      totalTurns: progress.totalTurns,
      elapsedMs: progress.elapsedMs,
    };
  }

  private sendSimulationRecoveryProgress(ws: WebSocket): void {
    const progress = this.simulationRecoveryProgress;
    if (!progress || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify(this.simulationRecoveryMessage("replaying", progress)),
    );
  }

  private broadcastSimulationRecoveryProgress(
    progress: SimulationRecoveryProgress,
  ): void {
    this.simulationRecoveryProgress = progress;
    const message = JSON.stringify(
      this.simulationRecoveryMessage("replaying", progress),
    );
    for (const client of this.activeClients) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
    }
  }

  private broadcastSimulationRecoveryReady(): void {
    const progress = this.simulationRecoveryProgress;
    if (!progress) return;
    const message = JSON.stringify(
      this.simulationRecoveryMessage("ready", {
        ...progress,
        completedTurns: progress.totalTurns,
      }),
    );
    this.simulationRecoveryProgress = undefined;
    for (const client of this.activeClients) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
    }
  }

  private endTurn() {
    // Skip turn execution if game is paused
    if (this.isPaused) {
      if (this.simulation) {
        this.simulationDeadline =
          performance.now() + ServerEnv.turnIntervalMs();
        this.scheduleSimulation();
      }
      return;
    }
    if (this.simulationBusy || this._hasEnded) return;

    const pastTurn: Turn = {
      turnNumber: this.turns.length,
      intents: this.intents,
    };
    this.intents = [];
    if (this.simulation) {
      this.simulationBusy = true;
      void this.simulation
        .turn(pastTurn)
        .then((result) => {
          this.commitTurn(pastTurn);
          this.publishView(result);
          this.simulationDeadline += ServerEnv.turnIntervalMs();
          this.simulationBusy = false;
          this.scheduleSimulation();
        })
        .catch((error) => {
          this.simulationBusy = false;
          this.simulationFailed = true;
          this.simulation?.stop();
          this.log.error("Authoritative simulation stopped", {
            error: String(error),
          });
          for (const c of this.activeClients)
            this.sendViewError(
              c.ws,
              "The simulation stopped. Your match needs server recovery.",
            );
        });
      return;
    }
    this.commitTurn(pastTurn);
  }

  private readonly viewQueryBudgets = new Map<
    ClientID,
    { at: number; count: number }
  >();

  private commitTurn(pastTurn: Turn): void {
    this.turns.push(pastTurn);
    const counts = this.telemetryTickCounts.get(pastTurn.turnNumber) ?? {
      observed: 0,
      enqueued: 0,
      dropped: 0,
    };
    this.telemetryTickCounts.delete(pastTurn.turnNumber);
    this.emitTelemetry(
      "turn_committed",
      {
        turnNumber: pastTurn.turnNumber,
        replayIntentCount: pastTurn.intents.length,
        ...counts,
      },
      this.turns.length,
    );

    if (!this.simulation) this.handleSynchronization();
    this.checkDisconnectedStatus();
    this.queueManagedTurn(pastTurn);

    if (this.simulation) return;

    const msg = JSON.stringify({
      type: "turn",
      turn: pastTurn,
    } satisfies ServerTurnMessage);
    this.activeClients.forEach((c) => {
      if (c.ws.readyState === c.ws.OPEN) {
        c.ws.send(msg);
      }
    });
  }

  async end() {
    clearTimeout(this.simulationTimer);
    clearTimeout(this.simulationStartFallbackTimer);
    this.simulation?.stop();
    for (const connection of this.viewConnections.values()) connection.stop();
    this.viewConnections.clear();
    this.viewHistory = [];
    this._hasEnded = true;
    // Close all WebSocket connections
    if (this.endTurnIntervalID) {
      clearInterval(this.endTurnIntervalID);
      this.endTurnIntervalID = undefined;
    }
    this.flushManagedTurns();
    this.websockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "game has ended");
      }
    });
    if (!this._hasPrestarted && !this._hasStarted) {
      this.log.info(`game not started, not archiving game`);
      this.emitMatchFinished();
      return;
    }
    this.log.info(`ending game with ${this.turns.length} turns`);
    try {
      if (this.allClients.size === 0) {
        this.log.info("no clients joined, not archiving game", {
          gameID: this.id,
        });
      } else if (this.winner !== null) {
        this.log.info("game already archived", {
          gameID: this.id,
        });
      } else {
        this.archiveGame();
      }
    } catch (error) {
      let errorDetails;
      if (error instanceof Error) {
        errorDetails = {
          message: error.message,
          stack: error.stack,
        };
      } else if (Array.isArray(error)) {
        errorDetails = error; // Now we'll actually see the array contents
      } else {
        try {
          errorDetails = JSON.stringify(error, null, 2);
        } catch (e) {
          errorDetails = String(error);
        }
      }

      this.log.error("Error archiving game record details:", {
        gameId: this.id,
        errorType: typeof error,
        error: errorDetails,
      });
    }
    this.emitMatchFinished();
  }

  /** Flushes the current managed journal batch, including during teardown. */
  public flushManagedTurns(): void {
    if (this.managedTurnFlushTimer !== undefined) {
      clearTimeout(this.managedTurnFlushTimer);
      this.managedTurnFlushTimer = undefined;
    }
    if (
      this.pendingManagedTurns.length === 0 ||
      !this.managedHooks?.onTurnsCommitted
    ) {
      return;
    }
    const batch = this.pendingManagedTurns;
    this.pendingManagedTurns = [];
    try {
      this.managedHooks.onTurnsCommitted(batch);
    } catch (error) {
      this.pendingManagedTurns = [...batch, ...this.pendingManagedTurns];
      this.log.error("Failed to emit managed turn batch", {
        gameID: this.id,
        firstTurn: batch[0]?.turnNumber,
        lastTurn: batch[batch.length - 1]?.turnNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private queueManagedTurn(turn: Turn): void {
    if (!this.managedHooks?.onTurnsCommitted) return;
    this.pendingManagedTurns.push(turn);
    if (turn.intents.length > 0 || this.pendingManagedTurns.length >= 10) {
      this.flushManagedTurns();
      return;
    }
    if (this.managedTurnFlushTimer === undefined) {
      this.managedTurnFlushTimer = setTimeout(
        () => this.flushManagedTurns(),
        1_000,
      );
      this.managedTurnFlushTimer.unref?.();
    }
  }

  phase(): GamePhase {
    // An ended game (e.g. an unstarted lobby whose host left) must report
    // Finished: GameManager prunes on Finished, and a ghost that kept
    // reporting Lobby would stay advertised in the lobby browser and hold
    // the creator's one-listing quota until the max-duration cutoff.
    if (this._hasEnded) {
      return GamePhase.Finished;
    }
    const now = Date.now();
    const alive: Client[] = [];
    for (const client of this.activeClients) {
      if (now - client.lastPing > 60_000) {
        this.log.info("no pings received, terminating connection", {
          clientID: client.clientID,
          persistentID: client.persistentID,
        });
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.close(1000, "no heartbeats received, closing connection");
        }
      } else {
        alive.push(client);
      }
    }
    this.activeClients = alive;
    // Managed match duration is a pacing target, not a wall-clock cutoff.
    if (!this.managedOptions && now > this.createdAt + this.maxGameDuration) {
      this.log.warn("game past max duration", {
        gameID: this.id,
      });
      return GamePhase.Finished;
    }

    const noRecentPings = now > this.lastPingUpdate + 20 * 1000;
    const noActive = this.activeClients.length === 0;

    const lessThanLifetime = this.startsAt ? Date.now() < this.startsAt : true;
    // A managed game belongs to an external schedule. Filling every reserved
    // seat must not pull that schedule forward as ordinary max-player lobbies
    // do, so remain in Lobby until the exact start time.
    if (this.managedOptions && lessThanLifetime && !this.hasStarted()) {
      return GamePhase.Lobby;
    }
    if (
      lessThanLifetime &&
      !this.hasStarted() &&
      !this.hasReachedMaxPlayerCount
    ) {
      return GamePhase.Lobby;
    }
    const warmupOver = now > this.startsAt! + 30 * 1000;
    if (!this.managedOptions && noActive && warmupOver && noRecentPings) {
      return GamePhase.Finished;
    }

    return GamePhase.Active;
  }

  hasStarted(): boolean {
    return this._hasStarted || this._hasPrestarted;
  }

  // Omitting viewer (e.g. the HTTP /api/game/:id and link-preview routes)
  // anonymizes all names when the option is on.
  public gameInfo(viewer?: ClientID): GameInfo {
    const friendsFor = this.buildFriendsLookup();
    const hideClanTags = this.gameConfig.disableClanTags ?? false;
    return {
      gameID: this.id,
      clients: this.activeClients.map((c) => {
        if (!this.seesReal(viewer, c.clientID)) {
          return {
            username: this.anonName(viewer, c.clientID),
            clanTag: null,
            clientID: c.clientID,
          };
        }
        // A TEAMMATE reveal is deliberately narrower than the others. Seeing a
        // teammate's clanTag and friends would hand out more than the identity
        // needed to coordinate: `friends` in particular names a THIRD party —
        // the viewer would learn their teammate is friends with a specific
        // still-anonymized opponent, which the host never granted. The wider
        // reveals (self, or host-granted nameReveals) keep the full payload.
        const teammateOnly =
          this.gameConfig.anonymizeNames &&
          !this.seesRealBeyondTeam(viewer, c.clientID);
        return {
          username: c.username,
          clanTag: teammateOnly || hideClanTags ? null : (c.clanTag ?? null),
          clientID: c.clientID,
          friends: teammateOnly ? undefined : friendsFor(c),
          verified: c.cosmetics?.verified,
        };
      }),
      lobbyCreatorClientID: this.lobbyCreatorID,
      gameConfig: this.gameConfig,
      startsAt: this.startsAt,
      serverTime: Date.now(),
      publicGameType: this.publicGameType,
      listed: this.isPublic() ? undefined : this.listed,
      autoStartAt: this.autoStartAt(),
    };
  }

  // Maps each active client's publicId-based friends list to in-game
  // clientIDs, dropping friends not present in this game. Returns undefined
  // when no friends are present so the field can be omitted from the wire
  // payload.
  private buildFriendsLookup(): (client: Client) => ClientID[] | undefined {
    const publicIdToClientID = new Map<string, ClientID>();
    for (const c of this.activeClients) {
      if (c.publicId) publicIdToClientID.set(c.publicId, c.clientID);
    }
    return (client: Client) => {
      const friendClientIDs = client.friends
        .map((pid) => publicIdToClientID.get(pid))
        .filter((id): id is ClientID => id !== undefined);
      return friendClientIDs.length > 0 ? friendClientIDs : undefined;
    };
  }

  public isPublic(): boolean {
    return this.gameConfig.gameType === GameType.Public;
  }

  public isListed(): boolean {
    return this.listed;
  }

  public setListed(listed: boolean): void {
    if (this.listed === listed) {
      // Duplicate toggles must not extend the auto-start deadline.
      return;
    }
    this.listed = listed;
    this.listedAt = listed ? Date.now() : undefined;
  }

  // Deadline after which a listed lobby starts automatically, so hosts
  // can't sit on a public listing indefinitely.
  public autoStartAt(): number | undefined {
    return this.listed && this.listedAt !== undefined
      ? this.listedAt + HOSTED_LOBBY_AUTO_START_MS
      : undefined;
  }

  // Called from GameManager's tick while in the Lobby phase: once the
  // listed deadline passes, arm the normal start countdown (same path as
  // the host's Start button). Cancelling the countdown re-arms it on the
  // next tick, so the only way out is to unlist.
  public maybeAutoStartListed(): void {
    if (this.hasStarted() || this.startsAt !== undefined) {
      return;
    }
    const deadline = this.autoStartAt();
    if (deadline === undefined || Date.now() < deadline) {
      return;
    }
    this.log.info("listed lobby reached auto-start deadline, starting", {
      gameID: this.id,
    });
    this.setStartsAt(Date.now() + (this.gameConfig.startDelay ?? 0) * 1000);
  }

  // Whether joining is restricted to an allowlist of publicIds. A lobby with
  // a join whitelist must not be publicly listed (it would advertise a lobby
  // that rejects every joiner).
  public hasJoinWhitelist(): boolean {
    return (this.gameConfig.allowedPublicIds?.length ?? 0) > 0;
  }

  // Whether any host-only cheat is actually granted. A lobby with host
  // cheats must not be publicly listed.
  public hasHostCheats(): boolean {
    return hostCheatsEnabled(this.gameConfig.hostCheats);
  }

  public isCreator(persistentId: string): boolean {
    return (
      this.creatorPersistentID !== undefined &&
      this.creatorPersistentID === persistentId
    );
  }

  // Hash of the creator's persistentID, safe to share between master and
  // workers (never sent to browsers) for the one-listed-lobby-per-creator
  // check. The raw persistentID must not leave this class.
  public hashedCreatorID(): string | undefined {
    return this.creatorPersistentID === undefined
      ? undefined
      : hashPersistentID(this.creatorPersistentID);
  }

  public kickClient(
    clientID: ClientID,
    reasonKey: string = KICK_REASON_DUPLICATE_SESSION,
  ): void {
    if (this.isKicked(clientID)) {
      this.log.warn(`cannot kick client, already kicked`, {
        clientID,
        reasonKey,
      });
      return;
    }

    const clientToKick = this.allClients.get(clientID);
    if (!clientToKick) {
      this.log.warn(`cannot kick client, not found in game`, {
        clientID,
        reasonKey,
      });
      return;
    }

    this.kickedPersistentIds.add(clientToKick.persistentID);

    const client = this.activeClients.find((c) => c.clientID === clientID);
    if (client) {
      this.log.info("Kicking client from game", {
        clientID: client.clientID,
        persistentID: client.persistentID,
        reasonKey,
      });
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(
          JSON.stringify({
            type: "error",
            error: reasonKey,
          } satisfies ServerErrorMessage),
        );
        client.ws.close(1000, reasonKey);
      }
      this.activeClients = this.activeClients.filter(
        (c) => c.clientID !== clientID,
      );
    } else {
      this.log.warn(`cannot kick client, not found in game`, {
        clientID,
        reasonKey,
      });
    }
  }

  private checkDisconnectedStatus() {
    if (this.turns.length % 5 !== 0) {
      return;
    }

    const now = Date.now();
    for (const [clientID, client] of this.allClients) {
      const isDisconnected = this.isClientDisconnected(clientID);
      if (!isDisconnected && now - client.lastPing > this.disconnectedTimeout) {
        this.markClientDisconnected(clientID, true);
      } else if (
        isDisconnected &&
        now - client.lastPing < this.disconnectedTimeout
      ) {
        this.markClientDisconnected(clientID, false);
      }
    }
  }

  public isClientDisconnected(clientID: string): boolean {
    return this.clientsDisconnectedStatus.get(clientID) ?? true;
  }

  private markClientDisconnected(clientID: string, isDisconnected: boolean) {
    this.clientsDisconnectedStatus.set(clientID, isDisconnected);
    this.addIntent({
      type: "mark_disconnected",
      clientID: clientID,
      isDisconnected: isDisconnected,
    });
  }

  private archiveGame() {
    this.log.info("archiving game", {
      gameID: this.id,
      winner: this.winner?.winner,
    });

    // Players must stay in the same order as the game start info.
    const playerRecords: PlayerRecord[] = this.gameStartInfo.players.map(
      (player) => {
        const stats = this.winner?.allPlayersStats[player.clientID];
        if (stats === undefined) {
          this.log.warn(`Unable to find stats for clientID ${player.clientID}`);
        }
        return {
          clientID: player.clientID,
          username: player.username,
          clanTag: player.clanTag,
          persistentID:
            this.allClients.get(player.clientID)?.persistentID ?? "",
          stats,
          cosmetics: player.cosmetics,
          // Simulation inputs: teamIndex pins matchmade teams, friends bias
          // team grouping, isLobbyCreator gates host cheats. Replays rebuild
          // GameStartInfo from these records, so dropping any of them makes
          // the replay diverge from the recorded hashes (desync errors).
          teamIndex: player.teamIndex,
          friends: player.friends,
          isLobbyCreator: player.isLobbyCreator,
        } satisfies PlayerRecord;
      },
    );
    this.replayArchiveAttempted = true;
    archive(
      finalizeGameRecord(
        createPartialGameRecord(
          this.id,
          this.gameStartInfo.config,
          playerRecords,
          this.turns,
          this._startTime ?? 0,
          Date.now(),
          this.winner?.winner,
          this.createdAt,
          this.visibleAt,
          this.gameStartInfo.tribes,
        ),
      ),
    );
  }

  private handleSynchronization() {
    if (this.activeClients.length <= 1) {
      return;
    }
    if (this.turns.length % 10 !== 0 || this.turns.length < 10) {
      // Check hashes every 10 turns
      return;
    }

    const lastHashTurn = this.turns.length - 10;

    const { mostCommonHash, outOfSyncClients } =
      this.findOutOfSyncClients(lastHashTurn);

    if (outOfSyncClients.length === 0) {
      this.turns[lastHashTurn].hash = mostCommonHash;
      return;
    }

    const serverDesync = ServerDesyncSchema.safeParse({
      type: "desync",
      turn: lastHashTurn,
      correctHash: mostCommonHash,
      clientsWithCorrectHash:
        this.activeClients.length - outOfSyncClients.length,
      totalActiveClients: this.activeClients.length,
    });
    if (!serverDesync.success) {
      this.log.warn("failed to create desync message", {
        gameID: this.id,
        error: serverDesync.error,
      });
      return;
    }

    const desyncMsg = JSON.stringify(serverDesync.data);
    for (const c of outOfSyncClients) {
      this.outOfSyncClients.add(c.clientID);
      if (this.sentDesyncMessageClients.has(c.clientID)) {
        continue;
      }
      this.sentDesyncMessageClients.add(c.clientID);
      this.log.info("sending desync to client", {
        gameID: this.id,
        clientID: c.clientID,
        persistentID: c.persistentID,
      });
      if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(desyncMsg);
      }
    }
  }

  findOutOfSyncClients(turnNumber: number): {
    mostCommonHash: number | null;
    outOfSyncClients: Client[];
  } {
    const counts = new Map<number, number>();

    // Count occurrences of each hash
    for (const client of this.activeClients) {
      if (client.hashes.has(turnNumber)) {
        const clientHash = client.hashes.get(turnNumber)!;
        counts.set(clientHash, (counts.get(clientHash) ?? 0) + 1);
      }
    }

    // Find the most common hash
    let mostCommonHash: number | null = null;
    let maxCount = 0;

    for (const [hash, count] of counts.entries()) {
      if (count > maxCount) {
        mostCommonHash = hash;
        maxCount = count;
      }
    }

    // Create a list of clients whose hash doesn't match the most common one
    let outOfSyncClients: Client[] = [];

    for (const client of this.activeClients) {
      if (client.hashes.has(turnNumber)) {
        const clientHash = client.hashes.get(turnNumber)!;
        if (clientHash !== mostCommonHash) {
          outOfSyncClients.push(client);
        }
      }
    }

    // If strict majority clients out of sync assume all are out of sync.
    if (outOfSyncClients.length > Math.floor(this.activeClients.length / 2)) {
      outOfSyncClients = this.activeClients;
    }

    return {
      mostCommonHash,
      outOfSyncClients,
    };
  }

  private handleWinner(client: Client, clientMsg: ClientSendWinnerMessage) {
    if (
      this.outOfSyncClients.has(client.clientID) ||
      this.isKicked(client.clientID) ||
      this.winner !== null ||
      client.reportedWinner !== null
    ) {
      return;
    }
    client.reportedWinner = clientMsg.winner;

    // Add client vote. A cancelled match ends with winner omitted;
    // JSON.stringify(undefined) is not a string, so key those votes as "null".
    const winnerKey = JSON.stringify(clientMsg.winner ?? null);
    const activeUniqueIPs = new Set(this.activeClients.map((c) => c.ip)).size;
    const votes = this.winnerVotes.add(winnerKey, clientMsg, client.ip);

    this.log.info(
      `received winner vote ${clientMsg.winner}, ${votes}/${activeUniqueIPs} votes for this winner`,
      {
        clientID: client.clientID,
      },
    );

    const result = this.winnerVotes.result(activeUniqueIPs);
    if (result === null) {
      return;
    }

    // Vote succeeded
    this.winner = result.value;
    this.log.info(
      `Winner determined by ${result.votes}/${activeUniqueIPs} active IPs`,
      {
        winnerKey,
      },
    );
    this.archiveGame();
  }

  // Clients each send a live stats snapshot every ~10s tagged with the turn it
  // was taken at. In-sync clients produce an identical snapshot for a given
  // turn, so we reach majority consensus (same IP-weighted vote as the winner)
  // and keep the latest agreed snapshot for the admin bot to read.
  private handleLiveStats(
    client: Client,
    clientMsg: ClientSendLiveStatsMessage,
  ) {
    if (
      this.outOfSyncClients.has(client.clientID) ||
      this.isKicked(client.clientID)
    ) {
      return;
    }
    const stats = clientMsg.stats;
    const turn = stats.turn;
    // Ignore turns we've already reached consensus on (or older ones).
    if (this.latestLiveStats !== null && turn <= this.latestLiveStats.turn) {
      return;
    }

    let entry = this.liveStatsVotes.get(turn);
    if (entry === undefined) {
      entry = { round: new VoteRound<LiveStats>(), voters: new Set() };
      this.liveStatsVotes.set(turn, entry);
      this.pruneLiveStatsVotes();
    }
    // One vote per client per turn.
    if (entry.voters.has(client.clientID)) {
      return;
    }
    entry.voters.add(client.clientID);

    const activeUniqueIPs = new Set(this.activeClients.map((c) => c.ip)).size;
    entry.round.add(JSON.stringify(stats), stats, client.ip);
    const result = entry.round.result(activeUniqueIPs);
    if (result === null) {
      return;
    }

    this.latestLiveStats = result.value;
    if (this.managedHooks?.onLiveStatsCommitted) {
      try {
        this.managedHooks.onLiveStatsCommitted(result.value);
      } catch (error) {
        this.log.error("Failed to emit managed live stats", {
          gameID: this.id,
          turn,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // This turn (and any older still-pending ones) are now settled.
    for (const t of this.liveStatsVotes.keys()) {
      if (t <= turn) {
        this.liveStatsVotes.delete(t);
      }
    }
  }

  // Bound the pending-vote map in case consensus is never reached for some
  // turns (e.g. a persistent desync). Maps iterate in insertion order and turns
  // arrive ascending, so this drops the oldest pending rounds.
  private pruneLiveStatsVotes() {
    while (
      this.liveStatsVotes.size > GameServer.MAX_PENDING_LIVE_STATS_ROUNDS
    ) {
      const oldest = this.liveStatsVotes.keys().next().value;
      if (oldest === undefined) break;
      this.liveStatsVotes.delete(oldest);
    }
  }

  // Latest majority-agreed live stats snapshot, with players enriched with
  // server-authoritative info the clients don't vote on: the username and
  // current connection status. null until the first consensus.
  public liveStats(): {
    turn: number;
    // The winner's clientID once the game is decided (player win), else null.
    // Server-side (from the winner vote), so the live board can seat the winner
    // without waiting for the post-game record.
    winner: string | null;
    players: (PlayerLiveStats & {
      username: string | null;
      publicID: string | null;
      connected: boolean;
    })[];
  } | null {
    if (this.latestLiveStats === null) {
      return null;
    }
    const w = this.winner?.winner;
    return {
      turn: this.latestLiveStats.turn,
      winner: w?.[0] === "player" ? w[1] : null,
      players: this.latestLiveStats.players.map((p) => {
        const client = this.allClients.get(p.clientID);
        return {
          ...p,
          username: client?.username ?? null,
          publicID: client?.publicId ?? null,
          connected: !this.isClientDisconnected(p.clientID),
        };
      }),
    };
  }
}
