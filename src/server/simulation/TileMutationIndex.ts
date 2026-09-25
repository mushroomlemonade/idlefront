import type { GameMap, TileRef } from "../../core/game/GameMap";

export interface TileMutationCheckpoint {
  readonly source: TileMutationIndex;
  readonly epoch: number;
  readonly chunks: Uint32Array;
  readonly revisions: Uint32Array;
}

/** Conservative spatial read-dependency invalidation. Optional; the live
 * simulation does not instantiate this until parallel planning is enabled.
 * State/terrain writes MUST use map mutators, not exposed raw array references.
 * All captures and validation occur on the one authoritative thread.
 */
export class TileMutationIndex {
  private readonly versions: Uint32Array;
  private readonly columns: number;
  private readonly shift: number;
  private readonly width: number;
  private epoch = 0;
  private active = true;
  private readonly unsubscribe: (() => void)[];

  constructor(
    map: GameMap,
    readonly chunkSize = 16,
  ) {
    if (
      !Number.isSafeInteger(chunkSize) ||
      chunkSize < 1 ||
      chunkSize > 1024 ||
      (chunkSize & (chunkSize - 1)) !== 0
    )
      throw new Error("Invalid revision chunk size");
    if (!map.observeState || !map.observeTerrain)
      throw new Error("Map mutation hooks unavailable");
    this.width = map.width();
    this.shift = Math.log2(chunkSize);
    this.columns = Math.ceil(this.width / chunkSize);
    const count = this.columns * Math.ceil(map.height() / chunkSize);
    if (!Number.isSafeInteger(count) || count > 16_777_216)
      throw new Error("Mutation revision memory budget exceeded");
    this.versions = new Uint32Array(count);
    const mark = (tile: TileRef) => {
      const chunk = this.chunkOf(tile);
      // Do not let wrapping a per-chunk uint32 accidentally validate an old
      // checkpoint. All prior epochs fail closed, including unchanged chunks.
      this.versions[chunk] = (this.versions[chunk] + 1) >>> 0;
      if (this.versions[chunk] === 0) {
        this.versions.fill(0);
        if (this.epoch === Number.MAX_SAFE_INTEGER) this.active = false;
        else this.epoch++;
      }
    };
    this.unsubscribe = [map.observeState(mark), map.observeTerrain(mark)];
  }

  private chunkOf(tile: TileRef): number {
    return (
      (((tile / this.width) | 0) >>> this.shift) * this.columns +
      ((tile % this.width) >>> this.shift)
    );
  }

  capture(tiles: Uint32Array): TileMutationCheckpoint {
    if (!this.active) throw new Error("Mutation index is inactive");
    const unique = new Set<number>();
    for (const tile of tiles) unique.add(this.chunkOf(tile));
    const chunks = Uint32Array.from(unique);
    return {
      source: this,
      epoch: this.epoch,
      chunks,
      revisions: Uint32Array.from(chunks, (chunk) => this.versions[chunk]),
    };
  }

  unchanged(checkpoint: TileMutationCheckpoint): boolean {
    if (
      !this.active ||
      checkpoint.source !== this ||
      checkpoint.epoch !== this.epoch
    )
      return false;
    if (checkpoint.chunks.length !== checkpoint.revisions.length) return false;
    for (let i = 0; i < checkpoint.chunks.length; i++)
      if (
        checkpoint.chunks[i] >= this.versions.length ||
        this.versions[checkpoint.chunks[i]] !== checkpoint.revisions[i]
      )
        return false;
    return true;
  }

  get byteLength(): number {
    return this.versions.byteLength;
  }

  dispose(): void {
    if (!this.active && this.unsubscribe.length === 0) return;
    this.active = false;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }
}
