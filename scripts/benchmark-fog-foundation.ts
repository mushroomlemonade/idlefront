import { PlayerVisibility } from "../src/server/simulation/PlayerVisibility";
import { circularSightFootprint } from "../src/server/simulation/SightFootprint";

const width = 21344, height = 10124;
const fog = new PlayerVisibility(width * height);
const samples: number[] = [];
const scouts = 128;
for (let tick = 0; tick < 120; tick++) {
  const started = performance.now();
  for (let id = 0; id < scouts; id++) {
    const x = 100 + (id % 16) * 1100 + tick;
    const y = 100 + Math.floor(id / 16) * 1100;
    fog.setSource(`train:${id}`, circularSightFootprint(width, height, x, y, 10));
  }
  fog.takeDirtyPages();
  if (tick > 5) samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({
  scenario: "27x map, 128 moving scout circles; coverage only, not full simulation",
  meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
  p95Ms: samples[Math.floor(samples.length * .95)],
  typedArrayMiB: fog.allocatedBytes() / 1048576,
  heapMiB: process.memoryUsage().heapUsed / 1048576,
}, null, 2));
