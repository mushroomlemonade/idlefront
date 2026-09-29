import { UnitType, type Game } from "../../core/game/Game";
import type { GameUpdateViewData } from "../../core/game/GameUpdates";
import { unpackMotionPlans } from "../../core/game/MotionPlans";

interface Route {
  path: Uint32Array;
  sea: boolean;
  trips: number;
  tick: number;
}
/** Bounded authoritative journey geometry. Derived by journal replay, independent
 * of viewers. Never paints straight shortcuts through land: coalesce collinear
 * grid steps only. No separate pathfinder and no full-map scan. */
export class CorridorHistory {
  private routes = new Map<string, Route>();
  private nodes = 0;
  private lastSnapshotTick = -1;
  private cached = new Uint32Array(0);
  constructor(
    private game: Game,
    private maxNodes = 100_000,
    private maxRoutes = 256,
  ) {}
  record(
    update: GameUpdateViewData,
    removedRailTiles: Iterable<number> = [],
  ): void {
    this.lastSnapshotTick = -1;
    // Invalidate only routes crossing changed terrain/rail. No global reset.
    const damaged = new Set<number>();
    for (let i = 0; i < (update.packedTerrainUpdates?.length ?? 0); i += 2)
      damaged.add(update.packedTerrainUpdates![i]);
    for (const tile of removedRailTiles) damaged.add(tile);
    if (damaged.size)
      for (const [key, r] of this.routes)
        if (r.path.some((t) => damaged.has(t))) this.remove(key);
    if (!update.packedMotionPlans) return;
    for (const plan of unpackMotionPlans(update.packedMotionPlans)) {
      const sea = plan.kind === "grid";
      if (sea && this.game.unit(plan.unitId)?.type() !== UnitType.TradeShip)
        continue;
      const path = plan.path;
      if (path.length < 2 || path.length > this.maxNodes) continue;
      // Hash every tile; collision verified, including reverse journeys.
      const reverse = path[0] > path[path.length - 1];
      let hash = 2166136261;
      for (let i = 0; i < path.length; i++)
        hash =
          Math.imul(
            hash ^ path[reverse ? path.length - 1 - i : i],
            16777619,
          ) >>> 0;
      const key = `${sea}:${path.length}:${hash}`;
      const old = this.routes.get(key);
      if (
        old &&
        old.path.every((t, i) => t === path[reverse ? path.length - 1 - i : i])
      ) {
        old.trips = Math.min(65535, old.trips + 1);
        old.tick = update.tick;
        continue;
      }
      if (old) this.remove(key);
      while (
        this.routes.size >= this.maxRoutes ||
        this.nodes + path.length > this.maxNodes
      ) {
        const victim = [...this.routes].sort(
          (a, b) => a[1].trips - b[1].trips || a[1].tick - b[1].tick,
        )[0];
        if (!victim) break;
        this.remove(victim[0]);
      }
      const copy = Uint32Array.from(path);
      if (reverse) copy.reverse();
      this.routes.set(key, { path: copy, sea, trips: 1, tick: update.tick });
      this.nodes += copy.length;
    }
  }
  private remove(key: string): void {
    this.nodes -= this.routes.get(key)?.path.length ?? 0;
    this.routes.delete(key);
  }
  snapshot(visible?: (tile: number) => boolean): Uint32Array {
    if (!this.routes.size) return new Uint32Array(0);
    const tick = this.game.ticks();
    if (!visible && this.lastSnapshotTick === tick) return this.cached;
    const cfg = this.game.config().gameConfig().tradeCorridors;
    const idle = (cfg?.idleSeconds ?? 1800) * 10;
    const values: number[] = [];
    const width = this.game.width();
    for (const [key, r] of [...this.routes].sort(
      (a, b) => b[1].trips - a[1].trips || b[1].tick - a[1].tick,
    )) {
      if (tick - r.tick > idle) {
        this.remove(key);
        continue;
      }
      // Current visibility alone cannot authorize hidden interior route geometry.
      if (visible && !r.path.every(visible)) continue;
      const heat = Math.round(
        65535 * Math.min(1, r.trips / (cfg?.hotTrips ?? 8)),
      );
      let a = r.path[0],
        last = a,
        dx = 0,
        dy = 0;
      const emit = () => {
        if (a !== last && values.length < 80_000)
          values.push(a, last, heat, r.sea ? 1 : 0);
      };
      for (let i = 1; i < r.path.length; i++) {
        const b = r.path[i],
          nx = (b % width) - (last % width),
          ny = Math.floor(b / width) - Math.floor(last / width);
        if (i > 1 && (nx !== dx || ny !== dy)) {
          emit();
          a = last;
        }
        last = b;
        dx = nx;
        dy = ny;
      }
      emit();
    }
    const data = Uint32Array.from(values);
    if (!visible) {
      this.lastSnapshotTick = tick;
      this.cached = data;
    }
    return data;
  }
}
