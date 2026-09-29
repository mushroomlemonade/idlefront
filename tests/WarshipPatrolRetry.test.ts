import { afterEach, expect, it, vi } from "vitest";
import { MoveWarshipExecution } from "../src/core/execution/MoveWarshipExecution";
import { WarshipExecution } from "../src/core/execution/WarshipExecution";
import { WarshipPatrolRetry } from "../src/core/execution/WarshipPatrolRetry";
import { PlayerInfo, PlayerType, UnitType } from "../src/core/game/Game";
import { WaterPathFinder } from "../src/core/pathfinding/PathFinder";
import { PathStatus } from "../src/core/pathfinding/types";
import { setup } from "./util/Setup";

afterEach(() => vi.restoreAllMocks());

it("bounds retries, staggers ships, and resets on context changes or explicit commands", () => {
  const retry = new WarshipPatrolRetry();
  const attempts: number[] = [];
  for (let tick = 0; tick < 600; tick++) {
    if (retry.ready(tick, "same")) {
      attempts.push(tick);
      retry.failed(tick, 3);
    }
  }
  expect(attempts.slice(0, 5)).toEqual([0, 13, 36, 79, 132]);
  expect(attempts.length).toBeLessThan(16);
  expect(retry.ready(600, "same")).toBe(false);
  expect(retry.ready(600, "changed terrain/owner/position/order")).toBe(true);
  retry.failed(600, 3);
  retry.reset();
  expect(retry.ready(601, "changed terrain/owner/position/order")).toBe(true);
});

async function fixture(versioned: boolean) {
  const game = await setup(
    "half_land_half_ocean",
    {
      infiniteGold: true,
      instantBuild: true,
      ...(versioned ? { warshipPatrolScheduling: "v1" as const } : {}),
    },
    [new PlayerInfo("p1", PlayerType.Human, null, "p1")],
  );
  const owner = game.player("p1");
  const tile = game.ref(8, 10);
  const ship = owner.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
  const exec = new WarshipExecution(ship);
  exec.init(game, 0);
  return { game, owner, tile, ship, exec };
}

it.each([false, true])(
  "preserves legacy retries and bounds versioned failures (v1=%s)",
  async (versioned) => {
    const { game, tile, exec, owner, ship } = await fixture(versioned);
    const clock = vi.spyOn(game, "ticks");
    vi.spyOn(exec, "randomTile").mockReturnValue(tile);
    const next = vi
      .spyOn(WaterPathFinder.prototype, "next")
      .mockReturnValue({ status: PathStatus.NOT_FOUND });
    for (let tick = 0; tick < 600; tick++) {
      clock.mockReturnValue(tick);
      exec.tick(tick);
    }
    if (versioned) expect(next.mock.calls.length).toBeLessThan(16);
    else expect(next).toHaveBeenCalledTimes(600);
    const before = next.mock.calls.length;
    // The same-tile command must also wake it, not only changes of patrol area.
    new MoveWarshipExecution(owner, [ship.id()], tile).init(game, 600);
    clock.mockReturnValue(600);
    exec.tick(600);
    expect(next).toHaveBeenCalledTimes(before + 1);
  },
);

it("bounds all off-map candidate draws, including shoreline fallback", async () => {
  const { game, exec } = await fixture(true);
  const valid = vi.spyOn(game, "isValidCoord").mockReturnValue(false);
  expect(exec.randomTile()).toBeUndefined();
  expect(valid).toHaveBeenCalledTimes(384);
});

it("does not throttle successful patrol movement", async () => {
  const { game, exec, tile } = await fixture(true);
  const clock = vi.spyOn(game, "ticks");
  vi.spyOn(exec, "randomTile").mockReturnValue(tile);
  const next = vi
    .spyOn(WaterPathFinder.prototype, "next")
    .mockReturnValue({ status: PathStatus.COMPLETE, node: tile });
  for (let tick = 0; tick < 100; tick++) {
    clock.mockReturnValue(tick);
    exec.tick(tick);
  }
  expect(next).toHaveBeenCalledTimes(100);
});

it("still selects and fires at enemy transports during failed-patrol cooldown", async () => {
  const { game, exec, tile, ship } = await fixture(true);
  const clock = vi.spyOn(game, "ticks").mockReturnValue(100);
  vi.spyOn(exec, "randomTile").mockReturnValue(tile);
  vi.spyOn(WaterPathFinder.prototype, "next").mockReturnValue({
    status: PathStatus.NOT_FOUND,
  });
  exec.tick(100);
  // Use a real second player, preserving target legality and native shell execution.
  const enemy = game.addPlayer(
    new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
  );
  const transport = enemy.buildUnit(UnitType.TransportShip, game.ref(9, 10), {
    troops: 100,
  });
  vi.spyOn(ship.owner(), "canAttackPlayer").mockReturnValue(true);
  const add = vi.spyOn(game, "addExecution");
  clock.mockReturnValue(101);
  exec.tick(101);
  expect(transport.isActive()).toBe(true);
  expect(add).toHaveBeenCalled();
});
