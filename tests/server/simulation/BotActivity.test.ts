import { expect, it } from "vitest";
import { PlayerInfo, PlayerType, UnitType } from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { BotActivity } from "../../../src/server/simulation/BotActivity";
import { GameFog } from "../../../src/server/simulation/GameFog";
import { setup } from "../../util/Setup";

async function fixture() {
  const template = await setup("ocean_and_land", {
    instantBuild: true,
    infiniteGold: true,
  });
  const map = new GameMapImpl(400, 100, new Uint8Array(40000).fill(128), 40000);
  const game = createGame(
    [
      new PlayerInfo("Human", PlayerType.Human, "human001", "human"),
      new PlayerInfo("Near", PlayerType.Bot, null, "near"),
      new PlayerInfo("Far", PlayerType.Bot, null, "far"),
    ],
    [],
    map,
    map,
    template.config(),
  );
  const fog = new GameFog(game, "activity");
  const activity = new BotActivity(game, fog);
  const human = game.player("human"),
    near = game.player("near"),
    far = game.player("far");
  human.conquer(game.ref(10, 10));
  human.setSpawnTile(game.ref(10, 10));
  near.conquer(game.ref(13, 10));
  far.conquer(game.ref(300, 10));
  game.endSpawnPhase();
  fog.advance();
  activity.beginTurn();
  return { game, fog, activity, human, near, far };
}

it("staggered hidden frontiers run at 1Hz without slowing humans or their opponents", async () => {
  const { game, fog, activity, human, far } = await fixture();
  const wilderness = game.terraNullius();
  let runs = 0;
  for (let tick = 0; tick < 100; tick++) {
    if (game.shouldExpandAttack(far, wilderness, tick)) runs++;
    expect(game.shouldExpandAttack(human, wilderness, tick)).toBe(true);
    expect(game.shouldExpandAttack(far, human, tick)).toBe(true);
  }
  expect(runs).toBe(100 / activity.stride);
  activity.dispose();
  fog.dispose();
  expect(game.shouldExpandAttack(far, wilderness, 0)).toBe(true);
});

it("promotes within the same turn before a newly approaching frontier can be throttled", async () => {
  const { game, fog, activity, human, near } = await fixture();
  human.conquer(game.ref(11, 10));
  human.conquer(game.ref(12, 10));
  for (let tick = 0; tick < activity.stride; tick++)
    expect(game.shouldExpandAttack(near, game.terraNullius(), tick)).toBe(true);
  activity.dispose();
  fog.dispose();
});

it("keeps offline human allies, observed scouts and vehicle dependencies full-rate", async () => {
  const { game, fog, activity, human, far } = await fixture();
  human.createAllianceRequest(far)!.accept();
  fog.advance();
  activity.beginTurn();
  for (let tick = 0; tick < activity.stride; tick++)
    expect(game.shouldExpandAttack(far, game.terraNullius(), tick)).toBe(true);
  human.breakAlliance(human.allianceWith(far)!);
  const ship = far.buildUnit(UnitType.Warship, game.ref(300, 10), {
    patrolTile: game.ref(300, 10),
  });
  fog.advance();
  activity.beginTurn();
  expect(
    game.attackExpansionBudget(
      far,
      game.terraNullius(),
      far.smallID() % activity.stride,
    ),
  ).toBe(BotActivity.REMOTE_EXPANSION_BUDGET);
  ship.move(game.ref(11, 10));
  fog.advance();
  activity.beginTurn();
  for (let tick = 0; tick < activity.stride; tick++)
    expect(game.shouldExpandAttack(far, game.terraNullius(), tick)).toBe(true);
  activity.dispose();
  fog.dispose();
});
