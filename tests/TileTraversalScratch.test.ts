import { expect, it } from "vitest";
import {
  bumpTraversalGeneration,
  tileTraversalScratch,
} from "../src/core/game/TileTraversalScratch";
it("tracks sparse linear tiles across blocks and resets generations", () => {
  const scratch = tileTraversalScratch({} as never);
  const generation = bumpTraversalGeneration(scratch);
  for (const tile of [0, 4095, 4096, 216000000, 4294836224]) {
    expect(scratch.has(tile, generation)).toBe(false);
    scratch.mark(tile, generation);
    expect(scratch.has(tile, generation)).toBe(true);
    expect(scratch.has(tile + 1, generation)).toBe(false);
  }
  expect(scratch.has(4096, bumpTraversalGeneration(scratch))).toBe(false);
  scratch.gen = 0xfffffffe;
  expect(bumpTraversalGeneration(scratch)).toBe(1);
  expect(scratch.has(4096, 1)).toBe(false);
});
