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
  readonly metrics = { searches: 0, hits: 0, invalidations: 0 };
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
    const key = typeof from === "number" ? `${from}:${to}` : undefined;
    if (key !== undefined && this.failures.has(key)) {
      this.metrics.hits++;
      return null;
    }
    this.metrics.searches++;
    const route = this.inner.findPath(from, to);
    if (route === null && key !== undefined && this.capacity > 0) {
      if (this.failures.size >= this.capacity)
        this.failures.delete(this.failures.values().next().value!);
      this.failures.add(key);
    }
    return route;
  }
}
