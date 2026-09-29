// Local development harness. Not part of the production entrypoint.
import { createRenderSettings } from "../src/client/render/gl/RenderSettings";
import { OverviewMapPass } from "../src/client/render/gl/passes/OverviewMapPass";
import { SparseRailroadPass } from "../src/client/render/gl/passes/SparseRailroadPass";
import { SparseTrailPass } from "../src/client/render/gl/passes/SparseTrailPass";
import {
  buildCursorTex,
  buildPlayerDataTex,
  buildStringTex,
} from "../src/client/render/gl/passes/name-pass/DataTextures";
import {
  configureOwnerCapacity,
  getPaletteSize,
  ownerPaletteShape,
} from "../src/client/render/gl/utils/ColorUtils";
import {
  createProgram,
  createTexture2D,
  shaderSrc,
} from "../src/client/render/gl/utils/GlUtils";
import { PagedGameMap } from "../src/core/game/PagedGameMap";

const sources = import.meta.glob(
  "../src/client/render/gl/shaders/name/*.glsl",
  { query: "?raw", import: "default", eager: true },
);
document.querySelector("#run")!.addEventListener("click", () => {
  const result = document.querySelector("#result")!;
  const lines: string[] = [];
  try {
    const gl = document.querySelector("canvas")!.getContext("webgl2")!;
    if (!gl) throw new Error("WebGL2 unavailable");
    lines.push(`WebGL2 max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const wide of [false, true]) {
      configureOwnerCapacity(wide);
      const settings = createRenderSettings();
      const map = new PagedGameMap(
        32,
        32,
        32,
        [
          {
            pageX: 0,
            pageY: 0,
            width: 32,
            height: 32,
            terrain: new Uint8Array(1024).fill(128),
          },
        ],
        1024,
        wide,
      );
      map.setOwnerID(1, wide ? 16000 : 2000);
      const texture = (rows: number) =>
        createTexture2D(gl, {
          ...ownerPaletteShape(rows),
          internalFormat: gl.RGBA32F,
          format: gl.RGBA,
          type: gl.FLOAT,
          data: new Float32Array(getPaletteSize() * rows * 4),
        });
      const palette = texture(2),
        effect = texture(32);
      const passes = [
        new OverviewMapPass(gl, map, palette, settings),
        new SparseTrailPass(gl, 32, palette, effect, settings),
        new SparseRailroadPass(gl, map, palette, settings),
      ];
      for (const name of ["name", "icon", "status-icon", "debug-box"]) {
        const root = "../src/client/render/gl/shaders/name/";
        const program = createProgram(
          gl,
          shaderSrc(sources[root + name + ".vert.glsl"] as string, {
            MAX_CHARS: 32,
            LINES_PER_PLAYER: 2,
          }),
          sources[root + name + ".frag.glsl"] as string,
        );
        gl.deleteProgram(program);
      }
      const textures = [
        palette,
        effect,
        buildCursorTex(gl, wide ? 32768 : 4096),
        buildStringTex(gl, wide ? 32768 : 4096),
        buildPlayerDataTex(gl, wide ? 32768 : 4096),
      ];
      const error = gl.getError();
      if (error !== gl.NO_ERROR)
        throw new Error(`GPU error ${error}, wide=${wide}`);
      passes.forEach((p) => p.dispose());
      textures.forEach((t) => gl.deleteTexture(t));
      lines.push(
        `PASS ${wide ? "16-bit" : "legacy"}: real map/trail/rail/name shaders linked; textures allocated`,
      );
    }
    lines.push("PASS all checks");
  } catch (error) {
    lines.push(`FAIL ${error instanceof Error ? error.stack : error}`);
  }
  result.textContent = lines.join("\n");
});
