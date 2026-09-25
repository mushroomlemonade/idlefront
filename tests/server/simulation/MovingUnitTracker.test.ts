import { describe, expect, it, vi } from "vitest";
import { UnitType, type Unit } from "../../../src/core/game/Game";
import type { UnitUpdate } from "../../../src/core/game/GameUpdates";
import {
  isPositionDynamic,
  MovingUnitTracker,
} from "../../../src/server/simulation/MovingUnitTracker";

function unit(id: number, type: UnitType, position: { value: number }): Unit {
  return {
    id: () => id,
    type: () => type,
    tile: () => position.value,
    isActive: () => true,
    toUpdate: () =>
      ({ id, unitType: type, pos: position.value, isActive: true }) as UnitUpdate,
  } as Unit;
}

describe("MovingUnitTracker", () => {
  it("never classifies OpenFront structures as position-dynamic", () => {
    for (const type of [
      UnitType.City,
      UnitType.Factory,
      UnitType.Port,
      UnitType.DefensePost,
      UnitType.SAMLauncher,
      UnitType.MissileSilo,
    ]) {
      expect(isPositionDynamic(type)).toBe(false);
    }
    expect(isPositionDynamic(UnitType.TransportShip)).toBe(true);
    expect(isPositionDynamic(UnitType.Warship)).toBe(true);
    expect(isPositionDynamic(UnitType.Train)).toBe(true);
  });

  it("stops visiting stationary structures after the initial full sync", () => {
    const cityPos = { value: 10 };
    const boatPos = { value: 20 };
    const city = unit(1, UnitType.City, cityPos);
    const boat = unit(2, UnitType.TransportShip, boatPos);
    const units = vi.fn(() => [city, boat]);
    const byID = new Map([
      [1, city],
      [2, boat],
    ]);
    const game = { units, unit: (id: number) => byID.get(id) };
    const tracker = new MovingUnitTracker();

    const initial: UnitUpdate[] = [];
    tracker.appendChangedPositions(game, initial);
    expect(initial.map((update) => update.id)).toEqual([1, 2]);
    expect(tracker.trackedCount()).toBe(1);

    boatPos.value = 21;
    const next: UnitUpdate[] = [];
    tracker.appendChangedPositions(game, next);
    expect(next.map((update) => update.id)).toEqual([2]);
    expect(units).toHaveBeenCalledTimes(1);
  });
});
