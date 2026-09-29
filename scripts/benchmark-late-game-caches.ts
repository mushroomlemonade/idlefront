import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PlayerType, UnitType } from "../src/core/game/Game";
import { tradePortCandidates } from "../src/core/game/PortTradeIndex";
import { playerInfo, setup } from "../tests/util/Setup";
const game = await setup(
  "big_plains",
  {},
  Array.from({ length: 3000 }, (_, i) => playerInfo(`p${i}`, PlayerType.Bot)),
  fileURLToPath(new URL("../tests/util/", import.meta.url)),
);
const players = game.allPlayers();
for (let i = 0; i < players.length; i++)
  players[i].conquer(game.ref(i % 200, Math.floor(i / 200)));
const p = players[0];
for (let i = 0; i < 1000; i++)
  p.buildUnit(UnitType.City, game.ref(i % 200, 30 + Math.floor(i / 200)), {});
for (let i = 1; i <= 10; i++)
  for (let j = 0; j < 50; j++)
    players[i].buildUnit(UnitType.Port, game.ref(j, 50 + i), {});
const cities = p.units(UnitType.City);
const measure = (work: () => number) => {
  let checksum = 0;
  const start = performance.now();
  for (let i = 0; i < 1000; i++) checksum += work();
  return { ms: performance.now() - start, checksum };
};
const oldCount = () => {
  let n = 0;
  for (const u of cities) n += u.isUnderConstruction() ? 1 : u.level();
  return n;
};
const oldPorts = () =>
  game
    .players()
    .filter((other) => other !== p && other.canTrade(p))
    .flatMap((other) => other.units(UnitType.Port)).length;
const newPorts = () => tradePortCandidates(game, p).length;
// Warm both paths; fixed fixture and equal checksums, not a whole-game TPS claim.
measure(oldCount);
measure(() => p.unitsOwned(UnitType.City));
measure(oldPorts);
measure(newPorts);
console.log(
  JSON.stringify(
    {
      fixture: { owners: 3000, cities: 1000, ports: 500, queries: 1000 },
      counts: {
        old: measure(oldCount),
        cached: measure(() => p.unitsOwned(UnitType.City)),
      },
      portCandidates: { old: measure(oldPorts), indexed: measure(newPorts) },
    },
    null,
    2,
  ),
);
