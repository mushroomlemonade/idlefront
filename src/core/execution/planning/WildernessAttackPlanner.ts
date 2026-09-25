import { PseudoRandom } from "../../PseudoRandom";
import { Config } from "../../configuration/Config";
import type { TileRef } from "../../game/GameMap";
import { AttackExecution } from "../AttackExecution";
import { FlatBinaryHeap } from "../utils/FlatBinaryHeap";
import type {
  WildernessAttackInput,
  WildernessAttackState,
} from "./WildernessAttackState";

export type WildernessAttackEffect =
  | { type: "border-add" | "border-remove" | "conquer"; tile: TileRef }
  | { type: "troops"; troops: number };

export type WildernessAttackPlan =
  | { kind: "fallback"; reason: string }
  | {
      kind: "shadow-plan";
      state: WildernessAttackState;
      effects: WildernessAttackEffect[];
      /** Addresses only, NOT a validated/versioned worker read set. */
      readTiles: Uint32Array;
    };

class UnsupportedPlanningPath extends Error {}
const unsupported = (reason: string): never => {
  throw new UnsupportedPlanningPath(reason);
};

/** Fail closed if the engine starts consulting a capability not modeled here.
 * The guard deliberately favors correctness over speed during shadow R&D.
 */
function capability<T extends object>(name: string, value: T): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (!(property in target)) unsupported(`${name}.${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });
}

// Capture the real implementation before diagnostic wrappers are installed.
// Reuse its heap/tie/PRNG/combat logic, replacing ONLY its world capabilities.
const executeAttackTick = AttackExecution.prototype.tick;

/** Side-effect-free feasibility planner, currently SHADOW ONLY. No commit API.
 * The original simulation must still execute. Worker use additionally needs
 * coherent shared inputs, dependency-version validation and ordered application.
 */
export function planWildernessAttack(
  input: WildernessAttackInput,
): WildernessAttackPlan {
  if (
    Object.getPrototypeOf(input.config) !== Config.prototype ||
    input.config.gameConfig().fogOfWar ||
    input.config.attackLogic !== Config.prototype.attackLogic ||
    input.config.attackTilesPerTick !== Config.prototype.attackTilesPerTick ||
    input.config.falloutDefenseModifier !==
      Config.prototype.falloutDefenseModifier
  )
    return { kind: "fallback", reason: "configuration" };

  const base = input.map,
    state = input.state;
  const reads = new Set<TileRef>(),
    owned = new Set<TileRef>();
  const effects: WildernessAttackEffect[] = [];
  const border = new Set(state.border.tiles);
  let borderSize = state.border.size,
    troops = state.troops,
    clearedFallout = 0;
  const random = PseudoRandom.fromSnapshot(state.random);
  const heap = FlatBinaryHeap.fromSnapshot(state.heap);
  const terrainType = (tile: TileRef) => {
    reads.add(tile);
    return base.terrainType(tile);
  };
  const hasFallout = (tile: TileRef) => {
    reads.add(tile);
    return !owned.has(tile) && base.hasFallout(tile);
  };
  const map = capability("map", {
    ownerID(tile: TileRef) {
      reads.add(tile);
      return owned.has(tile) ? state.ownerSmallID : base.ownerID(tile);
    },
    neighbors4: (tile: TileRef, out: TileRef[]) => base.neighbors4(tile, out),
    terrainType,
    isLand(tile: TileRef) {
      reads.add(tile);
      return base.isLand(tile);
    },
    isImpassable(tile: TileRef) {
      reads.add(tile);
      return base.isImpassable(tile);
    },
  });
  const owner = capability("owner", {
    isPlayer: () => true,
    type: () => state.ownerType,
    conquer(tile: TileRef) {
      if (hasFallout(tile)) clearedFallout++;
      owned.add(tile);
      effects.push({ type: "conquer", tile });
    },
  });
  const target = capability("target", { isPlayer: () => false });
  const attack = capability("attack", {
    troops: () => troops,
    setTroops(value: number) {
      troops = Math.max(0, value);
      effects.push({ type: "troops", troops });
    },
    borderSize: () => borderSize,
    addBorderTile(tile: TileRef) {
      if (!border.has(tile)) {
        borderSize++;
        border.add(tile);
      }
      effects.push({ type: "border-add", tile });
    },
    removeBorderTile(tile: TileRef) {
      if (border.has(tile)) {
        borderSize--;
        border.delete(tile);
      }
      effects.push({ type: "border-remove", tile });
    },
    isActive: () => true,
    retreated: () => false,
    retreating: () => false,
    delete: () => unsupported("attack-ended"),
  });
  const game = capability("game", {
    config: () => input.config,
    ticks: () => input.tick,
    // Input capture rejects any installed policy; do not call it a second time.
    attackExpansionBudget: () => Infinity,
    terrainType,
    hasFallout,
    numTilesWithFallout: () => base.numTilesWithFallout() - clearedFallout,
    numLandTiles: () => base.numLandTiles(),
  });
  const execution = capability(
    "execution",
    Object.assign(Object.create(AttackExecution.prototype), {
      active: true,
      passiveWilderness: state.passiveWilderness === true,
      executionVersion: 0,
      toConquer: heap,
      random,
      target,
      mg: game,
      map,
      attack,
      ownerSmallID: state.ownerSmallID,
      targetSmallID: 0,
      _owner: owner,
      nbuf: [0, 0, 0, 0],
      nbuf2: [0, 0, 0, 0],
      refreshToConquer: () => unsupported("frontier-exhausted"),
      retreat: () => unsupported("retreat"),
    }),
  ) as AttackExecution;
  try {
    executeAttackTick.call(execution, input.executionTick);
  } catch (error) {
    if (error instanceof UnsupportedPlanningPath)
      return { kind: "fallback", reason: error.message };
    throw error;
  }
  return {
    kind: "shadow-plan",
    state: {
      ...state,
      troops,
      border: { tiles: [...border], size: borderSize },
      random: random.snapshot(),
      heap: heap.snapshot(),
    },
    effects,
    readTiles: Uint32Array.from(reads),
  };
}
