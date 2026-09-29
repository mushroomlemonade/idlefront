import { expect, it, vi } from "vitest";
import { PlayerType, UnitType } from "../src/core/game/Game";
import { PlayerImpl } from "../src/core/game/PlayerImpl";
import { playerInfo, setup } from "./util/Setup";

it("preserves player and unit ordering across build, capture, removal and owner re-entry", async () => {
  const game = await setup("big_plains", { infiniteGold: true }, [
    playerInfo("a", PlayerType.Human),
    playerInfo("b", PlayerType.Human),
    playerInfo("empty", PlayerType.Human),
  ]);
  const a = game.player("a"),
    b = game.player("b");
  const check = () =>
    expect(game.units(UnitType.City)).toEqual(
      game.allPlayers().flatMap((p) => p.units(UnitType.City)),
    );
  const b1 = b.buildUnit(UnitType.City, game.ref(4, 4), {});
  const a1 = a.buildUnit(UnitType.City, game.ref(6, 6), {});
  const a2 = a.buildUnit(UnitType.City, game.ref(8, 8), {});
  check();
  expect(game.units(UnitType.City)).toEqual([a1, a2, b1]);
  b.captureUnit(a1);
  check();
  a2.delete(false);
  check();
  a.captureUnit(b1);
  check();
  game.units(UnitType.City).reverse();
  check();
  const spy = vi.spyOn(game.player("empty") as PlayerImpl, "appendUnitsOfType");
  game.units(UnitType.City);
  game.units(UnitType.TransportShip);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
