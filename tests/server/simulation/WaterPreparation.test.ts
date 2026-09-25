import { expect, it, vi } from "vitest";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import {
  PathFinding,
  prepareWaterRoutes,
} from "../../../src/core/pathfinding/PathFinder";
import {
  enableWaterPreparation,
  queueWaterPreparation,
} from "../../../src/core/pathfinding/WaterRoutePreparation";
import { ParallelWaterRoutes } from "../../../src/server/simulation/ParallelWaterRoutes";
import { setup } from "../../util/Setup";

async function fixture() {
  const config = (await setup("big_plains")).config();
  const bytes = new Uint8Array(32 * 20).fill(32);
  bytes[16] = 128;
  return createGame(
    [],
    [],
    new GameMapImpl(32, 20, bytes, 1),
    new GameMapImpl(16, 10, new Uint8Array(160).fill(32), 0),
    config,
  );
}
it("discards a result if terrain changed while computation was pending", async () => {
  const game = await fixture();
  enableWaterPreparation(game);
  queueWaterPreparation(game, 0, 31);
  let release!: (value: (number[] | null)[]) => void;
  const pending = new Promise<(number[] | null)[]>((resolve) => {
    release = resolve;
  });
  const work = prepareWaterRoutes(game, () => pending);
  game.setWater(16);
  release([[999]]);
  await work;
  expect(PathFinding.Water(game).findPath(0, 31)).not.toEqual([999]);
});
it("falls back to ordinary routing if a worker batch fails", async () => {
  const game = await fixture(),
    pool = new ParallelWaterRoutes(game, 2);
  const expected = PathFinding.Water(game).findPath(1, 29);
  queueWaterPreparation(game, 0, 31);
  vi.spyOn(pool, "execute").mockRejectedValueOnce(new Error("worker crashed"));
  try {
    await pool.prepare();
    expect(pool.metrics.errors).toBe(1);
    expect(PathFinding.Water(game).findPath(1, 29)).toEqual(expected);
  } finally {
    await pool.close();
  }
});
