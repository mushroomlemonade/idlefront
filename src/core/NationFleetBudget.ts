import { fleetTargetForPercent, MAX_FLEET_TARGET } from "./FleetAffordability";
/** Coverage demand grows sublinearly so every new port doesn't spawn three
 * more permanent ships. A campaign adds an escort group. Native costs apply. */
export function nationFleetBudget(
  ports: number,
  owned: number,
  gold: bigint,
  reserve: bigint,
  nextCost: bigint,
  invading: boolean,
): number {
  if (ports <= 0) return 0;
  const coverage = Math.ceil(Math.sqrt(ports) * 8) + (invading ? 8 : 0);
  const budget = gold > reserve ? gold - reserve : 0n;
  return Math.min(
    MAX_FLEET_TARGET,
    coverage,
    fleetTargetForPercent(owned, budget, nextCost, 25),
  );
}
