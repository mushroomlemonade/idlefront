import { PlayerType, UnitType } from "../src/core/game/Game";
import { playerInfo, setup } from "./util/Setup";

describe("incremental global unit counts", () => {
  it("matches the roster through builds, capture, upgrades and destruction", async () => {
    const game = await setup("big_plains", {
      infiniteGold: true,
      instantBuild: true,
    });
    game.addPlayer(playerInfo("a", PlayerType.Human));
    game.addPlayer(playerInfo("b", PlayerType.Human));
    const a = game.player("a");
    const b = game.player("b");
    const check = () => {
      for (const type of Object.values(UnitType)) {
        expect(game.unitCount(type)).toBe(
          a.unitCount(type) + b.unitCount(type),
        );
      }
    };
    check();
    const port = a.buildUnit(UnitType.Port, game.ref(5, 5), {});
    const ship = a.buildUnit(UnitType.TradeShip, game.ref(6, 5), {
      targetUnit: port,
    });
    check();
    port.increaseLevel();
    check();
    b.captureUnit(port);
    b.captureUnit(ship);
    check();
    port.decreaseLevel();
    check();
    port.decreaseLevel();
    check();
    ship.delete(false);
    check();
    expect(game.unitCount(UnitType.Port)).toBe(0);
    expect(game.unitCount(UnitType.TradeShip)).toBe(0);
  });
});
