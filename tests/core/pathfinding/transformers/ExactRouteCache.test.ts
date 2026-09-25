import { expect, it, vi } from "vitest";
import { ExactRouteCache } from "../../../../src/core/pathfinding/transformers/ExactRouteCache";
it("caches exact ordered sources, protects arrays and invalidates terrain revisions", () => {
  let revision = "0";
  const fn = vi.fn((from: number | number[], to: number) => [
    ...(Array.isArray(from) ? from : [from]),
    to,
  ]);
  const cache = new ExactRouteCache({ findPath: fn }, () => revision);
  cache.findPath(1, 3)!.reverse();
  expect(cache.findPath(1, 3)).toEqual([1, 3]);
  expect(fn).toHaveBeenCalledTimes(1);
  cache.findPath([1, 2], 3);
  cache.findPath([2, 1], 3);
  expect(fn).toHaveBeenCalledTimes(3);
  revision = "1";
  cache.findPath(1, 3);
  expect(fn).toHaveBeenCalledTimes(4);
});
it("bounds retained nodes and entries, including null routes", () => {
  const cache = new ExactRouteCache(
    { findPath: (f, t) => [f as number, t] },
    () => "0",
    4,
    2,
  );
  cache.findPath(1, 9);
  cache.findPath(2, 9);
  cache.findPath(3, 9);
  expect(cache.has(1, 9)).toBe(false);
  expect(cache.has(3, 9)).toBe(true);
  cache.store(4, 9, null);
  expect(cache.findPath(4, 9)).toBeNull();
  cache.store(5, 9, [1, 2, 3, 4, 5]);
  expect(cache.has(5, 9)).toBe(false);
});
