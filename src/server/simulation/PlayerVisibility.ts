/** Half-open linear tile interval. Producers split circular footprints into rows. */
export type SightSpan = readonly [start: number, end: number];

const PAGE_SIZE = 4096;
type Page = {
  sight?: Uint32Array;
  uniform: number;
  visibleTiles: number;
  explored: Uint32Array;
};
export interface ExplorationCheckpoint {
  version: 1;
  tileCount: number;
  pages: { index: number; words: number[] }[];
}

/**
 * One match/player's authority-owned coverage, shared across viewing devices.
 * Sparse pages avoid allocating a full-world counter array per player. Sources
 * retain row spans, not per-tile Sets. Moving sources touch only the difference
 * between old/new footprints. No work is performed on animation frames.
 */
export class PlayerVisibility {
  private readonly pages = new Map<number, Page>();
  private readonly sources = new Map<string, SightSpan[]>();
  private readonly dirty = new Set<number>();

  constructor(
    readonly tileCount: number,
    private readonly sightChanged?: (tile: number, visible: boolean) => void,
  ) {
    if (!Number.isSafeInteger(tileCount) || tileCount <= 0)
      throw new Error("Invalid visibility map size");
  }

  setSource(id: string, footprint: readonly SightSpan[]): void {
    // Validate the entire replacement before modifying any existing coverage.
    const next = this.normalize(footprint);
    const old = this.sources.get(id) ?? [];
    this.difference(old, next, -1);
    this.difference(next, old, 1);
    if (next.length) this.sources.set(id, next);
    else this.sources.delete(id);
  }

  removeSource(id: string): void {
    this.setSource(id, []);
  }

  /** Balanced authority events for territory halos, without a source per tile. */
  adjustCoverage(spans: readonly SightSpan[], delta: 1 | -1): void {
    for (const [start, end] of this.normalize(spans))
      this.change(start, end, delta);
  }

  explore(tile: number): void {
    if (!this.validTile(tile)) throw new Error("Invalid explored tile");
    const index = Math.floor(tile / PAGE_SIZE);
    let page = this.pages.get(index);
    if (!page) {
      page = {
        uniform: 0,
        visibleTiles: 0,
        explored: new Uint32Array(PAGE_SIZE / 32),
      };
      this.pages.set(index, page);
    }
    const offset = tile % PAGE_SIZE;
    const bit = 1 << (offset & 31);
    if (!(page.explored[offset >>> 5] & bit)) this.dirty.add(index);
    page.explored[offset >>> 5] |= bit;
  }

  isVisible(tile: number): boolean {
    if (!this.validTile(tile)) return false;
    const page = this.pages.get(Math.floor(tile / PAGE_SIZE));
    return !!page && (page.sight?.[tile % PAGE_SIZE] ?? page.uniform) > 0;
  }

  isExplored(tile: number): boolean {
    if (!this.validTile(tile)) return false;
    const page = this.pages.get(Math.floor(tile / PAGE_SIZE));
    const offset = tile % PAGE_SIZE;
    return !!(page && page.explored[offset >>> 5] & (1 << (offset & 31)));
  }

  /** Regions whose public visibility actually changed, not just overlap counts. */
  takeDirtyPages(): number[] {
    const result = [...this.dirty].sort((a, b) => a - b);
    this.dirty.clear();
    return result;
  }

  /** Typed-array storage only, excluding JS object overhead. */
  allocatedBytes(): number {
    let bytes = 0;
    for (const page of this.pages.values())
      bytes += page.explored.byteLength + (page.sight?.byteLength ?? 0);
    return bytes;
  }

  *exploredTiles(): IterableIterator<number> {
    for (const index of [...this.pages.keys()].sort((a, b) => a - b)) {
      const words = this.pages.get(index)!.explored;
      for (let word = 0; word < words.length; word++) {
        let bits = words[word];
        while (bits) {
          const tile =
            index * PAGE_SIZE + word * 32 + 31 - Math.clz32(bits & -bits);
          if (tile < this.tileCount) yield tile;
          bits = (bits & (bits - 1)) >>> 0;
        }
      }
    }
  }

  checkpoint(): ExplorationCheckpoint {
    return {
      version: 1,
      tileCount: this.tileCount,
      pages: [...this.pages]
        .sort(([a], [b]) => a - b)
        .map(([index, page]) => ({
          index,
          words: Array.from(page.explored),
        })),
    };
  }

  /** Merge server-owned historical exploration without replacing live sources. */
  mergeExploration(checkpoint: ExplorationCheckpoint): void {
    if (checkpoint.tileCount !== this.tileCount)
      throw new Error("Exploration map mismatch");
    const checked = PlayerVisibility.restore(checkpoint);
    for (const [index, restored] of checked.pages) {
      const current = this.pages.get(index);
      if (!current) this.pages.set(index, restored);
      else
        for (let word = 0; word < restored.explored.length; word++)
          current.explored[word] |= restored.explored[word];
      this.dirty.add(index);
    }
  }

  /** Restore charted terrain only. Rebuild current sources from live authority. */
  static restore(checkpoint: ExplorationCheckpoint): PlayerVisibility {
    if (checkpoint.version !== 1)
      throw new Error("Unsupported exploration version");
    const result = new PlayerVisibility(checkpoint.tileCount);
    for (const { index, words } of checkpoint.pages) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= Math.ceil(result.tileCount / PAGE_SIZE) ||
        result.pages.has(index) ||
        words.length !== PAGE_SIZE / 32 ||
        words.some(
          (word) => !Number.isInteger(word) || word < 0 || word > 0xffffffff,
        )
      )
        throw new Error("Invalid exploration page");
      result.pages.set(index, {
        uniform: 0,
        visibleTiles: 0,
        explored: Uint32Array.from(words),
      });
      result.dirty.add(index);
    }
    return result;
  }

  private validTile(tile: number): boolean {
    return Number.isSafeInteger(tile) && tile >= 0 && tile < this.tileCount;
  }

  private normalize(spans: readonly SightSpan[]): SightSpan[] {
    const sorted = spans
      .map(([start, end]): SightSpan => {
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          end > this.tileCount ||
          end <= start
        )
          throw new Error("Invalid sight span");
        return [start, end];
      })
      .sort(([a], [b]) => a - b);
    const result: SightSpan[] = [];
    for (const [start, end] of sorted) {
      const last = result[result.length - 1];
      if (last && start <= last[1])
        result[result.length - 1] = [last[0], Math.max(last[1], end)];
      else result.push([start, end]);
    }
    return result;
  }

  /** Apply A minus B in linear span time, plus only changed tiles. */
  private difference(a: SightSpan[], b: SightSpan[], delta: 1 | -1): void {
    let j = 0;
    for (const [start, end] of a) {
      let cursor = start;
      while (j < b.length && b[j][1] <= cursor) j++;
      let k = j;
      while (k < b.length && b[k][0] < end) {
        if (b[k][0] > cursor)
          this.change(cursor, Math.min(end, b[k][0]), delta);
        cursor = Math.max(cursor, b[k][1]);
        if (cursor >= end) break;
        k++;
      }
      if (cursor < end) this.change(cursor, end, delta);
      j = k;
    }
  }

  private change(start: number, end: number, delta: 1 | -1): void {
    while (start < end) {
      const index = Math.floor(start / PAGE_SIZE);
      let page = this.pages.get(index);
      if (!page) {
        page = {
          uniform: 0,
          visibleTiles: 0,
          explored: new Uint32Array(PAGE_SIZE / 32),
        };
        this.pages.set(index, page);
      }
      const limit = Math.min(end, (index + 1) * PAGE_SIZE);
      if (
        !page.sight &&
        start % PAGE_SIZE === 0 &&
        limit - start === PAGE_SIZE
      ) {
        const before = page.uniform;
        if (delta === -1 && before === 0)
          throw new Error("Unbalanced sight removal");
        page.uniform += delta;
        page.visibleTiles = page.uniform > 0 ? PAGE_SIZE : 0;
        if (delta === 1) page.explored.fill(0xffffffff);
        if ((before === 0) !== (page.uniform === 0)) {
          this.dirty.add(index);
          if (this.sightChanged)
            for (let tile = start; tile < limit; tile++)
              this.sightChanged(tile, page.uniform > 0);
        }
        start = limit;
        continue;
      }
      const sight = (page.sight ??= new Uint32Array(PAGE_SIZE).fill(
        page.uniform,
      ));
      for (; start < limit; start++) {
        const offset = start % PAGE_SIZE;
        const before = sight[offset];
        if (delta === -1 && before === 0)
          throw new Error("Unbalanced sight removal");
        sight[offset] = before + delta;
        if (delta === 1) page.explored[offset >>> 5] |= 1 << (offset & 31);
        if ((before === 0) !== (sight[offset] === 0)) {
          page.visibleTiles += delta;
          this.dirty.add(index);
          this.sightChanged?.(start, sight[offset] > 0);
        }
      }
      // Explored-only pages retain 512 bytes, not 16 KB of unused live counts.
      if (page.visibleTiles === 0) {
        page.sight = undefined;
        page.uniform = 0;
      }
    }
  }
}
