import { allowAmbientNationChat } from "../src/core/execution/nation/NationEmojiBehavior";
import type { Game } from "../src/core/game/Game";

test("ambient nation chat shares a 30-second recipient budget and isolates games", () => {
  let tick = 0;
  const game = { ticks: () => tick } as Game;
  expect(allowAmbientNationChat(game, "human")).toBe(true);
  expect(allowAmbientNationChat(game, "human")).toBe(false);
  tick = 299;
  expect(allowAmbientNationChat(game, "human")).toBe(false);
  tick = 300;
  expect(allowAmbientNationChat(game, "human")).toBe(true);
  expect(allowAmbientNationChat({ ticks: () => tick } as Game, "human")).toBe(
    true,
  );
});
