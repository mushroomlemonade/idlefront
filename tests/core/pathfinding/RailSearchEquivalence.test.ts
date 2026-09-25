import { describe, expect, it } from "vitest";
import { GameMapImpl, type GameMap } from "../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import { AStar } from "../../../src/core/pathfinding/algorithms/AStar";
import {
  AStarRail,
  RailAdapter,
} from "../../../src/core/pathfinding/algorithms/AStar.Rail";
import { SparseAStar } from "../../../src/core/pathfinding/algorithms/SparseAStar";

describe.each([false, true])("rail equivalence paged=%s", (paged) => {
  it("keeps exact paths, source/tie order and cutoff behavior across terrain changes", () => {
    let seed = 169;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const w = 47,
      h = 39,
      terrain = new Uint8Array(w * h);
    const values = [128, 128, 0, 64, 192, 159];
    for (let i = 0; i < terrain.length; i++)
      terrain[i] = values[random() % values.length];
    const map: GameMap = paged
      ? PagedGameMap.fromRowMajor(w, h, 16, terrain, 0)
      : new GameMapImpl(w, h, terrain, 0);
    const optimized = new AStarRail(map);
    const adapter = new RailAdapter(map);
    const reference = new AStar({ adapter });
    const sparse = new SparseAStar({ adapter });
    for (let i = 0; i < 300; i++) {
      const tile = random() % terrain.length;
      switch (i % 6) {
        case 0:
          map.setWater(tile);
          break;
        case 1:
          map.setShorelineBit(tile);
          break;
        case 2:
          map.clearShorelineBit(tile);
          break;
        case 3:
          map.setMagnitude(tile, random() % 32);
          break;
        case 4:
          map.setOcean(tile);
          break;
        case 5:
          map.updateTile(tile, values[random() % values.length] << 16);
          break;
      }
      const from = random() % terrain.length,
        to = random() % terrain.length;
      const starts = i % 3 ? from : [from, random() % terrain.length, from];
      const expected = reference.findPath(starts, to);
      expect(sparse.findPath(starts, to)).toEqual(expected);
      expect(optimized.findPath(starts, to)).toEqual(expected);
    }
    for (const maxIterations of [1, 2, 7, 39, 200]) {
      const old = new AStar({ adapter, maxIterations });
      const next = new SparseAStar({ adapter, maxIterations });
      for (let i = 0; i < 30; i++) {
        const starts = [random() % terrain.length, random() % terrain.length];
        const to = random() % terrain.length;
        expect(next.findPath(starts, to)).toEqual(old.findPath(starts, to));
      }
    }
  });

  it("rejects separate islands but immediately accepts newly opened connections", () => {
    const terrain = new Uint8Array(35).fill(128);
    for (let y = 0; y < 5; y++)
      for (let x = 2; x <= 4; x++) terrain[y * 7 + x] = 0;
    const map: GameMap = paged
      ? PagedGameMap.fromRowMajor(7, 5, 4, terrain, 0)
      : new GameMapImpl(7, 5, terrain, 0);
    const search = new AStarRail(map),
      reference = new AStar({ adapter: new RailAdapter(map) });
    expect(search.findPath(7, 13)).toBeNull();
    expect(search.metrics.disconnected).toBe(1);
    for (const tile of [9, 10, 11]) map.updateTile(tile, 128 << 16);
    const route = reference.findPath(7, 13);
    expect(route).not.toBeNull();
    expect(search.findPath(7, 13)).toEqual(route);
    map.updateTile(10, 159 << 16);
    expect(search.findPath(7, 13)).toEqual(reference.findPath(7, 13));
  });
});

it("does not allocate world-sized search arrays without a connectivity index", () => {
  const map = new GameMapImpl(32, 32, new Uint8Array(1024).fill(128), 1024);
  const adapter = new RailAdapter(map);
  adapter.numNodes = () => 200_000_000;
  const search = new SparseAStar({ adapter });
  expect(search.findPath(0, 1)).toEqual([0, 1]);
  expect((search as any).tiles.length).toBe(2048);
});
