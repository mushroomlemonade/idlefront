import { expect, it, vi } from "vitest";
import { PlayerExecution } from "../../../src/core/execution/PlayerExecution";
import { PlayerInfo, PlayerType, UnitType } from "../../../src/core/game/Game";
import type { PlayerImpl } from "../../../src/core/game/PlayerImpl";
import { tileTraversalScratch } from "../../../src/core/game/TileTraversalScratch";
import { referenceBorderClusters } from "../../util/referenceBorderClusters";
import { setup } from "../../util/Setup";

it("preserves player hashes, captures and structures across identical scripted ownership changes", async () => {
  const build = async (reference: boolean) => {
    const game = await setup(
      "big_plains",
      { infiniteGold: true, instantBuild: true },
      [
        new PlayerInfo("a", PlayerType.Human, "a", "a"),
        new PlayerInfo("b", PlayerType.Human, "b", "b"),
      ],
    );
    for (const player of game.allPlayers()) {
      const execution = new PlayerExecution(player);
      if (reference)
        Object.assign(execution, {
          calculateClusters: () =>
            referenceBorderClusters(
              game.map(),
              player.borderTiles(),
              tileTraversalScratch(game),
            ),
        });
      game.addExecution(execution);
    }
    for (let y = 20; y < 45; y++)
      for (let x = 20; x < 45; x++)
        game.player(x < 32 ? "a" : "b").conquer(game.ref(x, y));
    game.player("a").buildUnit(UnitType.City, game.ref(25, 25), {});
    game.player("b").buildUnit(UnitType.DefensePost, game.ref(38, 38), {});
    return game;
  };
  const baseline = await build(true),
    optimized = await build(false);
  let seed = 27;
  for (let tick = 0; tick < 160; tick++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const x = 20 + (seed % 25),
      y = 20 + ((seed >>> 8) % 25);
    for (const game of [baseline, optimized]) {
      game.player(tick % 3 === 0 ? "a" : "b").conquer(game.ref(x, y));
      game.executeNextTick();
    }
    expect(optimized.allPlayers().map((p) => (p as PlayerImpl).hash())).toEqual(
      baseline.allPlayers().map((p) => (p as PlayerImpl).hash()),
    );
    expect(
      optimized.allPlayers().map((p) => p.largestClusterBoundingBox),
    ).toEqual(baseline.allPlayers().map((p) => p.largestClusterBoundingBox));
    expect(
      optimized
        .units()
        .map((u) => [u.type(), u.tile(), u.owner().id(), u.level()]),
    ).toEqual(
      baseline
        .units()
        .map((u) => [u.type(), u.tile(), u.owner().id(), u.level()]),
    );
    for (let row = 19; row < 46; row++)
      for (let col = 19; col < 46; col++)
        expect(optimized.ownerID(optimized.ref(col, row))).toBe(
          baseline.ownerID(baseline.ref(col, row)),
        );
  }
});

it("preserves captures and exact bounds through expansion, islands and enclosure", async () => {
  const make = async (reference: boolean) => {
    const game = await setup("big_plains", {}, [
      new PlayerInfo("a", PlayerType.Human, "a", "a"),
      new PlayerInfo("b", PlayerType.Human, "b", "b"),
    ]);
    const player = game.player("a");
    const execution = new PlayerExecution(player);
    execution.init(game, 0);
    if (reference)
      Object.assign(execution, {
        calculateClusters: () =>
          referenceBorderClusters(
            game.map(),
            player.borderTiles(),
            tileTraversalScratch(game),
          ),
      });
    const internals = execution as unknown as {
      removeClusters(): void;
      calculateClusters(): number[][];
    };
    return { game, player, execution: internals };
  };
  const baseline = await make(true),
    optimized = await make(false);
  const search = vi.spyOn(optimized.execution, "calculateClusters");
  const check = () => {
    baseline.execution.removeClusters();
    optimized.execution.removeClusters();
    expect(optimized.player.largestClusterBoundingBox).toEqual(
      baseline.player.largestClusterBoundingBox,
    );
    expect(optimized.game.allPlayers().map((p) => [...p.tiles()])).toEqual(
      baseline.game.allPlayers().map((p) => [...p.tiles()]),
    );
    expect(
      optimized.game.allPlayers().map((p) => [...p.borderTiles()]),
    ).toEqual(baseline.game.allPlayers().map((p) => [...p.borderTiles()]));
  };
  for (let x = 20; x <= 28; x++) {
    for (const { game, player } of [baseline, optimized])
      for (let y = 20; y <= 28; y++) player.conquer(game.ref(x, y));
    check();
  }
  // Unchanged queries must also preserve the exact bounds and ownership.
  check();
  search.mockClear();
  check();

  for (const { game, player } of [baseline, optimized])
    player.conquer(game.ref(40, 40));
  check();
  expect(search).toHaveBeenCalled();
  search.mockClear();
  // Enclose every current island, invalidating the cached unowned witness.
  for (const { game, player } of [baseline, optimized]) {
    for (let x = 18; x <= 42; x++)
      for (let y = 18; y <= 42; y++) {
        const tile = game.ref(x, y);
        if (!player.tiles().has(tile)) game.player("b").conquer(tile);
      }
  }
  check();
  expect(search).toHaveBeenCalled();
});

it("captures an enclosed single border even when only the other player's territory changed", async () => {
  const outcomes: unknown[] = [];
  for (const reference of [true, false]) {
    const game = await setup("big_plains", {}, [
      new PlayerInfo("a", PlayerType.Human, "a", "a"),
      new PlayerInfo("b", PlayerType.Human, "b", "b"),
    ]);
    const player = game.player("a");
    for (let y = 20; y <= 24; y++)
      for (let x = 20; x <= 24; x++) player.conquer(game.ref(x, y));
    const execution = new PlayerExecution(player);
    execution.init(game, 0);
    if (reference)
      Object.assign(execution, {
        calculateClusters: () =>
          referenceBorderClusters(
            game.map(),
            player.borderTiles(),
            tileTraversalScratch(game),
          ),
      });
    const internal = execution as unknown as {
      removeClusters(): void;
      calculateClusters(): number[][];
    };
    internal.removeClusters();
    internal.removeClusters();
    const search = vi.spyOn(internal, "calculateClusters");
    // Only the other country's territory changes. Player a's border remains
    // connected, but none of its old unowned-neighbor witnesses remain valid.
    for (let y = 19; y <= 25; y++)
      for (let x = 19; x <= 25; x++) {
        const tile = game.ref(x, y);
        if (!player.tiles().has(tile)) game.player("b").conquer(tile);
      }
    internal.removeClusters();
    expect(search).toHaveBeenCalled();
    expect(player.numTilesOwned()).toBe(0);
    outcomes.push({
      box: player.largestClusterBoundingBox,
      tiles: game.allPlayers().map((p) => [...p.tiles()]),
      borders: game.allPlayers().map((p) => [...p.borderTiles()]),
    });
  }
  expect(outcomes[1]).toEqual(outcomes[0]);
});
