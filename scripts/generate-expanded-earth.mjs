import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function integerArg(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const largeVariant = process.argv.includes("--variant=large");
const ultraVariant = process.argv.includes("--variant=ultra");
const uhd27Variant = process.argv.includes("--variant=uhd27");
const pixelTerrain = process.argv.includes("--pixel-terrain");
if (pixelTerrain && !uhd27Variant) throw new Error("Pixel Earth v1 requires the 27x variant");
if ([largeVariant, ultraVariant, uhd27Variant].filter(Boolean).length > 1)
  throw new Error("Choose only one versioned expanded-Earth variant");
const scale = uhd27Variant ? Math.sqrt(27) : integerArg("scale", ultraVariant ? 4 : largeVariant ? 3 : 2);
if (largeVariant && scale !== 3)
  throw new Error("The versioned large variant must remain scale=3");
if (ultraVariant && scale !== 4)
  throw new Error("The versioned ultra variant must remain scale=4");
const pageSize = integerArg("page-size", 1024);
const sourceName = "giantworldmap";
const terrainArg = process.argv
  .find((arg) => arg.startsWith("--terrain-bin="))
  ?.slice(14);
const baseMapId = ultraVariant
  ? "ExpandedGiantWorldUltra"
  : largeVariant
    ? "ExpandedGiantWorldLarge"
    : "ExpandedGiantWorld";
const baseMapName = ultraVariant
  ? "Expanded Earth Ultra"
  : largeVariant
    ? "Expanded Earth XL"
    : "Expanded Earth";
const mapId = pixelTerrain ? "PixelEarth27v1" : uhd27Variant ? "ExpandedGiantWorldUHD27v1" : terrainArg ? `${baseMapId}HDv1` : baseMapId;
const mapName = pixelTerrain ? "Pixel Earth 27x v1" : uhd27Variant ? "UHD Earth 27x v1" : terrainArg ? `${baseMapName} HD v1` : baseMapName;
const outputName = mapId.toLowerCase();
const sourceDir = join(repo, "resources", "maps", sourceName);
// Experimental assets must never replace maps used by running games.
const outputArg = process.argv
  .find((arg) => arg.startsWith("--output-root="))
  ?.slice(14);
const outputRoot = outputArg
  ? resolve(repo, outputArg)
  : join(repo, "resources", "maps");
if (terrainArg && !outputArg)
  throw new Error("HD terrain requires an isolated --output-root");
if (uhd27Variant && (!terrainArg || !outputArg))
  throw new Error("UHD 27x requires imported terrain and an isolated output root");
const relativeOutput = relative(repo, outputRoot);
if (
  !relativeOutput ||
  isAbsolute(relativeOutput) ||
  relativeOutput.startsWith(`..${sep}`) ||
  relativeOutput === ".."
) {
  throw new Error("Output root must be a directory inside this repository");
}
if (scale !== 2 && !largeVariant && !ultraVariant && !outputArg)
  throw new Error("Non-default scales require an isolated --output-root");
const outputDir = join(outputRoot, outputName);
if (outputArg && existsSync(outputDir))
  throw new Error(
    "Experimental output already exists; choose a fresh output root",
  );
const pagesDir = join(outputDir, "pages");
const englishPath = join(repo, "resources", "lang", "en.json");
const sourceGeneratorDir = join(
  repo,
  "map-generator",
  "assets",
  "maps",
  sourceName,
);
const outputGeneratorDir = join(
  repo,
  "map-generator",
  "assets",
  "maps",
  outputName,
);

const sourceManifest = JSON.parse(
  readFileSync(join(sourceDir, "manifest.json"), "utf8"),
);
const source = readFileSync(join(sourceDir, "map.bin"));
const sourceWidth = sourceManifest.map.width;
const sourceHeight = sourceManifest.map.height;
if (source.length !== sourceWidth * sourceHeight) {
  throw new Error("Giant Earth map.bin does not match its manifest dimensions");
}

const width = uhd27Variant ? Math.round(sourceWidth * scale / 4) * 4 : sourceWidth * scale;
const height = uhd27Variant ? Math.round(sourceHeight * scale / 4) * 4 : sourceHeight * scale;
if (!Number.isSafeInteger(width * height) || width * height > 0x7fffffff) {
  throw new Error(
    "Scaled map exceeds the engine's signed 32-bit tile address space",
  );
}
const pagesWide = Math.ceil(width / pageSize);
const pagesHigh = Math.ceil(height / pageSize);

mkdirSync(pagesDir, { recursive: true });

/**
 * XL used nearest-neighbour tile replication. Ultra instead builds the
 * land/water decision at final resolution using a continuous four-sample
 * field, then preserves narrow one-source-tile waterways as a controlled
 * two-tile channel. This removes blocky 4x4 coasts and over-wide rivers while
 * keeping the upstream terrain semantics and projection.
 */
function generateFullResolutionTerrain() {
  const output = Buffer.allocUnsafe(width * height);
  const x0 = new Uint32Array(width);
  const x1 = new Uint32Array(width);
  const xf = new Float32Array(width);
  const nearestX = new Uint32Array(width);
  const localX = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const continuous = (x + 0.5) / scale - 0.5;
    const left = Math.max(0, Math.min(sourceWidth - 1, Math.floor(continuous)));
    x0[x] = left;
    x1[x] = Math.min(sourceWidth - 1, left + 1);
    xf[x] = Math.max(0, Math.min(1, continuous - Math.floor(continuous)));
    nearestX[x] = Math.min(sourceWidth - 1, Math.floor((x + 0.5) / scale));
    localX[x] = ((x + 0.5) % scale) / scale;
  }
  const isLand = (value) => (value & 128) !== 0;
  let landTiles = 0;
  for (let y = 0; y < height; y++) {
    const continuousY = (y + 0.5) / scale - 0.5;
    const top = Math.max(
      0,
      Math.min(sourceHeight - 1, Math.floor(continuousY)),
    );
    const bottom = Math.min(sourceHeight - 1, top + 1);
    const fy = Math.max(0, Math.min(1, continuousY - Math.floor(continuousY)));
    const nearestY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) / scale));
    const sourceRow = nearestY * sourceWidth;
    const localY = ((y + 0.5) % scale) / scale;
    const outputRow = y * width;
    for (let x = 0; x < width; x++) {
      const a = isLand(source[top * sourceWidth + x0[x]]) ? 1 : 0;
      const b = isLand(source[top * sourceWidth + x1[x]]) ? 1 : 0;
      const c = isLand(source[bottom * sourceWidth + x0[x]]) ? 1 : 0;
      const d = isLand(source[bottom * sourceWidth + x1[x]]) ? 1 : 0;
      const upper = a + (b - a) * xf[x];
      const lower = c + (d - c) * xf[x];
      let land = upper + (lower - upper) * fy >= 0.5;
      const sourceIndex = sourceRow + nearestX[x];
      const center = source[sourceIndex];

      // A one-pixel river in the source must remain navigable, but it should
      // not become a four-pixel slab. Detect land banks across the source tile
      // and retain a two-pixel-wide centre channel at 4x.
      if (!isLand(center)) {
        const sx = nearestX[x];
        const sy = nearestY;
        const landLeft = sx > 0 && isLand(source[sourceIndex - 1]);
        const landRight =
          sx + 1 < sourceWidth && isLand(source[sourceIndex + 1]);
        const landUp = sy > 0 && isLand(source[sourceIndex - sourceWidth]);
        const landDown =
          sy + 1 < sourceHeight && isLand(source[sourceIndex + sourceWidth]);
        if (landLeft && landRight) land = Math.abs(localX[x] - 0.5) > 0.26;
        if (landUp && landDown) land = Math.abs(localY - 0.5) > 0.26;
      }

      let value;
      if (land) {
        const magnitude = center & 31;
        value = 128 | magnitude;
      } else {
        value = center & 63;
      }
      output[outputRow + x] = value;
      if (land && (value & 31) !== 31) landTiles++;
    }
  }

  // Recompute shorelines from the final-resolution topology. Boat placement,
  // ports and pathfinding now see the same exact coast that players see.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const index = row + x;
      const land = isLand(output[index]);
      const touchesOther =
        (x > 0 && isLand(output[index - 1]) !== land) ||
        (x + 1 < width && isLand(output[index + 1]) !== land) ||
        (y > 0 && isLand(output[index - width]) !== land) ||
        (y + 1 < height && isLand(output[index + width]) !== land);
      if (touchesOther) output[index] |= 64;
    }
  }
  return { output, landTiles };
}

const importedTerrain = terrainArg
  ? readFileSync(resolve(repo, terrainArg))
  : null;
if (importedTerrain && importedTerrain.length !== width * height)
  throw new Error("Imported terrain dimensions do not match target variant");
const fullResolution = importedTerrain
  ? {
      output: importedTerrain,
      landTiles: importedTerrain.reduce(
        (n, b) => n + (b & 128 && (b & 31) !== 31 ? 1 : 0),
        0,
      ),
    }
  : ultraVariant
    ? generateFullResolutionTerrain()
    : null;

const pages = [];
for (let pageY = 0; pageY < pagesHigh; pageY++) {
  for (let pageX = 0; pageX < pagesWide; pageX++) {
    const pageWidth = Math.min(pageSize, width - pageX * pageSize);
    const pageHeight = Math.min(pageSize, height - pageY * pageSize);
    const page = Buffer.allocUnsafe(pageWidth * pageHeight);
    const originX = pageX * pageSize;
    const originY = pageY * pageSize;

    for (let localY = 0; localY < pageHeight; localY++) {
      const worldY = originY + localY;
      const outputRow = localY * pageWidth;
      if (fullResolution) {
        const sourceOffset = worldY * width + originX;
        page.set(
          fullResolution.output.subarray(
            sourceOffset,
            sourceOffset + pageWidth,
          ),
          outputRow,
        );
      } else {
        const sourceY = Math.floor(worldY / scale);
        const sourceRow = sourceY * sourceWidth;
        for (let localX = 0; localX < pageWidth; localX++) {
          const sourceX = Math.floor((originX + localX) / scale);
          page[outputRow + localX] = source[sourceRow + sourceX];
        }
      }
    }

    const fileName = `${pageX}-${pageY}.bin`;
    writeFileSync(join(pagesDir, fileName), page);
    pages.push({
      x: pageX,
      y: pageY,
      width: pageWidth,
      height: pageHeight,
      path: `pages/${fileName}`,
      byte_length: page.length,
      sha256: createHash("sha256").update(page).digest("hex"),
    });
  }
}

function scaleCoordinates(entries = []) {
  return entries.map((entry) => ({
    ...entry,
    coordinates: entry.coordinates?.map((coordinate, axis) => Math.round(coordinate * (axis === 0 ? width / sourceWidth : height / sourceHeight))),
  }));
}

function scaleSpawnAreas(groups) {
  if (!groups) return undefined;
  return Object.fromEntries(
    Object.entries(groups).map(([key, areas]) => [
      key,
      areas.map((area) => ({
        x: area.x * scale,
        y: area.y * scale,
        width: area.width * scale,
        height: area.height * scale,
      })),
    ]),
  );
}

// Keep the half-resolution pathfinding grid at exactly half the new world
// dimensions. Copying Giant Earth's LOD only works for scale=2.
function halfMap(sample, fullWidth, fullHeight) {
  const halfWidth = Math.floor(fullWidth / 2);
  const halfHeight = Math.floor(fullHeight / 2);
  const data = Buffer.alloc(halfWidth * halfHeight);
  let land = 0;
  for (let y = 0; y < halfHeight; y++) {
    for (let x = 0; x < halfWidth; x++) {
      let selected = sample(x * 2, y * 2);
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 2; dy++) {
          const next = sample(x * 2 + dx, y * 2 + dy);
          // Same water > impassable > land priority as createMiniMap in Go.
          if (!(selected & 128)) continue;
          if (!(next & 128) || (selected & 31) !== 31) selected = next;
        }
      }
      data[y * halfWidth + x] = selected & ~64;
      if (selected & 128 && (selected & 31) !== 31) land++;
    }
  }
  for (let y = 0; y < halfHeight; y++) {
    for (let x = 0; x < halfWidth; x++) {
      const index = y * halfWidth + x;
      if ((data[index] & 159) === 159) continue;
      const neighbours = [
        x > 0 ? index - 1 : index,
        x + 1 < halfWidth ? index + 1 : index,
        y > 0 ? index - halfWidth : index,
        y + 1 < halfHeight ? index + halfWidth : index,
      ];
      if (neighbours.some((n) => (data[n] & 128) !== (data[index] & 128)))
        data[index] |= 64;
    }
  }
  return {
    data,
    metadata: { width: halfWidth, height: halfHeight, num_land_tiles: land },
  };
}
let lod4, lod16;
if (scale !== 2) {
  lod4 = halfMap(
    (x, y) =>
      fullResolution
        ? fullResolution.output[y * width + x]
        : source[Math.floor(y / scale) * sourceWidth + Math.floor(x / scale)],
    width,
    height,
  );
  lod16 = halfMap(
    (x, y) => lod4.data[y * lod4.metadata.width + x],
    lod4.metadata.width,
    lod4.metadata.height,
  );
}

const manifest = {
  ...sourceManifest,
  id: mapId,
  name: mapName,
  translation_key: `map.${outputName}`,
  multiplayer_frequency: 0,
  map: {
    format: "paged-v1",
    width,
    height,
    num_land_tiles:
      fullResolution?.landTiles ??
      sourceManifest.map.num_land_tiles * scale * scale,
    page_size: pageSize,
    pages_wide: pagesWide,
    pages_high: pagesHigh,
    pages,
  },
  // The normal renderer/pathfinder LOD is one half the linear world size.
  map4x: lod4?.metadata ?? sourceManifest.map,
  map16x: lod16?.metadata ?? sourceManifest.map4x,
  nations: scaleCoordinates(sourceManifest.nations),
  additionalNations: scaleCoordinates(sourceManifest.additionalNations),
  teamGameSpawnAreas: scaleSpawnAreas(sourceManifest.teamGameSpawnAreas),
};

if (terrainArg) {
  const metadata = JSON.parse(
    readFileSync(resolve(repo, `${terrainArg}.json`), "utf8"),
  );
  manifest.source = metadata;
  // The new source has more exact shorelines. Keep each original nation's
  // vicinity, snapping only water placements to the nearest land tile.
  for (const nation of [
    ...manifest.nations,
    ...(manifest.additionalNations ?? []),
  ]) {
    if (!nation.coordinates) continue;
    const [ox, oy] = nation.coordinates;
    let best = null,
      bestDistance = Infinity;
    const radius = Math.ceil(20 * scale);
    for (
      let y = Math.max(0, oy - radius);
      y <= Math.min(height - 1, oy + radius);
      y++
    ) {
      for (
        let x = Math.max(0, ox - radius);
        x <= Math.min(width - 1, ox + radius);
        x++
      ) {
        const value = importedTerrain[y * width + x];
        const distance = (x - ox) ** 2 + (y - oy) ** 2;
        if (value & 128 && (value & 31) !== 31 && distance < bestDistance) {
          best = [x, y];
          bestDistance = distance;
        }
      }
    }
    if (!best) throw new Error(`No land near nation ${nation.name}`);
    nation.coordinates = best;
  }
}

writeFileSync(
  join(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
// The Go asset pipeline emits this contiguous intermediate before our paged
// transform. Only that known generated file is obsolete; never wipe a tree.
const contiguousIntermediate = join(outputDir, "map.bin");
if (existsSync(contiguousIntermediate)) unlinkSync(contiguousIntermediate);
if (lod4 && lod16) {
  writeFileSync(join(outputDir, "map4x.bin"), lod4.data);
  writeFileSync(join(outputDir, "map16x.bin"), lod16.data);
} else {
  copyFileSync(join(sourceDir, "map.bin"), join(outputDir, "map4x.bin"));
  copyFileSync(join(sourceDir, "map4x.bin"), join(outputDir, "map16x.bin"));
}
copyFileSync(
  terrainArg
    ? resolve(repo, `${terrainArg}.webp`)
    : join(sourceDir, "thumbnail.webp"),
  join(outputDir, "thumbnail.webp"),
);
writeFileSync(
  join(outputDir, "NOTICE.md"),
  terrainArg
    ? readFileSync(resolve(repo, `${terrainArg}.NOTICE.md`), "utf8")
    : `# Expanded Earth asset notice

Expanded Earth is a modified, ${scale}-times linear enlargement of OpenFront's
\`giantworldmap\` terrain, thumbnail, nation coordinates, and spawn metadata.
The transformation is reproducible with
\`scripts/generate-expanded-earth.mjs\`; the generated manifest records a SHA-256
digest for every terrain page.

The source map and this adaptation are licensed under the repository's
\`LICENSE-ASSETS\` terms (Creative Commons Attribution-ShareAlike 4.0). Copyright
and contributor attribution remain with OpenFront and its contributors. This
modified map is distributed on the same CC BY-SA 4.0 terms.
`,
);

function updateGeneratorSource() {
  mkdirSync(outputGeneratorDir, { recursive: true });
  copyFileSync(
    join(sourceGeneratorDir, "image.png"),
    join(outputGeneratorDir, "image.png"),
  );
  writeFileSync(
    join(outputGeneratorDir, "info.json"),
    `${JSON.stringify(
      {
        id: mapId,
        name: mapName,
        translation_key: `map.${outputName}`,
        categories: ["world"],
        multiplayer_frequency: 0,
        nations: manifest.nations,
      },
      null,
      2,
    )}\n`,
  );
}

function updateEnglishName() {
  const english = JSON.parse(readFileSync(englishPath, "utf8"));
  english.map = Object.fromEntries(
    Object.entries({
      ...english.map,
      [outputName]: mapName,
    }).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(englishPath, `${JSON.stringify(english, null, 2)}\n`);
}

if (!outputArg) {
  updateGeneratorSource();
  updateEnglishName();
}

console.log(
  `Expanded Earth: ${width}x${height}, ${pagesWide}x${pagesHigh} pages, scale ${scale}x`,
);
