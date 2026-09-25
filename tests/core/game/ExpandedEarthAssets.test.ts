import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GameMapSize, GameMapType } from "../../../src/core/game/Game";
import {
  isPagedMapMetadata,
  loadTerrainMap,
  type MapManifest,
} from "../../../src/core/game/TerrainMapLoader";
import { NodeGameMapLoader } from "../../perf/fullgame/NodeGameMapLoader";

const mapsDir = path.resolve("resources/maps");
const expandedDir = path.join(mapsDir, "expandedgiantworld");

describe("Expanded Earth assets", () => {
  it("describe an exact 2x enlargement in an arbitrary paged-v1 grid", () => {
    const giant = JSON.parse(
      fs.readFileSync(
        path.join(mapsDir, "giantworldmap/manifest.json"),
        "utf8",
      ),
    ) as MapManifest;
    const expanded = JSON.parse(
      fs.readFileSync(path.join(expandedDir, "manifest.json"), "utf8"),
    ) as MapManifest;

    expect(isPagedMapMetadata(expanded.map)).toBe(true);
    if (!isPagedMapMetadata(expanded.map)) return;
    expect(expanded.map.width).toBe(giant.map.width * 2);
    expect(expanded.map.height).toBe(giant.map.height * 2);
    expect(expanded.map.num_land_tiles).toBe(giant.map.num_land_tiles * 4);
    expect(expanded.map.pages_wide).toBe(
      Math.ceil(expanded.map.width / expanded.map.page_size),
    );
    expect(expanded.map.pages_high).toBe(
      Math.ceil(expanded.map.height / expanded.map.page_size),
    );
    expect(expanded.map.pages).toHaveLength(
      expanded.map.pages_wide * expanded.map.pages_high,
    );
    expect(expanded.nations).toHaveLength(giant.nations.length);
    expect(expanded.nations[0].coordinates).toEqual(
      giant.nations[0].coordinates?.map((coordinate) => coordinate * 2),
    );

    for (const page of expanded.map.pages) {
      const data = fs.readFileSync(path.join(expandedDir, page.path));
      expect(data).toHaveLength(page.byte_length);
      expect(createHash("sha256").update(data).digest("hex")).toBe(page.sha256);
    }
  });

  it("loads the complete world without reconstructing contiguous tile storage", async () => {
    const data = await loadTerrainMap(
      GameMapType.ExpandedGiantWorld,
      GameMapSize.Normal,
      new NodeGameMapLoader(mapsDir),
      false,
    );

    expect(data.gameMap.width()).toBe(8216);
    expect(data.gameMap.height()).toBe(3896);
    expect(data.gameMap.isPaged()).toBe(true);
    expect(data.gameMap.tilePages()).toHaveLength(36);
    expect(
      data.gameMap.tilePages().every((page) => page.state.length <= 1024 ** 2),
    ).toBe(true);

    const source = fs.readFileSync(path.join(mapsDir, "giantworldmap/map.bin"));
    const checks: Array<[number, number]> = [
      [0, 0],
      [1023, 1023],
      [1024, 1024],
      [4107, 1947],
      [8215, 3895],
    ];
    for (const [x, y] of checks) {
      const sourceX = Math.floor(x / 2);
      const sourceY = Math.floor(y / 2);
      expect(data.gameMap.terrainByte(data.gameMap.ref(x, y))).toBe(
        source[sourceY * 4108 + sourceX],
      );
    }
  });
});
