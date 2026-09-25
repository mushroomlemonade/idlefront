import type { PseudoRandomState } from "../../PseudoRandom";
import type { Config } from "../../configuration/Config";
import type { PlayerType } from "../../game/Game";
import type { GameMap, TileRef } from "../../game/GameMap";
import type { FlatBinaryHeapState } from "../utils/FlatBinaryHeap";

export interface WildernessAttackState {
  attackID: string;
  ownerSmallID: number;
  ownerType: PlayerType;
  troops: number;
  passiveWilderness?: boolean;
  border: { tiles: TileRef[]; size: number };
  random: PseudoRandomState;
  heap: FlatBinaryHeapState;
}

/** References are read-only in the first, synchronous shadow implementation.
 * A worker transport must replace these with validated shared state, not clone
 * an entity graph. This input does not authorize committing a plan.
 */
export interface WildernessAttackInput {
  state: WildernessAttackState;
  map: Pick<
    GameMap,
    | "ownerID"
    | "neighbors4"
    | "terrainType"
    | "isLand"
    | "isImpassable"
    | "hasFallout"
    | "numTilesWithFallout"
    | "numLandTiles"
  >;
  config: Config;
  tick: number;
  executionTick: number;
}
