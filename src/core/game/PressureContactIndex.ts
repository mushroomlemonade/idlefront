import type { Game, Player } from "./Game";

interface Contacts {
  counts: Map<number, number>;
  ordered: Map<number, number>;
  orderDirty: boolean;
  terrainDirty: boolean;
}

/** Directed cardinal contacts. Memory scales with neighboring players, not
 * border tiles. Legacy attack order is materialized only when requested. */
export class PressureContactIndex {
  private owners = new Map<number, Contacts>();
  private neighbors = [0, 0, 0, 0];
  readonly metrics = { seededTiles: 0, updatedTiles: 0, orderTiles: 0 };
  constructor(protected game: Game) {
    game.observeTerritory((tile, before, after) => {
      if (before === after) return;
      this.metrics.updatedTiles++;
      const count = game.map().neighbors4(tile, this.neighbors);
      const passable = game.isLand(tile) && !game.isImpassable(tile);
      for (let i = 0; i < count; i++) {
        const neighbor = this.neighbors[i],
          owner = game.ownerID(neighbor);
        if (game.isLand(neighbor) && !game.isImpassable(neighbor)) {
          if (owner !== before) this.adjust(before, owner, -1);
          if (owner !== after) this.adjust(after, owner, 1);
        }
        if (passable) {
          if (owner !== before) this.adjust(owner, before, -1);
          if (owner !== after) this.adjust(owner, after, 1);
        }
        this.markOrderDirty(owner);
      }
      this.markOrderDirty(before);
      this.markOrderDirty(after);
    });
    // Terrain callbacks have no old byte. Re-seed only affected owners on rare
    // terrain edits instead of maintaining a second terrain/edge map.
    game.map().observeTerrain?.((tile) => {
      const mark = (owner: number) => {
        const state = this.owners.get(owner);
        if (state) state.terrainDirty = true;
      };
      mark(game.ownerID(tile));
      const count = game.map().neighbors4(tile, this.neighbors);
      for (let i = 0; i < count; i++) mark(game.ownerID(this.neighbors[i]));
    });
  }
  private markOrderDirty(owner: number) {
    const state = this.owners.get(owner);
    if (state) state.orderDirty = true;
  }
  private adjust(owner: number, other: number, delta: number) {
    const state = this.owners.get(owner);
    if (!state || state.terrainDirty) return;
    const value = (state.counts.get(other) ?? 0) + delta;
    if (value < 0)
      throw new Error("Pressure contact index lost synchronization");
    if (value) state.counts.set(other, value);
    else state.counts.delete(other);
  }
  private seed(player: Player): Contacts {
    const counts = new Map<number, number>();
    for (const tile of player.borderTiles()) {
      this.metrics.seededTiles++;
      const count = this.game.map().neighbors4(tile, this.neighbors);
      for (let i = 0; i < count; i++) {
        const neighbor = this.neighbors[i],
          owner = this.game.ownerID(neighbor);
        if (
          owner !== player.smallID() &&
          this.game.isLand(neighbor) &&
          !this.game.isImpassable(neighbor)
        )
          counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
    }
    const state = {
      counts,
      ordered: new Map(counts),
      orderDirty: false,
      terrainDirty: false,
    };
    this.owners.set(player.smallID(), state);
    return state;
  }
  counts(player: Player): Map<number, number> {
    let state = this.owners.get(player.smallID());
    if (!state || state.terrainDirty || !this.game.map().observeTerrain)
      state = this.seed(player);
    return state.counts;
  }
  get(player: Player): Map<number, number> {
    const counts = this.counts(player),
      state = this.owners.get(player.smallID())!;
    if (!state.orderDirty) return state.ordered;
    const ordered = new Map<number, number>();
    if (counts.size)
      for (const tile of player.borderTiles()) {
        this.metrics.orderTiles++;
        const count = this.game.map().neighbors4(tile, this.neighbors);
        for (let i = 0; i < count; i++) {
          const neighbor = this.neighbors[i],
            owner = this.game.ownerID(neighbor);
          if (
            !ordered.has(owner) &&
            counts.has(owner) &&
            this.game.isLand(neighbor) &&
            !this.game.isImpassable(neighbor)
          )
            ordered.set(owner, counts.get(owner)!);
        }
        if (ordered.size === counts.size) break;
      }
    state.ordered = ordered;
    state.orderDirty = false;
    return ordered;
  }
}
