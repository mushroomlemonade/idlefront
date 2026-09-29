// Deterministic synthetic mechanism benchmark, NOT whole-world TPS evidence.
// Same map dimensions as the 9x fixture; no server or database interaction.
import { performance } from "node:perf_hooks";
import { type Unit, UnitType } from "../src/core/game/Game";
import { type GameMap } from "../src/core/game/GameMap";
import { UnitGrid } from "../src/core/game/UnitGrid";
import { ReferenceUnitGrid } from "../tests/util/ReferenceUnitGrid";
const width = 12324,
  height = 5844;
const map = {
  width: () => width,
  height: () => height,
  x: (t: number) => t % width,
  y: (t: number) => Math.floor(t / width),
} as GameMap;
const reference = new ReferenceUnitGrid(map),
  candidate = new UnitGrid(map);
let seed = 42;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
for (let id = 0; id < 50000; id++) {
  const tile = random() % (width * height),
    type =
      id < 12
        ? UnitType.AtomBomb
        : id % 2
          ? UnitType.Warship
          : UnitType.TradeShip;
  const unit = {
    tile: () => tile,
    lastTile: () => tile,
    type: () => type,
    isActive: () => true,
    isUnderConstruction: () => false,
    id: () => id,
  } as Unit;
  reference.addUnit(unit);
  candidate.addUnit(unit);
}
const points = Array.from({ length: 5000 }, () => random() % (width * height));
for (const [name, range, types] of [
  [
    "sparse missile targeting",
    2200,
    [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRVWarhead],
  ],
  [
    "local fleet targeting",
    150,
    [UnitType.Warship, UnitType.TradeShip, UnitType.TransportShip],
  ],
] as const) {
  const run = (grid: UnitGrid | ReferenceUnitGrid) => {
    const start = performance.now();
    let hash = 0,
      matches = 0;
    for (const tile of points) {
      const found = grid.nearbyUnits(tile, range, types);
      matches += found.length;
      for (const hit of found)
        hash = (Math.imul(hash, 31) + hit.unit.id()) >>> 0;
    }
    return { ms: performance.now() - start, hash, matches };
  };
  run(reference);
  run(candidate);
  const old: number[] = [],
    next: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = i % 2 ? run(candidate) : run(reference);
    const b = i % 2 ? run(reference) : run(candidate);
    if (a.hash !== b.hash || a.matches !== b.matches)
      throw new Error("Query ordering/result mismatch");
    old.push(i % 2 ? b.ms : a.ms);
    next.push(i % 2 ? a.ms : b.ms);
  }
  old.sort((a, b) => a - b);
  next.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      name,
      units: 50000,
      queries: points.length,
      width,
      height,
      baselineMedianMs: old[2],
      candidateMedianMs: next[2],
      improvementPercent: (1 - next[2] / old[2]) * 100,
    }),
  );
}
