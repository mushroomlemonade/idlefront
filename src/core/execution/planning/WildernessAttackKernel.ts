import { PseudoRandom } from "../../PseudoRandom";
import { Config } from "../../configuration/Config";
import {
  TerrainType,
  type Game,
  type Player,
  type TerraNullius,
} from "../../game/Game";
import type { TileRef } from "../../game/GameMap";
import { FlatBinaryHeap } from "../utils/FlatBinaryHeap";
import type {
  WildernessAttackEffect,
  WildernessAttackPlan,
} from "./WildernessAttackPlanner";
import type { WildernessAttackInput } from "./WildernessAttackState";

class UnmodeledRead extends Error {}

// Config remains the source of combat/pacing formulas. Fail closed if it gains
// new world dependencies; the planning loop itself uses only explicit inputs.
function configView<T extends object>(name: string, value: T): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (!(key in target)) throw new UnmodeledRead(`${name}.${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}

/** Isolated wilderness-only kernel. SHADOW ONLY: no authoritative commit API.
 * Keep traversal, heap duplicates, PRNG calls and effect order identical to
 * AttackExecution.tick/addNeighbors; replay verification is the drift gate.
 * Unlike the guarded reference planner this never calls AttackExecution with
 * a proxy receiver, avoiding instrumentation of the live execution hot loop.
 */
export function planWildernessAttackKernel(
  input: WildernessAttackInput,
): WildernessAttackPlan {
  const config = input.config;
  if (
    Object.getPrototypeOf(config) !== Config.prototype ||
    config.gameConfig().fogOfWar ||
    config.attackLogic !== Config.prototype.attackLogic ||
    config.attackTilesPerTick !== Config.prototype.attackTilesPerTick ||
    config.falloutDefenseModifier !== Config.prototype.falloutDefenseModifier
  )
    return { kind: "fallback", reason: "configuration" };

  const { state, map } = input;
  const random = PseudoRandom.fromSnapshot(state.random);
  const heap = FlatBinaryHeap.fromSnapshot(state.heap);
  const border = new Set(state.border.tiles);
  const reads = new Set<TileRef>();
  const conquered = new Set<TileRef>();
  const effects: WildernessAttackEffect[] = [];
  const neighbors: TileRef[] = [0, 0, 0, 0];
  const inner: TileRef[] = [0, 0, 0, 0];
  let troops = state.troops,
    borderSize = state.border.size,
    clearedFallout = 0;

  const ownerID = (tile: TileRef) => {
    reads.add(tile);
    return conquered.has(tile) ? state.ownerSmallID : map.ownerID(tile);
  };
  const hasFallout = (tile: TileRef) => {
    reads.add(tile);
    return !conquered.has(tile) && map.hasFallout(tile);
  };
  const terrainType = (tile: TileRef) => {
    reads.add(tile);
    return map.terrainType(tile);
  };
  const owner = configView("owner", {
    isPlayer: () => true,
    type: () => state.ownerType,
  }) as unknown as Player;
  const target = configView("target", {
    isPlayer: () => false,
  }) as unknown as TerraNullius;
  const game = configView("game", {
    terrainType,
    hasFallout,
    numTilesWithFallout: () => map.numTilesWithFallout() - clearedFallout,
    numLandTiles: () => map.numLandTiles(),
  }) as unknown as Game;

  try {
    let remaining = config.attackTilesPerTick(
      troops,
      owner,
      target,
      borderSize + random.nextInt(0, 5),
    );
    remaining = Math.min(remaining, Infinity);
    while (remaining > 0) {
      if (troops < 1) return { kind: "fallback", reason: "attack-ended" };
      if (heap.size() === 0)
        return { kind: "fallback", reason: "frontier-exhausted" };
      const tile = heap.dequeue();
      if (border.delete(tile)) borderSize--;
      effects.push({ type: "border-remove", tile });

      let onBorder = false;
      const count = map.neighbors4(tile, neighbors);
      for (let i = 0; i < count; i++) {
        if (ownerID(neighbors[i]) === state.ownerSmallID) {
          onBorder = true;
          break;
        }
      }
      if (ownerID(tile) !== 0 || !onBorder) continue;
      // ownerID above already records this tile in the dependency read set.
      if (!map.isLand(tile) || map.isImpassable(tile)) continue;

      // The tile is not owned until AFTER all neighbors' priorities are built.
      const adjacent = map.neighbors4(tile, neighbors);
      for (let i = 0; i < adjacent; i++) {
        const neighbor = neighbors[i];
        const terrain = terrainType(neighbor);
        if (
          terrain === TerrainType.Ocean ||
          terrain === TerrainType.Impassable ||
          ownerID(neighbor) !== 0
        )
          continue;
        if (!border.has(neighbor)) {
          borderSize++;
          border.add(neighbor);
        }
        effects.push({ type: "border-add", tile: neighbor });
        let ownedCount = 0;
        const innerCount = map.neighbors4(neighbor, inner);
        for (let j = 0; j < innerCount; j++)
          if (ownerID(inner[j]) === state.ownerSmallID) ownedCount++;
        let magnitude: number;
        switch (terrain) {
          case TerrainType.Plains:
            magnitude = 1;
            break;
          case TerrainType.Highland:
            magnitude = 1.5;
            break;
          case TerrainType.Mountain:
            magnitude = 2;
            break;
          default:
            magnitude = 0;
            break;
        }
        const priority =
          (random.nextInt(0, 7) + 10) * (1 - ownedCount * 0.5 + magnitude / 2) +
          input.tick;
        heap.enqueue(neighbor, priority);
      }
      const result = config.attackLogic(game, troops, owner, target, tile);
      remaining -= result.tilesPerTickUsed;
      if (!state.passiveWilderness) troops -= result.attackerTroopLoss;
      effects.push({ type: "troops", troops: Math.max(0, troops) });
      if (hasFallout(tile)) clearedFallout++;
      conquered.add(tile);
      effects.push({ type: "conquer", tile });
    }
  } catch (error) {
    if (error instanceof UnmodeledRead)
      return { kind: "fallback", reason: error.message };
    throw error;
  }
  return {
    kind: "shadow-plan",
    state: {
      ...state,
      troops: Math.max(0, troops),
      border: { tiles: [...border], size: borderSize },
      random: random.snapshot(),
      heap: heap.snapshot(),
    },
    effects,
    readTiles: Uint32Array.from(reads),
  };
}
