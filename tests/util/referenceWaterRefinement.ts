import { GameMap, TileRef } from "../../src/core/game/GameMap";
import { PathFinder } from "../../src/core/pathfinding/types";

/**
 * Coarse water cells can contain dry full-resolution banks. Keep valid routes
 * unchanged, but repair invalid ones against real water in a bounded corridor.
 * Scratch scales with the search, never with total map area.
 */
export class ReferenceWaterRefinementTransformer implements PathFinder<TileRef> {
  constructor(
    private inner: PathFinder<TileRef>,
    private map: GameMap,
  ) {}

  findPath(from: TileRef | TileRef[], to: TileRef): TileRef[] | null {
    const route = this.inner.findPath(from, to);
    if (!route?.length) return null;
    const starts = Array.isArray(from) ? from : [from];
    const allowedEndpoints = new Set([...starts, to]);
    const wet = (t: TileRef) => this.map.isWater(t);
    const legal = (t: TileRef) => wet(t) || allowedEndpoints.has(t);
    let valid = starts.includes(route[0]) && route[route.length - 1] === to;
    for (let i = 0; valid && i < route.length; i++) {
      if (!wet(route[i]) && i !== 0 && i !== route.length - 1) valid = false;
      if (i === 0) continue;
      const ax = this.map.x(route[i - 1]),
        ay = this.map.y(route[i - 1]);
      const bx = this.map.x(route[i]),
        by = this.map.y(route[i]);
      if (Math.max(Math.abs(ax - bx), Math.abs(ay - by)) > 1) valid = false;
      if (
        ax !== bx &&
        ay !== by &&
        (!wet(this.map.ref(ax, by)) || !wet(this.map.ref(bx, ay)))
      )
        valid = false;
    }
    if (valid) return route;

    const blockSize = 16;
    const blocksWide = Math.ceil(this.map.width() / blockSize);
    const blocksHigh = Math.ceil(this.map.height() / blockSize);
    const corridor = new Set<number>();
    const addCorridor = (tile: TileRef) => {
      const x = Math.floor(this.map.x(tile) / blockSize);
      const y = Math.floor(this.map.y(tile) / blockSize);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (
            x + dx >= 0 &&
            y + dy >= 0 &&
            x + dx < blocksWide &&
            y + dy < blocksHigh
          )
            corridor.add((y + dy) * blocksWide + x + dx);
        }
    };
    route.forEach(addCorridor);
    starts.forEach(addCorridor);
    addCorridor(to);
    const parents = new Map<TileRef, TileRef>();
    const costs = new Map<TileRef, number>();
    const closed = new Set<TileRef>();
    const heap: Array<[number, TileRef]> = [];
    const push = (tile: TileRef, priority: number) => {
      let i = heap.length;
      heap.push([priority, tile]);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= priority) break;
        heap[i] = heap[p];
        i = p;
      }
      heap[i] = [priority, tile];
    };
    const pop = () => {
      const result = heap[0][1],
        last = heap.pop()!;
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1;
          if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0])
            child++;
          if (heap[child][0] >= last[0]) break;
          heap[i] = heap[child];
          i = child;
        }
        heap[i] = last;
      }
      return result;
    };
    for (const start of starts) {
      costs.set(start, 0);
      parents.set(start, start);
      push(start, this.map.manhattanDist(start, to));
    }
    const neighbors: TileRef[] = [0, 0, 0, 0];
    while (heap.length && closed.size < 200_000) {
      const tile = pop();
      if (closed.has(tile)) continue;
      if (tile === to) {
        const repaired = [to];
        let node = to;
        while (parents.get(node) !== node) {
          node = parents.get(node)!;
          repaired.push(node);
        }
        return repaired.reverse();
      }
      closed.add(tile);
      const count = this.map.neighbors4(tile, neighbors);
      for (let i = 0; i < count; i++) {
        const next = neighbors[i];
        if (closed.has(next) || !legal(next)) continue;
        const block =
          Math.floor(this.map.y(next) / blockSize) * blocksWide +
          Math.floor(this.map.x(next) / blockSize);
        if (!corridor.has(block)) continue;
        const cost = costs.get(tile)! + 1;
        if (cost >= (costs.get(next) ?? Infinity)) continue;
        costs.set(next, cost);
        parents.set(next, tile);
        push(next, cost + this.map.manhattanDist(next, to));
      }
    }
    // Never substitute a route through land when the bounded repair fails.
    return null;
  }
}


