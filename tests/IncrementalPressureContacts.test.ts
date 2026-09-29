import { expect, it } from "vitest";
import { PlayerType, type Game, type Player } from "../src/core/game/Game";
import { PressureContactIndex } from "../src/core/game/PressureContactIndex";
import { playerInfo, setup } from "./util/Setup";

function reference(game: Game, player: Player) {
  const out = new Map<number, number>();
  for (const tile of player.borderTiles())
    game.forEachNeighbor(tile, (neighbor) => {
      const owner = game.ownerID(neighbor);
      if (
        owner !== player.smallID() &&
        game.isLand(neighbor) &&
        !game.isImpassable(neighbor)
      )
        out.set(owner, (out.get(owner) ?? 0) + 1);
    });
  return [...out];
}
it("matches exact contact counts AND iteration order through captures, losses and terrain changes", async () => {
  const game = await setup("big_plains", {}, [
    playerInfo("a", PlayerType.Human),
    playerInfo("b", PlayerType.Human),
    playerInfo("c", PlayerType.Human),
  ]);
  const players = [game.player("a"), game.player("b"), game.player("c")];
  const index = new PressureContactIndex(game);
  for (let i = 0; i < 400; i++) {
    const tile = game.ref((i * 13) % 24, (Math.floor(i / 24) * 7) % 24);
    if (game.isLand(tile) && !game.isImpassable(tile)) {
      const p = players[i % 3];
      if (game.ownerID(tile) !== p.smallID()) p.conquer(tile);
      if (i % 11 === 0 && game.hasOwner(tile)) p.relinquish(tile);
      if (i % 31 === 0) {
        if (game.hasOwner(tile)) p.relinquish(tile);
        game.setWater(tile);
      }
    }
    if (i % 7 === 0)
      for (const p of players)
        expect([...index.get(p)]).toEqual(reference(game, p));
  }
  for (const p of players)
    expect([...index.get(p)]).toEqual(reference(game, p));
  const updates = index.metrics.updatedTiles;
  for (const p of players) index.get(p);
  expect(index.metrics.updatedTiles).toBe(updates);
});

it("seeds after ownership exists and only recomputes local contributions", async () => {
  const game = await setup("big_plains", {}, [
    playerInfo("a", PlayerType.Human),
  ]);
  const a = game.player("a");
  for (let x = 0; x < 24; x++) a.conquer(game.ref(x, 10));
  const index = new PressureContactIndex(game);
  expect([...index.get(a)]).toEqual(reference(game, a));
  const before = index.metrics.updatedTiles;
  a.conquer(game.ref(12, 11));
  expect([...index.get(a)]).toEqual(reference(game, a));
  expect(index.metrics.updatedTiles - before).toBeLessThanOrEqual(5);
});
