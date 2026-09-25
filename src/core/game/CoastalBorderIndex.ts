import type { Game, Player } from "./Game";
import type { TileRef } from "./GameMap";
import { TileSet } from "./TileSet";

/** Index only owned shoreline candidates, not the world's interior borders.
 * Normal land expansion costs one terrain check. Rare terrain edits also
 * revisit adjacent shores. Queries retain the border set's insertion order.
 */
export class CoastalBorderIndex {
  private readonly byOwner = new Map<number, Set<TileRef>>();
  private readonly owners = new Map<TileRef, number>();
  private readonly neighbors = [0, 0, 0, 0];
  private readonly map;

  constructor(game: Game) {
    this.map = game.map();
    game.observeTerritory((tile, before, after) => {
      // Ownership cannot change a tile's terrain. A shore with an adjacent
      // water tile is necessarily a border (water cannot be player-owned).
      if (!this.map.isShore(tile)) return;
      this.byOwner.get(before)?.delete(tile);
      this.owners.delete(tile);
      const candidates = this.byOwner.get(after);
      if (candidates) {
        candidates.add(tile);
        this.owners.set(tile, after);
      }
    });
    this.map.observeTerrain?.((tile) => {
      this.sync(tile);
      const count = this.map.neighbors4(tile, this.neighbors);
      for (let i = 0; i < count; i++) this.sync(this.neighbors[i]);
    });
  }

  private sync(tile: TileRef): void {
    const previous = this.owners.get(tile);
    if (previous !== undefined) this.byOwner.get(previous)?.delete(tile);
    this.owners.delete(tile);
    const owner = this.map.ownerID(tile);
    const candidates = this.byOwner.get(owner);
    if (candidates && this.map.isShore(tile)) {
      candidates.add(tile);
      this.owners.set(tile, owner);
    }
  }

  tiles(player: Player): TileRef[] {
    const borders = player.borderTiles();
    // Without reliable terrain notifications use the original scan.
    if (!this.map.observeTerrain)
      return Array.from(borders).filter((tile) => this.map.isShore(tile));
    const id = player.smallID();
    let candidates = this.byOwner.get(id);
    if (!candidates) {
      candidates = new Set();
      this.byOwner.set(id, candidates);
      // Seed once from owned terrain, including unusual inland shoreline
      // flags that may become border tiles after a later ownership change.
      for (const tile of player.tiles()) {
        if (!this.map.isShore(tile)) continue;
        candidates.add(tile);
        this.owners.set(tile, id);
      }
    }
    if (!(borders instanceof TileSet))
      return Array.from(borders).filter((tile) => this.map.isShore(tile));
    // Inland shoreline flags can exist without actual adjacent water. Keep
    // the original border-membership filter even for those unusual maps.
    return Array.from(candidates)
      .filter((tile) => borders.has(tile))
      .sort((a, b) => borders.positionOf(a) - borders.positionOf(b));
  }
}
