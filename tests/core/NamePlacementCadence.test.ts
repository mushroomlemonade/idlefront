import { expect, it, vi } from "vitest";
import { GameRunner } from "../../src/core/GameRunner";
import type { GameUpdateViewData } from "../../src/core/game/GameUpdates";

vi.mock("../../src/client/hud/NameBoxCalculator", () => ({
  placeName: (game: { ticks(): number }, player: { smallID(): number }) => ({
    x: game.ticks(),
    y: player.smallID(),
    size: 1,
  }),
  placeSpawnName: () => ({ x: 0, y: 0, size: 1 }),
}));

it("spreads label work across 30 ticks, sends deltas, and refreshes each player once per interval", () => {
  let tick = 30;
  const players = Array.from({ length: 60 }, (_, i) => ({
    id: () => `p${i + 1}`,
    smallID: () => i + 1,
  }));
  const game = {
    ticks: () => tick,
    inSpawnPhase: () => false,
    players: () => players,
    config: () => ({ gameConfig: () => ({}) }),
    addExecution: () => {},
    executeNextTick: () => {
      tick++;
      return {};
    },
    drainPackedTileUpdates: () => new Uint32Array(),
    drainPackedMotionPlans: () => undefined,
    drainPackedPlayerUpdates: () => undefined,
    drainPackedAttackUpdates: () => undefined,
    drainNukeImpacts: () => [],
  };
  const counts = new Map<string, number>();
  const packets: GameUpdateViewData[] = [];
  const runner = new GameRunner(
    game as never,
    { createExecs: () => [] } as never,
    (update) => {
      if ("errMsg" in update) throw new Error(update.errMsg);
      packets.push(update);
    },
  );
  for (let i = 0; i < 60; i++) {
    runner.addTurn({ turnNumber: i, intents: [] });
    expect(runner.executeNextTick()).toBe(true);
    const names = packets[packets.length - 1].playerNameViewData!;
    expect(Object.keys(names)).toHaveLength(2);
    for (const [id, placement] of Object.entries(names)) {
      expect(placement.y % 30).toBe(tick % 30);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  expect(counts.size).toBe(60);
  expect([...counts.values()].every((n) => n === 2)).toBe(true);
  expect(packets[0].playerNameViewData).toEqual({
    p1: { x: 31, y: 1, size: 1 },
    p31: { x: 31, y: 31, size: 1 },
  });
});
