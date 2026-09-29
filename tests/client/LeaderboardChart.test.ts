import { describe, expect, it } from "vitest";
import {
  historyRange,
  valueRange,
  windowPoints,
} from "../../src/client/hud/layers/lib/LeaderboardChart";
import { LeaderboardHistory } from "../../src/client/hud/layers/lib/LeaderboardHistory";
import { WORLD_HISTORY_METRICS } from "../../src/core/WorldHistory";

describe("history windows and recovery", () => {
  it("loads the same pre-join history on fresh devices instead of retaining device samples", () => {
    const first = new LeaderboardHistory(),
      second = new LeaderboardHistory();
    first.sample(999, [{ id: "stale", name: "old", values: new Map() }]);
    const data = {
      tick: 1000,
      restricted: false,
      events: [],
      metrics: WORLD_HISTORY_METRICS.join(","),
      series: [
        {
          id: "a",
          points: [100, 500, 1000].map((t) =>
            Float64Array.from([t, ...WORLD_HISTORY_METRICS.map(() => t)]),
          ),
        },
      ],
    };
    first.applyServer(data);
    second.applyServer(data);
    expect([...first.series]).toEqual([...second.series]);
    expect(first.series.has("stale")).toBe(false);
    expect(first.series.get("a")?.points.map((p) => p[0])).toEqual([
      100, 500, 1000,
    ]);
  });
  it("offers genuinely different time windows and keeps the preceding step", () => {
    const points = [0, 100, 500, 1000].map(
      (t) => new Float64Array([t, 100 + t / 100]),
    );
    expect(historyRange(points, 600)).toEqual([400, 1000]);
    expect(historyRange(points, 0)).toEqual([0, 1000]);
    expect(windowPoints(points, 400, 1000).map((p) => p[0])).toEqual([
      100, 500, 1000,
    ]);
    expect(valueRange(points, 1, true)[0]).toBeGreaterThan(0);
    expect(valueRange(points, 1, false)[0]).toBe(0);
  });
  it("restores observed samples without overwriting newer live observations", () => {
    const old = new LeaderboardHistory(),
      live = new LeaderboardHistory();
    const rows = (n: number) => [
      { id: "a", name: "A", values: new Map([["gold" as const, n]]) },
    ];
    old.sample(10, rows(100));
    old.sample(20, rows(200));
    live.sample(20, rows(300));
    live.sample(30, rows(400));
    live.restore(old.snapshot());
    expect(live.series.get("a")!.points.map((p) => p[0])).toEqual([10, 20, 30]);
    expect(live.leaders("gold")[0].values.get("gold")).toBe(400);
    expect(live.series.get("a")!.points[1]).toEqual(
      live.snapshot().series[0].points[1],
    );
    expect(() =>
      live.restore({
        ...old.snapshot(),
        series: [null] as never,
        events: [null] as never,
      }),
    ).not.toThrow();
  });
});
