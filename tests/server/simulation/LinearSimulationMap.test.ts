import { expect, it } from "vitest";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import { linearSimulationMap } from "../../../src/server/simulation/NodeGameMapLoader";

it("preserves partial-page terrain and subsequent ownership/terrain operations", () => {
  const bytes = Uint8Array.from({ length: 37 * 29 }, (_, i) => i % 255);
  const paged = PagedGameMap.fromRowMajor(37, 29, 16, bytes, 500);
  const linear = linearSimulationMap(paged) as GameMapImpl;
  expect(linear.isPaged()).toBe(false);
  expect(linear.numLandTiles()).toBe(500);
  for (let i = 0; i < bytes.length; i++) {
    expect(linear.terrainByte(i)).toBe(paged.terrainByte(i));
    for (const map of [paged, linear]) {
      map.setOwnerID(i, i % 13);
      map.setFallout(i, i % 7 === 0);
      map.setDefenseBonus(i, i % 11 === 0);
      if (i % 5 === 0) map.setWater(i);
    }
  }
  for (let i = 0; i < bytes.length; i++) {
    expect(linear.tileState(i)).toBe(paged.tileState(i));
    expect(linear.terrainByte(i)).toBe(paged.terrainByte(i));
    expect(linear.isBorder(i)).toBe(paged.isBorder(i));
    expect(linear.neighbors(i)).toEqual(paged.neighbors(i));
  }
});

it("keeps paging when over budget or given an already-mutated map", () => {
  const map = PagedGameMap.fromRowMajor(
    37,
    29,
    16,
    new Uint8Array(37 * 29).fill(128),
    37 * 29,
  );
  expect(linearSimulationMap(map, 100)).toBe(map);
  map.setOwnerID(15, 3);
  expect(linearSimulationMap(map)).toBe(map);
});
