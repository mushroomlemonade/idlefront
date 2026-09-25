import { GameMapType, type Game } from "./Game";
import type { GameMap } from "./GameMap";
import { MapManifest } from "./TerrainMapLoader";

export interface GameMapLoader {
  getMapData(map: GameMapType): MapData;
  /** Optional host-only storage policy. Called on a fresh simulation map,
   * never the browser's rendering map; must preserve every terrain byte. */
  prepareSimulationMap?(map: GameMap): GameMap;
  /** Optional host-only preparation before the first simulation tick. */
  prepareSimulationGame?(game: Game): void;
}

export interface MapData {
  mapBin: () => Promise<Uint8Array>;
  map4xBin: () => Promise<Uint8Array>;
  map16xBin: () => Promise<Uint8Array>;
  mapPageBin: (path: string) => Promise<Uint8Array>;
  manifest: () => Promise<MapManifest>;
  webpPath: string;
  /** Load a map layer PNG by layer id. Returns an ImageBitmap. */
  layerPng: (layerId: string) => Promise<ImageBitmap>;
}
