import { expect, it } from "vitest";
import {
  affordableFleetMaximum,
  fleetPurchaseCost,
  fleetTargetForPercent,
  MAX_FLEET_TARGET,
  warshipCost,
} from "../src/core/FleetAffordability";

it("converts a money percentage using cumulative native costs", () => {
  expect(fleetPurchaseCost(4, 250000n)).toBe(2500000n);
  expect(fleetTargetForPercent(0, 1000000n, 250000n, 100)).toBe(2);
  expect(fleetTargetForPercent(5, 10000000n, 1000000n, 110)).toBe(16);
  expect(fleetTargetForPercent(5, 10000000n, 1000000n, 0)).toBe(0);
  expect(fleetTargetForPercent(5, 0n, 1000000n, 100)).toBe(5);
  expect(fleetTargetForPercent(0, 99999544n, 250000n, 50)).toBe(51);
  expect(fleetTargetForPercent(0, 99999544n, 250000n, 110)).toBe(111);
  expect(fleetTargetForPercent(0, 0n, 0n, 110)).toBe(MAX_FLEET_TARGET);
});

it("sums escalating prices, counts existing ships, and respects reserve", () => {
  expect(affordableFleetMaximum(0, 1000000n, 0n, 250000n)).toBe(3);
  expect(affordableFleetMaximum(5, 5000000n, 2000000n, 1000000n)).toBe(9);
  expect(affordableFleetMaximum(100, 0n, 1000n, 1000000n)).toBe(110);
  expect(affordableFleetMaximum(0, 100n, 1000n, 250000n)).toBe(1);
});
it("matches native prices and bounds free or enormous budgets", () => {
  expect([0, 1, 2, 3, 4].map(warshipCost)).toEqual([
    250000, 500000, 750000, 1000000, 1000000,
  ]);
  expect(affordableFleetMaximum(0, 0n, 0n, 0n)).toBe(MAX_FLEET_TARGET);
  expect(affordableFleetMaximum(0, 10n ** 30n, 0n, 250000n)).toBe(
    MAX_FLEET_TARGET,
  );
});
