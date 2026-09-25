import { SpawnTimer } from "../../src/client/hud/layers/SpawnTimer";
import type { GameView } from "../../src/client/view";
import { GameMode, GameType } from "../../src/core/game/Game";

describe("spawn timer visibility", () => {
  it("removes its casing after spawn and remains hidden after joining a running match", async () => {
    let spawning = true;
    const timer = new SpawnTimer();
    timer.game = {
      inSpawnPhase: () => spawning,
      ticks: () => 50,
      config: () => ({
        gameConfig: () => ({
          gameType: GameType.Public,
          gameMode: GameMode.FFA,
        }),
        numSpawnPhaseTurns: () => 300,
      }),
    } as unknown as GameView;
    document.body.append(timer);
    timer.init();
    await timer.updateComplete;
    expect(timer.style.display).toBe("block");
    spawning = false;
    timer.tick();
    await timer.updateComplete;
    expect(timer.style.display).toBe("none");
    expect(timer.children.length).toBe(0);
    timer.init();
    await timer.updateComplete;
    expect(timer.style.display).toBe("none");
    timer.remove();
  });
});
