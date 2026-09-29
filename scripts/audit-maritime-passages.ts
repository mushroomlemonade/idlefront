// Read-only bounded connectivity audit of shipped HD terrain. No long detour
// around Africa/South America can count as canal connectivity.
import { Config } from "../src/core/configuration/Config";
import {
  Difficulty,
  GameMapSize,
  GameMode,
  GameType,
} from "../src/core/game/Game";
import { createGame } from "../src/core/game/GameImpl";
import { GameMapType } from "../src/core/game/Maps.gen";
import { loadTerrainMap } from "../src/core/game/TerrainMapLoader";
import { PathFinding } from "../src/core/pathfinding/PathFinder";
import type { GameConfig } from "../src/core/Schemas";
import { NodeGameMapLoader } from "../src/server/simulation/NodeGameMapLoader";
const data = await loadTerrainMap(
  GameMapType.ExpandedGiantWorldLargeHDv1,
  GameMapSize.Normal,
  new NodeGameMapLoader("resources/maps"),
  false,
  true,
);
const map = data.gameMap;
const config = new Config(
  {
    gameMap: GameMapType.ExpandedGiantWorldLargeHDv1,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Private,
    difficulty: Difficulty.Medium,
    bots: 0,
    nations: "default",
  } as GameConfig,
  null,
  false,
);
const game = createGame([], [], map, data.miniGameMap, config);
const project = (lon: number, lat: number) => [
  Math.round((((lon + 169) % 360) / 360) * ((map.width() * 4110) / 4108)),
  Math.round(((85 - lat) / 165) * map.height()),
];
function passage(name: string, from: number[], to: number[], bounds: number[]) {
  const [left, bottom, right, top] = bounds;
  const [minX, minY] = project(left, top),
    [maxX, maxY] = project(right, bottom);
  const near = (ll: number[]) => {
    const [x, y] = project(ll[0], ll[1]);
    for (let r = 0; r <= 8; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < minX || xx > maxX || yy < minY || yy > maxY) continue;
          const t = map.ref(xx, yy);
          if (map.isWater(t)) return t;
        }
    return null;
  };
  const start = near(from),
    end = near(to),
    width = maxX - minX + 1,
    height = maxY - minY + 1;
  if (start === null || end === null)
    return {
      name,
      status: "endpoint not resolved within 8 pixels",
      from,
      to,
      bounds,
    };
  const seen = new Uint8Array(width * height),
    queue = new Uint32Array(width * height);
  let head = 0,
    tail = 0;
  const mark = (tile: number) => {
    const x = tile % map.width(),
      y = Math.floor(tile / map.width());
    if (x < minX || x > maxX || y < minY || y > maxY) return;
    const i = (y - minY) * width + x - minX;
    if (seen[i] || !map.isWater(tile)) return;
    seen[i] = 1;
    queue[tail++] = tile;
  };
  mark(start);
  let connected = false;
  while (head < tail) {
    const t = queue[head++];
    if (t === end) {
      connected = true;
      break;
    }
    mark(t - 1);
    mark(t + 1);
    mark(t - map.width());
    mark(t + map.width());
  }
  const native = PathFinding.Water(game).findPath(start, end);
  return {
    name,
    connected,
    visited: head,
    nativeRouteTiles: native?.length ?? null,
    nativeStaysLocal:
      native?.every((t) => {
        const x = t % map.width(),
          y = Math.floor(t / map.width());
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
      }) ?? false,
    bounds,
    from,
    to,
    start,
    end,
    note: "approximate source-map registration; cardinal full-resolution water only, within local bounds",
  };
}
console.log(
  JSON.stringify(
    {
      map: GameMapType.ExpandedGiantWorldLargeHDv1,
      width: map.width(),
      height: map.height(),
      passages: [
        passage(
          "Panama",
          [-79.92, 9.36],
          [-79.55, 8.88],
          [-80.25, 8.5, -79.2, 9.65],
        ),
        passage(
          "Suez",
          [32.33, 31.3],
          [32.56, 29.85],
          [31.95, 29.6, 32.85, 31.6],
        ),
      ],
    },
    null,
    2,
  ),
);
