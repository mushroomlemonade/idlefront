import { expect, it } from "vitest";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import {
  SharedPlanningWorld,
  sharedPlanningReader,
} from "../../../src/server/simulation/SharedPlanningWorld";

it.each([false, true])(
  "shares exact state/terrain across irregular page edges, paged=%s",
  (paged) => {
    const terrain = Uint8Array.from({ length: 37 * 29 }, (_, i) => i % 256);
    const map = paged
      ? PagedGameMap.fromRowMajor(37, 29, 16, terrain, 500)
      : new GameMapImpl(37, 29, terrain, 500);
    for (let tile = 0; tile < terrain.length; tile++) {
      map.setOwnerID(tile, tile % 3000);
      map.setFallout(tile, tile % 7 === 0);
    }
    const shared = new SharedPlanningWorld(map);
    const view = sharedPlanningReader(shared.data);
    const verify = () => {
      const epoch = shared.beginRead();
      view.begin(epoch);
      expect(view.map.numLandTiles()).toBe(map.numLandTiles());
      expect(view.map.numTilesWithFallout()).toBe(map.numTilesWithFallout());
      const a: number[] = [],
        b: number[] = [];
      for (let tile = 0; tile < terrain.length; tile++) {
        expect(view.map.ownerID(tile)).toBe(map.ownerID(tile));
        expect(view.map.terrainType(tile)).toBe(map.terrainType(tile));
        expect(view.map.hasFallout(tile)).toBe(map.hasFallout(tile));
        expect(view.map.isLand(tile)).toBe(map.isLand(tile));
        expect(view.map.isImpassable(tile)).toBe(map.isImpassable(tile));
        const n = view.map.neighbors4(tile, a),
          m = map.neighbors4(tile, b);
        expect(a.slice(0, n)).toEqual(b.slice(0, m));
      }
      expect(view.valid()).toBe(true);
      expect(shared.endRead(epoch)).toBe(true);
      expect(view.valid()).toBe(false);
    };
    verify();
    for (let tile = 0; tile < terrain.length; tile += 11) {
      map.setOwnerID(tile, 9);
      map.setFallout(tile, false);
      map.updateTile(tile, (128 << 16) | 3);
      map.setWater(tile);
    }
    verify();
    const epoch = shared.beginRead();
    view.begin(epoch);
    expect(() => shared.beginRead()).toThrow("unavailable");
    map.setOwnerID(0, 1);
    expect(view.valid()).toBe(false);
    expect(shared.endRead(epoch)).toBe(false);
    verify();
    shared.dispose();
    expect(() => shared.beginRead()).toThrow("unavailable");
  },
);

it("rejects oversized copies and malformed external state buffers", () => {
  const map = new GameMapImpl(10, 10, new Uint8Array(100), 0);
  expect(() => new SharedPlanningWorld(map, 100)).toThrow("memory budget");
  expect(
    () =>
      new GameMapImpl(10, 10, new Uint8Array(100), 0, {
        state: new Uint16Array(1),
        falloutTiles: 0,
      }),
  ).toThrow("State data length");
});
