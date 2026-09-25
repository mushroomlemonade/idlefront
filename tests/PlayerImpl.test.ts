import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let player: Player;
let other: Player;

describe("PlayerImpl", () => {
  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("other", PlayerType.Human, null, "other_id"),
    ]);

    player = game.player("player_id");
    other = game.player("other_id");

    player.conquer(game.ref(0, 0));
    other.conquer(game.ref(50, 50));
    player.addGold(BigInt(1000000));

    game.config().structureMinDist = () => 10;
  });

  test("City can be upgraded", () => {
    const city = player.buildUnit(UnitType.City, game.ref(0, 0), {});
    const buCity = player
      .buildableUnits(game.ref(0, 0))
      .find((bu) => bu.type === UnitType.City);
    expect(buCity).toBeDefined();
    expect(buCity!.canUpgrade).toBe(city.id());
  });

  test("ordered type indexes and level counts match full scans after captures, upgrades and deletions", () => {
    const types = [UnitType.City, UnitType.Factory, UnitType.DefensePost];
    let seed = 19;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 300; step++) {
      const owner = step % 2 ? player : other;
      const all = game.units();
      const unit = all.length ? all[random() % all.length] : undefined;
      switch (random() % 5) {
        case 0:
          if (unit) unit.setOwner(unit.owner() === player ? other : player);
          break;
        case 1:
          unit?.increaseLevel();
          break;
        case 2:
          unit?.decreaseLevel();
          break;
        case 3:
          unit?.delete(false);
          break;
        default:
          owner.buildUnit(
            types[random() % types.length],
            game.ref(step % 50, 2),
            {},
          );
      }
      for (const type of types) {
        for (const p of [player, other]) {
          const expected = p.units().filter((u) => u.type() === type);
          expect(p.units(type)).toEqual(expected);
          expect(p.unitCount(type)).toBe(
            expected.reduce((n, u) => n + u.level(), 0),
          );
          expect(p.unitsOwned(type)).toBe(
            expected.reduce(
              (n, u) => n + (u.isUnderConstruction() ? 1 : u.level()),
              0,
            ),
          );
          // The indexed results must not become mutable internal storage.
          p.units(type).reverse().pop();
          expect(p.units(type)).toEqual(expected);
        }
        expect(game.units(type)).toEqual(
          game.units().filter((u) => u.type() === type),
        );
        expect(game.unitCount(type)).toBe(
          game.units(type).reduce((n, u) => n + u.level(), 0),
        );
      }
    }
  });

  test("deleting and capturing during roster iteration preserves every original entry", () => {
    const city = player.buildUnit(UnitType.City, game.ref(1, 1), {});
    const factory = player.buildUnit(UnitType.Factory, game.ref(2, 1), {});
    const defense = player.buildUnit(UnitType.DefensePost, game.ref(3, 1), {});
    const initial = player.units();
    const visited: number[] = [];
    for (const unit of initial) {
      visited.push(unit.id());
      if (unit === factory) other.captureUnit(unit);
      else unit.delete(false);
    }
    expect(visited).toEqual([city.id(), factory.id(), defense.id()]);
    expect(initial).toEqual([city, factory, defense]);
    expect(player.units()).toEqual([]);
    expect(other.units()).toEqual([factory]);
    expect(player.units([UnitType.City, UnitType.Factory])).toEqual([]);
    expect(game.units(UnitType.Factory)).toEqual([factory]);
  });

  test("DefensePost cannot be upgraded", () => {
    player.buildUnit(UnitType.DefensePost, game.ref(0, 0), {});
    const buDefensePost = player
      .buildableUnits(game.ref(0, 0))
      .find((bu) => bu.type === UnitType.DefensePost);
    expect(buDefensePost).toBeDefined();
    expect(buDefensePost!.canUpgrade).toBeFalsy();
  });

  test("City can be upgraded from another city", () => {
    const city = player.buildUnit(UnitType.City, game.ref(0, 0), {});
    const cityToUpgrade = player.findUnitToUpgrade(
      UnitType.City,
      game.ref(0, 1),
    );
    expect(cityToUpgrade).toBeTruthy();
    if (cityToUpgrade === false) {
      return;
    }
    expect(cityToUpgrade.id()).toBe(city.id());
  });
  test("City cannot be upgraded when too far away", () => {
    player.buildUnit(UnitType.City, game.ref(0, 0), {});
    const cityToUpgrade = player.findUnitToUpgrade(
      UnitType.City,
      game.ref(50, 50),
    );
    expect(cityToUpgrade).toBe(false);
  });
  test("Unit cannot be upgraded when not enough gold", () => {
    player.buildUnit(UnitType.City, game.ref(0, 0), {});
    player.removeGold(BigInt(1000000));
    const cityToUpgrade = player.findUnitToUpgrade(
      UnitType.City,
      game.ref(0, 1),
    );
    expect(cityToUpgrade).toBe(false);
  });

  describe("units() type filtering", () => {
    beforeEach(() => {
      player.buildUnit(UnitType.City, game.ref(0, 0), {});
      player.buildUnit(UnitType.DefensePost, game.ref(11, 0), {});
      player.buildUnit(UnitType.City, game.ref(0, 11), {});
      player.buildUnit(UnitType.MissileSilo, game.ref(11, 11), {});
    });

    // Reference implementation: filter _units preserving insertion order.
    function expected(...types: UnitType[]) {
      const ts = new Set(types);
      return player.units().filter((u) => ts.has(u.type()));
    }

    test("single type returns matching units in insertion order", () => {
      expect(player.units(UnitType.City)).toEqual(expected(UnitType.City));
      expect(player.units(UnitType.City)).toHaveLength(2);
    });

    test("returns a fresh array, not the internal or shared buffer", () => {
      const a = player.units(UnitType.City);
      const b = player.units(UnitType.City);
      expect(a).not.toBe(b);
      expect(a).not.toBe(player.units());
      // Mutating one result must not affect a later query.
      a.length = 0;
      expect(player.units(UnitType.City)).toHaveLength(2);
    });

    test("two and three types return the union in insertion order", () => {
      expect(player.units(UnitType.City, UnitType.MissileSilo)).toEqual(
        expected(UnitType.City, UnitType.MissileSilo),
      );
      expect(
        player.units(UnitType.City, UnitType.DefensePost, UnitType.MissileSilo),
      ).toEqual(
        expected(UnitType.City, UnitType.DefensePost, UnitType.MissileSilo),
      );
      // Duplicate types don't duplicate results.
      expect(player.units(UnitType.City, UnitType.City)).toEqual(
        expected(UnitType.City),
      );
    });

    test("array of types (Set path) and no match", () => {
      expect(
        player.units([
          UnitType.City,
          UnitType.DefensePost,
          UnitType.MissileSilo,
          UnitType.Port,
        ]),
      ).toEqual(
        expected(UnitType.City, UnitType.DefensePost, UnitType.MissileSilo),
      );
      expect(player.units(UnitType.Port)).toEqual([]);
    });
  });

  test("Can't send alliance requests when dead", () => {
    // conquer other
    const otherTiles = other.tiles();
    for (const tile of otherTiles) {
      player.conquer(tile);
    }
    expect(other.canSendAllianceRequest(player)).toBe(false);
  });

  describe("tiles()", () => {
    test("returns a live view that reflects later ownership changes", () => {
      const tiles = player.tiles();
      const sizeBefore = tiles.size;
      const tile = game.ref(5, 5);
      player.conquer(tile);
      expect(tiles.has(tile)).toBe(true);
      expect(tiles.size).toBe(sizeBefore + 1);
    });

    test("every tile is visited when relinquishing during iteration", () => {
      player.conquer(game.ref(1, 0));
      player.conquer(game.ref(2, 0));
      const owned = player.numTilesOwned();
      expect(owned).toBeGreaterThan(1);
      // SpawnExecution relinquishes all tiles while iterating tiles().
      let visited = 0;
      player.tiles().forEach((t) => {
        visited++;
        player.relinquish(t);
      });
      expect(visited).toBe(owned);
      expect(player.numTilesOwned()).toBe(0);
    });
  });
});
