import { TradeCorridorPass } from "../src/client/render/gl/passes/TradeCorridorPass";
const canvas = document.querySelector<HTMLCanvasElement>("#map")!;
const gl = canvas.getContext("webgl2")!;
const pass = new TradeCorridorPass(gl);
gl.clearColor(0.08, 0.13, 0.16, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
const data: number[] = [];
for (let i = 0; i < 4; i++)
  data.push(
    50,
    100 + i * 130,
    1800,
    100 + i * 130,
    i % 2 === 0 ? 0.1 : 1,
    i >= 2 ? 1 : 0,
  );
pass.update(Float32Array.from(data));
pass.draw(new Float32Array([0.001, 0, 0, 0, -0.0025, 0, -0.95, 0.75, 1]), 0.2);
document.querySelector("#result")!.textContent =
  `WebGL error: ${gl.getError()}`;
