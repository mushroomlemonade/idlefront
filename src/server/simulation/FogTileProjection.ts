import type { GameMap } from "../../core/game/GameMap";
import { fogTileState } from "../../core/network/FogTileState";
import { DirtyFogTiles } from "./DirtyFogTiles";
import type { NationFog } from "./GameFog";

/** Visibility changes are shared read-only by every device for this seat. */
export function projectFogTileRuns(
  map: GameMap,
  fog: NationFog,
  packed: Uint32Array,
): Uint32Array {
  const changed = new DirtyFogTiles();
  for (const tile of fog.changedTiles) changed.add(tile);
  for (let i = 0; i + 1 < packed.length; i += 2) {
    // Do not even disclose the locations/timing of changes behind the fog.
    if (fog.isVisible(packed[i])) changed.add(packed[i]);
  }
  const tiles = changed.drain();
  const result = new Uint32Array(tiles.length * 3);
  let length = 0;
  for (const tile of tiles) {
    const state = fogTileState(
      map.tileState(tile),
      fog.isVisible(tile),
      fog.isExplored(tile),
    );
    if (
      length &&
      result[length - 3] + result[length - 2] === tile &&
      result[length - 1] === state
    ) {
      result[length - 2]++;
    } else {
      result[length++] = tile;
      result[length++] = 1;
      result[length++] = state;
    }
  }
  return result.slice(0, length);
}

/** Terrain mutations/reveals are separate, so hidden clears preserve charted geography. */
export function projectFogTerrain(
  map: GameMap,
  fog: NationFog,
  runs: Uint32Array,
): Uint32Array {
  const pairs: number[] = [];
  for (let i = 0; i + 2 < runs.length; i += 3)
    for (let tile = runs[i]; tile < runs[i] + runs[i + 1]; tile++)
      if (fog.isVisible(tile)) pairs.push(tile, map.terrainByte(tile));
  return Uint32Array.from(pairs);
}

/** Each packet is bounded by expanded tile work as well as encoded run count. */
export function* fogExplorationSnapshot(
  map: GameMap,
  fog: NationFog,
): IterableIterator<Uint32Array> {
  const MAX_TILES = 65536,
    MAX_RUNS = 4096;
  let runs: number[] = [],
    expanded = 0;
  for (const tile of fog.coverage.exploredTiles()) {
    const state = fogTileState(map.tileState(tile), fog.isVisible(tile), true);
    const last = runs.length - 3;
    if (
      last >= 0 &&
      runs[last] + runs[last + 1] === tile &&
      runs[last + 2] === state
    )
      runs[last + 1]++;
    else runs.push(tile, 1, state);
    expanded++;
    if (expanded >= MAX_TILES || runs.length / 3 >= MAX_RUNS) {
      yield Uint32Array.from(runs);
      runs = [];
      expanded = 0;
    }
  }
  if (runs.length) yield Uint32Array.from(runs);
}
