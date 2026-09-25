import { expect, it } from "vitest";
import { PlayerInfo, PlayerType } from "../../../src/core/game/Game";
import { TerritoryContactIndex } from "../../../src/server/simulation/TerritoryContactIndex";
import { setup } from "../../util/Setup";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";

it("removes wilderness contacts when terrain becomes water", async () => {
  const template = await setup("ocean_and_land");
  const map = new GameMapImpl(10, 10, new Uint8Array(100).fill(128), 100);
  const game = createGame([new PlayerInfo("p", PlayerType.Human, "seat1", "p")], [], map, map, template.config());
  const index = new TerritoryContactIndex(game);
  const player = game.player("p"); player.conquer(55);
  expect(index.edgeCount(player.smallID(), 0)).toBe(4);
  game.setWater(54);
  expect(index.edgeCount(player.smallID(), 0)).toBe(3);
  player.relinquish(55);
  expect(index.edgeCount(player.smallID(), 0)).toBe(0);
  index.dispose();
});

it("matches exhaustive land contacts through captures and relinquishing", async () => {
  const game = await setup("ocean_and_land");
  const index = new TerritoryContactIndex(game);
  const players = [1, 2, 3].map((id) =>
    game.addPlayer(new PlayerInfo(`p${id}`, PlayerType.Human, null, `p${id}`)),
  );
  const tiles: number[] = [];
  game.forEachTile((tile) => {
    if (game.isLand(tile) && !game.isImpassable(tile)) tiles.push(tile);
  });
  let seed = 51;
  for (let step = 0; step < 70; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const tile = tiles[seed % tiles.length];
    if (game.hasOwner(tile) && step % 4 === 0)
      players.find(p => p.smallID() === game.ownerID(tile))!.relinquish(tile);
    else players[step % players.length].conquer(tile);
    const expected = new Map<string, number>();
    for (const source of tiles)
      game.forEachNeighbor(source, (target) => {
        if (!game.isLand(target) || game.isImpassable(target)) return;
        const a = game.ownerID(source),
          b = game.ownerID(target);
        if (a === b) return;
        const key = `${a}:${b}`;
        expected.set(key, (expected.get(key) ?? 0) + 1);
      });
    for (const a of [0, ...players.map((p) => p.smallID())])
      for (const b of [0, ...players.map((p) => p.smallID())])
        expect(index.edgeCount(a, b)).toBe(expected.get(`${a}:${b}`) ?? 0);
  }
  index.dispose();
});
