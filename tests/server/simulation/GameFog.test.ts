import { expect, it, vi } from "vitest";
import {
  PlayerInfo,
  PlayerType,
  TrainType,
  UnitType,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { GameFog } from "../../../src/server/simulation/GameFog";
import { setup } from "../../util/Setup";

async function fixture() {
  const template = await setup("ocean_and_land", {
    instantBuild: true,
    infiniteGold: true,
  });
  const terrain = new GameMapImpl(
    400,
    200,
    new Uint8Array(80000).fill(128),
    80000,
  );
  const players = [1, 2, 3].map(
    (id) => new PlayerInfo(`p${id}`, PlayerType.Human, `seat${id}`, `p${id}`),
  );
  const game = createGame(players, [], terrain, terrain, template.config());
  const fog = new GameFog(game, "fog-fixture");
  return {
    game,
    fog,
    a: game.player("p1"),
    b: game.player("p2"),
    c: game.player("p3"),
  };
}

it("releases per-tile coverage permanently at global discovery", async () => {
  const { game, fog, a } = await fixture();
  a.conquer(game.ref(20,20)); a.setSpawnTile(game.ref(20,20));
  fog.advance();
  const view = fog.forClient("seat1");
  expect(view.coverage.allocatedBytes()).toBeGreaterThan(0);
  vi.spyOn(game.map(), "numLandTiles").mockReturnValue(2);
  fog.advance();
  expect(view.global).toBe(true);
  expect(view.coverage.allocatedBytes()).toBe(0);
  a.conquer(game.ref(21,20)); fog.advance();
  expect(view.coverage.allocatedBytes()).toBe(0);
  expect(view.isVisible(game.ref(399,199))).toBe(true);
  fog.dispose();
});

it("starts tight, reveals direct neighbours when cornered, and never recursively reveals their neighbours", async () => {
  const { game, fog, a, b, c } = await fixture();
  const center = game.ref(30, 30);
  a.setSpawnTile(center);
  a.conquer(center);
  b.conquer(game.ref(40, 30));
  c.conquer(game.ref(41, 30));
  fog.advance();
  const view = fog.forClient("seat1");
  expect(view.isVisible(center)).toBe(true);
  expect(view.isVisible(game.ref(31, 30))).toBe(true);
  expect(view.isVisible(game.ref(40, 30))).toBe(false);
  // A single contact reveals the tribe while other sides remain wilderness.
  b.conquer(game.ref(31, 30));
  fog.advance();
  expect(view.expanded).toBe(false);
  expect(view.isVisible(game.ref(40, 30))).toBe(true);
  expect(view.isVisible(game.ref(41, 30))).toBe(false);
  game.forEachNeighbor(center, (tile) => b.conquer(tile));
  fog.advance();
  expect(view.expanded).toBe(true);
  expect(view.isVisible(game.ref(40, 30))).toBe(true);
  expect(view.isVisible(game.ref(41, 30))).toBe(false);
  expect(view.canInspectPlayer(c.smallID())).toBe(false);
  expect(() => fog.forClient("unknown-seat")).toThrow();
  fog.dispose();
});

it("factories use connection range, trains move sight, and lost scouts leave no live intelligence", async () => {
  const { game, fog, a, b } = await fixture();
  a.conquer(game.ref(20, 100));
  a.setSpawnTile(game.ref(20, 100));
  const factory = a.buildUnit(UnitType.Factory, game.ref(20, 100), {});
  const target = game.ref(125, 100);
  b.conquer(target);
  fog.advance();
  const view = fog.forClient("seat1");
  expect(view.isVisible(target)).toBe(true);
  expect(view.canInspectPlayer(b.smallID())).toBe(true);
  expect(view.isVisible(game.ref(132, 100))).toBe(false);
  factory.delete();
  fog.advance();
  expect(view.isVisible(target)).toBe(false);
  expect(view.isExplored(target)).toBe(true);
  expect(view.canInspectPlayer(b.smallID())).toBe(false);
  const train = a.buildUnit(UnitType.Train, game.ref(200, 100), {
    trainType: TrainType.Engine,
  });
  fog.advance();
  expect(view.isVisible(game.ref(207, 100))).toBe(true);
  train.move(game.ref(230, 100));
  fog.advance();
  expect(view.isVisible(game.ref(207, 100))).toBe(false);
  expect(view.isExplored(game.ref(207, 100))).toBe(true);
  expect(view.isVisible(game.ref(237, 100))).toBe(true);
  fog.dispose();
});

it("revokes allied sight without forgetting terrain, and trade ships do not scout", async () => {
  const { game, fog, a, b } = await fixture();
  a.conquer(game.ref(20, 20));
  b.conquer(game.ref(250, 100));
  a.setSpawnTile(game.ref(20, 20));
  b.setSpawnTile(game.ref(250, 100));
  const request = a.createAllianceRequest(b)!;
  request.accept();
  fog.advance();
  const view = fog.forClient("seat1");
  expect(view.isVisible(game.ref(250, 100))).toBe(true);
  a.breakAlliance(a.allianceWith(b)!);
  fog.advance();
  expect(view.isVisible(game.ref(250, 100))).toBe(false);
  expect(view.isExplored(game.ref(250, 100))).toBe(true);
  const port = b.buildUnit(UnitType.Port, game.ref(250, 100), {});
  a.buildUnit(UnitType.TradeShip, game.ref(180, 100), { targetUnit: port });
  fog.advance();
  expect(view.isVisible(game.ref(180, 100))).toBe(false);
  fog.dispose();
});

it("restores only the correct match's exploration, never another player's live sight", async () => {
  const first = await fixture();
  first.a.conquer(first.game.ref(20, 20));
  first.a.setSpawnTile(first.game.ref(20, 20));
  const train = first.a.buildUnit(UnitType.Train, first.game.ref(200, 100), {
    trainType: TrainType.Engine,
  });
  first.fog.advance();
  train.delete();
  first.fog.advance();
  const checkpoint = JSON.parse(JSON.stringify(first.fog.checkpoint()));
  const second = await fixture();
  second.a.conquer(second.game.ref(20, 20));
  second.a.setSpawnTile(second.game.ref(20, 20));
  second.fog.restoreExploration(checkpoint);
  const tile = second.game.ref(200, 100);
  expect(second.fog.forClient("seat1").isExplored(tile)).toBe(true);
  expect(second.fog.forClient("seat1").isVisible(tile)).toBe(false);
  expect(second.fog.forClient("seat2").isExplored(tile)).toBe(false);
  expect(() =>
    second.fog.restoreExploration({ ...checkpoint, matchID: "other-match" }),
  ).toThrow();
  expect(() =>
    second.fog.restoreExploration({ ...checkpoint, tick: 999999 }),
  ).toThrow();
  expect(() =>
    second.fog.restoreExploration({ ...checkpoint, width: 200, height: 400 }),
  ).toThrow();
  first.fog.dispose();
  second.fog.dispose();
});
