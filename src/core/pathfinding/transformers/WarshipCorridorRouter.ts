import type { PathFinder } from "../types";

/** Share geography with trade, never destinations, ownership or combat state.
 * Short tactical trips bypass the corridor overlay entirely. */
export class WarshipCorridorRouter implements PathFinder<number> {
  constructor(
    private native: PathFinder<number>,
    private corridors: PathFinder<number>,
    private distance: (a: number, b: number) => number,
  ) {}

  findSharedPath(
    from: number | number[],
    to: number,
  ): Readonly<ArrayLike<number>> | null {
    if (typeof from === "number" && this.distance(from, to) >= 96) {
      return this.corridors.findSharedPath!(from, to);
    }
    const path = this.native.findPath(from, to);
    return path === null ? null : Uint32Array.from(path);
  }

  findPath(from: number | number[], to: number): number[] | null {
    const path = this.findSharedPath(from, to);
    return path === null ? null : Array.from(path);
  }
}
