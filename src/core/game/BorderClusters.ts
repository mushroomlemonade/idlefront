import type { GameMap, TileRef } from "./GameMap";
import type { ReadonlyTileSet } from "./TileSet";
import {
  bumpTraversalGeneration,
  type TileTraversalScratch,
} from "./TileTraversalScratch";

/**
 * Same DFS and insertion order as PlayerExecution's original cluster traversal.
 * A single generation stamp means "border member, not visited yet", replacing
 * both a hash-table membership check and a separate visited check per edge.
 * No connectivity approximation, changed cadence, or different capture order.
 */
export function collectBorderClusters(
  map: GameMap,
  borders: ReadonlyTileSet,
  scratch: TileTraversalScratch,
): TileRef[][] {
  if (borders.size === 0) return [];
  const generation = bumpTraversalGeneration(scratch);
  borders.forEach((tile) => scratch.mark(tile, generation));
  const clusters: TileRef[][] = [];
  const stack = scratch.stack;
  stack.length = 0;
  let cluster: TileRef[];
  const visit = (tile: TileRef) => {
    if (!scratch.has(tile, generation)) return;
    scratch.mark(tile, 0);
    cluster.push(tile);
    stack.push(tile);
  };
  borders.forEach((start) => {
    if (!scratch.has(start, generation)) return;
    cluster = [];
    visit(start);
    while (stack.length) map.forEachNeighborWithDiag(stack.pop()!, visit);
    clusters.push(cluster);
  });
  return clusters;
}
