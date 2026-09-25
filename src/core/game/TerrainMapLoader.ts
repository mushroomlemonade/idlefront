import { GameMapSize, GameMapType, TeamGameSpawnAreas } from "./Game";
import { GameMap, GameMapImpl } from "./GameMap";
import { GameMapLoader } from "./GameMapLoader";
import { PagedGameMap, TerrainPageInput } from "./PagedGameMap";

export type TerrainMapData = {
  nations: Nation[];
  additionalNations: AdditionalNation[];
  gameMap: GameMap;
  miniGameMap: GameMap;
  teamGameSpawnAreas?: TeamGameSpawnAreas;
  /** Map layers from the manifest, if any. */
  layers?: MapLayer[];
  /** Pre-loaded layer PNG images keyed by layer id. */
  layerImages?: Map<string, ImageBitmap>;
};

export interface MapMetadata {
  width: number;
  height: number;
  num_land_tiles: number;
}

export interface MapPageMetadata {
  x: number;
  y: number;
  width: number;
  height: number;
  path: string;
  byte_length: number;
  sha256: string;
}

/**
 * Versioned map storage descriptor. `width` and `height` remain world
 * dimensions; `page_size` is a storage choice and never a gameplay constant.
 */
export interface PagedMapMetadata extends MapMetadata {
  format: "paged-v1";
  page_size: number;
  pages_wide: number;
  pages_high: number;
  pages: MapPageMetadata[];
}

export function isPagedMapMetadata(
  metadata: MapMetadata,
): metadata is PagedMapMetadata {
  return (metadata as Partial<PagedMapMetadata>).format === "paged-v1";
}

export interface MapManifest {
  name: string;
  map: MapMetadata;
  map4x: MapMetadata;
  map16x: MapMetadata;
  nations: Nation[];
  // Optional pool of fallback nation names used when a game requests more
  // nations than the manifest defines. Picked at random; if still not enough,
  // the remainder is generated procedurally.
  additionalNations?: AdditionalNation[];
  teamGameSpawnAreas?: TeamGameSpawnAreas;
  /** Optional map layers rendered between terrain and territory. */
  layers?: MapLayer[];
}

export type LayerPlacement = "land" | "water";

export interface MapLayer {
  /** Unique identifier — also the PNG filename (without extension). */
  id: string;
  /** Whether the layer sits on land or water tiles. */
  placement: LayerPlacement;
  /** If true, the layer is permanently destroyed in nuke impact radii. */
  nukeable?: boolean;
}

export interface Nation {
  coordinates?: [number, number];
  flag?: string;
  name: string;
}

export interface AdditionalNation {
  coordinates?: [number, number];
  flag?: string;
  name: string;
}

export async function loadTerrainMap(
  map: GameMapType,
  mapSize: GameMapSize,
  terrainMapFileLoader: GameMapLoader,
  /** Whether to load layer PNG images inline. The Web Worker path should
   *  pass false — it never renders layers and should not retain ImageBitmaps. */
  loadImages: boolean = true,
  /**
   * Whether to load the coarse simulation map. Rendering clients never read
   * it: only GameRunner uses it for simulation searches. Skipping it on the
   * browser's view copy saves 96 MB on Expanded Earth Ultra while the server
   * (and legacy local worker) retain the exact same simulation data.
   */
  loadSimulationMiniMap: boolean = true,
): Promise<TerrainMapData> {
  // GameMap contains mutable ownership/fallout state. Reusing it across games
  // also reused the previous world's territory (and made parallel views alias
  // one another). Browser asset caching still reuses downloaded terrain bytes;
  // each simulation/render view must own a fresh map state.
  const mapFiles = terrainMapFileLoader.getMapData(map);
  const manifest = await mapFiles.manifest();

  const gameMap =
    mapSize === GameMapSize.Normal && isPagedMapMetadata(manifest.map)
      ? await genTerrainFromPages(
          manifest.map,
          await Promise.all(
            manifest.map.pages.map(async (page) => ({
              ...page,
              terrain: await mapFiles.mapPageBin(page.path),
            })),
          ),
        )
      : mapSize === GameMapSize.Normal
        ? await genTerrainFromBin(manifest.map, await mapFiles.mapBin())
        : await genTerrainFromBin(manifest.map4x, await mapFiles.map4xBin());

  const miniMap = loadSimulationMiniMap
    ? mapSize === GameMapSize.Normal
      ? await genTerrainFromBin(manifest.map4x, await mapFiles.map4xBin())
      : await genTerrainFromBin(manifest.map16x, await mapFiles.map16xBin())
    : new GameMapImpl(1, 1, new Uint8Array(1), 0);

  if (mapSize === GameMapSize.Compact) {
    manifest.nations.forEach((nation) => {
      if (nation.coordinates !== undefined) {
        nation.coordinates = [
          Math.floor(nation.coordinates[0] / 2),
          Math.floor(nation.coordinates[1] / 2),
        ];
      }
    });
    manifest.additionalNations?.forEach((nation) => {
      if (nation.coordinates !== undefined) {
        nation.coordinates = [
          Math.floor(nation.coordinates[0] / 2),
          Math.floor(nation.coordinates[1] / 2),
        ];
      }
    });
  }

  // Scale spawn areas for compact maps
  let teamGameSpawnAreas = manifest.teamGameSpawnAreas;
  if (mapSize === GameMapSize.Compact && teamGameSpawnAreas) {
    const scaled: TeamGameSpawnAreas = {};
    for (const [key, areas] of Object.entries(teamGameSpawnAreas)) {
      scaled[key] = areas.map((a) => ({
        x: Math.floor(a.x / 2),
        y: Math.floor(a.y / 2),
        width: Math.max(1, Math.floor(a.width / 2)),
        height: Math.max(1, Math.floor(a.height / 2)),
      }));
    }
    teamGameSpawnAreas = scaled;
  }

  const layers = manifest.layers;

  // Validate layer placements at game start.
  if (layers) {
    for (const layer of layers) {
      if (layer.placement !== "land" && layer.placement !== "water") {
        throw new Error(
          `Map ${map}: layer "${layer.id}" has invalid placement "${layer.placement}" (must be "land" or "water")`,
        );
      }
    }
  }

  // Load layer PNG images if requested and the manifest defines layers.
  // For Compact maps, downsample to map4x dimensions to match the game map.
  // When loadImages=false (e.g. Web Worker), skip image loading — the caller
  // can use loadLayerImages() separately.
  let layerImages: Map<string, ImageBitmap> | undefined;
  if (loadImages && layers && layers.length > 0) {
    layerImages = new Map();
    const compactW =
      mapSize === GameMapSize.Compact ? manifest.map4x.width : undefined;
    const compactH =
      mapSize === GameMapSize.Compact ? manifest.map4x.height : undefined;
    await Promise.all(
      layers.map(async (layer) => {
        try {
          let img = await mapFiles.layerPng(layer.id);
          if (compactW !== undefined && compactH !== undefined) {
            img = await createImageBitmap(img, {
              resizeWidth: compactW,
              resizeHeight: compactH,
              resizeQuality: "high",
            });
          }
          layerImages!.set(layer.id, img);
        } catch (e) {
          console.warn(
            `[MapLoader] Failed to load layer "${layer.id}" for map ${map}: ${e}`,
          );
        }
      }),
    );
  }

  const result = {
    nations: manifest.nations,
    additionalNations: manifest.additionalNations ?? [],
    gameMap: gameMap,
    miniGameMap: miniMap,
    teamGameSpawnAreas,
    layers,
    layerImages,
  };
  return result;
}

/**
 * Load layer PNG images for a map that already has layer definitions.
 * Call this off the critical path (after the game has started) and pass
 * the result to `Renderer.setMapLayers()`.
 */
export async function loadLayerImages(
  map: GameMapType,
  mapSize: GameMapSize,
  terrainMapFileLoader: GameMapLoader,
  layers: MapLayer[],
): Promise<Map<string, ImageBitmap>> {
  const mapFiles = terrainMapFileLoader.getMapData(map);
  const manifest = await mapFiles.manifest();
  const images = new Map<string, ImageBitmap>();
  const compactW =
    mapSize === GameMapSize.Compact ? manifest.map4x.width : undefined;
  const compactH =
    mapSize === GameMapSize.Compact ? manifest.map4x.height : undefined;
  await Promise.all(
    layers.map(async (layer) => {
      try {
        let img = await mapFiles.layerPng(layer.id);
        if (compactW !== undefined && compactH !== undefined) {
          img = await createImageBitmap(img, {
            resizeWidth: compactW,
            resizeHeight: compactH,
            resizeQuality: "high",
          });
        }
        images.set(layer.id, img);
      } catch (e) {
        console.warn(
          `[MapLoader] Failed to load layer "${layer.id}" for map ${map}: ${e}`,
        );
      }
    }),
  );
  return images;
}

export async function genTerrainFromBin(
  mapData: MapMetadata,
  data: Uint8Array,
): Promise<GameMap> {
  if (data.length !== mapData.width * mapData.height) {
    throw new Error(
      `Invalid data: buffer size ${data.length} incorrect for ${mapData.width}x${mapData.height} terrain plus 4 bytes for dimensions.`,
    );
  }

  return new GameMapImpl(
    mapData.width,
    mapData.height,
    data,
    mapData.num_land_tiles,
  );
}

export async function genTerrainFromPages(
  metadata: PagedMapMetadata,
  pages: readonly (MapPageMetadata & { terrain: Uint8Array })[],
): Promise<GameMap> {
  if (metadata.pages_wide !== Math.ceil(metadata.width / metadata.page_size)) {
    throw new Error("Paged map pages_wide does not match its dimensions");
  }
  if (metadata.pages_high !== Math.ceil(metadata.height / metadata.page_size)) {
    throw new Error("Paged map pages_high does not match its dimensions");
  }

  const terrainPages: TerrainPageInput[] = pages.map((page) => {
    if (page.terrain.length !== page.byte_length) {
      throw new Error(
        `Page ${page.path} length ${page.terrain.length} does not match manifest length ${page.byte_length}`,
      );
    }
    return {
      pageX: page.x,
      pageY: page.y,
      width: page.width,
      height: page.height,
      terrain: page.terrain,
    };
  });

  return new PagedGameMap(
    metadata.width,
    metadata.height,
    metadata.page_size,
    terrainPages,
    metadata.num_land_tiles,
  );
}
