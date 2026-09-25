import type { GameMap, TileRef } from "./GameMap";
import type { TileSet } from "./TileSet";

type Witness = { tile: TileRef; offset: number };
type Frontier = {
  contacts: Map<number, Witness>;
  dirty: boolean;
  result?: number[];
};

/** An ordered contact certificate stores only each country's FIRST occurrence,
 * not an object graph for every border tile. Most changes cannot affect that
 * certificate. If a first witness disappears, rebuild lazily on the next query:
 * paying for thousands of intermediate expansion states would cost more than
 * the scan this replaces. Stable fronts use incremental local updates. */
export class OrderedContactIndex {
  private frontiers = new Map<number, Frontier>();
  private neighbors = [0, 0, 0, 0];
  private affected = [0, 0, 0, 0];
  constructor(
    private map: GameMap,
    private borders: (id: number) => TileSet,
  ) {}

  neighborsOf(id: number): number[] {
    let f = this.frontiers.get(id);
    if (!f) {
      f = { contacts: new Map(), dirty: true };
      this.frontiers.set(id, f);
    }
    if (f.dirty) {
      f.contacts.clear();
      for (const tile of this.borders(id)) {
        const count = this.map.neighbors4(tile, this.neighbors);
        for (let i = 0; i < count; i++) {
          const owner = this.target(this.neighbors[i], id);
          if (owner >= 0 && !f.contacts.has(owner))
            f.contacts.set(owner, { tile, offset: i });
        }
      }
      f.dirty = false;
      f.result = [...f.contacts.keys()];
    }
    if (!f.result) {
      const borders = this.borders(id);
      f.result = [...f.contacts]
        .sort(
          (a, b) =>
            borders.positionOf(a[1].tile) - borders.positionOf(b[1].tile) ||
            a[1].offset - b[1].offset,
        )
        .map(([owner]) => owner);
    }
    return f.result;
  }

  ownershipChanged(tile: number, before: number, _after: number) {
    if (!this.frontiers.size) return;
    const previous = this.frontiers.get(before);
    // A same-owner conquer also deletes/reinserts its border slot.
    if (previous && !previous.dirty)
      for (const witness of previous.contacts.values())
        if (witness.tile === tile) {
          previous.dirty = true;
          break;
        }
    this.localChanged(tile);
  }

  localChanged(tile: number) {
    if (!this.frontiers.size) return;
    this.syncOwner(tile);
    const count = this.map.neighbors4(tile, this.affected);
    for (let i = 0; i < count; i++) this.syncOwner(this.affected[i]);
  }

  private target(tile: number, id: number): number {
    const terrain = this.map.terrainByte(tile);
    if (!(terrain & 128) || (terrain & 31) === 31) return -1;
    const owner = this.map.ownerID(tile);
    return owner === id || (!owner && this.map.hasFallout(tile)) ? -1 : owner;
  }

  private syncOwner(tile: number) {
    const id = this.map.ownerID(tile),
      f = this.frontiers.get(id);
    if (!f || f.dirty) return;
    const borders = this.borders(id),
      position = borders.positionOf(tile);
    const count = position < 0 ? 0 : this.map.neighbors4(tile, this.neighbors);
    // Losing a first occurrence needs an ordered scan, but only if queried.
    for (const [owner, witness] of f.contacts) {
      if (witness.tile !== tile) continue;
      let offset = -1;
      for (let i = 0; i < count; i++)
        if (this.target(this.neighbors[i], id) === owner) {
          offset = i;
          break;
        }
      if (offset < 0) {
        f.dirty = true;
        return;
      }
      if (witness.offset !== offset) {
        witness.offset = offset;
        f.result = undefined;
      }
    }
    for (let i = 0; i < count; i++) {
      const owner = this.target(this.neighbors[i], id);
      if (owner < 0) continue;
      const old = f.contacts.get(owner);
      if (
        !old ||
        position < borders.positionOf(old.tile) ||
        (old.tile === tile && i < old.offset)
      ) {
        f.contacts.set(owner, { tile, offset: i });
        f.result = undefined;
      }
    }
  }
}
