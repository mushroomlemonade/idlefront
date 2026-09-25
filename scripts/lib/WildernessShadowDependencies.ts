import { isDeepStrictEqual } from "node:util";
import type { WildernessAttackInput } from "../../src/core/execution/planning/WildernessAttackState";

/** Diagnostic exact-value validation, not a production worker/version scheme.
 * Capture only while the authority is paused. Read addresses come from a plan
 * evaluated against that same stable world. Conservatively include all terrain
 * flags and global fallout/land counts, even when a particular branch omitted
 * them. The original tick still runs whether this succeeds or not.
 */
export function captureWildernessDependencies(
  input: WildernessAttackInput,
  tiles: Uint32Array,
) {
  const map = input.map;
  const ownerIDs = Uint32Array.from(tiles, (tile) => map.ownerID(tile));
  const terrain = Uint8Array.from(tiles, (tile) => terrainFlags(input, tile));
  const land = map.numLandTiles(),
    fallout = map.numTilesWithFallout();
  const config = structuredClone(input.config.gameConfig());
  const attackLogic = input.config.attackLogic;
  const attackTilesPerTick = input.config.attackTilesPerTick;
  const falloutDefenseModifier = input.config.falloutDefenseModifier;
  return {
    bytes: tiles.byteLength + ownerIDs.byteLength + terrain.byteLength,
    conflict(current: WildernessAttackInput | null): string | null {
      if (!current) return "ineligible";
      if (
        current.tick !== input.tick ||
        current.executionTick !== input.executionTick ||
        current.map !== map ||
        !isDeepStrictEqual(current.state, input.state)
      )
        return "attack-state";
      if (
        current.config.attackLogic !== attackLogic ||
        current.config.attackTilesPerTick !== attackTilesPerTick ||
        current.config.falloutDefenseModifier !== falloutDefenseModifier ||
        !isDeepStrictEqual(current.config.gameConfig(), config)
      )
        return "configuration";
      if (map.numLandTiles() !== land || map.numTilesWithFallout() !== fallout)
        return "global-terrain";
      for (let i = 0; i < tiles.length; i++)
        if (
          map.ownerID(tiles[i]) !== ownerIDs[i] ||
          terrainFlags(current, tiles[i]) !== terrain[i]
        )
          return "tile-state";
      return null;
    },
  };
}

function terrainFlags(input: WildernessAttackInput, tile: number): number {
  const map = input.map;
  return (
    map.terrainType(tile) |
    (Number(map.isLand(tile)) << 3) |
    (Number(map.isImpassable(tile)) << 4) |
    (Number(map.hasFallout(tile)) << 5)
  );
}
