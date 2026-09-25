import type { Game } from "../../core/game/Game";

/** Cardinal, passable land contacts; no repeated whole-front scans for fog. */
export class TerritoryContactIndex {
  private readonly contacts = new Map<number, Map<number, number>>();
  private readonly neighbors: number[] = [0, 0, 0, 0];
  private readonly unsubscribe: () => void;
  private readonly unsubscribeWater: () => void;

  constructor(private readonly game: Game) {
    // Attach before the first simulation tick. Restored games rebuild through
    // the same replay, rather than taking a second full-world ownership copy.
    if (game.allPlayers().some((player) => player.numTilesOwned() > 0))
      throw new Error("Territory contact index must attach before spawning");
    this.unsubscribe = game.observeTerritory((tile, before, after) => {
      if (before === after) return;
      const map = game.map();
      const count = map.neighbors4(tile, this.neighbors);
      for (let i = 0; i < count; i++) {
        const neighbor = this.neighbors[i];
        // One paged terrain lookup instead of separate land/magnitude reads.
        const terrain = map.terrainByte(neighbor);
        if (!(terrain & 128) || (terrain & 31) === 31) continue;
        const owner = map.ownerID(neighbor);
        if (owner !== before) this.adjust(before, owner, -1);
        if (owner !== after) this.adjust(after, owner, 1);
      }
    });
    this.unsubscribeWater = game.observeWaterConversions((tile) => {
      game.forEachNeighbor(tile, (neighbor) => {
        if (!game.isLand(neighbor) || game.isImpassable(neighbor)) return;
        const owner = game.ownerID(neighbor);
        if (owner) this.adjust(0, owner, -1);
      });
    });
  }

  neighborsOf(owner: number): readonly number[] {
    return [...(this.contacts.get(owner)?.keys() ?? [])];
  }

  edgeCount(a: number, b: number): number {
    return this.contacts.get(a)?.get(b) ?? 0;
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeWater();
  }

  private adjust(a: number, b: number, delta: number): void {
    this.adjustOne(a, b, delta);
    this.adjustOne(b, a, delta);
  }

  private adjustOne(a: number, b: number, delta: number): void {
    let edges = this.contacts.get(a);
    const count = (edges?.get(b) ?? 0) + delta;
    if (count < 0)
      throw new Error("Territory contact index lost synchronization");
    if (!count) {
      edges?.delete(b);
      if (!edges?.size) this.contacts.delete(a);
    } else {
      if (!edges) this.contacts.set(a, (edges = new Map()));
      edges.set(b, count);
    }
  }
}
