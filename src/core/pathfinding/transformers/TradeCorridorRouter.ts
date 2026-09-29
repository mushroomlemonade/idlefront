import type { TradeCorridors } from "../../TradeCorridors";
import type { PathFinder } from "../types";

interface Corridor {
  path: Uint32Array;
  trips: number;
  last: number;
}
interface CorridorJoin {
  route: Corridor;
  a: number;
  b: number;
  estimate: number;
}
/** A bounded overlay of proven routes, not a new ocean pathfinder. Nearby ports
 * join a hot route with two short native searches; no route survives a terrain
 * revision. Single-threaded deterministic order and no gameplay RNG consumption. */
export class TradeCorridorRouter implements PathFinder<number> {
  private readonly routes = new Map<string, Corridor>();
  private nodes = 0;
  private revision = "";
  private lastSweep = -Infinity;
  readonly metrics = {
    exactHits: 0,
    corridorHits: 0,
    fallbacks: 0,
    connectorSearches: 0,
  };
  constructor(
    private native: PathFinder<number>,
    private distance: (a: number, b: number) => number,
    private version: () => string,
    private tick: () => number,
    private config: TradeCorridors,
    private maxNodes = 250_000,
    private maxRoutes = 128,
  ) {}

  private fresh() {
    const version = this.version();
    if (version !== this.revision) {
      this.routes.clear();
      this.nodes = 0;
      this.revision = version;
      this.lastSweep = -Infinity;
    }
    // At most one bounded expiry pass per simulation second, not per ship.
    if (this.tick() - this.lastSweep < 10) return;
    this.lastSweep = this.tick();
    for (const [key, route] of this.routes) {
      if (this.tick() - route.last > this.config.idleSeconds * 10) {
        this.nodes -= route.path.length;
        this.routes.delete(key);
      }
    }
  }
  private remember(from: number, to: number, path: number[]): Uint32Array {
    const shared = Uint32Array.from(path);
    if (!path.length || path.length > this.maxNodes || this.maxRoutes < 1)
      return shared;
    const key = `${from}:${to}`;
    const previous = this.routes.get(key);
    this.nodes -= previous?.path.length ?? 0;
    this.routes.delete(key);
    this.routes.set(key, {
      path: shared,
      trips: (previous?.trips ?? 0) + 1,
      last: this.tick(),
    });
    this.nodes += path.length;
    while (this.routes.size > this.maxRoutes || this.nodes > this.maxNodes) {
      const oldest = this.routes.keys().next().value!;
      this.nodes -= this.routes.get(oldest)!.path.length;
      this.routes.delete(oldest);
    }
    return shared;
  }
  findPath(from: number | number[], to: number): number[] | null {
    const path = this.findSharedPath(from, to);
    return path === null ? null : Array.from(path);
  }
  findSharedPath(from: number | number[], to: number): Uint32Array | null {
    this.fresh();
    if (Array.isArray(from)) {
      const path = this.native.findPath(from, to);
      return path === null ? null : Uint32Array.from(path);
    }
    const key = `${from}:${to}`,
      exact = this.routes.get(key);
    if (exact && this.tick() - exact.last > this.config.idleSeconds * 10) {
      this.nodes -= exact.path.length;
      this.routes.delete(key);
    }
    if (exact && this.tick() - exact.last <= this.config.idleSeconds * 10) {
      exact.trips++;
      exact.last = this.tick();
      this.routes.delete(key);
      this.routes.set(key, exact);
      this.metrics.exactHits++;
      return exact.path;
    }
    return this.resolve(from, to, this.bestCorridor(from, to));
  }

  /** Pure preparation plan: do not warm trip counts or publish a new corridor.
   * Once connectors are cached, a second pass requests the direct fallback
   * only if those connectors cannot form an acceptable journey. */
  preparationRequests(
    from: number,
    to: number,
    lookup: (
      a: number,
      b: number,
    ) => Readonly<ArrayLike<number>> | null | undefined,
  ): { from: number; to: number }[] {
    this.fresh();
    const exact = this.routes.get(`${from}:${to}`);
    if (exact && this.tick() - exact.last <= this.config.idleSeconds * 10)
      return [];
    const best = this.bestCorridor(from, to);
    if (best) {
      const { route, a, b } = best;
      const connectors = [
        { from, to: route.path[a] },
        { from: route.path[b], to },
      ];
      const values = connectors.map((q) => lookup(q.from, q.to));
      const missing = connectors.filter((_, i) => values[i] === undefined);
      if (missing.length) return missing;
      const [first, last] = values;
      if (
        first?.length &&
        last?.length &&
        first[0] === from &&
        last[last.length - 1] === to &&
        first.length - 1 + Math.abs(b - a) + last.length - 1 <=
          this.distance(from, to) * 1.25
      )
        return [];
    }
    return lookup(from, to) === undefined ? [{ from, to }] : [];
  }

  private bestCorridor(from: number, to: number): CorridorJoin | undefined {
    const hot = [...this.routes.values()]
      .filter(
        (r) =>
          r.trips >= this.config.hotTrips &&
          this.tick() - r.last <= this.config.idleSeconds * 10,
      )
      .sort((a, b) => b.trips - a.trips)
      .slice(0, 8);
    let best: CorridorJoin | undefined;
    const direct = this.distance(from, to);
    for (const route of hot) {
      let a = -1,
        b = -1,
        da = 33,
        db = 33;
      // Bounded coarse portals plus exact endpoints; at most ~66 per route.
      const step = Math.max(1, Math.ceil((route.path.length - 1) / 64));
      for (let i = 0; i < route.path.length + step; i += step) {
        const index = Math.min(i, route.path.length - 1),
          tile = route.path[index];
        const ds = this.distance(from, tile),
          dt = this.distance(to, tile);
        if (ds < da) {
          da = ds;
          a = index;
        }
        if (dt < db) {
          db = dt;
          b = index;
        }
      }
      const estimate = da + db + Math.abs(b - a);
      if (
        a >= 0 &&
        b >= 0 &&
        a !== b &&
        estimate <= direct * 1.25 &&
        (!best || estimate < best.estimate)
      )
        best = { route, a, b, estimate };
    }
    return best;
  }
  private resolve(
    from: number,
    to: number,
    best: CorridorJoin | undefined,
  ): Uint32Array | null {
    const direct = this.distance(from, to);
    if (best) {
      const { route, a, b } = best;
      this.metrics.connectorSearches += 2;
      const first = this.native.findPath(from, route.path[a]);
      const last = this.native.findPath(route.path[b], to);
      if (first?.length && last?.length) {
        const middle = Array.from(
          route.path.slice(Math.min(a, b), Math.max(a, b) + 1),
        );
        if (a > b) middle.reverse();
        const joined = [...first, ...middle.slice(1), ...last.slice(1)];
        // Never trade a short direct voyage for a large corridor detour.
        if (
          joined.length - 1 <= direct * 1.25 &&
          joined[0] === from &&
          joined[joined.length - 1] === to
        ) {
          route.trips++;
          route.last = this.tick();
          this.metrics.corridorHits++;
          return this.remember(from, to, joined);
        }
      }
    }
    this.metrics.fallbacks++;
    const path = this.native.findPath(from, to);
    return path === null ? null : this.remember(from, to, path);
  }
}
