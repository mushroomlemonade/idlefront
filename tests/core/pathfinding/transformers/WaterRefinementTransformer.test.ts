import { GameMapImpl } from "../../../../src/core/game/GameMap";
import { WaterRefinementTransformer } from "../../../../src/core/pathfinding/transformers/WaterRefinementTransformer";

describe("full-resolution water refinement", () => {
  function setup(w: number, h: number, dry: number[], path: number[]) {
    const terrain = new Uint8Array(w * h).fill(32);
    dry.forEach((tile) => (terrain[tile] = 128));
    const map = new GameMapImpl(w, h, terrain, dry.length);
    const inner = { findPath: () => path };
    return { map, pf: new WaterRefinementTransformer(inner, map) };
  }
  it("retains an already valid route without changing its geometry", () => {
    const path = [0, 1, 2, 3];
    expect(setup(6, 6, [], path).pf.findPath(0, 3)).toBe(path);
  });
  it("repairs dry banks and gaps using adjacent real water", () => {
    const { map, pf } = setup(10, 10, [22, 23, 24], [20, 22, 24, 26]);
    const path = pf.findPath(20, 26)!;
    expect(path[0]).toBe(20);
    expect(path[path.length - 1]).toBe(26);
    expect(path.every((tile) => map.isWater(tile))).toBe(true);
    expect(
      path.slice(1).every((tile, i) => map.manhattanDist(path[i], tile) === 1),
    ).toBe(true);
  });
  it("cannot cross a real closed barrier or squeeze diagonally between banks", () => {
    expect(setup(4, 4, [1, 4], [0, 5, 10, 15]).pf.findPath(0, 15)).toBeNull();
  });
  it("retains legal port endpoints but never traverses inland cells", () => {
    const { map, pf } = setup(6, 6, [0, 2, 5], [0, 1, 2, 3, 4, 5]);
    const path = pf.findPath(0, 5)!;
    expect(path[0]).toBe(0);
    expect(path[path.length - 1]).toBe(5);
    expect(path.slice(1, -1).every((tile) => map.isWater(tile))).toBe(true);
  });
  it("can choose a reachable alternative source without walking through another dry source", () => {
    const { map, pf } = setup(6, 6, [1, 6, 7], [0, 7, 14, 21, 28, 35]);
    const path = pf.findPath([0, 30], 35)!;
    expect(path[0]).toBe(30);
    expect(path.every((tile) => map.isWater(tile))).toBe(true);
  });
});
