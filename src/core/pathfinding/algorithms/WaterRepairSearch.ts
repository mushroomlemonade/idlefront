import type { GameMap, TileRef } from "../../game/GameMap";
import { TileNodeIndex } from "./TileNodeIndex";

/** Reusable local search records. One tile lookup replaces costs/parents/closed
 * hash tables; typed heap entries avoid allocating tuples on every push. The
 * comparison operators and neighbor order match the original repair exactly. */
export class WaterRepairSearch {
  private index = new TileNodeIndex();
  private count = 0;
  private tiles = new Uint32Array(2048);
  private parents = new Uint32Array(2048);
  private costs = new Uint32Array(2048);
  private closed = new Uint8Array(2048);
  private heapNodes = new Uint32Array(2048);
  private heapScores = new Uint32Array(2048);
  private heapSize = 0;
  private neighbors: TileRef[] = [0, 0, 0, 0];

  constructor(
    private readonly map: Pick<
      GameMap,
      "isWater" | "neighbors4" | "manhattanDist" | "x" | "y"
    >,
  ) {}

  private node(tile: TileRef): number {
    const existing = this.index.get(tile);
    if (existing !== undefined) return existing;
    const i = this.count++;
    if (i === this.tiles.length) {
      const length = this.tiles.length * 2;
      const tiles = new Uint32Array(length),
        parents = new Uint32Array(length),
        costs = new Uint32Array(length),
        closed = new Uint8Array(length);
      tiles.set(this.tiles);
      parents.set(this.parents);
      costs.set(this.costs);
      closed.set(this.closed);
      this.tiles = tiles;
      this.parents = parents;
      this.costs = costs;
      this.closed = closed;
    }
    this.index.set(tile, i);
    this.tiles[i] = tile;
    this.parents[i] = i;
    this.costs[i] = 0xffffffff;
    this.closed[i] = 0;
    return i;
  }

  private push(node: number, priority: number): void {
    let i = this.heapSize++;
    if (i === this.heapNodes.length) {
      const nodes = new Uint32Array(this.heapNodes.length * 2),
        scores = new Uint32Array(this.heapScores.length * 2);
      nodes.set(this.heapNodes);
      scores.set(this.heapScores);
      this.heapNodes = nodes;
      this.heapScores = scores;
    }
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heapScores[p] <= priority) break;
      this.heapNodes[i] = this.heapNodes[p];
      this.heapScores[i] = this.heapScores[p];
      i = p;
    }
    this.heapNodes[i] = node;
    this.heapScores[i] = priority;
  }

  private pop(): number {
    const result = this.heapNodes[0];
    const lastIndex = --this.heapSize;
    const lastNode = this.heapNodes[lastIndex],
      lastScore = this.heapScores[lastIndex];
    if (this.heapSize) {
      let i = 0;
      while (i * 2 + 1 < this.heapSize) {
        let child = i * 2 + 1;
        if (
          child + 1 < this.heapSize &&
          this.heapScores[child + 1] < this.heapScores[child]
        )
          child++;
        if (this.heapScores[child] >= lastScore) break;
        this.heapNodes[i] = this.heapNodes[child];
        this.heapScores[i] = this.heapScores[child];
        i = child;
      }
      this.heapNodes[i] = lastNode;
      this.heapScores[i] = lastScore;
    }
    return result;
  }

  search(
    starts: readonly TileRef[],
    to: TileRef,
    corridor: ReadonlySet<number>,
    blocksWide: number,
  ): TileRef[] | null {
    this.index.clear();
    this.count = 0;
    this.heapSize = 0;
    // Avoid retaining an exceptional multi-source query's high-water allocation.
    if (this.tiles.length > 1_048_576) {
      this.tiles = new Uint32Array(2048);
      this.parents = new Uint32Array(2048);
      this.costs = new Uint32Array(2048);
      this.closed = new Uint8Array(2048);
    }
    if (this.heapNodes.length > 1_048_576) {
      this.heapNodes = new Uint32Array(2048);
      this.heapScores = new Uint32Array(2048);
    }
    const endpoints = new Set([...starts, to]);
    for (const tile of starts) {
      const node = this.node(tile);
      this.costs[node] = 0;
      this.parents[node] = node;
      this.push(node, this.map.manhattanDist(tile, to));
    }
    let closedCount = 0;
    while (this.heapSize && closedCount < 200_000) {
      const node = this.pop(),
        tile = this.tiles[node];
      if (this.closed[node]) continue;
      if (tile === to) {
        const route = [to];
        let cursor = node;
        while (this.parents[cursor] !== cursor) {
          cursor = this.parents[cursor];
          route.push(this.tiles[cursor]);
        }
        return route.reverse();
      }
      this.closed[node] = 1;
      closedCount++;
      const count = this.map.neighbors4(tile, this.neighbors);
      const nextCost = this.costs[node] + 1;
      for (let i = 0; i < count; i++) {
        const next = this.neighbors[i];
        const existing = this.index.get(next);
        if (existing !== undefined && this.closed[existing]) continue;
        if (!this.map.isWater(next) && !endpoints.has(next)) continue;
        const block =
          Math.floor(this.map.y(next) / 16) * blocksWide +
          Math.floor(this.map.x(next) / 16);
        if (!corridor.has(block)) continue;
        if (existing !== undefined && nextCost >= this.costs[existing])
          continue;
        const nextNode = existing ?? this.node(next);
        this.costs[nextNode] = nextCost;
        this.parents[nextNode] = node;
        this.push(nextNode, nextCost + this.map.manhattanDist(next, to));
      }
    }
    return null;
  }
}
