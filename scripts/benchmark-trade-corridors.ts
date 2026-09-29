import { performance } from "node:perf_hooks";
import { tradeCorridorsForPreset } from "../src/core/TradeCorridors";
import { PathFinderStepper } from "../src/core/pathfinding/PathFinderStepper";
import { TradeCorridorRouter } from "../src/core/pathfinding/transformers/TradeCorridorRouter";
const journeys = 4000,
  length = 4096,
  routes = 32;
let nativeCalls = 0,
  tick = 0;
const router = new TradeCorridorRouter(
  {
    findPath(from, to) {
      nativeCalls++;
      return Array.from(
        { length: to - Number(from) + 1 },
        (_, i) => Number(from) + i,
      );
    },
  },
  (a, b) => Math.abs(a - b),
  () => "1",
  () => tick,
  tradeCorridorsForPreset("longplay")!,
);
const elapsed: number[] = [],
  steppers: PathFinderStepper<number>[] = [];
for (let i = 0; i < journeys; i++) {
  tick = Math.floor(i / 40);
  const from = (i % routes) * 10000,
    to = from + length - 1;
  const stepper = new PathFinderStepper(router);
  const start = performance.now();
  stepper.next(from, to);
  elapsed.push(performance.now() - start);
  steppers.push(stepper);
}
// Diagnostic inspection only: count actual retained backing stores, not heap noise.
const buffers = new Set(
  steppers.map((s) => (s as unknown as { path: Uint32Array }).path.buffer),
);
elapsed.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    fixture:
      "synthetic repeated-route allocation benchmark; no terrain search or full match",
    journeys,
    routeLength: length,
    uniqueRoutes: routes,
    nativeCalls,
    metrics: router.metrics,
    totalMs: elapsed.reduce((a, b) => a + b, 0),
    p95Ms: elapsed[Math.floor(journeys * 0.95)],
    p99Ms: elapsed[Math.floor(journeys * 0.99)],
    retainedGeometryBytes: [...buffers].reduce((n, b) => n + b.byteLength, 0),
    distinctJourneyBuffers: buffers.size,
  }),
);
