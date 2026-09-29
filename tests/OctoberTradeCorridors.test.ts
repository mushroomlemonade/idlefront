import { describe, expect, it, vi } from "vitest";
import { assetValue } from "../src/core/AssetValue";
import {
  tradeCorridorsForPreset,
  TradeCorridorsSchema,
  tradeTripRate,
} from "../src/core/TradeCorridors";
import { UnitType } from "../src/core/game/Game";
import { OrientedRailroad, Railroad } from "../src/core/game/Railroad";
import { RailCorridorRouter } from "../src/core/pathfinding/RailCorridorRouter";
import { TradeCorridorRouter } from "../src/core/pathfinding/transformers/TradeCorridorRouter";

describe("October trade rules", () => {
  it("keeps an in-flight train on a split track but invalidates it when a replacement is destroyed", () => {
    const station = (): any => ({
      links: new Map(),
      getRailroadTo(s: any) {
        return this.links.get(s);
      },
      removeRailroad(r: any) {
        for (const [s, v] of this.links) if (v === r) this.links.delete(s);
      },
    });
    const a = station(),
      b = station(),
      c = station();
    const old = new Railroad(a, b, [1, 2, 3, 4], 1);
    a.links.set(b, old);
    b.links.set(a, old);
    old.trips = 12;
    old.lastTripTick = 100;
    const travelling = new OrientedRailroad(old, true);
    const left = new Railroad(a, c, [1, 2], 2),
      right = new Railroad(c, b, [3, 4], 3);
    old.replaceWith([left, right]);
    a.links.delete(b);
    b.links.delete(a);
    a.links.set(c, left);
    c.links.set(a, left);
    c.links.set(b, right);
    b.links.set(c, right);
    expect(travelling.isCurrent()).toBe(true);
    expect(left.trips).toBe(12);
    right.delete({ addUpdate: vi.fn() } as any);
    expect(travelling.isCurrent()).toBe(false);
  });
  it("opts in only new longplay and idlefront configs; legacy multiplier stays one", () => {
    expect(tradeCorridorsForPreset("quickplay")).toBeUndefined();
    expect(tradeCorridorsForPreset("scheduled-earth")).toBeUndefined();
    expect(tradeTripRate(undefined, 0)).toBe(1);
    const config = tradeCorridorsForPreset("longplay")!;
    expect(TradeCorridorsSchema.parse(config)).toEqual(config);
    expect(tradeTripRate(config, 0)).toBe(0.25);
    expect(tradeTripRate(config, config.rampSeconds * 10)).toBe(1);
    expect(tradeTripRate(config, 1e9)).toBe(1);
    expect(
      TradeCorridorsSchema.safeParse({ ...config, initialTrips: 0 }).success,
    ).toBe(false);
  });
  it("values only completed, active assets, with level weighting", () => {
    const unit = (
      type: UnitType,
      level = 1,
      active = true,
      building = false,
    ) => ({
      type: () => type,
      level: () => level,
      isActive: () => active,
      isUnderConstruction: () => building,
    });
    expect(
      assetValue([
        unit(UnitType.City, 2),
        unit(UnitType.Warship),
        unit(UnitType.SAMLauncher, 1, false),
        unit(UnitType.Factory, 1, true, true),
        unit(UnitType.AtomBomb),
      ]),
    ).toBe(500000);
  });
  it("reuses hot subpaths with bounded short connectors, without aliasing routes", () => {
    const config = { ...tradeCorridorsForPreset("longplay")!, hotTrips: 2 };
    let tick = 0,
      version = "1";
    const native = {
      findPath: vi.fn((a: number | number[], b: number) => {
        const x = Array.isArray(a) ? a[0] : a;
        return Array.from(
          { length: Math.abs(b - x) + 1 },
          (_, i) => x + i * Math.sign(b - x),
        );
      }),
    };
    const router = new TradeCorridorRouter(
      native,
      (a, b) => Math.abs(a - b),
      () => version,
      () => tick,
      config,
    );
    const first = router.findPath(0, 100)!;
    first[0] = 999;
    expect(router.findPath(0, 100)![0]).toBe(0);
    expect(native.findPath).toHaveBeenCalledTimes(1);
    expect(router.findPath(10, 90)).toEqual(
      Array.from({ length: 81 }, (_, i) => 10 + i),
    );
    expect(router.metrics.corridorHits).toBe(1);
    version = "2";
    router.findPath(0, 100);
    expect(router.metrics.fallbacks).toBe(2);
    tick = config.idleSeconds * 10 + 1;
    router.findPath(0, 100);
    expect(router.metrics.fallbacks).toBe(3);
  });
  it("falls back when there is no route and respects cache capacity", () => {
    const native = {
      findPath: vi.fn((a: number | number[], b: number) =>
        b === 9 ? null : [Number(a), b],
      ),
    };
    const router = new TradeCorridorRouter(
      native,
      (a, b) => Math.abs(a - b),
      () => "1",
      () => 0,
      tradeCorridorsForPreset("longplay")!,
      4,
      1,
    );
    expect(router.findPath(0, 9)).toBeNull();
    router.findPath(0, 1);
    router.findPath(2, 3);
    router.findPath(0, 1);
    expect(router.metrics.exactHits).toBe(0);
  });
  it("rail routing prefers direct physical distance, validates cached edges after damage", () => {
    let tick = 0;
    const station = (id: number): any => ({
      id,
      isActive: () => true,
      links: new Map(),
      neighbors() {
        return [...this.links.keys()];
      },
      getRailroadTo(s: any) {
        return this.links.get(s) ?? null;
      },
    });
    const a = station(1),
      b = station(2),
      c = station(3);
    const link = (x: any, y: any, n: number) => {
      const rail = { tiles: new Array(n + 1), trips: 0, lastTripTick: 0 };
      x.links.set(y, rail);
      y.links.set(x, rail);
    };
    link(a, b, 5);
    link(b, c, 5);
    link(a, c, 30);
    const game: any = {
      ticks: () => tick,
      config: () => ({
        gameConfig: () => ({
          tradeCorridors: tradeCorridorsForPreset("longplay"),
        }),
      }),
    };
    const native: any = { findStationsPath: vi.fn(() => []) };
    const router = new RailCorridorRouter(game, native);
    expect(router.find(a, c)).toEqual([a, b, c]);
    a.links.delete(b);
    b.links.delete(a);
    tick++;
    expect(router.find(a, c)).toEqual([a, c]);
    a.links.delete(c);
    c.links.delete(a);
    tick++;
    expect(router.find(a, c)).toEqual([]);
    expect(native.findStationsPath).toHaveBeenCalledOnce();
  });
});
