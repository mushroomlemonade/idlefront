/** Rolling live measurements, never derived from replay speed or game age. */
export class SimulationPerformanceWindow {
  private samples: {
    tick: number;
    at: number;
    duration: number;
    debt: number;
  }[] = [];
  private next = 0;
  constructor(private readonly capacity = 600) {
    if (capacity < 2)
      throw new Error("Performance window needs at least two samples");
  }
  record(tick: number, at: number, duration: number, debt: number): void {
    const previous =
      this.samples[(this.next + this.samples.length - 1) % this.samples.length];
    if (previous && (tick <= previous.tick || at < previous.at)) {
      this.samples = [];
      this.next = 0;
    }
    this.samples[this.next] = { tick, at, duration, debt };
    this.next = (this.next + 1) % this.capacity;
  }
  summary() {
    if (!this.samples.length) return undefined;
    const ordered =
      this.samples.length < this.capacity
        ? this.samples
        : [
            ...this.samples.slice(this.next),
            ...this.samples.slice(0, this.next),
          ];
    const first = ordered[0],
      last = ordered[ordered.length - 1];
    const durations = ordered.map((s) => s.duration).sort((a, b) => a - b);
    const percentile = (p: number) =>
      durations[Math.max(0, Math.ceil(p * durations.length) - 1)];
    return {
      samples: ordered.length,
      elapsedMs: last.at - first.at,
      liveTPS:
        last.at > first.at
          ? ((last.tick - first.tick) * 1000) / (last.at - first.at)
          : null,
      tickP50Ms: percentile(0.5),
      tickP95Ms: percentile(0.95),
      tickP99Ms: percentile(0.99),
      tickMaxMs: durations[durations.length - 1],
      overBudgetTicks: durations.filter((ms) => ms > 100).length,
      clockDebtMs: last.debt,
      debtChangeMs: last.debt - first.debt,
    };
  }
}
