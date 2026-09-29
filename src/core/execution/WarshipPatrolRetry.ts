import type { Unit } from "../game/Game";

/** Simulation-tick scheduling only; never wall time or shared random draws. */
export class WarshipPatrolRetry {
  private failures = 0;
  private nextTick = 0;
  private context: string | undefined;

  ready(tick: number, context: string): boolean {
    if (context !== this.context) {
      this.reset();
      this.context = context;
    }
    return tick >= this.nextTick;
  }

  failed(tick: number, unitId: number): void {
    this.failures = Math.min(this.failures + 1, 4);
    // 1–5 seconds at 10 TPS, plus a stable spread so fleets do not retry in lockstep.
    this.nextTick =
      tick + Math.min(50, 10 * 2 ** (this.failures - 1)) + (unitId % 7);
  }

  reset(): void {
    this.failures = 0;
    this.nextTick = 0;
  }
}

// Weak keys avoid retaining destroyed ships. Both manual and autonomous orders
// can wake a retry, even when the new patrol tile equals the previous one.
const retries = new WeakMap<Unit, WarshipPatrolRetry>();
export function warshipPatrolRetry(unit: Unit): WarshipPatrolRetry {
  let retry = retries.get(unit);
  if (!retry) retries.set(unit, (retry = new WarshipPatrolRetry()));
  return retry;
}
export function resetWarshipPatrolRetry(unit: Unit): void {
  retries.get(unit)?.reset();
}
