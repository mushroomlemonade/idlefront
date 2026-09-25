import type { WildernessAttackInput } from "../../core/execution/planning/WildernessAttackState";
import { GameMapImpl, type GameMap } from "../../core/game/GameMap";

export interface SharedPlanningData {
  width: number;
  height: number;
  initialFallout: number;
  terrain: Uint8Array<SharedArrayBuffer>;
  state: Uint16Array<SharedArrayBuffer>;
  control: Int32Array<SharedArrayBuffer>;
}
export interface PlanningEpoch {
  epoch: number;
  land: number;
  fallout: number;
}

/** One bounded world copy shared by the entire computation pool. Incremental
 * setter notifications mirror changes; no per-worker or per-tick world copy.
 * Authority must await ALL readers before executing the next mutation phase.
 * Unexpected mutation during reads poisons the epoch so every result is dropped.
 */
export class SharedPlanningWorld {
  readonly data: SharedPlanningData;
  private reading = false;
  private disposed = false;
  private sequence = 0;
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly source: GameMap,
    maxBytes = 768 * 1024 * 1024,
  ) {
    const count = source.width() * source.height();
    if (!source.observeState || !source.observeTerrain)
      throw new Error("Map mutation hooks unavailable");
    if (!Number.isSafeInteger(count) || count < 1 || count * 3 + 4 > maxBytes)
      throw new Error("Shared planning world exceeds memory budget");
    this.data = {
      width: source.width(),
      height: source.height(),
      initialFallout: source.numTilesWithFallout(),
      terrain: new Uint8Array(new SharedArrayBuffer(count)),
      state: new Uint16Array(new SharedArrayBuffer(count * 2)),
      control: new Int32Array(new SharedArrayBuffer(4)),
    };
    for (const page of source.tilePages()) {
      const state = page.state;
      for (let y = 0; y < page.height; y++) {
        const offset = (page.originY + y) * this.data.width + page.originX;
        this.data.terrain.set(
          page.terrain.subarray(y * page.width, (y + 1) * page.width),
          offset,
        );
        this.data.state.set(
          state.subarray(y * page.width, (y + 1) * page.width),
          offset,
        );
      }
    }
    const poison = () => {
      if (this.reading) Atomics.store(this.data.control, 0, 0);
    };
    this.unsubscribe = [
      source.observeState((tile) => {
        poison();
        this.data.state[tile] = source.tileState(tile);
      }),
      source.observeTerrain((tile) => {
        poison();
        this.data.terrain[tile] = source.terrainByte(tile);
      }),
    ];
  }

  beginRead(): PlanningEpoch {
    if (this.disposed || this.reading)
      throw new Error("Planning epoch unavailable");
    this.reading = true;
    this.sequence = this.sequence === 0x7fffffff ? 1 : this.sequence + 1;
    // Release/acquire through Atomics brackets preceding shared-byte writes.
    Atomics.store(this.data.control, 0, this.sequence);
    return {
      epoch: this.sequence,
      land: this.source.numLandTiles(),
      fallout: this.source.numTilesWithFallout(),
    };
  }

  endRead(snapshot: PlanningEpoch): boolean {
    if (!this.reading || snapshot.epoch !== this.sequence)
      throw new Error("Planning epoch mismatch");
    const valid =
      !this.disposed && Atomics.load(this.data.control, 0) === snapshot.epoch;
    this.reading = false;
    Atomics.store(this.data.control, 0, 0);
    return valid;
  }

  dispose(): void {
    this.disposed = true;
    Atomics.store(this.data.control, 0, 0);
    for (const stop of this.unsubscribe.splice(0)) stop();
  }
}

/** Uses the engine's own terrain/state decoding and cardinal neighbor order.
 * The exposed planning capability has no mutation methods. State scalars are
 * captured per epoch rather than reconstructed by scanning the whole world.
 */
export function sharedPlanningReader(data: SharedPlanningData) {
  const decoded = new GameMapImpl(data.width, data.height, data.terrain, 0, {
    state: data.state,
    falloutTiles: data.initialFallout,
  });
  let snapshot: PlanningEpoch | undefined;
  const map: WildernessAttackInput["map"] = {
    ownerID: decoded.ownerID.bind(decoded),
    terrainType: decoded.terrainType.bind(decoded),
    isLand: decoded.isLand.bind(decoded),
    isImpassable: decoded.isImpassable.bind(decoded),
    hasFallout: decoded.hasFallout.bind(decoded),
    neighbors4: decoded.neighbors4.bind(decoded),
    numLandTiles: () => snapshot!.land,
    numTilesWithFallout: () => snapshot!.fallout,
  };
  return {
    map,
    begin(value: PlanningEpoch) {
      if (value.epoch <= 0 || Atomics.load(data.control, 0) !== value.epoch)
        throw new Error("Stale planning epoch");
      snapshot = value;
    },
    valid: () =>
      snapshot !== undefined &&
      Atomics.load(data.control, 0) === snapshot.epoch,
  };
}
