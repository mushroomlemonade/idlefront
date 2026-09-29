import { describe, expect, it } from "vitest";
import {
  HISTORY_METRICS,
  LeaderboardHistory,
} from "../../src/client/hud/layers/lib/LeaderboardHistory";
import { TradeTraffic } from "../../src/client/render/frame/TradeTraffic";
import type { UnitState } from "../../src/client/render/types/Renderer";
import { TrainType } from "../../src/client/render/types/Renderer";
import type { GameView } from "../../src/client/view";
import { UnitType } from "../../src/core/game/Game";
import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../../src/core/game/GameUpdates";

describe("bounded observed history", () => {
  it("bounds series and points over long sessions and sorts charts by the chosen metric", () => {
    const h = new LeaderboardHistory();
    for (let tick = 0; tick < 1200; tick++)
      h.sample(tick, [
        {
          id: "a",
          name: "Alice",
          values: new Map([
            ["gold", 100],
            ["cities", 1],
          ]),
        },
        {
          id: "b",
          name: "Bob",
          values: new Map([
            ["gold", 1],
            ["cities", 20],
          ]),
        },
      ]);
    expect(h.leaders("gold")[0].id).toBe("a");
    expect(h.leaders("cities")[0].id).toBe("b");
    expect(h.series.get("a")!.points.length).toBeLessThanOrEqual(384);
    expect(h.series.get("a")!.points[0][0]).toBe(0);
    expect(
      h.series.get("a")!.points[h.series.get("a")!.points.length - 1][0],
    ).toBe(1199);
    for (let tick = 1200; tick < 1300; tick++)
      h.sample(
        tick,
        Array.from({ length: 100 }, (_, i) => ({
          id: `${tick}-${i}`,
          name: "nation",
          values: new Map(HISTORY_METRICS.map((c, j) => [c.id, (i + j) % 100])),
        })),
      );
    expect(h.series.size).toBeLessThanOrEqual(64);
  });
  it("does not invent samples for missing or fogged players", () => {
    const h = new LeaderboardHistory();
    h.sample(10, [{ id: "a", name: "A", values: new Map([["gold", 10]]) }]);
    h.sample(20, []);
    expect(h.series.get("a")!.points).toHaveLength(1);
  });
});
describe("observed world events", () => {
  it("starts tracking ascending selections without exceeding its memory limit", () => {
    const h = new LeaderboardHistory();
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      name: String(i),
      values: new Map([["gold" as const, i]]),
    }));
    h.sample(10, rows);
    h.trackSelection("gold", "asc");
    h.sample(20, rows);
    for (let i = 0; i < 5; i++) expect(h.series.has(String(i))).toBe(true);
    expect(h.series.size).toBeLessThanOrEqual(64);
  });
  it("retains a visible former leader after its assets collapse", () => {
    const h = new LeaderboardHistory();
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      name: String(i),
      values: new Map([["gold" as const, 100 - i]]),
    }));
    h.sample(10, rows);
    h.sample(
      20,
      rows.map((r, i) =>
        i === 0 ? { ...r, values: new Map([["gold", 1]]) } : r,
      ),
    );
    expect(h.leaders("gold").map((r) => r.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "0",
    ]);
    h.sample(30, rows.slice(1));
    expect(h.leaders("gold").map((r) => r.id)).not.toContain("0");
  });
  it("annotates nuclear events once without replaying snapshot events", () => {
    const h = new LeaderboardHistory();
    let tick = 100;
    const game = {
      inSpawnPhase: () => false,
      ticksSinceStart: () => tick,
      players: () => [],
      config: () => ({ gameConfig: () => ({}) }),
      playerBySmallID: () => ({ isPlayer: () => true, name: () => "Nation" }),
    } as unknown as GameView;
    const unit = { id: 1, unitType: UnitType.MIRV, ownerID: 1, isActive: true };
    const update = (u: unknown, snapshotPhase?: string) =>
      ({
        snapshotPhase,
        updates: { [GameUpdateType.Unit]: [u] },
      }) as unknown as GameUpdateViewData;
    h.observe(game, update(unit, "end"));
    expect(h.events).toHaveLength(0);
    tick++;
    h.observe(game, update(unit));
    tick++;
    h.observe(game, update(unit));
    expect(h.events).toHaveLength(1);
    tick++;
    h.observe(game, update({ ...unit, isActive: false, reachedTarget: true }));
    expect(h.events.map((e) => e.text)).toEqual([
      "Nation: mirv detected",
      "Nation: mirv impact",
    ]);
    const city = {
      id: 2,
      unitType: UnitType.City,
      ownerID: 1,
      lastOwnerID: 2,
      isActive: true,
    };
    tick++;
    h.observe(game, update(city));
    tick++;
    h.observe(game, update(city));
    expect(h.events.filter((e) => e.kind === "capture")).toHaveLength(1);
  });
});

describe("observed trade corridors", () => {
  const ship = (pos: number, lastPos: number, type = "Trade Ship") =>
    ({
      id: 1,
      pos,
      lastPos,
      unitType: type,
      isActive: true,
      trainType: TrainType.Engine,
    }) as UnitState;
  it("accumulates actual crossings and expires idle edges", () => {
    const traffic = new TradeTraffic(100);
    const units = new Map([[1, ship(11, 10)]]);
    const initial = traffic.update(1, units, () => true, 100, 8);
    for (let tick = 2; tick <= 11; tick++) {
      units.set(1, tick % 2 ? ship(11, 10) : ship(10, 11));
      traffic.update(tick, units, () => true, 100, 8);
    }
    const hot = traffic.update(21, units, () => true, 100, 8);
    expect(hot[4]).toBeGreaterThan(initial[4]);
    expect(traffic.update(200, new Map(), () => true, 100, 8).length).toBe(0);
  });
  it("does not count stationary units as more trips", () => {
    const traffic = new TradeTraffic(100);
    const units = new Map([[1, ship(11, 10)]]);
    const initial = traffic.update(1, units, () => true, 100, 8);
    for (let tick = 2; tick <= 11; tick++)
      traffic.update(tick, units, () => true, 100, 8);
    expect(traffic.update(21, units, () => true, 100, 8)[4]).toBeLessThan(
      initial[4],
    );
  });
  it("removes newly fog-hidden routes without waiting for the normal upload interval", () => {
    const traffic = new TradeTraffic(100);
    expect(
      traffic.update(1, new Map([[1, ship(11, 10)]]), () => true).length,
    ).toBe(6);
    expect(
      traffic.update(2, new Map(), () => false, 18000, 8, true).length,
    ).toBe(0);
  });
  it("rejects teleport trails and hidden positions; counts engines not carriages", () => {
    const traffic = new TradeTraffic(100);
    expect(
      traffic.update(10, new Map([[1, ship(5000, 0)]]), () => true).length,
    ).toBe(0);
    expect(
      traffic.update(20, new Map([[1, ship(11, 10)]]), () => false).length,
    ).toBe(0);
    traffic.reset();
    expect(
      traffic.update(30, new Map([[1, ship(11, 10, "Train")]]), () => true)
        .length,
    ).toBe(6);
    traffic.reset();
    const carriage = {
      ...ship(11, 10, "Train"),
      trainType: TrainType.Carriage,
    };
    expect(
      traffic.update(40, new Map([[1, carriage]]), () => true).length,
    ).toBe(0);
  });
});
