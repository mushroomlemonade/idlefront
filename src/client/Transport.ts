import { ClientEnv } from "src/client/ClientEnv";
import { z } from "zod";
import { EventBus, GameEvent } from "../core/EventBus";
import type { FleetOrders } from "../core/FleetOrders";
import {
  AllPlayers,
  GameType,
  Gold,
  PlayerID,
  Tick,
  UnitType,
} from "../core/game/Game";
import { TileRef } from "../core/game/GameMap";
import {
  decodeViewPacket,
  type ClientViewMessage,
  type ViewPacket,
} from "../core/network/ViewProtocol";
import {
  AllPlayersStats,
  ClientHashMessage,
  ClientIntentMessage,
  ClientJoinMessage,
  ClientMessage,
  ClientPingMessage,
  ClientRejoinMessage,
  ClientSendLiveStatsMessage,
  ClientSendWinnerMessage,
  GameConfig,
  Intent,
  LiveStats,
  ServerMessage,
  ServerMessageSchema,
  Winner,
} from "../core/Schemas";
import { replacer } from "../core/Util";
import { getOnlinePlayToken, getPlayToken } from "./Auth";
import { LobbyConfig } from "./ClientGameRunner";
import { showInGameAlert } from "./InGameModal";
import { LocalServer } from "./LocalServer";
import { translateText } from "./Utils";
import { PlayerView } from "./view";

/**
 * Browsers do not agree on the runtime type used for binary WebSocket frames.
 * Chromium normally honours `binaryType = "arraybuffer"`, while WKWebView and
 * some React Native WebViews can still provide a Blob. Normalize every binary
 * shape before decoding so view snapshots work consistently on every device.
 */
export async function webSocketBinaryPayload(
  data: unknown,
): Promise<ArrayBuffer | null> {
  if (data instanceof ArrayBuffer) return data;
  if (typeof Blob !== "undefined" && data instanceof Blob)
    return data.arrayBuffer();
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy.buffer;
  }
  return null;
}

export class PauseGameIntentEvent implements GameEvent {
  constructor(public readonly paused: boolean) {}
}

export class SendAllianceRequestIntentEvent implements GameEvent {
  constructor(
    public readonly requestor: PlayerView,
    public readonly recipient: PlayerView,
  ) {}
}

export class SendBreakAllianceIntentEvent implements GameEvent {
  constructor(
    public readonly requestor: PlayerView,
    public readonly recipient: PlayerView,
  ) {}
}

export class SendUpgradeStructureIntentEvent implements GameEvent {
  constructor(
    public readonly unitId: number,
    public readonly unitType: UnitType,
    public readonly amount: number = 1,
  ) {}
}

export class SendAllianceRejectIntentEvent implements GameEvent {
  constructor(public readonly requestor: PlayerView) {}
}

export class SendAllianceExtensionIntentEvent implements GameEvent {
  constructor(public readonly recipient: PlayerView) {}
}

export class SendSpawnIntentEvent implements GameEvent {
  constructor(public readonly tile: TileRef) {}
}

export class SendMobilisationIntentEvent implements GameEvent {
  constructor(
    public readonly target: number,
    public readonly autoDefenceEnabled?: boolean,
  ) {}
}

export class SendAttackIntentEvent implements GameEvent {
  constructor(
    public readonly targetID: PlayerID | null,
    public readonly troops: number,
  ) {}
}

export class SendBoatAttackIntentEvent implements GameEvent {
  constructor(
    public readonly dst: TileRef,
    public readonly troops: number,
  ) {}
}

export class BuildUnitIntentEvent implements GameEvent {
  constructor(
    public readonly unit: UnitType,
    public readonly tile: TileRef,
    public readonly rocketDirectionUp?: boolean,
    public readonly amount?: number,
  ) {}
}

export class SendTargetPlayerIntentEvent implements GameEvent {
  constructor(public readonly targetID: PlayerID) {}
}

export class SendEmojiIntentEvent implements GameEvent {
  constructor(
    public readonly recipient: PlayerView | typeof AllPlayers,
    public readonly emoji: number,
  ) {}
}

export class SendDonateGoldIntentEvent implements GameEvent {
  constructor(
    public readonly recipient: PlayerView,
    public readonly gold: Gold | null,
  ) {}
}

export class SendDonateTroopsIntentEvent implements GameEvent {
  constructor(
    public readonly recipient: PlayerView,
    public readonly troops: number | null,
  ) {}
}

export class SendQuickChatEvent implements GameEvent {
  constructor(
    public readonly recipient: PlayerView,
    public readonly quickChatKey: string,
    public readonly target?: PlayerID,
  ) {}
}

export class SendEmbargoIntentEvent implements GameEvent {
  constructor(
    public readonly target: PlayerView,
    public readonly action: "start" | "stop",
  ) {}
}

export class SendEmbargoAllIntentEvent implements GameEvent {
  constructor(public readonly action: "start" | "stop") {}
}

export class SendDeleteUnitIntentEvent implements GameEvent {
  constructor(public readonly unitId: number) {}
}

export class CancelAttackIntentEvent implements GameEvent {
  constructor(public readonly attackID: string) {}
}

export class CancelBoatIntentEvent implements GameEvent {
  constructor(public readonly unitID: number) {}
}

export class SendWinnerEvent implements GameEvent {
  constructor(
    public readonly winner: Winner,
    public readonly allPlayersStats: AllPlayersStats,
  ) {}
}
export class SendLiveStatsEvent implements GameEvent {
  constructor(public readonly stats: LiveStats) {}
}
export class SendHashEvent implements GameEvent {
  constructor(
    public readonly tick: Tick,
    public readonly hash: number,
  ) {}
}

// Emitted when the server tells us the host started a successor lobby, carrying
// the new game id to move the group to.
export class NewLobbyEvent implements GameEvent {
  constructor(public readonly gameID: string) {}
}

export class MoveWarshipIntentEvent implements GameEvent {
  constructor(
    public readonly unitIds: number[],
    public readonly tile: number,
  ) {}
}

export class SendKickPlayerIntentEvent implements GameEvent {
  constructor(public readonly target: string) {}
}

export class SendUpdateGameConfigIntentEvent implements GameEvent {
  constructor(public readonly config: Partial<GameConfig>) {}
}

export class SendToggleGameStartTimer implements GameEvent {
  constructor() {}
}

export class SendFleetOrdersEvent implements GameEvent {
  constructor(public readonly orders: FleetOrders) {}
}
export class SendIdleModeEvent implements GameEvent {
  constructor(public readonly idle: boolean) {}
}
export class GameSessionEndedEvent implements GameEvent {}

export class Transport {
  private idleControlsLocked = false;
  private idlePresencePending = false;
  private viewReceiver?: (sequence: number, packet: ViewPacket) => void;
  setViewReceiver(
    receiver: ((sequence: number, packet: ViewPacket) => void) | undefined,
  ): void {
    this.viewReceiver = receiver;
  }
  sendViewMessage(message: ClientViewMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }
  private socket: WebSocket | null = null;

  private localServer: LocalServer;

  private buffer: string[] = [];

  private onconnect: () => void;
  private onmessage: (msg: ServerMessage) => void;

  private pingInterval: number | null = null;
  public readonly isLocal: boolean;

  constructor(
    private lobbyConfig: LobbyConfig,
    private eventBus: EventBus,
  ) {
    // If gameRecord is not null, we are replaying an archived game.
    // For multiplayer games, GameConfig is not known until game starts.
    this.isLocal =
      lobbyConfig.gameRecord !== undefined ||
      lobbyConfig.gameStartInfo?.config.gameType === GameType.Singleplayer;
    this.eventBus.on(SendFleetOrdersEvent, (e) =>
      this.sendIntent({ type: "fleet_orders", orders: e.orders }),
    );
    this.eventBus.on(SendIdleModeEvent, (e) => {
      this.idleControlsLocked = e.idle;
      this.idlePresencePending = true;
      this.sendIntent({ type: "idle_mode", idle: e.idle });
    });

    this.eventBus.on(SendAllianceRequestIntentEvent, (e) =>
      this.onSendAllianceRequest(e),
    );
    this.eventBus.on(SendAllianceRejectIntentEvent, (e) =>
      this.onAllianceRejectUIEvent(e),
    );
    this.eventBus.on(SendAllianceExtensionIntentEvent, (e) =>
      this.onSendAllianceExtensionIntent(e),
    );
    this.eventBus.on(SendBreakAllianceIntentEvent, (e) =>
      this.onBreakAllianceRequestUIEvent(e),
    );
    this.eventBus.on(SendSpawnIntentEvent, (e) =>
      this.onSendSpawnIntentEvent(e),
    );
    this.eventBus.on(SendAttackIntentEvent, (e) => this.onSendAttackIntent(e));
    this.eventBus.on(SendMobilisationIntentEvent, (e) =>
      this.sendIntent({
        type: "mobilisation",
        target: e.target,
        ...(e.autoDefenceEnabled === undefined
          ? {}
          : { autoDefenceEnabled: e.autoDefenceEnabled }),
      }),
    );
    this.eventBus.on(SendUpgradeStructureIntentEvent, (e) =>
      this.onSendUpgradeStructureIntent(e),
    );
    this.eventBus.on(SendBoatAttackIntentEvent, (e) =>
      this.onSendBoatAttackIntent(e),
    );
    this.eventBus.on(SendTargetPlayerIntentEvent, (e) =>
      this.onSendTargetPlayerIntent(e),
    );
    this.eventBus.on(SendEmojiIntentEvent, (e) => this.onSendEmojiIntent(e));
    this.eventBus.on(SendDonateGoldIntentEvent, (e) =>
      this.onSendDonateGoldIntent(e),
    );
    this.eventBus.on(SendDonateTroopsIntentEvent, (e) =>
      this.onSendDonateTroopIntent(e),
    );
    this.eventBus.on(SendQuickChatEvent, (e) => this.onSendQuickChatIntent(e));
    this.eventBus.on(SendEmbargoIntentEvent, (e) =>
      this.onSendEmbargoIntent(e),
    );
    this.eventBus.on(SendEmbargoAllIntentEvent, (e) =>
      this.onSendEmbargoAllIntent(e),
    );
    this.eventBus.on(BuildUnitIntentEvent, (e) => this.onBuildUnitIntent(e));

    this.eventBus.on(PauseGameIntentEvent, (e) => this.onPauseGameIntent(e));
    this.eventBus.on(SendWinnerEvent, (e) => this.onSendWinnerEvent(e));
    this.eventBus.on(SendLiveStatsEvent, (e) => this.onSendLiveStatsEvent(e));
    this.eventBus.on(SendHashEvent, (e) => this.onSendHashEvent(e));
    this.eventBus.on(CancelAttackIntentEvent, (e) =>
      this.onCancelAttackIntentEvent(e),
    );
    this.eventBus.on(CancelBoatIntentEvent, (e) =>
      this.onCancelBoatIntentEvent(e),
    );

    this.eventBus.on(MoveWarshipIntentEvent, (e) => {
      this.onMoveWarshipEvent(e);
    });

    this.eventBus.on(SendDeleteUnitIntentEvent, (e) =>
      this.onSendDeleteUnitIntent(e),
    );

    this.eventBus.on(SendKickPlayerIntentEvent, (e) =>
      this.onSendKickPlayerIntent(e),
    );

    this.eventBus.on(SendUpdateGameConfigIntentEvent, (e) =>
      this.onSendUpdateGameConfigIntent(e),
    );

    this.eventBus.on(SendToggleGameStartTimer, (e) =>
      this.onSendToggleGameStartTimer(e),
    );
  }

  private startPing() {
    if (this.isLocal) return;
    this.pingInterval ??= window.setInterval(() => {
      if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
        this.sendMsg({
          type: "ping",
        } satisfies ClientPingMessage);
      }
    }, 5 * 1000);
  }

  private stopPing() {
    if (this.pingInterval) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  public connect(
    onconnect: () => void,
    onmessage: (message: ServerMessage) => void,
  ) {
    if (this.isLocal) {
      this.connectLocal(onconnect, onmessage);
    } else {
      this.connectRemote(onconnect, onmessage);
    }
  }

  public updateCallback(
    onconnect: () => void,
    onmessage: (message: ServerMessage) => void,
  ) {
    if (this.isLocal) {
      this.localServer.updateCallback(onconnect, onmessage);
    } else {
      this.onconnect = onconnect;
      this.onmessage = onmessage;
    }
  }

  private connectLocal(
    onconnect: () => void,
    onmessage: (message: ServerMessage) => void,
  ) {
    this.localServer = new LocalServer(
      this.lobbyConfig,
      this.lobbyConfig.gameRecord !== undefined,
      this.eventBus,
    );
    this.localServer.updateCallback(onconnect, onmessage);
    this.localServer.start();
  }

  private connectRemote(
    onconnect: () => void,
    onmessage: (message: ServerMessage) => void,
  ) {
    this.startPing();
    this.killExistingSocket();
    // WS origin comes from ClientEnv (same-origin on web, audience-derived on
    // the desktop app://openfront origin), not window.location.host.
    const workerPath = ClientEnv.workerPath(this.lobbyConfig.gameID);
    const socket = new WebSocket(`${ClientEnv.serverWsBase()}/${workerPath}`);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    this.onconnect = onconnect;
    this.onmessage = onmessage;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      // Reassert an explicitly chosen local mode after the authenticated view
      // arrives, never before join/authentication and never on every heartbeat.
      if (this.idleControlsLocked) this.idlePresencePending = true;
      console.log("Connected to game server!");
      if (this.socket === null) {
        console.error("socket is null");
        return;
      }
      while (this.buffer.length > 0) {
        console.log("sending dropped message");
        const msg = this.buffer.pop();
        if (msg === undefined) {
          console.warn("msg is undefined");
          continue;
        }
        this.socket.send(msg);
      }
      onconnect();
    };
    // Blob conversion is asynchronous. Serialize message handling so a later
    // snapshot part can never overtake an earlier one while it is converted.
    let incoming = Promise.resolve();
    socket.onmessage = (event: MessageEvent) => {
      incoming = incoming
        .then(async () => {
          if (this.socket !== socket) return;
          const binary = await webSocketBinaryPayload(event.data);
          if (this.socket !== socket) return;
          if (binary !== null) {
            if (binary.byteLength < 4)
              throw new Error("View packet is missing its sequence header");
            const sequence = new DataView(binary).getUint32(0);
            this.viewReceiver?.(sequence, decodeViewPacket(binary.slice(4)));
            if (this.idlePresencePending)
              this.sendIntent({
                type: "idle_mode",
                idle: this.idleControlsLocked,
              });
            return;
          }
          if (typeof event.data !== "string")
            throw new Error("Unsupported WebSocket message payload");
          const parsed = JSON.parse(event.data);
          const result = ServerMessageSchema.safeParse(parsed);
          if (!result.success) {
            const error = z.prettifyError(result.error);
            console.error("Error parsing server message", error);
            return;
          }
          if (result.data.type === "simulation_recovery") {
            window.dispatchEvent(
              new CustomEvent("idlefront:simulation-recovery", {
                detail: result.data,
              }),
            );
            return;
          }
          this.onmessage(result.data);
        })
        .catch((e) => {
          console.error("Error in onmessage handler:", e, event.data);
          window.dispatchEvent(
            new CustomEvent("idlefront:diagnostic", {
              detail: {
                scope: "view-transport",
                message: e instanceof Error ? e.message : String(e),
                stack: e instanceof Error ? e.stack : undefined,
              },
            }),
          );
        });
    };
    socket.onerror = (err) => {
      console.error("Socket encountered error: ", err, "Closing socket");
      if (this.socket !== socket) return;
      socket.close();
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      console.log(
        `WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`,
      );
      if (event.code === 4009) {
        // Finish queued server messages first: the server sends the useful
        // error before closing. Do not stack a second alert over that panel.
        void incoming.then(() => {
          if (this.socket !== socket || document.querySelector("#error-modal"))
            return;
          showInGameAlert(
            "Someone with that username is currently playing. Disconnect on your other device, then try again.",
          );
        });
      } else if (event.code === 1002) {
        showInGameAlert(
          translateText("error_modal.connection_refused", {
            reason: event.reason,
          }),
        );
      } else if (event.code !== 1000) {
        console.log(`received error code ${event.code}, reconnecting`);
        this.reconnect();
      }
    };
  }

  public reconnect() {
    this.connect(this.onconnect, this.onmessage);
  }

  public turnComplete() {
    if (this.isLocal) {
      this.localServer.turnComplete();
    }
  }

  async joinGame() {
    this.sendMsg({
      type: "join",
      gameID: this.lobbyConfig.gameID,
      // Note: clientID is not sent - server assigns it based on persistentID
      username: this.lobbyConfig.playerName,
      clanTag: this.lobbyConfig.playerClanTag ?? null,
      cosmetics: this.lobbyConfig.cosmetics,
      turnstileToken: this.lobbyConfig.turnstileToken,
      token: await (this.isLocal
        ? getPlayToken()
        : getOnlinePlayToken(this.lobbyConfig.gameID)),
    } satisfies ClientJoinMessage);
  }

  async rejoinGame(lastTurn: number) {
    this.sendMsg({
      type: "rejoin",
      gameID: this.lobbyConfig.gameID,
      // Note: clientID is not sent - server looks it up from persistentID in token
      lastTurn: lastTurn,
      token: await (this.isLocal
        ? getPlayToken()
        : getOnlinePlayToken(this.lobbyConfig.gameID)),
    } satisfies ClientRejoinMessage);
  }

  leaveGame() {
    this.eventBus.emit(new GameSessionEndedEvent());
    if (this.isLocal) {
      this.localServer.endGame();
      return;
    }
    this.stopPing();
    if (this.socket === null) return;
    if (this.socket.readyState === WebSocket.OPEN) {
      console.log("on stop: leaving game");
      this.killExistingSocket();
    } else {
      console.log(
        "WebSocket is not open. Current state:",
        this.socket.readyState,
      );
      console.error("attempting reconnect");
      this.killExistingSocket();
    }
  }

  private onSendAllianceRequest(event: SendAllianceRequestIntentEvent) {
    this.sendIntent({
      type: "allianceRequest",
      recipient: event.recipient.id(),
    });
  }

  private onAllianceRejectUIEvent(event: SendAllianceRejectIntentEvent) {
    this.sendIntent({
      type: "allianceReject",
      requestor: event.requestor.id(),
    });
  }

  private onBreakAllianceRequestUIEvent(event: SendBreakAllianceIntentEvent) {
    this.sendIntent({
      type: "breakAlliance",
      recipient: event.recipient.id(),
    });
  }

  private onSendAllianceExtensionIntent(
    event: SendAllianceExtensionIntentEvent,
  ) {
    this.sendIntent({
      type: "allianceExtension",
      recipient: event.recipient.id(),
    });
  }

  private onSendSpawnIntentEvent(event: SendSpawnIntentEvent) {
    this.sendIntent({
      type: "spawn",
      tile: event.tile,
    });
  }

  private onSendAttackIntent(event: SendAttackIntentEvent) {
    this.sendIntent({
      type: "attack",
      targetID: event.targetID,
      troops: event.troops,
    });
  }

  private onSendBoatAttackIntent(event: SendBoatAttackIntentEvent) {
    this.sendIntent({
      type: "boat",
      troops: event.troops,
      dst: event.dst,
    });
  }

  private onSendUpgradeStructureIntent(event: SendUpgradeStructureIntentEvent) {
    this.sendIntent({
      type: "upgrade_structure",
      unit: event.unitType,
      unitId: event.unitId,
      amount: event.amount,
    });
  }

  private onSendTargetPlayerIntent(event: SendTargetPlayerIntentEvent) {
    this.sendIntent({
      type: "targetPlayer",
      target: event.targetID,
    });
  }

  private onSendEmojiIntent(event: SendEmojiIntentEvent) {
    this.sendIntent({
      type: "emoji",
      recipient:
        event.recipient === AllPlayers ? AllPlayers : event.recipient.id(),
      emoji: event.emoji,
    });
  }

  private onSendDonateGoldIntent(event: SendDonateGoldIntentEvent) {
    this.sendIntent({
      type: "donate_gold",
      recipient: event.recipient.id(),
      gold: event.gold ? Number(event.gold) : null,
    });
  }

  private onSendDonateTroopIntent(event: SendDonateTroopsIntentEvent) {
    this.sendIntent({
      type: "donate_troops",
      recipient: event.recipient.id(),
      troops: event.troops,
    });
  }

  private onSendQuickChatIntent(event: SendQuickChatEvent) {
    this.sendIntent({
      type: "quick_chat",
      recipient: event.recipient.id(),
      quickChatKey: event.quickChatKey,
      target: event.target,
    });
  }

  private onSendEmbargoIntent(event: SendEmbargoIntentEvent) {
    this.sendIntent({
      type: "embargo",
      targetID: event.target.id(),
      action: event.action,
    });
  }

  private onSendEmbargoAllIntent(event: SendEmbargoAllIntentEvent) {
    this.sendIntent({
      type: "embargo_all",
      action: event.action,
    });
  }

  private onBuildUnitIntent(event: BuildUnitIntentEvent) {
    this.sendIntent({
      type: "build_unit",
      unit: event.unit,
      tile: event.tile,
      rocketDirectionUp: event.rocketDirectionUp,
      amount: event.amount,
    });
  }

  private onPauseGameIntent(event: PauseGameIntentEvent) {
    this.sendIntent({
      type: "toggle_pause",
      paused: event.paused,
    });
  }

  private onSendWinnerEvent(event: SendWinnerEvent) {
    if (this.isLocal || this.socket?.readyState === WebSocket.OPEN) {
      this.sendMsg({
        type: "winner",
        winner: event.winner,
        allPlayersStats: event.allPlayersStats,
      } satisfies ClientSendWinnerMessage);
    } else {
      console.log(
        "WebSocket is not open. Current state:",
        this.socket?.readyState,
      );
      console.log("attempting reconnect");
    }
  }

  private onSendLiveStatsEvent(event: SendLiveStatsEvent) {
    if (this.isLocal || this.socket?.readyState === WebSocket.OPEN) {
      this.sendMsg({
        type: "live_stats",
        stats: event.stats,
      } satisfies ClientSendLiveStatsMessage);
    }
  }

  private onSendHashEvent(event: SendHashEvent) {
    if (this.isLocal || this.socket?.readyState === WebSocket.OPEN) {
      this.sendMsg({
        type: "hash",
        turnNumber: event.tick,
        hash: event.hash,
      } satisfies ClientHashMessage);
    } else {
      console.log(
        "WebSocket is not open. Current state:",
        this.socket?.readyState,
      );
      console.log("attempting reconnect");
    }
  }

  private onCancelAttackIntentEvent(event: CancelAttackIntentEvent) {
    this.sendIntent({
      type: "cancel_attack",
      attackID: event.attackID,
    });
  }

  private onCancelBoatIntentEvent(event: CancelBoatIntentEvent) {
    this.sendIntent({
      type: "cancel_boat",
      unitID: event.unitID,
    });
  }

  private onMoveWarshipEvent(event: MoveWarshipIntentEvent) {
    this.sendIntent({
      type: "move_warship",
      unitIds: event.unitIds,
      tile: event.tile,
    });
  }

  private onSendDeleteUnitIntent(event: SendDeleteUnitIntentEvent) {
    this.sendIntent({
      type: "delete_unit",
      unitId: event.unitId,
    });
  }

  private onSendKickPlayerIntent(event: SendKickPlayerIntentEvent) {
    this.sendIntent({
      type: "kick_player",
      targetClientID: event.target,
    });
  }

  private onSendUpdateGameConfigIntent(event: SendUpdateGameConfigIntentEvent) {
    this.sendIntent({
      type: "update_game_config",
      config: event.config,
    });
  }

  private onSendToggleGameStartTimer(event: SendToggleGameStartTimer) {
    this.sendIntent({ type: "toggle_game_start_timer" });
  }

  private sendIntent(intent: Intent) {
    if (this.idleControlsLocked && intent.type !== "idle_mode") return;
    if (intent.type === "spawn") {
      window.dispatchEvent(
        new CustomEvent("idlefront:diagnostic", {
          detail: {
            scope: "spawn-transport",
            message: `sending spawn intent socket=${this.socket?.readyState ?? "local"}`,
          },
        }),
      );
    }
    if (this.isLocal || this.socket?.readyState === WebSocket.OPEN) {
      if (intent.type === "idle_mode") this.idlePresencePending = false;
      const msg = {
        type: "intent",
        intent: intent,
      } satisfies ClientIntentMessage;
      this.sendMsg(msg);
    } else {
      console.log(
        "WebSocket is not open. Current state:",
        this.socket?.readyState,
      );
      console.log("attempting reconnect");
    }
  }

  private sendMsg(msg: ClientMessage) {
    if (this.isLocal) {
      // Forward message to local server
      this.localServer.onMessage(msg);
      return;
    } else if (this.socket === null) {
      // Socket missing, do nothing
      return;
    }
    const str = JSON.stringify(msg, replacer);
    if (this.socket.readyState === WebSocket.CLOSED) {
      // Buffer message
      console.warn("socket not ready, closing and trying later");
      this.socket.close();
      this.socket = null;
      this.connectRemote(this.onconnect, this.onmessage);
      this.buffer.push(str);
    } else {
      // Send the message directly
      this.socket.send(str);
    }
  }

  private killExistingSocket(): void {
    if (this.socket === null) {
      return;
    }
    // Remove all event listeners
    this.socket.onmessage = null;
    this.socket.onopen = null;
    this.socket.onclose = null;
    this.socket.onerror = null;

    // Close the connection if it's still open or still connecting
    try {
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close();
      }
    } catch (e) {
      console.warn("Error while closing WebSocket:", e);
    }

    this.socket = null;
  }
}
