import { Game } from "./Game";
import { TileRef } from "./GameMap";

/**
 * Shared generation-stamped traversal state. Visited pages are allocated only
 * when a traversal reaches them, so local searches on very large worlds have
 * local memory cost rather than reserving one slot for every world tile.
 */
export interface TileTraversalScratch {
  readonly stack: TileRef[];
  readonly has: (tile: TileRef, generation: number) => boolean;
  readonly mark: (tile: TileRef, generation: number) => void;
  readonly clear: () => void;
  gen: number;
}

const scratches = new WeakMap<Game, TileTraversalScratch>();

export function tileTraversalScratch(game: Game): TileTraversalScratch {
  let scratch = scratches.get(game);
  if (scratch) return scratch;

  // Scratch has no spatial-page semantics. Linear 4K-tile blocks avoid the
  // coordinate division, object allocation and two page lookups per visit.
  const pageStamps: Array<Uint32Array | undefined> = [];
  scratch = {
    stack: [],
    gen: 0,
    has(tile, generation) {
      return pageStamps[tile >>> 12]?.[tile & 4095] === generation;
    },
    mark(tile, generation) {
      const pageIndex = tile >>> 12;
      const stamps =
        pageStamps[pageIndex] ??
        (pageStamps[pageIndex] = new Uint32Array(4096));
      stamps[tile & 4095] = generation;
    },
    clear() {
      for (const page of pageStamps) page?.fill(0);
    },
  };
  scratches.set(game, scratch);
  return scratch;
}

/** Starts a new traversal pass and returns its generation stamp. */
export function bumpTraversalGeneration(scratch: TileTraversalScratch): number {
  scratch.gen++;
  if (scratch.gen === 0xffffffff) {
    scratch.clear();
    scratch.gen = 1;
  }
  return scratch.gen;
}
