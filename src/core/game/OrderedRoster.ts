/** Ordered unique membership with legacy array iteration semantics.
 * Additions extend the current array; removals replace it lazily, leaving
 * existing readers/iterators untouched. Callers must not mutate snapshot().
 * A batch of k removals costs O(k), plus O(n) only if a reader needs an array.
 */
export class OrderedRoster<T> {
  private readonly members = new Set<T>();
  private cached: T[] | undefined = [];

  add(value: T): void {
    if (this.members.has(value)) return;
    this.members.add(value);
    this.cached?.push(value);
  }

  delete(value: T): boolean {
    if (!this.members.delete(value)) return false;
    this.cached = undefined;
    return true;
  }

  snapshot(): T[] {
    return (this.cached ??= Array.from(this.members));
  }
}
