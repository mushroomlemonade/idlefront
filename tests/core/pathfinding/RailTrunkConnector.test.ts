import { describe, expect, it, vi } from "vitest";
import { railTrunkConnection } from "../../../src/core/pathfinding/RailTrunkConnector";
import {
  tradeCorridorsForPreset,
  TradeRouteMaturation,
  tradeSpawnRate,
} from "../../../src/core/TradeCorridors";

describe("bounded trunk connectors and route pacing", () => {
  it("uses short native connectors and the intact trunk, including reverse travel", () => {
    const config = tradeCorridorsForPreset("longplay")!;
    const rail: any = {
      tiles: Array.from({ length: 101 }, (_, i) => i),
      trips: 8,
      lastTripTick: 100,
      from: { isActive: () => true, getRailroadTo: () => rail },
      to: { isActive: () => true },
    };
    const game: any = {
      config: () => ({ gameConfig: () => ({ tradeCorridors: config }) }),
      ticks: () => 100,
      manhattanDist: (a: number, b: number) => Math.abs(a - b),
    };
    const native: any = {
      findTilePath: vi.fn((a: number, b: number) =>
        Array.from(
          { length: Math.abs(a - b) + 1 },
          (_, i) => a + i * Math.sign(b - a),
        ),
      ),
    };
    const path = railTrunkConnection(game, native, -2, 102, [rail]);
    expect(path).toEqual(Array.from({ length: 105 }, (_, i) => i - 2));
    expect(native.findTilePath.mock.calls).toEqual([
      [-2, 0],
      [100, 102],
    ]);
    expect(railTrunkConnection(game, native, 102, -2, [rail])).toEqual(
      path!.slice().reverse(),
    );
    rail.from.getRailroadTo = () => null;
    expect(railTrunkConnection(game, native, -2, 102, [rail])).toBeNull();
  });
  it("new routes start quiet in old worlds while active routes mature; old configs remain unchanged", () => {
    const config = tradeCorridorsForPreset("longplay")!,
      routes = new TradeRouteMaturation(2);
    expect(tradeSpawnRate(config, 100000)).toBe(1);
    expect(routes.factor(config, "old", 100000)).toBe(0.25);
    for (let t = 110000; t <= 140000; t += 10000)
      routes.factor(config, "old", t);
    expect(routes.factor(config, "old", 140000)).toBe(1);
    expect(routes.factor(config, "new", 140000)).toBe(0.25);
    expect(routes.factor(config, "old", 160001)).toBe(0.25);
    const legacy = { ...config, maturation: undefined };
    expect(routes.factor(legacy, "x", 0)).toBe(1);
    expect(tradeSpawnRate(legacy, 0)).toBe(0.25);
    routes.factor(config, "third", 160001);
    expect(routes.factor(config, "new", 160002)).toBe(0.25);
  });
});
