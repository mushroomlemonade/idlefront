import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type {
  MapManifest,
  PagedMapMetadata,
} from "../../../src/core/game/TerrainMapLoader";

it("versions the larger board separately, with correct page edges, hashes, LOD dimensions and nations", () => {
  const base = path.resolve("resources/maps");
  const original = JSON.parse(
    fs.readFileSync(path.join(base, "giantworldmap/manifest.json"), "utf8"),
  ) as MapManifest;
  const current = JSON.parse(
    fs.readFileSync(
      path.join(base, "expandedgiantworld/manifest.json"),
      "utf8",
    ),
  ) as MapManifest;
  const largeDir = path.join(base, "expandedgiantworldlarge");
  const large = JSON.parse(
    fs.readFileSync(path.join(largeDir, "manifest.json"), "utf8"),
  ) as MapManifest;
  expect(current.map.width).toBe(8216);
  expect(large.map.width).toBe(12324);
  expect(large.map.height).toBe(5844);
  expect(large.map.width * large.map.height).toBe(72021456);
  const metadata = large.map as PagedMapMetadata;
  expect(metadata.format).toBe("paged-v1");
  expect(metadata.pages).toHaveLength(78);
  const source = fs.readFileSync(path.join(base, "giantworldmap/map.bin"));
  for (const page of metadata.pages) {
    const bytes = fs.readFileSync(path.join(largeDir, page.path));
    expect(bytes.length).toBe(page.width * page.height);
    expect(bytes.length).toBe(page.byte_length);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(page.sha256);
    for (const [x, y] of [
      [0, 0],
      [page.width - 1, page.height - 1],
    ]) {
      const sourceX = Math.floor((page.x * metadata.page_size + x) / 3);
      const sourceY = Math.floor((page.y * metadata.page_size + y) / 3);
      expect(bytes[y * page.width + x]).toBe(
        source[sourceY * original.map.width + sourceX],
      );
    }
  }
  for (const [name, lod, divisor] of [
    ["map4x", large.map4x, 2],
    ["map16x", large.map16x, 4],
  ] as const) {
    expect(lod.width).toBe(large.map.width / divisor);
    expect(lod.height).toBe(large.map.height / divisor);
    const bytes = fs.readFileSync(path.join(largeDir, `${name}.bin`));
    expect(bytes.length).toBe(lod.width * lod.height);
    expect(
      bytes.reduce(
        (n, value) => n + (value & 128 && (value & 31) !== 31 ? 1 : 0),
        0,
      ),
    ).toBe(lod.num_land_tiles);
  }
  expect(large.nations).toHaveLength(original.nations.length);
  for (let i = 0; i < large.nations.length; i++) {
    expect(large.nations[i].coordinates).toEqual(
      original.nations[i].coordinates?.map((c) => c * 3),
    );
  }
});
