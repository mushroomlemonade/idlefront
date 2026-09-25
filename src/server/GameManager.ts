import { Logger } from "winston";
import WebSocket from "ws";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../core/game/Game";
import { ClientID, GameConfig, GameID, PublicGameType } from "../core/Schemas";
import { Client } from "./Client";
import { GamePhase, GameServer, type ManagedGameHooks } from "./GameServer";
import type {
  ManagedGameOptions,
  ManagedReservedSeat,
} from "./IPCBridgeSchema";
import {
  noopMatchTelemetryEmitter,
  type MatchTelemetryEmitter,
} from "./telemetry/MatchTelemetry";

export class GameManager {
  private games: Map<GameID, GameServer> = new Map();
  private deploymentDraining = false;
  private pendingMatchmakingPolls = 0;

  constructor(
    private log: Logger,
    private readonly telemetry: MatchTelemetryEmitter = noopMatchTelemetryEmitter,
    private readonly telemetryBuildHash: string = "DEV",
  ) {
    setInterval(() => this.tick(), 1000);
  }

  public game(id: GameID): GameServer | null {
    return this.games.get(id) ?? null;
  }

  /** Drop only the exact failed startup instance; a retry may then recreate it. */
  public discardGame(id: GameID, expected: GameServer): void {
    if (this.games.get(id) === expected) this.games.delete(id);
  }

  public publicLobbies(): GameServer[] {
    return Array.from(this.games.values()).filter(
      (g) => g.phase() === GamePhase.Lobby && g.isPublic(),
    );
  }

  // Private lobbies a subscriber has listed in the public lobby browser.
  // Leaving the Lobby phase (start/fill/expiry) delists them automatically.
  public listedLobbies(): GameServer[] {
    return Array.from(this.games.values()).filter(
      (g) => g.phase() === GamePhase.Lobby && !g.isPublic() && g.isListed(),
    );
  }

  joinClient(
    client: Client,
    gameID: GameID,
    lastTurn: number = 0,
  ): "joined" | "kicked" | "rejected" | "not_allowlisted" | "not_found" {
    const game = this.games.get(gameID);
    if (!game) return "not_found";
    return game.joinClient(client, lastTurn);
  }

  rejoinClient(
    ws: WebSocket,
    persistentID: string,
    gameID: GameID,
    lastTurn: number = 0,
    identityUpdate?: { username: string; clanTag: string | null },
  ): boolean {
    const game = this.games.get(gameID);
    if (!game) return false;
    return game.rejoinClient(ws, persistentID, lastTurn, identityUpdate);
  }

  managedClientIDForPersistentId(
    gameID: GameID,
    persistentID: string,
  ): ClientID | null | undefined {
    return this.games.get(gameID)?.managedClientIDForPersistentId(persistentID);
  }

  managedSeatForPersistentId(
    gameID: GameID,
    persistentID: string,
  ): ManagedReservedSeat | null | undefined {
    return this.games.get(gameID)?.managedSeatForPersistentId(persistentID);
  }

  createGame(
    id: GameID,
    gameConfig: Partial<GameConfig> | undefined,
    creatorPersistentID?: string,
    startsAt?: number,
    publicGameType?: PublicGameType,
    matchmakingTeams?: string[][],
    managedOptions?: ManagedGameOptions,
    managedHooks?: ManagedGameHooks,
    allowDuringDeploymentDrain = false,
  ): GameServer | null {
    if (this.deploymentDraining && !allowDuringDeploymentDrain) {
      this.log.info("refusing game creation during deployment drain", {
        gameID: id,
      });
      return null;
    }
    if (this.games.has(id)) {
      this.log.warn("cannot create game, id already exists", { gameID: id });
      return null;
    }

    const game = new GameServer(
      id,
      this.log,
      Date.now(),
      {
        donateGold: false,
        donateTroops: false,
        gameMap: GameMapType.World,
        gameType: GameType.Private,
        gameMapSize: GameMapSize.Normal,
        difficulty: Difficulty.Easy,
        nations: "default",
        infiniteGold: false,
        infiniteTroops: false,
        maxTimerValue: undefined,
        instantBuild: false,
        randomSpawn: false,
        gameMode: GameMode.FFA,
        bots: 400,
        disabledUnits: [],
        ...gameConfig,
      },
      creatorPersistentID,
      startsAt,
      publicGameType,
      matchmakingTeams,
      this.telemetry,
      this.telemetryBuildHash,
      managedOptions,
      managedHooks,
    );
    this.games.set(id, game);
    return game;
  }

  activeGames(): number {
    return this.games.size;
  }

  public isDeploymentDraining(): boolean {
    return this.deploymentDraining;
  }

  public beginMatchmakingPoll(): boolean {
    if (this.deploymentDraining) return false;
    this.pendingMatchmakingPolls += 1;
    return true;
  }

  public endMatchmakingPoll(): void {
    this.pendingMatchmakingPolls = Math.max(
      0,
      this.pendingMatchmakingPolls - 1,
    );
  }

  public setDeploymentDraining(enabled: boolean): void {
    if (this.deploymentDraining === enabled) return;
    this.deploymentDraining = enabled;
    if (!enabled) return;

    // Do not let a countdown cross into Active while a deployment is waiting.
    // Managed games are deliberately retained because their turn journals make
    // restart a supported recovery boundary.
    for (const game of this.games.values()) game.cancelForDeploymentDrain();
  }

  public deploymentDrainStatus(): {
    blockingGames: number;
    managedGames: number;
    lobbyGames: number;
    activeClients: number;
    pendingAdmissions: number;
  } {
    let blockingGames = 0;
    let managedGames = 0;
    let lobbyGames = 0;
    let activeClients = 0;
    for (const game of this.games.values()) {
      const phase = game.phase();
      if (phase === GamePhase.Finished) continue;
      activeClients += game.activeClients.length;
      if (game.managedRequestId() !== undefined) {
        managedGames += 1;
      } else if (phase === GamePhase.Active) {
        blockingGames += 1;
      } else {
        lobbyGames += 1;
      }
    }
    return {
      blockingGames,
      managedGames,
      lobbyGames,
      activeClients,
      pendingAdmissions: this.pendingMatchmakingPolls,
    };
  }

  activeClients(): number {
    let totalClients = 0;
    this.games.forEach((game: GameServer) => {
      totalClients += game.activeClients.length;
    });
    return totalClients;
  }

  desyncCount(): number {
    return [...this.games.values()].reduce(
      (acc, game) => acc + game.numDesyncedClients(),
      0,
    );
  }

  flushManagedTurns(): void {
    for (const game of this.games.values()) game.flushManagedTurns();
  }

  tick() {
    const active = new Map<GameID, GameServer>();
    for (const [id, game] of this.games) {
      if (
        this.deploymentDraining &&
        !game.hasStarted() &&
        game.managedRequestId() === undefined
      ) {
        game.cancelForDeploymentDrain();
      }
      const phase = game.phase();
      if (phase === GamePhase.Lobby) {
        if (this.deploymentDraining) {
          game.cancelForDeploymentDrain();
        } else {
          game.maybeAutoStartListed();
        }
      }
      if (phase === GamePhase.Active) {
        // A matchmade game missing a player at the start deadline is
        // cancelled instead of started short-handed.
        if (!game.hasStarted() && !game.cancelShortHandedMatch()) {
          // Prestart tells clients to start loading the game.
          game.prestart();
          // Start game on delay to allow time for clients to connect.
          setTimeout(() => {
            try {
              game.start();
            } catch (error) {
              this.log.error(`error starting game ${id}: ${error}`);
            }
          }, 2000);
        }
      }

      if (phase === GamePhase.Finished) {
        try {
          game.end();
        } catch (error) {
          this.log.error(`error ending game ${id}: ${error}`);
        }
      } else {
        active.set(id, game);
      }
    }
    this.games = active;
  }
}
