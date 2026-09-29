import { afterEach, expect, it, vi } from "vitest";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { WaterPathFinder } from "../../../src/core/pathfinding/PathFinder";
import { WaterRefinementTransformer } from "../../../src/core/pathfinding/transformers/WaterRefinementTransformer";
import {
  tradeCorridorsForPreset,
  TradeCorridorsSchema,
} from "../../../src/core/TradeCorridors";

afterEach(() => vi.restoreAllMocks());

function fixture(enabled = true) {
  const map = new GameMapImpl(256, 1, new Uint8Array(256).fill(32), 0);
  let version = 0;
  const settings = { ...tradeCorridorsForPreset("longplay")!, hotTrips: 2 };
  if (!enabled) delete settings.warshipRouting;
  const game: any = {
    map: () => map,
    miniMap: () => map,
    miniWaterHPA: () => undefined,
    miniWaterGraph: () => undefined,
    config: () => ({ gameConfig: () => ({ tradeCorridors: settings }) }),
    observeWaterConversions: () => {},
    waterGraphVersion: () => version,
    ticks: () => 0,
    isValidRef: (t: number) => t >= 0 && t < 256,
    manhattanDist: (a: number, b: number) => Math.abs(a - b),
  };
  const native = vi
    .spyOn(WaterRefinementTransformer.prototype, "findPath")
    .mockImplementation((from, to) => {
      const a = Array.isArray(from) ? from[0] : from;
      return Array.from(
        { length: Math.abs(to - a) + 1 },
        (_, i) => a + i * Math.sign(to - a),
      );
    });
  return { game, native, revise: () => version++ };
}

it("warships join trade geometry in either direction using only short connectors", () => {
  const { game, native, revise } = fixture();
  const trade = new WaterPathFinder(game, 0, true);
  trade.findPath(0, 200);
  trade.findPath(0, 200);
  native.mockClear();
  const warship = new WaterPathFinder(game, 0, "warship");
  // Joining a sampled portal may briefly move away from the destination;
  // bounded detours are permitted, but every step must remain contiguous.
  expect(warship.next(10, 190)).toMatchObject({ node: 9 });
  expect(
    native.mock.calls.every(([a, b]) => Math.abs(Number(a) - b) <= 32),
  ).toBe(true);
  expect(native).toHaveBeenCalledTimes(2);
  expect(new WaterPathFinder(game, 0, "warship").next(10, 190)).toMatchObject({
    node: 9,
  });
  expect(native).toHaveBeenCalledTimes(2);
  expect(warship.next(9, 190)).toMatchObject({ node: 8 });
  const route = warship.findPath(10, 190)!;
  expect(route.length - 1).toBeLessThanOrEqual(180 * 1.25);
  expect(
    route.every((t, i) => i === 0 || Math.abs(t - route[i - 1]) === 1),
  ).toBe(true);
  expect(new WaterPathFinder(game, 0, "warship").next(190, 10)).toMatchObject({
    node: 189,
  });
  revise();
  native.mockClear();
  expect(warship.next(12, 190)).toMatchObject({ node: 13 });
  expect(native).toHaveBeenCalledWith(12, 190);
});

it("combat/retreat bypass corridors and changed orders get a new path", () => {
  const { game, native } = fixture();
  const trade = new WaterPathFinder(game, 0, true);
  trade.findPath(0, 200);
  trade.findPath(0, 200);
  native.mockClear();
  const ship = new WaterPathFinder(game, 0, "warship");
  ship.next(10, 190, undefined, true);
  expect(native).toHaveBeenCalledWith(10, 190);
  ship.next(11, 100, undefined, true);
  expect(native).toHaveBeenCalledWith(11, 100);
  ship.invalidate();
  ship.next(11, 20);
  expect(native).toHaveBeenCalledWith(11, 20);
});

it("legacy saved configs retain native routing and new presets persist the opt-in", () => {
  const { game, native } = fixture(false);
  const trade = new WaterPathFinder(game, 0, true);
  trade.findPath(0, 200);
  trade.findPath(0, 200);
  native.mockClear();
  new WaterPathFinder(game, 0, "warship").next(10, 190);
  expect(native).toHaveBeenCalledWith(10, 190);
  expect(
    TradeCorridorsSchema.parse(
      JSON.parse(JSON.stringify(tradeCorridorsForPreset("longplay"))),
    ),
  ).toHaveProperty("warshipRouting", "shared-v1");
  expect(tradeCorridorsForPreset("quickplay")).toBeUndefined();
});
