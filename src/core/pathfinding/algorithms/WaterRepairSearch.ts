import type { GameMap, TileRef } from "../../game/GameMap";
import { TileNodeIndex } from "./TileNodeIndex";

/** Reusable local search records. One tile lookup replaces costs/parents/closed
 * hash tables; typed heap entries avoid allocating tuples on every push. The
 * comparison operators and neighbor order match the original repair exactly. */
export class WaterRepairSearch {
  private readonly reachabilityIndex = new TileNodeIndex();
  private readonly reachabilityQueue = new Uint32Array(8192);
  private readonly isolated: {
    destinations: Set<TileRef>;
    boundary: Set<TileRef>;
  }[] = [];
  private isolatedRevision = "";
  readonly metrics = {
    searches: 0,
    expanded: 0,
    reachabilityVisited: 0,
    rejected: 0,
    connectivityHits: 0,
  };
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
    private readonly rejectDisconnected = true,
    private readonly terrainRevision?: () => string,
  ) {}

  /** Only exhausted GLOBAL components qualify. Search budgets and corridor
   * failures are not evidence that another request is impossible. */
  provenDisconnected(starts: readonly TileRef[], to: TileRef): boolean {
    if (!this.terrainRevision || starts.length === 0) return false;
    const revision = this.terrainRevision();
    if (revision !== this.isolatedRevision) {
      this.isolated.length = 0;
      this.isolatedRevision = revision;
    }
    const blocked = starts.every((from) =>
      this.isolated.some(
        (entry) =>
          (entry.destinations.has(to) && !entry.boundary.has(from)) ||
          (entry.destinations.has(from) && !entry.boundary.has(to)),
      ),
    );
    if (blocked) this.metrics.connectivityHits++;
    return blocked;
  }

  private rememberExhaustedSource(starts: readonly TileRef[]): void {
    if (
      !this.terrainRevision ||
      starts.length !== 1 ||
      !this.map.isWater(starts[0]) ||
      this.count > 8192
    )
      return;
    const destinations = new Set<TileRef>();
    const boundary = new Set<TileRef>();
    for (let i = 0; i < this.count; i++) {
      const tile = this.tiles[i];
      destinations.add(tile);
      boundary.add(tile);
      const count = this.map.neighbors4(tile, this.neighbors);
      for (let j = 0; j < count; j++) {
        const next = this.neighbors[j];
        boundary.add(next);
        // A wet edge outside the explored area means corridor-limited, NOT
        // globally disconnected. Dry endpoints stay in the boundary exception.
        if (this.map.isWater(next) && this.index.get(next) === undefined)
          return;
      }
    }
    this.isolated.push({ destinations, boundary });
    if (this.isolated.length > 8) this.isolated.shift();
  }

  /** Run once, only after a repair has already expanded 4,096 nodes.
   * Prove only small disconnected destination components. Exhausting the
   * budget means UNKNOWN, never unreachable. Starting tiles may lie outside
   * the corridor (the authoritative forward search seeds them unconditionally).
   * Meeting the forward frontier also means UNKNOWN. No successful route,
   * tie order, random state or expansion limit changes. Scratch is bounded
   * independently of world size and is reused between searches.
   */
  private disconnected(
    starts: readonly TileRef[],
    to: TileRef,
    corridor: ReadonlySet<number>,
    blocksWide: number,
  ): boolean {
    if (starts.length === 0) return true;
    const sources = new Set(starts);
    if (sources.has(to)) return false;
    this.reachabilityIndex.clear();
    this.reachabilityIndex.set(to, 0);
    this.reachabilityQueue[0] = to;
    let head = 0,
      tail = 1;
    let completeComponent = true;
    const boundary = this.terrainRevision ? new Set<TileRef>([to]) : undefined;
    while (head < tail) {
      const tile = this.reachabilityQueue[head++];
      this.metrics.reachabilityVisited++;
      const forwardNode = this.index.get(tile);
      if (forwardNode !== undefined && this.closed[forwardNode]) return false;
      const count = this.map.neighbors4(tile, this.neighbors);
      for (let i = 0; i < count; i++) {
        const next = this.neighbors[i];
        boundary?.add(next);
        if (sources.has(next)) return false;
        if (
          this.reachabilityIndex.get(next) !== undefined ||
          !this.map.isWater(next)
        )
          continue;
        const block =
          Math.floor(this.map.y(next) / 16) * blocksWide +
          Math.floor(this.map.x(next) / 16);
        if (!corridor.has(block)) {
          completeComponent = false;
          continue;
        }
        if (tail === this.reachabilityQueue.length) return false;
        this.reachabilityIndex.set(next, tail);
        this.reachabilityQueue[tail++] = next;
      }
    }
    // Only cache a GLOBAL connectivity proof, never a corridor-limited one.
    // Include dry boundary tiles because a route may start on a dry endpoint.
    // Eight bounded components; conversions invalidate even before graph rebuild.
    if (completeComponent && boundary) {
      this.isolated.push({
        destinations: new Set(this.reachabilityQueue.subarray(0, tail)),
        boundary,
      });
      if (this.isolated.length > 8) this.isolated.shift();
    }
    return true;
  }

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
    this.metrics.searches++;
    if (this.provenDisconnected(starts, to)) return null;
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
      this.metrics.expanded++;
      if (
        closedCount === 4096 &&
        this.rejectDisconnected &&
        this.disconnected(starts, to, corridor, blocksWide)
      ) {
        this.metrics.rejected++;
        return null;
      }
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
    if (this.heapSize === 0) this.rememberExhaustedSource(starts);
    return null;
  }
}
