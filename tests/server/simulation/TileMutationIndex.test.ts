import { describe, expect, it, vi } from "vitest";
import { GameMapImpl, type GameMap } from "../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import { TileMutationIndex } from "../../../src/server/simulation/TileMutationIndex";

type TestMap = GameMapImpl | PagedGameMap;
function makeMap(paged: boolean): TestMap {
  const terrain = new Uint8Array(35 * 33).fill(128);
  return paged
    ? PagedGameMap.fromRowMajor(35, 33, 16, terrain, terrain.length)
    : new GameMapImpl(35, 33, terrain, terrain.length);
}

describe.each([false, true])(
  "mutation revision tracking, paged=%s",
  (paged) => {
  const mutations: [string, (map: TestMap, tile: number) => void][] = [
      ["ownership", (m, t) => m.setOwnerID(t, 3)],
      ["fallout", (m, t) => m.setFallout(t, true)],
      [
        "fallout cleared",
        (m, t) => {
          m.setFallout(t, true);
          m.setFallout(t, false);
        },
      ],
      ["defense", (m, t) => m.setDefenseBonus(t, true)],
      ["water conversion", (m, t) => m.setWater(t)],
      ["magnitude", (m, t) => m.setMagnitude(t, 20)],
      ["shoreline", (m, t) => m.setShorelineBit(t)],
      ["ocean", (m, t) => m.setOcean(t)],
      ["packed state", (m, t) => m.updateTile(t, (128 << 16) | 7 | (1 << 13))],
      ["packed terrain", (m, t) => m.updateTile(t, 148 << 16)],
    ];
    it.each(mutations)("invalidates checkpoints on %s", (_name, mutate) => {
      const map = makeMap(paged);
      const index = new TileMutationIndex(map, 16);
      const checkpoint = index.capture(Uint32Array.of(map.ref(3, 3)));
      expect(index.unchanged(checkpoint)).toBe(true);
      mutate(map, map.ref(3, 3));
      expect(index.unchanged(checkpoint)).toBe(false);
      index.dispose();
    });

    it("only invalidates affected chunks, conservatively, including edge pages", () => {
      const map = makeMap(paged);
      const index = new TileMutationIndex(map, 16);
      const first = index.capture(Uint32Array.of(map.ref(0, 0), map.ref(3, 3)));
      const edge = index.capture(Uint32Array.of(map.ref(34, 32)));
      expect(first.chunks.length).toBe(1);
      map.setOwnerID(map.ref(34, 32), 7);
      expect(index.unchanged(first)).toBe(true);
      expect(index.unchanged(edge)).toBe(false);
      map.setOwnerID(map.ref(15, 15), 9);
      expect(index.unchanged(first)).toBe(false);
      index.dispose();
    expect(index.unchanged(first)).toBe(false);
      expect(() => index.capture(Uint32Array.of(0))).toThrow("inactive");
    });

    it("does not accept an old token after uint32 revision rollover", () => {
      const map = makeMap(paged);
      const index = new TileMutationIndex(map, 16);
      const before = index.capture(Uint32Array.of(map.ref(34, 32)));
      (index as unknown as { versions: Uint32Array }).versions[0] = 0xffffffff;
      map.setOwnerID(0, 1);
      expect(index.unchanged(before)).toBe(false);
      expect(index.unchanged(index.capture(Uint32Array.of(0)))).toBe(true);
      index.dispose();
    });

    it("preserves multiple state subscriptions and removes the final observer", () => {
      const map = makeMap(paged);
      const a = vi.fn(),
        b = vi.fn();
      const stopA = map.observeState!(a),
        stopB = map.observeState!(b);
      map.setOwnerID(0, 1);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      stopA();
      map.setOwnerID(0, 2);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(2);
      stopB();
      map.setOwnerID(0, 3);
      expect(b).toHaveBeenCalledTimes(2);
      expect(map.ownerID(0)).toBe(3);
    });
  },
);

it("bounds memory and rejects non-power-of-two chunks", () => {
  const map = makeMap(false);
  expect(() => new TileMutationIndex(map, 3)).toThrow("Invalid revision");
  const huge = {
    ...map,
    width: () => 1_000_000,
    height: () => 1_000_000,
    observeState: () => () => {},
    observeTerrain: () => () => {},
  } as unknown as GameMap;
  expect(() => new TileMutationIndex(huge, 16)).toThrow("memory budget");
});
