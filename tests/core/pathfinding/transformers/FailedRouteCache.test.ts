import { describe, expect, it, vi } from "vitest";
import { GameMapImpl } from "../../../../src/core/game/GameMap";
import { FailedRouteCache } from "../../../../src/core/pathfinding/transformers/FailedRouteCache";
import { WaterRefinementTransformer } from "../../../../src/core/pathfinding/transformers/WaterRefinementTransformer";

describe("exact failed water route cache", () => {
  it("eliminates repeated failed work but searches every changed endpoint", () => {
    const findPath = vi.fn(() => null);
    let revision = "0:0";
    const cache = new FailedRouteCache({ findPath }, () => revision);
    for (let i = 0; i < 1000; i++) expect(cache.findPath(1, 9)).toBeNull();
    expect(findPath).toHaveBeenCalledTimes(1);
    cache.findPath(2, 9);
    cache.findPath(1, 8);
    expect(findPath).toHaveBeenCalledTimes(3);
    revision = "1:0";
    cache.findPath(1, 9); // water conversion before graph rebuild
    revision = "1:1";
    cache.findPath(1, 9); // later graph rebuild
    expect(findPath).toHaveBeenCalledTimes(5);
  });
  it("does not cache successes, exceptions, or multi-source queries", () => {
    const route = [1, 2, 3];
    const findPath = vi.fn<(...args: any[]) => number[] | null>(() => route);
    const cache = new FailedRouteCache({ findPath }, () => "0");
    expect(cache.findPath(1, 3)).toBe(route);
    cache.findPath(1, 3);
    findPath.mockImplementation(() => null);
    cache.findPath([1, 2], 3);
    cache.findPath([1, 2], 3);
    findPath.mockImplementation(() => {
      throw new Error("failure");
    });
    expect(() => cache.findPath(1, 4)).toThrow("failure");
    expect(() => cache.findPath(1, 4)).toThrow("failure");
    expect(findPath).toHaveBeenCalledTimes(6);
  });
  it("bounds memory and retries evicted failures", () => {
    const findPath = vi.fn(() => null);
    const cache = new FailedRouteCache({ findPath }, () => "0", 2);
    cache.findPath(1, 9);
    cache.findPath(2, 9);
    cache.findPath(3, 9);
    cache.findPath(1, 9);
    expect(findPath).toHaveBeenCalledTimes(4);
  });
  it("reopens an actual blocked water journey on terrain invalidation", () => {
    const terrain = new Uint8Array(16).fill(32);
    terrain[1] = terrain[4] = 128;
    const map = new GameMapImpl(4, 4, terrain, 2);
    const inner = new WaterRefinementTransformer(
      { findPath: () => [0, 5, 10, 15] },
      map,
    );
    const findPath = vi.spyOn(inner, "findPath");
    let epoch = 0;
    const cache = new FailedRouteCache(inner, () => `${epoch}:0`);
    expect(cache.findPath(0, 15)).toBeNull();
    expect(cache.findPath(0, 15)).toBeNull();
    expect(findPath).toHaveBeenCalledTimes(1);
    map.setWater(1);
    epoch++;
    expect(cache.findPath(0, 15)).toEqual(inner.findPath(0, 15));
    expect(cache.findPath(0, 15)).not.toBeNull();
  });
});
