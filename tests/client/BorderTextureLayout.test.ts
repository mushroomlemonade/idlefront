import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BorderComputePass } from "../../src/client/render/gl/passes/BorderComputePass";
import { createRenderSettings } from "../../src/client/render/gl/RenderSettings";
import { createTexture2D } from "../../src/client/render/gl/utils/GlUtils";

vi.mock("../../src/client/render/gl/utils/GlUtils", () => ({
  createTexture2D: vi.fn(() => ({})),
  createProgram: vi.fn(() => ({})),
  createFullscreenQuad: vi.fn(() => ({})),
  shaderSrc: (source: string) => source,
}));
vi.mock("../../src/client/render/gl/passes/BorderScatterPass", () => ({
  BorderScatterPass: class {},
}));

describe("compact border texture", () => {
  it("allocates RG8 rather than RGBA8 at unchanged map resolution", () => {
    const noop = vi.fn();
    const gl = {
      RG8: 0x822b, RG: 0x8227,
      getUniformLocation: noop,
      useProgram: noop,
      uniform1i: noop,
      createFramebuffer: noop,
      bindFramebuffer: noop,
      framebufferTexture2D: noop,
    } as unknown as WebGL2RenderingContext;
    new BorderComputePass(
      gl,
      12324,
      5844,
      {} as WebGLTexture,
      createRenderSettings(),
    );
    expect(createTexture2D).toHaveBeenCalledWith(
      gl,
      expect.objectContaining({
        width: 12324,
        height: 5844,
        internalFormat: gl.RG8,
        format: gl.RG,
      }),
    );
  });

  it("both full and scatter borders preserve border type and relationship tint", () => {
    const shader = (path: string) =>
      readFileSync(
        resolve("src/client/render/gl", path),
        "utf8",
      );
    expect(shader("shaders/border-compute/border-compute.frag.glsl")).toContain(
      "vec4(borderType, relation, 0.0, 1.0)",
    );
    expect(shader("shaders/day-night/border-stamp.frag.glsl")).toContain(
      "float relation = borderData.g;",
    );
    expect(shader("shaders/map-overlay/territory.frag.glsl")).toContain(
      "texelFetch(uBorderTex, tc, 0).r",
    );
    expect(shader("passes/BorderScatterPass.ts")).toContain(
      'import borderComputeFragSrc from "../shaders/border-compute/border-compute.frag.glsl?raw"',
    );
  });
});
