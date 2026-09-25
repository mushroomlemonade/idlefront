import { NationExecution } from "../src/core/execution/NationExecution";
import { PlayerExecution } from "../src/core/execution/PlayerExecution";
import { Nation, PlayerType, UnitType } from "../src/core/game/Game";
import { playerInfo, setup } from "./util/Setup";

test("bounded seeded nation observer run develops without invalid resources", async () => {
  const infos = Array.from({ length: 6 }, (_, i) =>
    playerInfo(`observer-nation-${i}`, PlayerType.Nation),
  );
  const game = await setup(
    "big_plains",
    {
      continuousPressure: "v1",
      pressureGraceSeconds: 0,
      pressurePacing: {
        populationGrowthMultiplier: 1,
        populationDoublingSeconds: 60,
        mobilisationHalfLifeSeconds: 5,
      },
    },
    infos,
  );
  for (const [i, info] of infos.entries()) {
    const player = game.player(info.id);
    for (let x = 0; x < 12; x++)
      for (let y = 0; y < 12; y++)
        player.conquer(
          game.ref(15 + (i % 3) * 55 + x, 25 + Math.floor(i / 3) * 95 + y),
        );
    player.setTroops(20000);
    player.addGold(500000n);
    game.addExecution(new PlayerExecution(player));
    game.addExecution(
      new NationExecution(
        "nation-observer-fixed-seed",
        new Nation(undefined, info),
      ),
    );
  }
  const times: number[] = [];
  for (let i = 0; i < 6000; i++) {
    const start = performance.now();
    game.executeNextTick();
    times.push(performance.now() - start);
  }
  const players = game.players();
  for (const p of players) {
    expect(Number.isFinite(p.troops())).toBe(true);
    expect(p.troops()).toBeGreaterThanOrEqual(0);
    expect(p.gold()).toBeGreaterThanOrEqual(0n);
  }
  expect(
    players.reduce((sum, p) => sum + p.numTilesOwned(), 0),
  ).toBeGreaterThan(864);
  const structures = players.reduce(
    (sum, p) =>
      sum + p.unitCount(UnitType.City) + p.unitCount(UnitType.Factory),
    0,
  );
  expect(structures).toBeGreaterThan(0);
  times.sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      test: "small land-only observer",
      ticks: 6000,
      structures,
      alliances: players.reduce((sum, p) => sum + p.alliances().length, 0) / 2,
      p99ms: times[Math.floor(times.length * 0.99)],
      maxMs: times[times.length - 1],
    }) + "\n",
  );
}, 60000);
