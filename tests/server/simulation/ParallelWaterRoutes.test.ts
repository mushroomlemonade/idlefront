import { expect, it } from "vitest";
import type { Game } from "../../../src/core/game/Game";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import { WaterRefinementTransformer } from "../../../src/core/pathfinding/transformers/WaterRefinementTransformer";
import { ParallelWaterRoutes } from "../../../src/server/simulation/ParallelWaterRoutes";

it("runs real workers with shared paged terrain and returns exact ordered routes across conversions", async () => {
  const bytes = new Uint8Array(97 * 65).fill(32);
  for (let y = 0; y < 64; y++) bytes[y * 97 + 48] = 128;
  const map = PagedGameMap.fromRowMajor(97, 65, 16, bytes, 64);
  let notify: (tile: number) => void = () => {};
  const game = {
    map: () => map,
    observeWaterConversions: (fn: typeof notify) => {
      notify = fn;
      return () => {};
    },
  } as unknown as Game;
  const pool = new ParallelWaterRoutes(game, 2);
  const reference = new WaterRefinementTransformer(
    { findPath: () => null },
    map,
  );
  const jobs = Array.from({ length: 12 }, (_, i) => ({
    from: i * 97 + 1,
    to: (i + 2) * 97 + 90,
    route: [i * 97 + 1, (i + 2) * 97 + 90],
  }));
  try {
    expect(await pool.execute(jobs)).toEqual(
      jobs.map((j) => reference.refine(j.route, j.from, j.to)),
    );
    map.setWater(10 * 97 + 48);
    notify(10 * 97 + 48);
    expect(await pool.execute(jobs)).toEqual(
      jobs.map((j) => reference.refine(j.route, j.from, j.to)),
    );
    expect(pool.metrics.workers).toBe(2);
    expect(pool.metrics.jobs).toBe(24);
  } finally {
    await pool.close();
  }
}, 20000);
