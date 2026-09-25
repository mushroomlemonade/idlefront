import { TrainType, UnitType } from "../../core/game/Game";
import type { UnitView } from "../view";

/** Categories are deliberately separated so route length never beats combat. */
export function cinematicInterest(unit: UnitView): number {
  switch (unit.type()) {
    case UnitType.MIRV:
      return 600;
    case UnitType.MIRVWarhead:
      return 590;
    case UnitType.HydrogenBomb:
      return 500;
    case UnitType.AtomBomb:
      return 400;
    case UnitType.Warship:
      return unit.isInCombat?.() ? 300 : 40;
    case UnitType.Train:
      if (
        unit.trainType?.() !== undefined &&
        unit.trainType() !== TrainType.Engine
      )
        return 0;
      return unit.state?.lastPos !== unit.tile() ? 200 : 20;
    case UnitType.TradeShip:
      return 100;
    case UnitType.TransportShip:
      return 50;
    default:
      return 0;
  }
}
