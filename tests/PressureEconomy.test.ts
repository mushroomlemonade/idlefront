import { NationStructureBehavior } from "../src/core/execution/nation/NationStructureBehavior";
import { Game, Player, PlayerType, UnitType } from "../src/core/game/Game";
import {
  pressurePopulation,
  setAiMobilisationTarget,
} from "../src/core/game/PressurePopulation";
import { PseudoRandom } from "../src/core/PseudoRandom";

test("pressure nations keep a modest reserve independent of their city count", () => {
  const game = {
    config: () => ({ gameConfig: () => ({ continuousPressure: "v1" }) }),
    unitInfo: () => ({ cost: () => 1000n }),
  } as unknown as Game;
  const player = { unitsOwned: () => 1000 } as unknown as Player;
  const behavior = new NationStructureBehavior(
    new PseudoRandom(1),
    game,
    player,
  );
  expect(behavior["getPerceivedCost"](UnitType.City)).toBe(1250n);
});

test("AI mobilisation changes the target without minting troops or touching humans", () => {
  const game = { ticks: () => 0 } as Game;
  for (const type of [PlayerType.Nation, PlayerType.Human]) {
    const player = { troops: () => 1000, type: () => type } as Player;
    const state = pressurePopulation(game, player);
    setAiMobilisationTarget(player, 0.75);
    expect(state.target).toBe(type === PlayerType.Human ? 0.5 : 0.75);
    expect(state.civilians).toBe(1000);
    expect(state.military).toBe(1000);
    expect(player.troops()).toBe(1000);
  }
});
