import { expect, it, vi } from "vitest";
import { PlayerType, UnitType } from "../src/core/game/Game";
import { tradePortCandidates } from "../src/core/game/PortTradeIndex";
import { nationFleetBudget } from "../src/core/NationFleetBudget";
import { PersistentIdSchema } from "../src/core/Schemas";
import { tradeCorridorsForPreset } from "../src/core/TradeCorridors";
import { archiveIdentity } from "../src/server/ArchiveIdentity";
import { playerInfo, setup } from "./util/Setup";

it("invalidates cached construction counts across level, construction, capture and deletion", async () => {
  const g = await setup("big_plains", {}, [
    playerInfo("a", PlayerType.Human),
    playerInfo("b", PlayerType.Human),
  ]);
  const a = g.player("a"),
    b = g.player("b"),
    u = a.buildUnit(UnitType.City, g.ref(3, 3), {});
  const check = () => {
    for (const p of [a, b])
      expect(p.unitsOwned(UnitType.City)).toBe(
        p
          .units(UnitType.City)
          .reduce((n, u) => n + (u.isUnderConstruction() ? 1 : u.level()), 0),
      );
  };
  check();
  u.increaseLevel();
  check();
  u.setUnderConstruction(true);
  check();
  u.setUnderConstruction(false);
  check();
  b.captureUnit(u);
  check();
  u.delete(false);
  check();
});
it("reuses the port roster but immediately sees same-tick build/capture/delete and relation changes", async () => {
  const g = await setup("big_plains", {}, [
    playerInfo("a", PlayerType.Human),
    playerInfo("b", PlayerType.Human),
  ]);
  const a = g.player("a"),
    b = g.player("b"),
    u = b.buildUnit(UnitType.Port, g.ref(3, 3), {});
  a.conquer(g.ref(2, 2));
  b.conquer(g.ref(8, 8));
  const relation = vi.spyOn(b, "canTrade").mockReturnValue(true);
  const reference = () =>
    g
      .players()
      .filter((p) => p !== a && p.canTrade(a))
      .flatMap((p) => p.units(UnitType.Port));
  expect(tradePortCandidates(g, a)).toEqual(reference());
  const more = b.buildUnit(UnitType.Port, g.ref(5, 5), {});
  expect(tradePortCandidates(g, a)).toEqual(reference());
  a.captureUnit(u);
  expect(tradePortCandidates(g, a)).toEqual([more]);
  relation.mockReturnValue(false);
  expect(tradePortCandidates(g, a)).toEqual([]);
  relation.mockReturnValue(true);
  more.delete(false);
  expect(tradePortCandidates(g, a)).toEqual([]);
});
it("uses loaded HD map dimensions only for versioned new-world density", async () => {
  const cfg = tradeCorridorsForPreset("longplay")!;
  const g = await setup("big_plains", { tradeCorridors: cfg });
  const c = g.config();
  expect(c.tradeShipSpawnRate(12, 400 * 9, 12324 * 5844)).toBe(
    c.tradeShipSpawnRate(12, 400, 4108 * 1948),
  );
  const legacy = await setup("big_plains", {
    tradeCorridors: { ...cfg, economy: undefined },
  });
  expect(legacy.config().tradeShipSpawnRate(12, 400, 12324 * 5844)).toBe(
    legacy.config().tradeShipSpawnRate(12, 400, 4108 * 1948),
  );
});
it("allows fleets beyond 48 without ignoring reserve, coverage or ordinary escalating costs", () => {
  expect(nationFleetBudget(100, 48, 1000000000n, 0n, 1000000n, false)).toBe(80);
  expect(nationFleetBudget(100, 48, 1000000000n, 0n, 1000000n, true)).toBe(88);
  expect(nationFleetBudget(100, 0, 1000000n, 1000000n, 250000n, false)).toBe(0);
  expect(nationFleetBudget(0, 48, 1000000000n, 0n, 1000000n, true)).toBe(0);
});
it("archives restored seats with stable UUID metadata without changing authentication", () => {
  const id = archiveIdentity(undefined, "game1234", "seat1234");
  expect(PersistentIdSchema.safeParse(id).success).toBe(true);
  expect(archiveIdentity("not-a-uuid", "game1234", "seat1234")).toBe(id);
  expect(archiveIdentity(id, "another1", "another2")).toBe(id);
  expect(archiveIdentity(undefined, "different", "seat1234")).not.toBe(id);
});
