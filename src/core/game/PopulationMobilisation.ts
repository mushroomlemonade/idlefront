/** Prototype accounting kernel. Integration into PlayerImpl is a separate gate.
 * All quantities include committed troops: combat/transport must not duplicate
 * them, and a committed army cannot be demobilised until it returns.
 */
export interface PopulationState {
  civilians: number;
  troops: number;
  committedTroops: number;
}

function nonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function validatePopulation(state: PopulationState): void {
  if (
    !nonnegative(state.civilians) ||
    !nonnegative(state.troops) ||
    !nonnegative(state.committedTroops) ||
    state.committedTroops > state.troops
  ) {
    throw new RangeError("Invalid population accounting");
  }
}

/** Exact exponential approach to a target for a fixed population and target.
 * Manual and automatic targets use this same function and half-life setting.
 * No growth or deaths happen here. Fractions remain in simulation precision.
 */
export function mobilisePopulation(
  state: PopulationState,
  targetTroopShare: number,
  elapsedGameSeconds: number,
  halfLifeSeconds: number,
): PopulationState {
  validatePopulation(state);
  if (
    !nonnegative(targetTroopShare) ||
    targetTroopShare > 1 ||
    !nonnegative(elapsedGameSeconds) ||
    !Number.isFinite(halfLifeSeconds) ||
    halfLifeSeconds <= 0
  ) {
    throw new RangeError("Invalid mobilisation parameters");
  }
  const population = state.civilians + state.troops;
  const target = Math.max(state.committedTroops, population * targetTroopShare);
  const fraction = -Math.expm1(
    (-Math.LN2 * elapsedGameSeconds) / halfLifeSeconds,
  );
  const troops = Math.min(
    population,
    Math.max(
      state.committedTroops,
      state.troops + (target - state.troops) * fraction,
    ),
  );
  return {
    civilians: population - troops,
    troops,
    committedTroops: state.committedTroops,
  };
}

/** Proposed first income curve: 1x with no civilians, 2x with all civilians.
 * Apply only at passive/train/trade income sources, never transfers or refunds.
 */
export function civilianIncomeMultiplier(state: PopulationState): number {
  validatePopulation(state);
  const population = state.civilians + state.troops;
  return population === 0 ? 1 : 1 + state.civilians / population;
}

/** Immediate conserved donation of available troops, independent of capacity.
 * Capacity governs future growth; it must not silently destroy a donation.
 */
export function donatePopulationTroops(
  sender: PopulationState,
  recipient: PopulationState,
  amount: number,
): { sender: PopulationState; recipient: PopulationState } {
  validatePopulation(sender);
  validatePopulation(recipient);
  if (!nonnegative(amount) || amount > sender.troops - sender.committedTroops) {
    throw new RangeError("Donation exceeds available troops");
  }
  return {
    sender: { ...sender, troops: sender.troops - amount },
    recipient: { ...recipient, troops: recipient.troops + amount },
  };
}
