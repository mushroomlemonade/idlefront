import fs from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import path from "node:path";
import { GameMapType, UnitType, type Game } from "../../core/game/Game";
import { GameMapImpl, type GameMap } from "../../core/game/GameMap";
import type { GameMapLoader, MapData } from "../../core/game/GameMapLoader";
import { PagedGameMap } from "../../core/game/PagedGameMap";
import { PathFinding } from "../../core/pathfinding/PathFinder";

export class NodeGameMapLoader implements GameMapLoader {
  prepareSimulationGame(game: Game): void {
    if (!game.config().isUnitDisabled(UnitType.Factory)) PathFinding.Rail(game);
  }
  constructor(
    private mapsDir: string,
    private storage = process.env.IDLE_SIMULATION_STORAGE ?? "auto",
  ) {}
  prepareSimulationMap(map: GameMap): GameMap {
    if (this.storage === "paged") return map;
    if (this.storage !== "auto" && this.storage !== "linear") return map;
    // Reserve headroom for the rest of the engine and concurrent games. The
    // explicit linear mode still obeys the fixed contiguous-allocation cap.
    const constrained = process.constrainedMemory();
    const total =
      constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
    const available = Math.min(freemem(), process.availableMemory());
    const budget =
      this.storage === "linear"
        ? 768 * 1024 * 1024
        : Math.min(
            768 * 1024 * 1024,
            total / 8,
            Math.max(0, available - 1024 * 1024 * 1024),
          );
    const prepared = linearSimulationMap(map, budget);
    console.info(
      `[SimulationMap] ${prepared.isPaged() ? "paged" : "linear"} ${prepared.width()}x${prepared.height()}`,
    );
    return prepared;
  }
  getMapData(map: GameMapType): MapData {
    const key = Object.keys(GameMapType).find(
      (k) => GameMapType[k as keyof typeof GameMapType] === map,
    );
    if (!key) throw new Error(`Unknown map: ${map}`);
    const dir = path.resolve(this.mapsDir, key.toLowerCase());
    const read = async (name: string) => {
      const file = path.resolve(dir, name);
      if (!file.startsWith(dir + path.sep))
        throw new Error("Map path escaped asset directory");
      return new Uint8Array(await fs.readFile(file));
    };
    return {
      mapBin: () => read("map.bin"),
      map4xBin: () => read("map4x.bin"),
      map16xBin: () => read("map16x.bin"),
      mapPageBin: read,
      manifest: async () =>
        JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")),
      webpPath: path.join(dir, "thumbnail.webp"),
      layerPng: async () => {
        throw new Error("Simulation does not load visual layers");
      },
    };
  }
}

/** CPU-only row-major layout. Rendering clients retain their paged textures.
 * The cap includes full terrain + ownership buffers; larger worlds continue
 * using paged storage instead of risking an unbounded contiguous allocation.
 * Never convert a live map: ownership, fallout and observers must not be lost. */
export function linearSimulationMap(
  map: GameMap,
  maxBytes = 768 * 1024 * 1024,
): GameMap {
  const tiles = map.width() * map.height();
  if (
    !(map instanceof PagedGameMap) ||
    tiles * 3 > maxBytes ||
    map.hasAllocatedState()
  )
    return map;
  const pages = map.tilePages();
  const terrain = new Uint8Array(tiles);
  for (const page of pages) {
    for (let y = 0; y < page.height; y++) {
      terrain.set(
        page.terrain.subarray(y * page.width, (y + 1) * page.width),
        (page.originY + y) * map.width() + page.originX,
      );
    }
  }
  return new GameMapImpl(
    map.width(),
    map.height(),
    terrain,
    map.numLandTiles(),
  );
}
