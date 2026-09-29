import { expect, it } from "vitest";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import { packMotionPlans } from "../../src/core/game/MotionPlans";
import {
  decodeViewPacket,
  encodeViewPacket,
  ViewQuerySchema,
} from "../../src/core/network/ViewProtocol";
import { compactWorldHistory } from "../../src/core/WorldHistory";
import { CorridorHistory } from "../../src/server/simulation/CorridorHistory";
import { emptyView } from "../../src/server/simulation/ViewSnapshot";
import { WorldHistory } from "../../src/server/simulation/WorldHistory";
import { playerInfo, setup } from "../util/Setup";

it("records unattended nation history, replays deterministically, and restricts fog queries to the authenticated owner", async () => {
  const g = await setup("big_plains", {}, [
    playerInfo("a", PlayerType.Human),
    playerInfo("b", PlayerType.Human),
  ]);
  const a = g.player("a"),
    b = g.player("b");
  a.conquer(g.ref(3, 3));
  b.conquer(g.ref(8, 8));
  const h = new WorldHistory(g),
    replay = new WorldHistory(g);
  for (let tick = 100; tick <= 1000; tick += 100) {
    a.addGold(100n);
    const u = emptyView(tick);
    h.record(u);
    replay.record(u);
  }
  const data = h.query("gold", false, "a");
  expect(data).toEqual(replay.query("gold", false, "a"));
  expect(data.series.find((s) => s.id === "a")?.points).toHaveLength(10);
  expect(h.query("gold", false, "a", true).series.map((s) => s.id)).toEqual([
    "a",
  ]);
  expect(h.query("gold", false, undefined, true).series).toEqual([]);
  const packet = decodeViewPacket(
    encodeViewPacket({
      kind: "result",
      message: { type: "world_history_result", result: data },
    }).buffer,
  );
  expect(packet.kind).toBe("result");
  expect(packet).toEqual({
    kind: "result",
    message: { type: "world_history_result", result: data },
  });
  expect(
    ViewQuerySchema.safeParse({
      type: "world_history",
      id: "q",
      playerID: 0,
      metric: "secret",
    }).success,
  ).toBe(false);
});
it("bounds weeks of samples while retaining the first and newest points", () => {
  let points: Float64Array[] = [];
  for (let i = 0; i < 10000; i++) {
    points = compactWorldHistory(points);
    points.push(Float64Array.from([i, i === 300 ? 1000 : i]));
  }
  expect(points.length).toBeLessThanOrEqual(256);
  expect(points[0][0]).toBe(0);
  expect(points[points.length - 1][0]).toBe(9999);
});
it("serves complete server corridors immediately to different devices and invalidates only damaged routes", async () => {
  const g = await setup("big_plains", {}, [playerInfo("a", PlayerType.Human)]);
  const port = g.player("a").buildUnit(UnitType.Port, g.ref(8, 8), {});
  const ship = g
    .player("a")
    .buildUnit(UnitType.TradeShip, g.ref(2, 2), { targetUnit: port });
  const c = new CorridorHistory(g),
    replay = new CorridorHistory(g);
  const u = emptyView(1);
  u.packedMotionPlans = packMotionPlans([
    {
      kind: "grid",
      unitId: ship.id(),
      planId: 1,
      startTick: 1,
      ticksPerStep: 1,
      path: [g.ref(2, 2), g.ref(3, 2), g.ref(4, 2)],
    },
  ]);
  c.record(u);
  replay.record(u);
  expect(c.snapshot().length).toBe(4);
  expect(c.snapshot()).toEqual(replay.snapshot());
  expect(c.snapshot((t) => t !== g.ref(3, 2))).toHaveLength(0);
  const damage = emptyView(2);
  damage.packedTerrainUpdates = Uint32Array.from([g.ref(90, 90), 128]);
  c.record(damage);
  expect(c.snapshot()).toHaveLength(4);
  damage.packedTerrainUpdates = Uint32Array.from([g.ref(3, 2), 128]);
  c.record(damage);
  expect(c.snapshot()).toHaveLength(0);
});
