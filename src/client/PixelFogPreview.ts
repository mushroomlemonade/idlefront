import type { GameMap } from "../core/game/GameMap";
import { fogTileState } from "../core/network/FogTileState";
import { OverviewMapPass } from "./render/gl/passes/OverviewMapPass";
import { PixelFogPass } from "./render/gl/passes/PixelFogPass";
import { createRenderSettings } from "./render/gl/RenderSettings";
import { createTexture2D } from "./render/gl/utils/GlUtils";

const status = document.querySelector<HTMLDivElement>("#status")!;
async function start() {
  const canvas = document.querySelector("canvas")!;
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false })!;
  if (!gl) throw Error("WebGL2 unavailable");
  const base = "/maps/pixelearth27v1/";
  const manifest = await (await fetch(base + "manifest.json")).json();
  const originX = 5200,
    originY = 2100,
    w = 1024,
    h = 768;
  const span = manifest.map.page_size;
  const pages = new Map<number, { data: Uint8Array; width: number }>();
  const columns = Math.ceil(manifest.map.width / span);
  await Promise.all(
    manifest.map.pages
      .filter(
        (p: any) =>
          p.x * span < originX + w &&
          (p.x + 1) * span > originX &&
          p.y * span < originY + h &&
          (p.y + 1) * span > originY,
      )
      .map(async (p: any) =>
        pages.set(p.y * columns + p.x, {
          width: p.width,
          data: new Uint8Array(
            await (await fetch(base + p.path)).arrayBuffer(),
          ),
        }),
      ),
  );
  const centers = [
    [450, 270, 20],
    [340, 280, 78],
    [495, 370, 85],
    [600, 330, 100],
    [705, 235, 110],
    [810, 155, 95],
  ];
  const legacy = new URLSearchParams(location.search).has("legacy");
  const visible = new Uint8Array(w * h);
  const explored = new Uint8Array(w * h);
  const terrainByte = (r: number) => {
    const x = (r % w) + originX,
      y = Math.floor(r / w) + originY;
    const p = pages.get(Math.floor(y / span) * columns + Math.floor(x / span));
    return p?.data[(y % span) * p.width + (x % span)] ?? 0;
  };
  const map = {
    width: () => w,
    height: () => h,
    terrainByte,
    isValidRef: (r: number) => r >= 0 && r < w * h,
    tileState: (r: number) => {
      const present = (state: number) =>
        legacy ? state : fogTileState(state, visible[r] > 127, explored[r] > 0);
      if (!(terrainByte(r) & 128)) return present(0);
      const x = r % w,
        y = Math.floor(r / w);
      for (let i = 0; i < centers.length; i++) {
        const [cx, cy, rad] = centers[i];
        if (Math.hypot(x - cx, y - cy) < rad) return present(i + 1);
      }
      return present(0);
    },
  } as GameMap;
  const paletteData = new Float32Array(4096 * 2 * 4);
  for (let i = 1; i < 7; i++) {
    paletteData.set(
      [0.25 + i * 0.075, 0.57 - i * 0.04, 0.66 - i * 0.05, 1],
      i * 4,
    );
  }
  const palette = createTexture2D(gl, {
    width: 4096,
    height: 2,
    internalFormat: gl.RGBA32F,
    format: gl.RGBA,
    type: gl.FLOAT,
    data: paletteData,
    filter: gl.NEAREST,
  });
  const settings = createRenderSettings();
  settings.material.enabled = false;
  const board = new OverviewMapPass(gl, map, palette, settings);
  const fog = legacy ? new PixelFogPass(gl, w, h) : null;
  let stage = 0,
    zoom = 2,
    cx = 450,
    cy = 270;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function choose(next: number) {
    stage = Math.max(0, Math.min(3, Math.floor(next)));
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let inside = stage === 3 ? 1 : 0;
        const count = stage === 0 ? 1 : stage === 1 ? 4 : 6;
        for (let i = 0; i < count && inside < 1; i++) {
          const [px, py, radius] = centers[i];
          const r = stage === 0 ? radius + 7 : radius + 12;
          inside = Math.max(
            inside,
            Math.min(1, Math.max(0, (r - Math.hypot(x - px, y - py)) / 5)),
          );
        }
        mask[y * w + x] = Math.round(inside * 255);
      }
    visible.set(mask);
    for (let i = 0; i < mask.length; i++) if (mask[i] > 127) explored[i] = 1;
    if (fog) fog.setVisibility(mask, performance.now() / 1000, reduced);
    else board.rebuild();
    document
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) =>
        b.setAttribute(
          "aria-pressed",
          String(Number(b.dataset.stage) === stage),
        ),
      );
  }
  document
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((b) => (b.onclick = () => choose(Number(b.dataset.stage))));
  canvas.onwheel = (e) => {
    e.preventDefault();
    zoom = Math.max(0.5, Math.min(8, zoom * Math.exp(-e.deltaY * 0.001)));
  };
  let drag: { x: number; y: number } | null = null;
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY };
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    cx -= (e.clientX - drag.x) / zoom;
    cy -= (e.clientY - drag.y) / zoom;
    drag = { x: e.clientX, y: e.clientY };
  };
  canvas.onpointerup = canvas.onpointercancel = () => {
    drag = null;
  };
  choose(Number(new URLSearchParams(location.search).get("stage")) || 0);
  const camera = new Float32Array(9);
  function frame() {
    zoom = Math.max(zoom, innerWidth / w, innerHeight / h);
    cx = Math.max(
      innerWidth / (2 * zoom),
      Math.min(w - innerWidth / (2 * zoom), cx),
    );
    cy = Math.max(
      innerHeight / (2 * zoom),
      Math.min(h - innerHeight / (2 * zoom), cy),
    );
    const dpr = Math.min(devicePixelRatio, 2);
    if (
      canvas.width !== Math.round(innerWidth * dpr) ||
      canvas.height !== Math.round(innerHeight * dpr)
    ) {
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
    }
    const sx = (2 * zoom) / innerWidth,
      sy = (-2 * zoom) / innerHeight;
    camera.set([sx, 0, 0, 0, sy, 0, -cx * sx, -cy * sy, 1]);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0.18, 0.23, 0.27, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    board.updateCamera(cx, cy, zoom, innerWidth, innerHeight);
    board.setFogRendering(!legacy, reduced ? 0 : performance.now() / 1000);
    board.draw(camera);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    fog?.draw(camera, reduced ? 0 : performance.now() / 1000);
    gl.disable(gl.BLEND);
    document.body.dataset.ready = "true";
    requestAnimationFrame(frame);
  }
  status.textContent =
    "Pixel fog study · drag to pan · scroll to zoom · stages are illustrative";
  frame();
}
start().catch((e) => {
  status.textContent = String(e);
  document.body.dataset.error = String(e);
  console.error(e);
});
