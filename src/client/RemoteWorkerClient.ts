import {
  Cell,
  type BuildableUnit,
  type PlayerActions,
  type PlayerBorderTiles,
  type PlayerBuildableUnitType,
  type PlayerID,
  type PlayerProfile,
} from "../core/game/Game";
import type { ErrorUpdate, GameUpdateViewData } from "../core/game/GameUpdates";
import type { ViewQuery } from "../core/network/ViewProtocol";
import type { ClientID, GameStartInfo, Turn } from "../core/Schemas";
import { WorkerClient } from "../core/worker/WorkerClient";
import { RemoteViewIdentity } from "./RemoteViewIdentity";
import type { Transport } from "./Transport";

/** Same renderer/query interface, with no browser simulation worker. */
export class RemoteWorkerClient extends WorkerClient {
  private callback?: (update: GameUpdateViewData | ErrorUpdate) => void;
  private requestSequence = 0;
  private appliedTick: number | undefined;
  private snapshotStarted = false;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private inFlightByQuery = new Map<string, Promise<unknown>>();
  private stopped = false;
  private identities: RemoteViewIdentity;

  get isLoadingInitialView(): boolean {
    return this.appliedTick === undefined;
  }
  constructor(
    start: GameStartInfo,
    clientID: ClientID | undefined,
    private transport: Transport,
  ) {
    super(start, clientID);
    this.identities = new RemoteViewIdentity(start);
  }
  override async initialize(): Promise<void> {
    this.transport.setViewReceiver((sequence, packet) => {
      if (this.stopped) return;
      if (packet.kind === "error") {
        if (packet.id) {
          const pending = this.pending.get(packet.id);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(packet.error));
            this.pending.delete(packet.id);
          }
        } else if (packet.reload) window.location.reload();
        else this.callback?.({ errMsg: packet.error });
        return;
      }
      if (packet.kind === "result") {
        const pending = this.pending.get(packet.message.id ?? "");
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(packet.message.id!);
          pending.resolve(
            "result" in packet.message
              ? packet.message.result
              : "attacks" in packet.message
                ? packet.message.attacks
                : undefined,
          );
        }
        return;
      }
      // Acknowledge after applying the frame. Never accumulate unbounded main
      // thread messages, and leave an event-loop turn for touch/paint between
      // snapshot chunks. Only the slow connection waits for this ack.
      setTimeout(() => {
        if (this.stopped) return;
        try {
          const update = packet.update;
          if (packet.snapshot === "begin") this.snapshotStarted = true;
          if (
            !packet.snapshot &&
            this.appliedTick !== undefined &&
            update.tick <= this.appliedTick
          ) {
            return;
          }
          update.tickExecutionDuration = 0; // Simulation time belongs to the server.
          update.snapshotPhase = packet.snapshot;
          this.identities.apply(update);
          this.callback?.(update);
          if (!packet.snapshot || packet.snapshot === "end")
            this.appliedTick = update.tick;
          if (!packet.snapshot || packet.snapshot === "end") {
            window.dispatchEvent(
              new CustomEvent("idlefront:simulation-view-live", {
                detail: { tick: update.tick },
              }),
            );
          }
        } catch (error) {
          // The socket must never deadlock because a presentation callback
          // threw. That used to leave the last successfully rendered map on
          // screen, prevent spawn input, and make the server disconnect the
          // device exactly 30 seconds later for a missing ACK. Report the
          // failing stage to the native shell, but release the bounded server
          // delivery window so later frames and input can continue.
          const message =
            error instanceof Error ? error.message : String(error);
          console.error("Error applying authoritative view frame:", error);
          window.dispatchEvent(
            new CustomEvent("idlefront:diagnostic", {
              detail: {
                scope: `view-apply:${packet.snapshot ?? "live"}`,
                message: `sequence=${sequence} ${message}`,
                stack: error instanceof Error ? error.stack : undefined,
              },
            }),
          );
        } finally {
          this.transport.sendViewMessage({ type: "view_ack", sequence });
        }
      }, 0);
    });
  }
  subscribe(): void {
    // Restart an interrupted first load with a fresh view, so units that
    // died during disconnection cannot remain as ghosts in a partial map.
    if (this.snapshotStarted && this.appliedTick === undefined) {
      window.location.reload();
      return;
    }
    this.transport.sendViewMessage({
      type: "view_subscribe",
      afterTick: this.appliedTick,
    });
  }
  override start(
    callback: (update: GameUpdateViewData | ErrorUpdate) => void,
  ): void {
    this.callback = callback;
  }
  override sendTurn(_turn: Turn): void {}
  override sendTurns(_turns: readonly Turn[]): void {}
  override setFastForward(_enabled: boolean): void {}
  private ask<T>(query: Omit<ViewQuery, "id">): Promise<T> {
    const queryKey = JSON.stringify(query);
    const inFlight = this.inFlightByQuery.get(queryKey);
    if (inFlight !== undefined) return inFlight as Promise<T>;

    const id = String(++this.requestSequence);
    const request = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error("Action query timed out; reconnecting may be necessary"),
        );
      }, 10_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.transport.sendViewMessage({
        type: "view_query",
        query: { ...query, id },
      });
    });
    this.inFlightByQuery.set(queryKey, request);
    const forget = () => {
      if (this.inFlightByQuery.get(queryKey) === request)
        this.inFlightByQuery.delete(queryKey);
    };
    void request.then(forget, forget);
    return request;
  }
  override playerProfile(playerID: number): Promise<PlayerProfile> {
    return this.ask({ type: "player_profile", playerID });
  }
  override playerBorderTiles(playerID: PlayerID): Promise<PlayerBorderTiles> {
    return this.ask({ type: "player_border_tiles", playerID });
  }
  override playerInteraction(
    playerID: PlayerID,
    x?: number,
    y?: number,
    units?: readonly PlayerBuildableUnitType[] | null,
  ): Promise<PlayerActions> {
    return this.ask({
      type: "player_actions",
      playerID,
      x,
      y,
      units: units ? [...units] : units,
    });
  }
  override playerBuildables(
    playerID: PlayerID,
    x?: number,
    y?: number,
    units?: readonly PlayerBuildableUnitType[],
  ): Promise<BuildableUnit[]> {
    return this.ask({
      type: "player_buildables",
      playerID,
      x,
      y,
      units: units ? [...units] : undefined,
    });
  }
  override async attackClusteredPositions(
    playerID: number,
    attackID?: string,
  ): Promise<{ id: string; positions: Cell[] }[]> {
    const result = await this.ask<
      { id: string; positions: { x: number; y: number }[] }[]
    >({ type: "attack_clustered_positions", playerID, attackID });
    return result.map((a) => ({
      id: a.id,
      positions: a.positions.map((p) => new Cell(p.x, p.y)),
    }));
  }
  override transportShipSpawn(
    playerID: PlayerID,
    targetTile: number,
  ): Promise<number | false> {
    return this.ask({ type: "transport_ship_spawn", playerID, targetTile });
  }
  override cleanup(): void {
    this.stopped = true;
    this.transport.setViewReceiver(undefined);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Game closed"));
    }
    this.pending.clear();
    this.inFlightByQuery.clear();
    this.callback = undefined;
  }
}
