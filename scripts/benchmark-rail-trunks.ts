import { GameMapImpl } from "../src/core/game/GameMap";
import { RailSpatialGrid } from "../src/core/game/RailroadSpatialGrid";
import { AStar } from "../src/core/pathfinding/algorithms/AStar";
import { RailAdapter } from "../src/core/pathfinding/algorithms/AStar.Rail";
import { railTrunkConnection } from "../src/core/pathfinding/RailTrunkConnector";
import { tradeCorridorsForPreset } from "../src/core/TradeCorridors";
const width = 1024,
  height = 256,
  map = new GameMapImpl(
    width,
    height,
    new Uint8Array(width * height).fill(128),
    width * height,
  );
const rail: any = {
  tiles: Array.from({ length: 961 }, (_, i) => 128 * width + 32 + i),
  trips: 100,
  lastTripTick: 100,
  from: { isActive: () => true, getRailroadTo: () => rail },
  to: { isActive: () => true },
};
const game: any = {
  ticks: () => 100,
  config: () => ({
    gameConfig: () => ({ tradeCorridors: tradeCorridorsForPreset("longplay") }),
  }),
  manhattanDist: (a: number, b: number) =>
    Math.abs((a % width) - (b % width)) +
    Math.abs(Math.floor(a / width) - Math.floor(b / width)),
};
function run(reuse: boolean) {
  let expansions = 0,
    queries = 0,
    totalLength = 0;
  const adapter = new RailAdapter(map),
    neighbors = adapter.neighbors.bind(adapter);
  adapter.neighbors = (n, b) => {
    expansions++;
    return neighbors(n, b);
  };
  const nativeSearch = new AStar({ adapter });
  const grid = new RailSpatialGrid(map, 4);
  grid.register(rail);
  const native: any = {
    findTilePath: (a: number, b: number) => {
      queries++;
      return nativeSearch.findPath(a, b) ?? [];
    },
  };
  const samples: number[] = [];
  for (let i = 0; i < 500; i++) {
    const from = (129 + (i % 8)) * width + 40 + (i % 6),
      to = (127 - (i % 8)) * width + 976 - (i % 6);
    const start = performance.now();
    const path =
      (reuse
        ? railTrunkConnection(game, native, from, to, grid.query(from, 24, 32))
        : null) ?? native.findTilePath(from, to);
    samples.push(performance.now() - start);
    if (path[0] !== from || path[path.length - 1] !== to)
      throw Error("bad endpoints");
    if (
      path.some(
        (p: number, j: number) =>
          j > 0 && game.manhattanDist(p, path[j - 1]) !== 1,
      )
    )
      throw Error("discontinuous route");
    totalLength += path.length - 1;
  }
  samples.sort((a, b) => a - b);
  return {
    queries,
    expansions,
    totalLength,
    totalMs: samples.reduce((a, b) => a + b, 0),
    p95Ms: samples[475],
    p99Ms: samples[495],
  };
}
// Warm both mechanisms before recording; same queries and native algorithm.
run(false);
run(true);
console.log(
  JSON.stringify({
    fixture:
      "1024x256 synthetic land grid, one 961-tile busy trunk, 500 new rail connections; not full-game TPS",
    native: run(false),
    corridor: run(true),
  }),
);
