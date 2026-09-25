import { expect, it } from "vitest";
import { PlayerVisibility } from "../../../src/server/simulation/PlayerVisibility";
import { circularSightFootprint } from "../../../src/server/simulation/SightFootprint";

it("matches exact circles at edges and fractional moving positions without wrapping rows", () => {
  for (const [x, y, radius] of [
    [0, 0, 4],
    [19, 9, 5],
    [8.5, 5.25, 3.5],
    [5, 5, 0],
    [-10, 5, 2],
  ]) {
    const fog = new PlayerVisibility(200);
    const spans = circularSightFootprint(20, 10, x, y, radius);
    fog.setSource("scout", spans);
    expect(spans.length).toBeLessThanOrEqual(10);
    for (let tile = 0; tile < 200; tile++)
      expect(fog.isVisible(tile)).toBe(
        ((tile % 20) - x) ** 2 + (Math.floor(tile / 20) - y) ** 2 <=
          radius ** 2,
      );
  }
});

it("moving across page boundaries retains exploration but only reveals the current pocket", () => {
  const fog = new PlayerVisibility(21344 * 10124);
  fog.setSource("train", circularSightFootprint(21344, 10124, 4095, 100, 8));
  fog.setSource("train", circularSightFootprint(21344, 10124, 4120, 100, 8));
  expect(fog.isExplored(100 * 21344 + 4095)).toBe(true);
  expect(fog.isVisible(100 * 21344 + 4095)).toBe(false);
  expect(fog.isVisible(100 * 21344 + 4120)).toBe(true);
  fog.removeSource("train");
  fog.setSource("train", circularSightFootprint(21344, 10124, 4095, 100, 8));
  expect(fog.isVisible(100 * 21344 + 4095)).toBe(true);
});
