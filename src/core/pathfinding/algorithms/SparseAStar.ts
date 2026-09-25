import type { AStarConfig } from "./AStar";
import { BucketQueue } from "./PriorityQueue";
import { TileNodeIndex } from "./TileNodeIndex";

/** Same A* operations, neighbor order, integer costs, LIFO bucket ties and
 * iteration cutoff as AStar, with records proportional to visited nodes.
 * Shared between sequential rail searches, never between concurrent writers. */
export class SparseAStar {
  private index = new TileNodeIndex();
  private count = 0;
  private tiles = new Uint32Array(2048);
  private parents = new Uint32Array(2048);
  private costs = new Uint32Array(2048);
  private closed = new Uint8Array(2048);
  private queue: BucketQueue;
  private neighbors: Int32Array;
  constructor(private config: AStarConfig) {
    this.queue = new BucketQueue(config.adapter.maxPriority());
    this.neighbors = new Int32Array(config.adapter.maxNeighbors());
  }
  private node(tile: number): number {
    const previous = this.index.get(tile);
    if (previous !== undefined) return previous;
    const id = this.count++;
    if (id === this.tiles.length) {
      const n = id * 2;
      const tiles = new Uint32Array(n),
        parents = new Uint32Array(n),
        costs = new Uint32Array(n),
        closed = new Uint8Array(n);
      tiles.set(this.tiles);
      parents.set(this.parents);
      costs.set(this.costs);
      closed.set(this.closed);
      this.tiles = tiles;
      this.parents = parents;
      this.costs = costs;
      this.closed = closed;
    }
    this.index.set(tile, id);
    this.tiles[id] = tile;
    this.parents[id] = 0xffffffff;
    this.costs[id] = 0xffffffff;
    this.closed[id] = 0;
    return id;
  }
  findPath(start: number | number[], goal: number): number[] | null {
    this.index.clear();
    this.count = 0;
    this.queue.clear();
    const adapter = this.config.adapter,
      queue = this.queue;
    for (const tile of Array.isArray(start) ? start : [start]) {
      const id = this.node(tile);
      this.costs[id] = 0;
      this.parents[id] = 0xffffffff;
      queue.push(id, adapter.heuristic(tile, goal));
    }
    let iterations = this.config.maxIterations ?? 500_000;
    while (!queue.isEmpty()) {
      if (--iterations <= 0) return null;
      const current = queue.pop();
      if (this.closed[current]) continue;
      this.closed[current] = 1;
      const tile = this.tiles[current];
      if (tile === goal) {
        const path: number[] = [];
        for (let id = current; id !== 0xffffffff; id = this.parents[id])
          path.push(this.tiles[id]);
        return path.reverse();
      }
      const previous = this.parents[current];
      const count = adapter.neighbors(tile, this.neighbors);
      for (let i = 0; i < count; i++) {
        const neighbor = this.neighbors[i],
          existing = this.index.get(neighbor);
        if (existing !== undefined && this.closed[existing]) continue;
        const cost =
          this.costs[current] +
          adapter.cost(
            tile,
            neighbor,
            previous === 0xffffffff ? undefined : this.tiles[previous],
          );
        if (existing === undefined || cost < this.costs[existing]) {
          const id = existing ?? this.node(neighbor);
          this.parents[id] = current;
          this.costs[id] = cost;
          queue.push(id, cost + adapter.heuristic(neighbor, goal));
        }
      }
    }
    return null;
  }
}
