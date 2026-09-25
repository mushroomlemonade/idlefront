import { expect, it } from "vitest";
import { TileNodeIndex } from "../../../src/core/pathfinding/algorithms/TileNodeIndex";

it("matches a Map across growth, collisions, duplicate keys and generation resets", () => {
  const actual = new TileNodeIndex(),
    reference = new Map<number, number>();
  let seed = 17;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let round = 0; round < 3; round++) {
    const keys: number[] = [];
    for (let i = 0; i < 50_000; i++) {
      const key = random() % (65535 * 65535);
      keys.push(key);
      actual.set(key, i);
      reference.set(key, i);
      if (i % 11 === 0) {
        actual.set(key, i + 1);
        reference.set(key, i + 1);
      }
    }
    for (const key of keys) expect(actual.get(key)).toBe(reference.get(key));
    actual.clear();
    reference.clear();
    for (const key of keys) expect(actual.get(key)).toBeUndefined();
  }
  actual.set(0, 0);
  expect(actual.get(0)).toBe(0);
});

it("clears stale entries at the generation wrap boundary", () => {
  const actual = new TileNodeIndex();
  actual.set(7, 3);
  (actual as any).generation = 0xffffffff;
  actual.clear();
  expect(actual.get(7)).toBeUndefined();
  actual.set(7, 12);
  expect(actual.get(7)).toBe(12);
});
