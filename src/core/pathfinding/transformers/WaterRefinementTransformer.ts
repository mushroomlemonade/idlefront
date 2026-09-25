import { GameMap, TileRef } from "../../game/GameMap";
import { WaterRepairSearch } from "../algorithms/WaterRepairSearch";
import { PathFinder } from "../types";
export type WaterRefinementMap = Pick<
  GameMap,
  | "width"
  | "height"
  | "x"
  | "y"
  | "ref"
  | "isWater"
  | "neighbors4"
  | "manhattanDist"
>;

/**
 * Coarse water cells can contain dry full-resolution banks. Keep valid routes
 * unchanged, but repair invalid ones against real water in a bounded corridor.
 * Scratch scales with the search, never with total map area.
 */
export class WaterRefinementTransformer implements PathFinder<TileRef> {
  private readonly repair: WaterRepairSearch;
  constructor(
    private inner: PathFinder<TileRef>,
    private map: WaterRefinementMap,
  ) {
    this.repair = new WaterRepairSearch(map);
  }

  findPath(from: TileRef | TileRef[], to: TileRef): TileRef[] | null {
    const route = this.inner.findPath(from, to);
    return this.refine(route, from, to);
  }

  coarsePath(from: TileRef | TileRef[], to: TileRef): TileRef[] | null {
    return this.inner.findPath(from, to);
  }

  refine(
    route: TileRef[] | null,
    from: TileRef | TileRef[],
    to: TileRef,
  ): TileRef[] | null {
    if (!route?.length) return null;
    const starts = Array.isArray(from) ? from : [from];
    const wet = (t: TileRef) => this.map.isWater(t);
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
    const expanded = new Set<number>();
    const addCorridor = (tile: TileRef) => {
      const x = Math.floor(this.map.x(tile) / blockSize);
      const y = Math.floor(this.map.y(tile) / blockSize);
      const center = y * blocksWide + x;
      if (expanded.has(center)) return;
      expanded.add(center);
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
    return this.repair.search(starts, to, corridor, blocksWide);
  }
}
