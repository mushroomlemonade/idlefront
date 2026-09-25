import { AllPlayers, type Game } from "../../core/game/Game";
import {
  GameUpdateType,
  type GameUpdateViewData,
  type PlayerUpdate,
  type UnitUpdate,
} from "../../core/game/GameUpdates";
import {
  packMotionPlans,
  unpackMotionPlans,
} from "../../core/game/MotionPlans";
import { PlayerImpl } from "../../core/game/PlayerImpl";
import { FogRailProjection } from "./FogRailProjection";
import {
  fogExplorationSnapshot,
  projectFogTerrain,
  projectFogTileRuns,
} from "./FogTileProjection";
import type { NationFog } from "./GameFog";
import { emptyView } from "./ViewSnapshot";

/** Deny-by-default projection. Integration stays gated until every stream uses it. */
export class FogViewProjection {
  private readonly knownUnits = new Map<number, UnitUpdate>();
  private readonly knownPlayers = new Set<number>();
  private readonly rosterSent = new Set<number>();
  private readonly rails = new FogRailProjection();
  private globalDelivered: boolean;

  constructor(
    private readonly game: Game,
    readonly fog: NationFog,
  ) {
    this.globalDelivered = fog.global;
  }

  needsGlobalSnapshot(): boolean {
    if (!this.fog.global || this.globalDelivered) return false;
    this.globalDelivered = true;
    return true;
  }

  project(source: GameUpdateViewData): GameUpdateViewData {
    // Permanent end-game discovery returns to the compact native stream,
    // including shared motion plans. Never expand every ship into JSON/tick.
    if (this.fog.global)
      return {
        ...source,
        updates: {
          ...source.updates,
          [GameUpdateType.Player]: source.updates[GameUpdateType.Player].map(
            (update) =>
              update.id === this.fog.player.id()
                ? update
                : { ...update, fleet: undefined },
          ),
        },
        fog: {
          enabled: true,
          global: true,
          hiddenPlayers: new Uint16Array(0),
          forgottenUnits: new Uint32Array(0),
        },
      };
    const view = emptyView(source.tick);
    view.pendingTurns = source.pendingTurns;
    view.serverTickExecutionDuration = source.serverTickExecutionDuration;
    view.updates[GameUpdateType.SpawnPhaseEnd] =
      source.updates[GameUpdateType.SpawnPhaseEnd];
    view.updates[GameUpdateType.GamePaused] =
      source.updates[GameUpdateType.GamePaused];
    view.updates[GameUpdateType.Win] = source.updates[GameUpdateType.Win];
    const self = this.fog.player.smallID();
    view.updates[GameUpdateType.DisplayChatEvent] = source.updates[
      GameUpdateType.DisplayChatEvent
    ].filter((event) => event.playerID === self || event.playerID === null);
    view.updates[GameUpdateType.DisplayEvent] = source.updates[
      GameUpdateType.DisplayEvent
    ]
      .filter((event) => event.playerID === self)
      .map((event) => ({
        ...event,
        unitID: undefined,
        focusPlayerID: undefined,
      }));
    view.updates[GameUpdateType.AllianceRequest] = source.updates[
      GameUpdateType.AllianceRequest
    ].filter(
      (event) => event.requestorID === self || event.recipientID === self,
    );
    view.updates[GameUpdateType.AllianceRequestReply] = source.updates[
      GameUpdateType.AllianceRequestReply
    ].filter(
      (event) =>
        event.request.requestorID === self ||
        event.request.recipientID === self,
    );
    view.updates[GameUpdateType.BrokeAlliance] = source.updates[
      GameUpdateType.BrokeAlliance
    ].filter((event) => event.traitorID === self || event.betrayedID === self);
    view.updates[GameUpdateType.AllianceExpired] = source.updates[
      GameUpdateType.AllianceExpired
    ].filter((event) => event.player1ID === self || event.player2ID === self);
    view.updates[GameUpdateType.AllianceExtension] = source.updates[
      GameUpdateType.AllianceExtension
    ].filter((event) => event.playerID === self);
    view.updates[GameUpdateType.EmbargoEvent] = source.updates[
      GameUpdateType.EmbargoEvent
    ].filter((event) => event.playerID === self || event.embargoedID === self);
    view.updates[GameUpdateType.TargetPlayer] = source.updates[
      GameUpdateType.TargetPlayer
    ].filter(
      (event) =>
        event.playerID === self && this.fog.canInspectPlayer(event.targetID),
    );
    view.updates[GameUpdateType.Emoji] = source.updates[
      GameUpdateType.Emoji
    ].filter(
      ({ emoji }) =>
        emoji.senderID === self ||
        ((emoji.recipientID === self || emoji.recipientID === AllPlayers) &&
          this.fog.canInspectPlayer(emoji.senderID)),
    );
    const playerID = this.fog.player.id();
    view.updates[GameUpdateType.BonusEvent] = source.updates[
      GameUpdateType.BonusEvent
    ].filter(
      (event) => event.player === playerID && this.fog.isVisible(event.tile),
    );
    view.updates[GameUpdateType.ConquestEvent] = source.updates[
      GameUpdateType.ConquestEvent
    ].filter(
      (event) =>
        event.conquerorId === playerID || event.conqueredId === playerID,
    );
    view.updates[GameUpdateType.DonateEvent] = source.updates[
      GameUpdateType.DonateEvent
    ].filter(
      (event) => event.senderId === playerID || event.recipientId === playerID,
    );
    view.updates[GameUpdateType.UnitIncoming] = source.updates[
      GameUpdateType.UnitIncoming
    ].filter((event) => {
      const unit = this.game.unit(event.unitID);
      return (
        event.playerID === self && !!unit && this.fog.isVisible(unit.tile())
      );
    });
    view.packedTileRuns = projectFogTileRuns(
      this.game.map(),
      this.fog,
      source.packedTileUpdates,
    );
    view.packedTerrainUpdates = projectFogTerrain(
      this.game.map(),
      this.fog,
      view.packedTileRuns,
    );
    view.packedNukeImpacts = source.packedNukeImpacts?.filter((tile) =>
      this.fog.isVisible(tile),
    );

    const hidden: number[] = [];
    const sourcePlayers = new Map(
      source.updates[GameUpdateType.Player].map((p) => [p.id, p]),
    );
    for (const player of this.game.allPlayers()) {
      const id = player.smallID();
      const visible = this.fog.canInspectPlayer(id);
      if (!visible) hidden.push(id);
      if (!this.knownPlayers.has(id) && visible) {
        view.updates[GameUpdateType.Player].push(
          this.player((player as PlayerImpl).toFullUpdate(), true),
        );
        this.rosterSent.add(id);
        this.knownPlayers.add(id);
      } else if (this.knownPlayers.has(id) && !visible) {
        view.updates[GameUpdateType.Player].push(
          this.player((player as PlayerImpl).toFullUpdate(), false),
        );
        this.knownPlayers.delete(id);
      } else {
        const update = sourcePlayers.get(player.id());
        if (update && (visible || !this.rosterSent.has(id))) {
          view.updates[GameUpdateType.Player].push(
            this.player(update, visible),
          );
          this.rosterSent.add(id);
        }
      }
    }
    view.packedPlayerUpdates = this.quads(source.packedPlayerUpdates);
    // Attack-array indexes are only meaningful for players whose full arrays
    // are retained. Only the viewer receives those private arrays.
    view.packedAttackUpdates = this.quads(source.packedAttackUpdates, true);
    if (source.playerNameViewData) {
      view.playerNameViewData = Object.fromEntries(
        Object.entries(source.playerNameViewData).filter(
          ([id, name]) =>
            this.game.hasPlayer(id) &&
            this.fog.canInspectPlayer(this.game.player(id).smallID()) &&
            this.game.isValidCoord(name.x, name.y) &&
            this.fog.isVisible(this.game.ref(name.x, name.y)),
        ),
      );
    }
    const visibleUnits = new Set<number>();
    const unitUpdates = new Map(
      source.updates[GameUpdateType.Unit].map((unit) => [unit.id, unit]),
    );
    const candidates = new Set(this.knownUnits.keys());
    for (const id of unitUpdates.keys()) candidates.add(id);
    for (const id of this.fog.units.changed) {
      const unit = this.game.unit(id);
      if (
        unit &&
        (unit.owner() === this.fog.player || this.fog.isVisible(unit.tile()))
      )
        candidates.add(id);
    }
    let previousPage = -1;
    for (const tile of this.fog.changedTiles) {
      const page = tile >>> 12;
      if (page === previousPage) continue;
      previousPage = page;
      for (const id of this.fog.units.onPage(page)) candidates.add(id);
    }
    for (const id of candidates) {
      const unit = this.game.unit(id);
      if (!unit) continue;
      if (!unit.isActive()) continue;
      if (unit.owner() !== this.fog.player && !this.fog.isVisible(unit.tile()))
        continue;
      visibleUnits.add(unit.id());
      const own = unit.owner() === this.fog.player;
      if (own && this.knownUnits.has(unit.id()) && !unitUpdates.has(unit.id()))
        continue;
      const update = unit.toUpdate();
      const safe = { ...update };
      if (!own) {
        if (!this.fog.isVisible(safe.lastPos)) safe.lastPos = safe.pos;
        if (
          safe.targetTile !== undefined &&
          !this.fog.isVisible(safe.targetTile)
        )
          safe.targetTile = undefined;
        if (safe.targetUnitId !== undefined) {
          const target = this.game.unit(safe.targetUnitId);
          if (!target || !this.fog.isVisible(target.tile()))
            safe.targetUnitId = undefined;
        }
      }
      // Newly seen units need a full state even if no engine diff was emitted.
      // Enemy movement is positional, avoiding an unrevealed path disclosure.
      if (!this.knownUnits.has(unit.id()) || !own || unitUpdates.has(unit.id()))
        view.updates[GameUpdateType.Unit].push(safe);
      this.knownUnits.set(unit.id(), safe);
    }
    const forgotten: number[] = [];
    for (const [id, previous] of this.knownUnits)
      if (!visibleUnits.has(id)) {
        const candidate = unitUpdates.get(id);
        const death = candidate && !candidate.isActive ? candidate : undefined;
        if (
          death &&
          (previous.ownerID === this.fog.player.smallID() ||
            this.fog.isVisible(death.pos))
        )
          view.updates[GameUpdateType.Unit].push({
            ...death,
            lastPos: death.pos,
          });
        else forgotten.push(id);
        this.knownUnits.delete(id);
      }
    if (source.packedMotionPlans) {
      view.packedMotionPlans = packMotionPlans(
        unpackMotionPlans(source.packedMotionPlans).filter((plan) => {
          const unit = this.game.unit(
            plan.kind === "grid" ? plan.unitId : plan.engineUnitId,
          );
          // Own routes are intentional geographic clues, never enemy routes.
          return unit?.owner() === this.fog.player;
        }),
      );
    }
    this.rails.project(source, this.fog, view);
    view.fog = {
      enabled: true,
      global:
        this.fog.global ||
        (this.game.inSpawnPhase() && !this.fog.player.hasSpawned()),
      hiddenPlayers: Uint16Array.from(hidden),
      forgottenUnits: Uint32Array.from(forgotten),
    };
    return view;
  }

  explorationSnapshot(): IterableIterator<Uint32Array> {
    return fogExplorationSnapshot(this.game.map(), this.fog);
  }

  private player(update: PlayerUpdate, visible: boolean): PlayerUpdate {
    if (update.id === this.fog.player.id()) return update;
    if (visible)
      return {
        ...update,
        fleet: undefined,
        spawnTile:
          update.spawnTile !== undefined && this.fog.isVisible(update.spawnTile)
            ? update.spawnTile
            : undefined,
        deathPosition: undefined,
        nameViewData:
          update.nameViewData &&
          this.game.isValidCoord(
            update.nameViewData.x,
            update.nameViewData.y,
          ) &&
          this.fog.isVisible(
            this.game.ref(update.nameViewData.x, update.nameViewData.y),
          )
            ? update.nameViewData
            : undefined,
        incomingAttacks: [],
        outgoingAttacks: [],
        outgoingAllianceRequests: [],
        alliances: [],
        targets: [],
        outgoingEmojis: [],
      };
    // Static roster identity is public; geography and live intelligence are not.
    return {
      type: GameUpdateType.Player,
      id: update.id,
      smallID: update.smallID,
      clientID: update.clientID,
      name: update.name,
      displayName: update.displayName,
      clanTag: update.clanTag,
      team: update.team,
      playerType: update.playerType,
      nameViewData: undefined,
      spawnTile: undefined,
      deathPosition: undefined,
      tilesOwned: 0,
      troops: 0,
      gold: 0n,
      allies: [],
      embargoes: new Set(),
      incomingAttacks: [],
      outgoingAttacks: [],
      outgoingAllianceRequests: [],
      alliances: [],
      targets: [],
      outgoingEmojis: [],
    };
  }

  private quads(
    packed?: Float64Array,
    ownOnly = false,
  ): Float64Array | undefined {
    if (!packed) return;
    const result: number[] = [];
    for (let i = 0; i + 3 < packed.length; i += 4)
      if (
        ownOnly
          ? packed[i] === this.fog.player.smallID()
          : this.fog.canInspectPlayer(packed[i])
      )
        result.push(packed[i], packed[i + 1], packed[i + 2], packed[i + 3]);
    return Float64Array.from(result);
  }
}
