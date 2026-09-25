import type { GameMap, TileRef } from "../../src/core/game/GameMap";
import type { ReadonlyTileSet } from "../../src/core/game/TileSet";
import {
  bumpTraversalGeneration,
  type TileTraversalScratch,
} from "../../src/core/game/TileTraversalScratch";

// Frozen pre-optimization DFS, including insertion and neighbor visitation order.
export function referenceBorderClusters(
  map: GameMap,
  borders: ReadonlyTileSet,
  state: TileTraversalScratch,
): TileRef[][] {
  if (!borders.size) return [];
  const gen = bumpTraversalGeneration(state);
  const clusters: TileRef[][] = [];
  borders.forEach((start) => {
    if (state.has(start, gen)) return;
    const result: TileRef[] = [],
      stack = state.stack;
    stack.length = 0;
    const visit = (tile: TileRef) => {
      if (state.has(tile, gen) || !borders.has(tile)) return;
      state.mark(tile, gen);
      result.push(tile);
      stack.push(tile);
    };
    visit(start);
    while (stack.length) map.forEachNeighborWithDiag(stack.pop()!, visit);
    clusters.push(result);
  });
  return clusters;
}
