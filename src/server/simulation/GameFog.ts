import {
  PlayerType,
  UnitType,
  type Game,
  type Player,
} from "../../core/game/Game";
import { DirtyFogTiles } from "./DirtyFogTiles";
import {
  PlayerVisibility,
  type ExplorationCheckpoint,
} from "./PlayerVisibility";
import { circularSightFootprint } from "./SightFootprint";
import { TerritoryContactIndex } from "./TerritoryContactIndex";
import type { QueryVisibility } from "./ViewQueryAuthority";
import { VisibilityUnitIndex } from "./VisibilityUnitIndex";

/** Provisional discovery distances in native map tiles; no combat modifiers. */
export const FOG_DISCOVERY_DEFAULTS = {
  borderHalo: 5,
  transport: 8,
  warship: 24,
  train: 10,
  globalLandFraction: 0.35,
};

export interface GameFogCheckpoint {
  version: 1;
  matchID: string;
  width: number;
  height: number;
  tick: number;
  nations: {
    playerID: string;
    expanded: boolean;
    global: boolean;
    exploration: ExplorationCheckpoint;
  }[];
}

export class NationFog implements QueryVisibility {
  coverage: PlayerVisibility;
  readonly pendingTiles = new DirtyFogTiles();
  changedTiles: Uint32Array = new Uint32Array(0);
  readonly owners = new Set<number>();
  readonly scouts = new Map<number, { tile: number; radius: number }>();
  private readonly visibleOwnerTiles = new Map<number, number>();
  expanded = false;
  global = false;

  constructor(
    readonly player: Player,
    private readonly game: Game,
    readonly units: VisibilityUnitIndex,
  ) {
    this.coverage = new PlayerVisibility(
      game.width() * game.height(),
      (tile, visible) => {
        this.changeVisibleOwner(game.ownerID(tile), visible ? 1 : -1);
        this.pendingTiles.add(tile);
      },
    );
    this.owners.add(player.smallID());
  }
  isVisible(tile: number): boolean {
    return (
      this.game.isValidRef(tile) &&
      (this.global ||
        this.owners.has(this.game.ownerID(tile)) ||
        this.coverage.isVisible(tile))
    );
  }
  canInspectPlayer(smallID: number): boolean {
    return (
      smallID > 0 &&
      (this.global ||
        this.owners.has(smallID) ||
        (this.visibleOwnerTiles.get(smallID) ?? 0) > 0)
    );
  }
  changeVisibleOwner(owner: number, delta: number): void {
    if (owner === 0) return;
    const count = (this.visibleOwnerTiles.get(owner) ?? 0) + delta;
    if (count < 0) throw new Error("Visible owner index lost synchronization");
    if (count === 0) this.visibleOwnerTiles.delete(owner);
    else this.visibleOwnerTiles.set(owner, count);
  }
  isExplored(tile: number): boolean {
    return this.isVisible(tile) || this.coverage.isExplored(tile);
  }
  releaseLocalCoverage(): void {
    if (!this.global) throw new Error("Local fog is still required");
    this.coverage = new PlayerVisibility(
      this.game.width() * this.game.height(),
    );
    this.scouts.clear();
    this.visibleOwnerTiles.clear();
    this.pendingTiles.drain();
    this.changedTiles = new Uint32Array(0);
  }
}

/**
 * Deterministic authority-side discovery. Construct before spawning and advance
 * on every turn, including recovery and while humans are offline. Not yet
 * enabled for public matches until the complete filtered view path is ready.
 */
export class GameFog {
  readonly contacts: TerritoryContactIndex;
  readonly units: VisibilityUnitIndex;
  private readonly nations = new Map<string, NationFog>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly game: Game,
    readonly matchID: string,
  ) {
    this.contacts = new TerritoryContactIndex(game);
    this.units = new VisibilityUnitIndex(game);
    for (const player of game.allPlayers()) {
      if (player.type() === PlayerType.Human)
        this.nations.set(player.id(), new NationFog(player, game, this.units));
    }
    this.unsubscribe = game.observeTerritory((tile, before, after) => {
      if (before === after) return;
      for (const fog of this.nations.values()) {
        if (fog.global) continue;
        if (fog.coverage.isVisible(tile)) {
          fog.changeVisibleOwner(before, -1);
          fog.changeVisibleOwner(after, 1);
        }
        const self = fog.player.smallID();
        if (before === self || after === self) {
          const halo = circularSightFootprint(
            game.width(),
            game.height(),
            game.x(tile),
            game.y(tile),
            FOG_DISCOVERY_DEFAULTS.borderHalo,
          );
          fog.coverage.adjustCoverage(halo, after === self ? 1 : -1);
        }
        if (
          fog.global ||
          fog.owners.has(before) ||
          fog.owners.has(after) ||
          fog.coverage.isVisible(tile)
        ) {
          fog.coverage.explore(tile);
          fog.pendingTiles.add(tile);
        }
      }
    });
  }

  forClient(clientID: string): NationFog {
    const player = this.game.playerByClientID(clientID);
    const fog = player && this.nations.get(player.id());
    if (!fog)
      throw new Error("No player visibility for this authenticated seat");
    return fog;
  }

  /** Includes offline human seats; visibility is not tied to connected sockets. */
  isObservedPlayer(smallID: number): boolean {
    for (const fog of this.nations.values())
      if (fog.canInspectPlayer(smallID)) return true;
    return false;
  }
  isObservedTile(tile: number): boolean {
    for (const fog of this.nations.values())
      if (fog.isVisible(tile)) return true;
    return false;
  }

  checkpoint(): GameFogCheckpoint {
    return {
      version: 1,
      matchID: this.matchID,
      width: this.game.width(),
      height: this.game.height(),
      tick: this.game.ticks(),
      nations: [...this.nations.values()].map((fog) => ({
        playerID: fog.player.id(),
        expanded: fog.expanded,
        global: fog.global,
        exploration: fog.coverage.checkpoint(),
      })),
    };
  }

  /** Only authority storage may supply this; never accept it from a client. */
  restoreExploration(checkpoint: GameFogCheckpoint): void {
    if (
      checkpoint.version !== 1 ||
      checkpoint.matchID !== this.matchID ||
      checkpoint.width !== this.game.width() ||
      checkpoint.height !== this.game.height() ||
      !Number.isSafeInteger(checkpoint.tick) ||
      checkpoint.tick < 0 ||
      checkpoint.tick > this.game.ticks()
    )
      throw new Error("Fog checkpoint does not belong to this match state");
    const seen = new Set<string>();
    // Validate every entry before changing any player's state.
    for (const entry of checkpoint.nations) {
      if (
        !this.nations.has(entry.playerID) ||
        seen.has(entry.playerID) ||
        typeof entry.expanded !== "boolean" ||
        typeof entry.global !== "boolean" ||
        entry.exploration.tileCount !== this.game.width() * this.game.height()
      )
        throw new Error("Invalid fog checkpoint player");
      PlayerVisibility.restore(entry.exploration);
      seen.add(entry.playerID);
    }
    for (const entry of checkpoint.nations) {
      const fog = this.nations.get(entry.playerID)!;
      fog.coverage.mergeExploration(entry.exploration);
      fog.expanded ||= entry.expanded;
      fog.global ||= entry.global;
      if (fog.global) fog.releaseLocalCoverage();
    }
    this.advance();
  }

  advance(): void {
    const game = this.game;
    this.units.advance();
    for (const fog of this.nations.values()) {
      if (fog.global) {
        // Permanent global sight needs no per-tile counters or scout updates.
        continue;
      }
      const player = fog.player;
      const friendly = new Set<Player>([player, ...player.allies()]);
      if (player.team() !== null)
        for (const other of game.allPlayers())
          if (player.isOnSameTeam(other)) friendly.add(other);
      const hasStructures = player
        .units()
        .some(
          (unit) =>
            !unit.isUnderConstruction() &&
            (unit.type() === UnitType.City || unit.type() === UnitType.Factory),
        );
      if (
        player.hasSpawned() &&
        player.numTilesOwned() > 0 &&
        (hasStructures || this.contacts.edgeCount(player.smallID(), 0) === 0)
      )
        fog.expanded = true;
      const owners = new Set([...friendly].map((p) => p.smallID()));
      // Contact reveals that neighbour immediately, even with wilderness left.
      // Only walk friendly contacts, never contacts of the revealed enemy.
        for (const ally of friendly)
          for (const id of this.contacts.neighborsOf(ally.smallID()))
            if (id > 0) owners.add(id);
      // Direct friends and their fronts, never recursive enemy neighbours.
      for (const id of owners)
        if (!fog.owners.has(id)) {
          const owner = game.playerBySmallID(id);
          if (owner.isPlayer())
            for (const tile of owner.tiles()) fog.coverage.explore(tile);
        }
      for (const id of new Set([...fog.owners, ...owners])) {
        if (fog.owners.has(id) === owners.has(id)) continue;
        const owner = game.playerBySmallID(id);
        if (owner.isPlayer())
          for (const tile of owner.tiles()) fog.pendingTiles.add(tile);
      }
      fog.owners.clear();
      for (const id of owners) fog.owners.add(id);
      const friendlyLand = [...friendly].reduce(
        (sum, ally) => sum + ally.numTilesOwned(),
        0,
      );
      if (
        !fog.global &&
        friendlyLand / Math.max(1, game.map().numLandTiles()) >=
          FOG_DISCOVERY_DEFAULTS.globalLandFraction
      ) {
        fog.global = true;
        fog.releaseLocalCoverage();
        continue;
      }
      const present = new Set<number>();
      for (const ally of friendly)
        for (const unit of ally.units()) {
          if (!unit.isActive() || unit.isUnderConstruction()) continue;
          let radius: number;
          switch (unit.type()) {
            case UnitType.Factory:
              radius = game.config().trainStationMaxRange();
              break;
            case UnitType.Warship:
              radius = FOG_DISCOVERY_DEFAULTS.warship;
              break;
            case UnitType.TransportShip:
              radius = FOG_DISCOVERY_DEFAULTS.transport;
              break;
            case UnitType.Train:
              radius = FOG_DISCOVERY_DEFAULTS.train;
              break;
            default:
              continue; // Trade ships deliberately provide no direct sight.
          }
          present.add(unit.id());
          const previous = fog.scouts.get(unit.id());
          if (previous?.tile === unit.tile() && previous.radius === radius)
            continue;
          fog.scouts.set(unit.id(), { tile: unit.tile(), radius });
          fog.coverage.setSource(
            `unit:${unit.id()}`,
            circularSightFootprint(
              game.width(),
              game.height(),
              game.x(unit.tile()),
              game.y(unit.tile()),
              radius,
            ),
          );
        }
      for (const id of fog.scouts.keys())
        if (!present.has(id)) {
          fog.coverage.removeSource(`unit:${id}`);
          fog.scouts.delete(id);
        }
      fog.changedTiles = fog.pendingTiles.drain();
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.contacts.dispose();
    this.units.dispose();
  }
}
