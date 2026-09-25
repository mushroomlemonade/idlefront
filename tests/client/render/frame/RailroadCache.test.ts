import { describe, expect, it } from "vitest";
import { RailroadCache } from "../../../../src/client/render/frame/RailroadCache";
import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../../../../src/core/game/GameUpdates";

function update(
  events: Partial<GameUpdateViewData["updates"]>,
): GameUpdateViewData {
  return {
    tick: 1,
    updates: events as GameUpdateViewData["updates"],
    packedTileUpdates: new Uint32Array(),
  };
}

describe("RailroadCache dirty tiles", () => {
  it("reports only the texels revealed during the current tick", () => {
    const cache = new RailroadCache(10, 10);
    cache.apply(
      update({
        [GameUpdateType.RailroadConstructionEvent]: [
          {
            type: GameUpdateType.RailroadConstructionEvent,
            id: 7,
            tiles: [11, 12, 13, 14, 15, 16, 17, 18],
          },
        ],
      }),
    );

    expect(cache.dirtyTiles).toEqual([11, 12, 13, 16, 17, 18]);
    cache.clearDirty();
    cache.apply(update({}));
    expect(cache.dirtyTiles).toEqual([14, 15]);
  });

  it("reports the cleared texels when a railroad is destroyed", () => {
    const cache = new RailroadCache(10, 10);
    cache.apply(
      update({
        [GameUpdateType.RailroadConstructionEvent]: [
          {
            type: GameUpdateType.RailroadConstructionEvent,
            id: 9,
            tiles: [21, 22, 23],
          },
        ],
      }),
    );
    cache.clearDirty();
    cache.apply(
      update({
        [GameUpdateType.RailroadDestructionEvent]: [
          { type: GameUpdateType.RailroadDestructionEvent, id: 9 },
        ],
      }),
    );

    expect(cache.dirtyTiles).toEqual([21, 22, 23]);
    expect([...cache.railroadState.slice(21, 24)]).toEqual([0, 0, 0]);
  });

  it("retains live sparse values for page-backed renderers without a world buffer", () => {
    const cache = new RailroadCache(10, 10, true);
    cache.apply(
      update({
        [GameUpdateType.RailroadConstructionEvent]: [
          {
            type: GameUpdateType.RailroadConstructionEvent,
            id: 11,
            tiles: [31, 32, 33],
          },
        ],
      }),
    );

    expect(cache.railroadState).toHaveLength(0);
    expect([...cache.getSparseState()!.entries()]).toEqual([
      [31, 2],
      [32, 2],
      [33, 2],
    ]);
  });
});
