import { UnitType } from "./game/Game";

/** Standardized asset score (UI calls it GDP), not income or past spending.
 * Fixed first-unit replacement prices make capture/loss comparable regardless
 * of purchase order, inflation, or infinite-gold settings. Completed levels only. */
export const ASSET_VALUE: Readonly<Partial<Record<UnitType, number>>> = {
  [UnitType.City]: 125_000,
  [UnitType.Factory]: 125_000,
  [UnitType.Port]: 125_000,
  [UnitType.DefensePost]: 50_000,
  [UnitType.MissileSilo]: 1_000_000,
  [UnitType.SAMLauncher]: 1_500_000,
  [UnitType.Warship]: 250_000,
};

export function assetValue(
  units: Iterable<{
    type(): UnitType;
    level(): number;
    isActive(): boolean;
    isUnderConstruction(): boolean;
  }>,
): number {
  let value = 0;
  for (const unit of units) {
    if (unit.isActive() && !unit.isUnderConstruction())
      value += (ASSET_VALUE[unit.type()] ?? 0) * Math.max(0, unit.level());
  }
  return value;
}
