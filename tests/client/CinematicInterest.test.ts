import { expect, it } from "vitest";
import { cinematicInterest } from "../../src/client/components/CinematicInterest";
import type { UnitView } from "../../src/client/view";
import { UnitType } from "../../src/core/game/Game";

const unit = (type: UnitType, combat = false, moving = true) =>
  ({
    type: () => type,
    isInCombat: () => combat,
    tile: () => 20,
    state: { lastPos: moving ? 10 : 20 },
  }) as unknown as UnitView;

it("ranks MIRV, hydro, atom, combat, moving trains and deliveries in order", () => {
  const ranks = [
    unit(UnitType.MIRV),
    unit(UnitType.HydrogenBomb),
    unit(UnitType.AtomBomb),
    unit(UnitType.Warship, true),
    unit(UnitType.Train),
    unit(UnitType.TradeShip),
  ].map(cinematicInterest);
  for (let i = 1; i < ranks.length; i++)
    expect(ranks[i - 1]).toBeGreaterThan(ranks[i]);
});
it("does not mistake parked trains or idle warships for activity", () => {
  expect(cinematicInterest(unit(UnitType.Train, false, false))).toBeLessThan(
    cinematicInterest(unit(UnitType.TradeShip)),
  );
  expect(cinematicInterest(unit(UnitType.Warship))).toBeLessThan(
    cinematicInterest(unit(UnitType.Train)),
  );
  expect(cinematicInterest(unit(UnitType.City))).toBe(0);
  expect(cinematicInterest(unit(UnitType.Port))).toBe(0);
});
