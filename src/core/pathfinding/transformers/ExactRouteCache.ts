import type { PathFinder } from "../types";

/** Bounded, exact endpoint cache. Never reverses routes or shares mutable arrays.
 * Both the graph and full-resolution terrain revision are part of validity. */
export class ExactRouteCache implements PathFinder<number> {
  private entries = new Map<string, Uint32Array | null>();
  private nodes = 0;
  private revision = "";
  readonly metrics = { hits: 0, misses: 0, evictions: 0 };
  constructor(
    private inner: PathFinder<number>,
    private version: () => string,
    private maxNodes = 1_000_000,
    private maxEntries = 2048,
  ) {}
  private key(from: number | number[], to: number): string | undefined {
    if (Array.isArray(from) && from.length > 64) return undefined;
    return `${Array.isArray(from) ? "m:" + from.join(",") : "s:" + from}:${to}`;
  }
  private fresh() {
    const revision = this.version();
    if (revision !== this.revision) {
      this.entries.clear();
      this.nodes = 0;
      this.revision = revision;
    }
  }
  has(from: number | number[], to: number): boolean {
    this.fresh();
    const key = this.key(from, to);
    return key !== undefined && this.entries.has(key);
  }
  store(from: number | number[], to: number, route: number[] | null) {
    this.fresh();
    const key = this.key(from, to);
    if (
      key === undefined ||
      (route?.length ?? 0) > this.maxNodes ||
      this.maxEntries < 1
    )
      return;
    this.nodes -= this.entries.get(key)?.length ?? 0;
    this.entries.delete(key);
    const value = route === null ? null : Uint32Array.from(route);
    this.entries.set(key, value);
    this.nodes += value?.length ?? 0;
    while (this.nodes > this.maxNodes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.nodes -= this.entries.get(oldest)?.length ?? 0;
      this.entries.delete(oldest);
      this.metrics.evictions++;
    }
  }
  findPath(from: number | number[], to: number): number[] | null {
    this.fresh();
    const key = this.key(from, to);
    if (key !== undefined && this.entries.has(key)) {
      const value = this.entries.get(key)!;
      this.entries.delete(key);
      this.entries.set(key, value);
      this.metrics.hits++;
      return value === null ? null : Array.from(value);
    }
    this.metrics.misses++;
    const result = this.inner.findPath(from, to);
    this.store(from, to, result);
    return result;
  }
}
