import { SharedWaterCache } from "../../../src/core/execution/nation/SharedWaterCache";
import { PlayerType } from "../../../src/core/game/Game";
import { playerInfo, setup } from "../../util/Setup";

it("preserves shared-water membership and the 30-tick refresh across diplomacy and coastline edits", async () => {
  const game = await setup("plains", {}, [
    playerInfo("a", PlayerType.Nation),
    playerInfo("b", PlayerType.Human),
  ]);
  const a = game.player("a"),
    b = game.player("b"),
    map = game.map();
  const left = game.ref(8, 8),
    water = game.ref(9, 8),
    right = game.ref(10, 8);
  map.setWater(water);
  map.setShorelineBit(left);
  map.setShorelineBit(right);
  a.conquer(left);
  b.conquer(right);
  vi.spyOn(game, "getWaterComponent").mockReturnValue(17);
  let tick = 0;
  vi.spyOn(game, "ticks").mockImplementation(() => tick);
  const cache = new SharedWaterCache(game);
  expect([...(cache.get(a) ?? [])]).toEqual([17]);
  a.addEmbargo(b, false);
  tick = 29;
  expect([...(cache.get(a) ?? [])]).toEqual([17]);
  tick = 30;
  expect(cache.get(a)).toBeNull();
  expect(cache.get(b)).toBeNull();
  map.setOcean(water);
  tick = 59;
  expect(cache.get(a)).toBeNull();
  tick = 60;
  expect([...(cache.get(a) ?? [])]).toEqual([-1]);
  a.relinquish(left);
  tick = 90;
  expect(cache.get(a)).toBeNull();
  a.conquer(left);
  tick = 120;
  expect([...(cache.get(a) ?? [])]).toEqual([-1]);
  map.clearShorelineBit(left);
  tick = 150;
  expect(cache.get(a)).toBeNull();
});
