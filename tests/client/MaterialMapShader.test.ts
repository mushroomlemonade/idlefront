import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRenderSettings } from "../../src/client/render/gl/RenderSettings";
import {
  BOARD_MATERIAL_SIZE,
  createBoardMaterialData,
} from "../../src/client/render/gl/utils/BoardMaterialTexture";

const shader = (path: string) =>
  readFileSync(resolve("src/client/render/gl/shaders", path), "utf8");

const rendererSource = (path: string) =>
  readFileSync(resolve("src/client/render/gl", path), "utf8");

describe("mineral map material", () => {
  it("is opt-in and leaves the canonical renderer unchanged by default", () => {
    const settings = createRenderSettings();

    expect(settings.material).toEqual(
      expect.objectContaining({
        enabled: false,
        strength: expect.any(Number),
        scale: expect.any(Number),
      }),
    );
  });

  it("anchors terrain and territory detail to world coordinates", () => {
    const terrain = shader("terrain/terrain.frag.glsl");
    const territory = shader("map-overlay/territory.frag.glsl");

    expect(terrain).toContain("mineralTerrain(color, worldPos, isLand)");
    expect(territory).toContain(
      "mineralTerritory(color.rgb, vWorldPos, float(owner) * 0.37)",
    );
    expect(terrain).not.toContain("gl_FragCoord");
    expect(territory).not.toContain("gl_FragCoord");
  });

  it("keeps the material behind one shared renderer switch", () => {
    for (const source of [
      shader("terrain/terrain.frag.glsl"),
      shader("map-overlay/territory.frag.glsl"),
      shader("day-night/border-stamp.frag.glsl"),
    ]) {
      expect(source).toContain("uniform int uMineralEnabled;");
      expect(source).toContain("if (uMineralEnabled != 0)");
    }
  });

  it("applies the same material to page-backed massive worlds", () => {
    const overview = rendererSource("passes/OverviewMapPass.ts");

    expect(overview).toContain("uniform int uMineralEnabled;");
    expect(overview).toContain(
      "mineralSurface(color, vWorldPos, 0.0, !isLand)",
    );
    expect(overview).toContain("float(owner) * 0.37");
    expect(overview).not.toContain("gl_FragCoord");
  });

  it("uses one packed lookup instead of animated procedural bands", () => {
    for (const source of [
      shader("terrain/terrain.frag.glsl"),
      shader("map-overlay/territory.frag.glsl"),
      rendererSource("passes/OverviewMapPass.ts"),
    ]) {
      expect(source).toContain("uniform sampler2D uBoardMaterial;");
      expect(source).not.toContain("float flow");
      expect(source).not.toContain("float refraction");
      expect(source).not.toContain("uTime");
    }
  });

  it("packs normals and two material values into a tiny fixed-size texture", () => {
    const data = createBoardMaterialData();
    expect(data).toHaveLength(BOARD_MATERIAL_SIZE * BOARD_MATERIAL_SIZE * 4);
    expect(
      new Set(data.filter((_, index) => index % 4 === 2)).size,
    ).toBeGreaterThan(32);
    expect(
      new Set(data.filter((_, index) => index % 4 === 3)).size,
    ).toBeGreaterThan(32);
  });

  it("derives cut-edge lighting from existing neighbor ownership", () => {
    const border = shader("day-night/border-stamp.frag.glsl");
    const overview = rendererSource("passes/OverviewMapPass.ts");
    expect(border).toContain("ownerAt(tc + ivec2(-1, 0))");
    expect(border).toContain("normalize(vec2(-0.44, -0.58))");
    expect(overview).toContain("bool rightEdge");
    expect(overview).toContain("float bevel");
  });
});
