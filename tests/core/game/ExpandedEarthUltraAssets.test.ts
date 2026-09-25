import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type {
  MapManifest,
  PagedMapMetadata,
} from "../../../src/core/game/TerrainMapLoader";

it("ships a separately versioned 128-million-tile full-resolution paged Earth", () => {
  const base = path.resolve("resources/maps");
  const original = JSON.parse(
    fs.readFileSync(path.join(base, "giantworldmap/manifest.json"), "utf8"),
  ) as MapManifest;
  const ultraDir = path.join(base, "expandedgiantworldultra");
  const ultra = JSON.parse(
    fs.readFileSync(path.join(ultraDir, "manifest.json"), "utf8"),
  ) as MapManifest;
  const metadata = ultra.map as PagedMapMetadata;

  expect((ultra as MapManifest & { id: string }).id).toBe(
    "ExpandedGiantWorldUltra",
  );
  expect(metadata.width).toBe(16_432);
  expect(metadata.height).toBe(7_792);
  expect(metadata.width * metadata.height).toBe(128_038_144);
  expect(metadata.format).toBe("paged-v1");
  expect(metadata.pages).toHaveLength(136);
  expect(ultra.map4x).toMatchObject({ width: 8216, height: 3896 });
  expect(ultra.map16x).toMatchObject({ width: 4108, height: 1948 });
  expect(ultra.nations[0].coordinates).toEqual(
    original.nations[0].coordinates?.map((coordinate) => coordinate * 4),
  );

  for (const page of metadata.pages) {
    const bytes = fs.readFileSync(path.join(ultraDir, page.path));
    expect(bytes).toHaveLength(page.width * page.height);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(page.sha256);
  }

  const firstPage = fs.readFileSync(
    path.join(ultraDir, metadata.pages[0].path),
  );
  let mixedBlocks = 0;
  const pageWidth = metadata.pages[0].width;
  const pageHeight = metadata.pages[0].height;
  for (let y = 0; y + 3 < pageHeight; y += 4) {
    for (let x = 0; x + 3 < pageWidth; x += 4) {
      const first = firstPage[y * pageWidth + x];
      block: for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          if (firstPage[(y + dy) * pageWidth + x + dx] !== first) {
            mixedBlocks++;
            break block;
          }
        }
      }
    }
  }
  expect(mixedBlocks).toBeGreaterThan(100);
});
