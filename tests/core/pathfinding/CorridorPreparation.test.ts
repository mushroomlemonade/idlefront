import { expect, it, vi } from "vitest";
import { ExactRouteCache } from "../../../src/core/pathfinding/transformers/ExactRouteCache";
import { TradeCorridorRouter } from "../../../src/core/pathfinding/transformers/TradeCorridorRouter";
import { tradeCorridorsForPreset } from "../../../src/core/TradeCorridors";

const line = (a: number, b: number) =>
  Array.from(
    { length: Math.abs(b - a) + 1 },
    (_, i) => a + i * Math.sign(b - a),
  );
it("prepares only connector misses, without changing hotness or route selection", () => {
  const native = {
    findPath: vi.fn((a: number | number[], b: number) => line(Number(a), b)),
  };
  const cache = new ExactRouteCache(native, () => "0");
  const router = new TradeCorridorRouter(
    cache,
    (a, b) => Math.abs(a - b),
    () => "0",
    () => 0,
    { ...tradeCorridorsForPreset("longplay")!, hotTrips: 2 },
  );
  router.findPath(0, 200);
  router.findPath(0, 200);
  const lookup = (a: number, b: number) => cache.peek(a, b);
  expect(router.preparationRequests(0, 200, lookup)).toEqual([]);
  const requests = router.preparationRequests(10, 190, lookup);
  expect(requests).toHaveLength(2);
  expect(requests.every((q) => Math.abs(q.to - q.from) <= 32)).toBe(true);
  const before = { ...router.metrics };
  for (const q of requests) cache.store(q.from, q.to, line(q.from, q.to));
  expect(router.preparationRequests(10, 190, lookup)).toEqual([]);
  expect(router.metrics).toEqual(before);
  native.findPath.mockClear();
  expect(router.findPath(10, 190)?.length).toBeGreaterThan(0);
  expect(native.findPath).not.toHaveBeenCalled();
});
it("requests a direct fallback only after a connector fails; terrain revision clears preparation", () => {
  let revision = "0";
  const cache = new ExactRouteCache(
    { findPath: (a, b) => line(Number(a), b) },
    () => revision,
  );
  const router = new TradeCorridorRouter(
    cache,
    (a, b) => Math.abs(a - b),
    () => revision,
    () => 0,
    { ...tradeCorridorsForPreset("longplay")!, hotTrips: 2 },
  );
  router.findPath(0, 200);
  router.findPath(0, 200);
  const lookup = (a: number, b: number) => cache.peek(a, b);
  for (const q of router.preparationRequests(10, 190, lookup))
    cache.store(q.from, q.to, null);
  expect(router.preparationRequests(10, 190, lookup)).toEqual([
    { from: 10, to: 190 },
  ]);
  cache.store(10, 190, null);
  expect(router.preparationRequests(10, 190, lookup)).toEqual([]);
  expect(router.findPath(10, 190)).toBeNull();
  revision = "1";
  expect(router.preparationRequests(0, 200, lookup)).toEqual([
    { from: 0, to: 200 },
  ]);
});
