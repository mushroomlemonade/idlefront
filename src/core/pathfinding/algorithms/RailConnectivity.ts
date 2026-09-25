import type { GameMap } from "../../game/GameMap";

/** Conservative weak components of the directed rail graph. Disconnected
 * components prove a route impossible. Connected components do NOT prove a
 * route valid: the unchanged directed A* still decides that. Terrain changes
 * add newly possible edges immediately; old edges may remain, making the
 * filter less selective, never causing it to reject a newly valid route. */
export class RailConnectivity {
  private parents: Uint32Array;
  private ranks: Uint8Array;
  constructor(private map: GameMap) {
    const width = map.width(),
      count = width * map.height();
    this.parents = new Uint32Array(count);
    this.ranks = new Uint8Array(count);
    for (let tile = 0; tile < count; tile++) {
      if (tile >= width) this.connectEdge(tile, tile - width);
      if (tile % width) this.connectEdge(tile, tile - 1);
    }
    map.observeTerrain?.((tile) => {
      const x = tile % width;
      if (tile >= width) this.connectEdge(tile, tile - width);
      if (tile + width < count) this.connectEdge(tile, tile + width);
      if (x) this.connectEdge(tile, tile - 1);
      if (x + 1 < width) this.connectEdge(tile, tile + 1);
    });
  }
  private root(tile: number): number {
    let current = tile;
    while (this.parents[current]) current = this.parents[current] - 1;
    while (tile !== current) {
      const next = this.parents[tile] - 1;
      this.parents[tile] = current + 1;
      tile = next;
    }
    return current;
  }
  private connectEdge(a: number, b: number): void {
    if (!this.edge(a, b) && !this.edge(b, a)) return;
    let ar = this.root(a),
      br = this.root(b);
    if (ar === br) return;
    if (this.ranks[ar] < this.ranks[br]) {
      const swap = ar;
      ar = br;
      br = swap;
    }
    this.parents[br] = ar + 1;
    if (this.ranks[ar] === this.ranks[br]) this.ranks[ar]++;
  }
  private edge(from: number, to: number): boolean {
    const map = this.map;
    return (
      !map.isImpassable(from) &&
      (!map.isWater(to) || map.isShoreline(from) || map.isShoreline(to))
    );
  }
  mayConnect(from: number | number[], to: number): boolean {
    const target = this.root(to);
    return Array.isArray(from)
      ? from.some((tile) => this.root(tile) === target)
      : this.root(from) === target;
  }
}
