import type { TileRef } from "../../game/GameMap";
import type { PathFinder } from "../types";

/**
 * Cache ONLY exact single-source failures against unchanged navigation data.
 * No successful route reuse, source reordering, heuristic or retry-time change.
 * Moving targets and changed starts are new searches. Exceptions are not cached.
 */
export class FailedRouteCache implements PathFinder<TileRef> {
  private readonly failures = new Set<string>();
  private revision: string | undefined;
  readonly metrics = { searches: 0, hits: 0, invalidations: 0, totalMs: 0 };
  readonly failureSamples: { from: number[]; to: number; revision: string }[] =
    [];
  constructor(
    private readonly inner: PathFinder<TileRef>,
    private readonly getRevision: () => string,
    private readonly capacity = 4096,
  ) {}
  findPath(from: TileRef | TileRef[], to: TileRef): TileRef[] | null {
    const revision = this.getRevision();
    if (revision !== this.revision) {
      this.failures.clear();
      this.revision = revision;
      this.metrics.invalidations++;
    }
    // Multi-source ordering and duplicate-source behavior stay entirely with
    // the existing pathfinder; do not build enormous keys for port searches.
    // Preserve exact ordered multi-source semantics. Port coast candidates are
    // small; repeated failures from that same shore need not run A* again.
    const key =
      typeof from === "number"
        ? `${from}:${to}`
        : from.length <= 64
          ? `m:${from.join(",")}:${to}`
          : undefined;
    if (key !== undefined && this.failures.has(key)) {
      this.metrics.hits++;
      return null;
    }
    this.metrics.searches++;
    const started = performance.now();
    let route: TileRef[] | null;
    try {
      route = this.inner.findPath(from, to);
    } finally {
      this.metrics.totalMs += performance.now() - started;
    }
    if (route === null && key !== undefined && this.capacity > 0) {
      if (this.failures.size >= this.capacity)
        this.failures.delete(this.failures.values().next().value!);
      this.failures.add(key);
      this.failureSamples.push({
        from: typeof from === "number" ? [from] : from.slice(),
        to,
        revision,
      });
      if (this.failureSamples.length > 16) this.failureSamples.shift();
    }
    return route;
  }
}
