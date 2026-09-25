import { expect, it } from "vitest";
import { PlayerVisibility } from "../../../src/server/simulation/PlayerVisibility";

it("represents global sight without a full-world counter array", () => {
  const tiles = 21344 * 10124;
  const fog = new PlayerVisibility(tiles);
  fog.setSource("late-world", [[0, tiles]]);
  expect(fog.allocatedBytes()).toBeLessThan(28 * 1024 * 1024);
  fog.setSource("ship", [[4090, 4100]]);
  fog.removeSource("late-world");
  expect(fog.isVisible(4095)).toBe(true);
  expect(fog.isVisible(5000)).toBe(false);
  expect(fog.isExplored(tiles - 1)).toBe(true);
  fog.removeSource("ship");
  expect(fog.isVisible(4095)).toBe(false);
});

it("keeps overlapping factory sight when a train moves away", () => {
  const fog = new PlayerVisibility(10000);
  fog.setSource("factory", [[10, 30]]);
  fog.setSource("train", [
    [20, 40],
    [25, 35],
  ]);
  fog.takeDirtyPages();
  fog.setSource("train", [[50, 60]]);
  expect(fog.isVisible(25)).toBe(true);
  expect(fog.isVisible(35)).toBe(false);
  expect(fog.isExplored(35)).toBe(true);
  expect(fog.isVisible(55)).toBe(true);
  fog.removeSource("factory");
  expect(fog.isVisible(25)).toBe(false);
  expect(fog.isExplored(25)).toBe(true);
});

it("does not dirty unchanged footprints or changes wholly inside other sight", () => {
  const fog = new PlayerVisibility(10000);
  fog.setSource("ally", [[0, 100]]);
  fog.takeDirtyPages();
  fog.setSource("train", [[10, 20]]);
  fog.setSource("train", [[12, 22]]);
  fog.setSource("ally", [
    [50, 100],
    [0, 70],
  ]);
  expect(fog.takeDirtyPages()).toEqual([]);
});

it("restores exploration without stale live intelligence on another device", () => {
  const fog = new PlayerVisibility(216000000);
  fog.setSource("ship", [
    [4090, 4100],
    [215999990, 216000000],
  ]);
  const checkpoint = JSON.parse(JSON.stringify(fog.checkpoint()));
  expect(checkpoint.pages).toHaveLength(3);
  const restored = PlayerVisibility.restore(checkpoint);
  expect(restored.isExplored(4096)).toBe(true);
  expect(restored.isVisible(4096)).toBe(false);
  restored.setSource("ship", [[4090, 4100]]);
  expect(restored.isVisible(4096)).toBe(true);
  expect(restored.isVisible(215999999)).toBe(false);
  expect(restored.isExplored(215999999)).toBe(true);
  expect(restored.isVisible(216000000)).toBe(false);
});

it("rejects invalid replacement atomically and isolates different players", () => {
  const fog = new PlayerVisibility(100);
  fog.setSource("ship", [[5, 10]]);
  expect(() =>
    fog.setSource("ship", [
      [20, 25],
      [90, 101],
    ]),
  ).toThrow();
  expect(fog.isVisible(5)).toBe(true);
  expect(fog.isExplored(20)).toBe(false);
  expect(new PlayerVisibility(100).isExplored(5)).toBe(false);
  const checkpoint = fog.checkpoint();
  checkpoint.pages.push(checkpoint.pages[0]);
  expect(() => PlayerVisibility.restore(checkpoint)).toThrow();
});

it("matches a naive coverage oracle across deterministic source movements", () => {
  const fog = new PlayerVisibility(200);
  const sources = new Map<string, Set<number>>();
  const explored = new Set<number>();
  let seed = 42;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 300; step++) {
    const id = String(random() % 7);
    const spans: [number, number][] = [];
    const tiles = new Set<number>();
    for (let s = 0, n = random() % 5; s < n; s++) {
      const start = random() % 190;
      const end = Math.min(200, start + 1 + (random() % 20));
      spans.push([start, end]);
      for (let tile = start; tile < end; tile++) {
        tiles.add(tile);
        explored.add(tile);
      }
    }
    sources.set(id, tiles);
    fog.setSource(id, spans);
    for (let tile = 0; tile < 200; tile++) {
      expect(fog.isVisible(tile)).toBe(
        [...sources.values()].some((source) => source.has(tile)),
      );
      expect(fog.isExplored(tile)).toBe(explored.has(tile));
    }
  }
});
