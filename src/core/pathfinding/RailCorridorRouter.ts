import type { Game } from "../game/Game";
import type { RailPathFinderService } from "../game/RailNetworkImpl";
import type { TrainStation } from "../game/TrainStation";
import { MinHeap } from "./algorithms/PriorityQueue";

/** Route over the existing station graph, never search world tiles per train.
 * Weighted by physical rail length; hot edges get at most a 20% preference.
 * Cached routes are revalidated against live edges, so nukes cannot leave a
 * train using a severed connection. No physical bridge is pruned on expiry. */
export class RailCorridorRouter {
  private cache = new Map<string, { path: TrainStation[]; tick: number }>();
  private cachedNodes = 0;
  private forget(key: string): void {
    this.cachedNodes -= this.cache.get(key)?.path.length ?? 0;
    this.cache.delete(key);
  }
  constructor(
    private game: Game,
    private native: RailPathFinderService,
  ) {}
  find(from: TrainStation, to: TrainStation): TrainStation[] {
    const now = this.game.ticks(),
      config = this.game.config().gameConfig().tradeCorridors!;
    const key = `${from.id}:${to.id}`,
      cached = this.cache.get(key);
    if (
      cached &&
      now - cached.tick <= 100 &&
      cached.path.every(
        (s, i, a) =>
          s.isActive() && (i === 0 || a[i - 1].getRailroadTo(s) !== null),
      )
    )
      return [...cached.path];
    this.forget(key);
    const queue = new MinHeap(512),
      costs = new Map<number, number>([[from.id, 0]]);
    const previous = new Map<number, TrainStation>(),
      stations = new Map([[from.id, from]]),
      visited = new Set<number>();
    queue.push(from.id, 0);
    // Bounded search; native station router remains the fallback.
    while (!queue.isEmpty() && visited.size < 4096) {
      const id = queue.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const station = stations.get(id)!;
      if (station === to) {
        const path = [to];
        while (path[0] !== from) path.unshift(previous.get(path[0].id)!);
        this.cache.set(key, { path, tick: now });
        this.cachedNodes += path.length;
        while (this.cache.size > 256 || this.cachedNodes > 32768)
          this.forget(this.cache.keys().next().value!);
        return [...path];
      }
      for (const next of station.neighbors()) {
        if (!next.isActive()) continue;
        const rail = station.getRailroadTo(next);
        if (!rail) continue;
        const hot =
          now - rail.lastTripTick <= config.idleSeconds * 10
            ? Math.min(1, rail.trips / config.hotTrips)
            : 0;
        const cost =
          costs.get(id)! + Math.max(1, rail.tiles.length - 1) * (1 - 0.2 * hot);
        if (cost >= (costs.get(next.id) ?? Infinity)) continue;
        costs.set(next.id, cost);
        previous.set(next.id, station);
        stations.set(next.id, next);
        queue.push(next.id, cost);
      }
    }
    return this.native.findStationsPath(from, to);
  }
}
