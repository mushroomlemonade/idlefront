import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PlayerType, UnitType } from "../src/core/game/Game";
import { PressureContactIndex } from "../src/core/game/PressureContactIndex";
import { playerInfo, setup } from "../tests/util/Setup";

// Small bounded fixtures only while live play continues. This is not a replay
// load test or a claim about total TPS. Reference preserves pre-change scans.
const game = await setup(
  "big_plains",
  { infiniteGold: true },
  Array.from({ length: 3000 }, (_, i) => playerInfo(`p${i}`, PlayerType.Bot)),
  fileURLToPath(new URL("../tests/util/", import.meta.url)),
);
const p = game.player("p0"),
  other = game.player("p1");
other.buildUnit(UnitType.City, game.ref(40, 40), {});
const players = game.allPlayers();
function units(indexed: boolean) {
  const start = performance.now();
  let count = 0;
  for (let i = 0; i < 1000; i++) {
    if (indexed) count += game.units(UnitType.City).length;
    else {
      const out: any[] = [];
      for (const owner of players)
        (owner as any).appendUnitsOfType(UnitType.City, out);
      count += out.length;
    }
  }
  return { ms: performance.now() - start, count };
}
for (let y = 0; y < 32; y++)
  for (let x = 0; x < 32; x++) if ((x + y) % 2 === 0) p.conquer(game.ref(x, y));
const index = new PressureContactIndex(game);
index.counts(p);
function contacts(indexed: boolean) {
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < 200; i++) {
    const tile = game.ref(34, 1);
    if (game.hasOwner(tile)) p.relinquish(tile);
    else p.conquer(tile);
    if (indexed)
      for (const value of index.counts(p).values()) checksum += value;
    else
      for (const tile of p.borderTiles())
        game.forEachNeighbor(tile, (n) => {
          if (
            game.ownerID(n) !== p.smallID() &&
            game.isLand(n) &&
            !game.isImpassable(n)
          )
            checksum++;
        });
  }
  return { ms: performance.now() - start, checksum };
}
units(false);
units(true);
contacts(false);
contacts(true);
console.log(
  JSON.stringify(
    {
      units: {
        fixture: "1000 typed queries across 3000 owners, one matching unit",
        before: units(false),
        after: units(true),
      },
      pressure: {
        fixture:
          "200 local changes and width queries over 512 scattered owned tiles; candidate observer active in both timings",
        before: contacts(false),
        after: contacts(true),
      },
      limitation: "microbenchmarks; not mature-world or end-to-end TPS",
    },
    null,
    2,
  ),
);
