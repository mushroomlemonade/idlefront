export const MAX_FLEET_TARGET = 10000;
export const WARSHIP_COST_STEP = 250000;
export const WARSHIP_COST_CAP = 1000000;

/** Native pricing curve, shared with the construction configuration. */
export function warshipCost(count: number): number {
  return Math.min(WARSHIP_COST_CAP, (count + 1) * WARSHIP_COST_STEP);
}

export function fleetPurchaseCost(additions: number, nextCost: bigint): bigint {
  let remaining = Math.max(
    0,
    Math.min(MAX_FLEET_TARGET, Math.floor(additions)),
  );
  let price = nextCost,
    total = 0n;
  if (price <= 0n) return 0n;
  while (remaining > 0 && price < BigInt(WARSHIP_COST_CAP)) {
    total += price;
    remaining--;
    price = BigInt(
      Math.min(WARSHIP_COST_CAP, Number(price) + WARSHIP_COST_STEP),
    );
  }
  return total + BigInt(remaining) * price;
}

export function fleetTargetForPercent(
  owned: number,
  budget: bigint,
  nextCost: bigint,
  percent: number,
): number {
  if (percent <= 0) return 0;
  if (nextCost === 0n) return MAX_FLEET_TARGET;
  const funds =
    ((budget > 0n ? budget : 0n) * BigInt(Math.min(110, Math.round(percent)))) /
    100n;
  let low = 0,
    high = Math.max(0, MAX_FLEET_TARGET - owned);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fleetPurchaseCost(mid, nextCost) <= funds) low = mid;
    else high = mid - 1;
  }
  return Math.min(MAX_FLEET_TARGET, owned + low);
}

/** Starts from the authoritative next-ship quote, including free-build rules. */
export function affordableFleetMaximum(
  owned: number,
  gold: bigint,
  reserve: bigint,
  nextCost: bigint,
): number {
  let budget = gold > reserve ? gold - reserve : 0n;
  if (nextCost === 0n) return MAX_FLEET_TARGET;
  let additions = 0;
  let price = nextCost;
  // At most three rising-price purchases, then constant-time bulk division.
  while (price < BigInt(WARSHIP_COST_CAP) && price > 0n && budget >= price) {
    budget -= price;
    additions++;
    price = BigInt(
      Math.min(WARSHIP_COST_CAP, Number(price) + WARSHIP_COST_STEP),
    );
  }
  if (price > 0n && budget >= price) additions += Number(budget / price);
  return Math.min(
    MAX_FLEET_TARGET,
    Math.max(
      1,
      Math.ceil((Math.min(MAX_FLEET_TARGET, owned + additions) * 11) / 10),
    ),
  );
}
