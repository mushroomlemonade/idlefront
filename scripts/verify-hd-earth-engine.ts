import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Config } from "../src/core/configuration/Config";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../src/core/game/Game";
import { createGame } from "../src/core/game/GameImpl";
import {
  genTerrainFromBin,
  genTerrainFromPages,
  type PagedMapMetadata,
} from "../src/core/game/TerrainMapLoader";
import { PathFinding } from "../src/core/pathfinding/PathFinder";

async function main() {
  const root = path.resolve(process.argv[2]);
  fs.writeFileSync(
    path.join(root, "engine-waterway-validation.json"),
    JSON.stringify({
      releaseReady: false,
      status: "validation in progress or interrupted",
    }),
  );
  const report = [];
  for (const name of fs.readdirSync(path.join(root, "maps"))) {
    const dir = path.join(root, "maps", name);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
    );
    const metadata = manifest.map as PagedMapMetadata;
    const map = await genTerrainFromPages(
      metadata,
      metadata.pages.map((p) => ({
        ...p,
        terrain: new Uint8Array(fs.readFileSync(path.join(dir, p.path))),
      })),
    );
    const mini = await genTerrainFromBin(
      manifest.map4x,
      new Uint8Array(fs.readFileSync(path.join(dir, "map4x.bin"))),
    );
    const config = new Config(
      {
        gameMap: GameMapType.GiantWorldMap,
        gameMapSize: GameMapSize.Normal,
        gameType: GameType.Private,
        gameMode: GameMode.FFA,
        difficulty: Difficulty.Medium,
        nations: "default",
        bots: 0,
        donateGold: false,
        donateTroops: false,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
      },
      null,
      false,
    );
    const game = createGame([], [], map, mini, config);
    const scale = map.width() / 4108;
    function water(lon: number, lat: number) {
      const x = Math.round((((lon + 169) % 360) / 360) * 4110 * scale);
      const y = Math.round(((85 - lat) / 165) * 1948 * scale);
      let best = -1,
        dist = Infinity;
      const radius = Math.ceil(3 * scale);
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (
            x + dx < 0 ||
            y + dy < 0 ||
            x + dx >= map.width() ||
            y + dy >= map.height()
          )
            continue;
          const tile = map.ref(x + dx, y + dy),
            d = dx * dx + dy * dy;
          if (map.isWater(tile) && d < dist) {
            best = tile;
            dist = d;
          }
        }
      assert(best >= 0, `No water near ${lon},${lat}`);
      return best;
    }
    const routes = [
      ["Panama", -79.53, 8.9, -79.93, 9.4],
      ["Suez", 32.56, 29.88, 32.3, 31.3],
      ["Bosphorus", 28.98, 40.99, 29.17, 41.25],
      ["Dardanelles", 26.15, 40.0, 26.7, 40.4],
      ["Mississippi", -91.18, 30.46, -89.26, 29.12],
      ["Rhine", 6.76, 51.44, 4.12, 51.98],
      ["Amazon", -55.5, -1.95, -50.5, 0.5],
      ["St. Lawrence", -76.45, 44.2, -71.2, 46.8],
    ] as const;
    for (const [routeName, ax, ay, bx, by] of routes) {
      const start = water(ax, ay),
        end = water(bx, by);
      const started = performance.now();
      const route = PathFinding.Water(game).findPath(start, end);
      const durationMs = performance.now() - started;
      assert(
        route && route.length > 0,
        `${name}: ${routeName} has no engine boat route`,
      );
      const dryRoutePoints = route.filter((tile) => !map.isWater(tile)).length;
      assert.equal(route[0], start);
      assert.equal(route[route.length - 1], end);
      assert.equal(dryRoutePoints, 0, `${routeName}: route crosses dry land`);
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1],
          b = route[i];
        const dx = Math.abs(map.x(a) - map.x(b));
        const dy = Math.abs(map.y(a) - map.y(b));
        assert(dx <= 1 && dy <= 1, `${routeName}: non-adjacent route step`);
        if (dx && dy) {
          assert(map.isWater(map.ref(map.x(a), map.y(b))));
          assert(map.isWater(map.ref(map.x(b), map.y(a))));
        }
      }
      const length = route
        .slice(1)
        .reduce((sum, tile, i) => sum + map.manhattanDist(route[i], tile), 0);
      assert(
        length < map.manhattanDist(start, end) * 8 + 50,
        `${routeName}: ocean detour instead of passage`,
      );
      const entry = {
        map: name,
        route: routeName,
        points: route.length,
        length,
        dryRoutePoints,
        durationMs,
      };
      console.log(JSON.stringify(entry));
      report.push(entry);
    }
  }
  fs.writeFileSync(
    path.join(root, "engine-waterway-validation.json"),
    JSON.stringify(
      {
        releaseReady: report.every((r) => r.dryRoutePoints === 0),
        routes: report,
      },
      null,
      2,
    ) + "\n",
  );
  if (report.some((r) => r.dryRoutePoints > 0)) {
    console.error(
      "NOT RELEASE READY: MiniMapTransformer expands some route points onto dry banks. Terrain connectivity passes, but route refinement needs a separate fix.",
    );
    process.exitCode = 2;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
