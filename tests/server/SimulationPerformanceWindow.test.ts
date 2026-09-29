import { expect, it } from "vitest";
import { SimulationPerformanceWindow } from "../../src/server/simulation/SimulationPerformanceWindow";
it("measures live throughput, tail latency and accumulating debt with bounded storage", () => {
  const window = new SimulationPerformanceWindow(600);
  for (let i = 0; i < 10000; i++)
    window.record(i, i * 100, i % 20 === 0 ? 150 : 50, 0);
  expect(window.summary()).toMatchObject({
    samples: 600,
    liveTPS: 10,
    tickP50Ms: 50,
    tickP95Ms: 50,
    tickP99Ms: 150,
    overBudgetTicks: 30,
    debtChangeMs: 0,
  });
  for (let i = 10000; i < 10600; i++)
    window.record(i, 1_000_000 + (i - 10000) * 200, 190, (i - 10000) * 100);
  expect(window.summary()).toMatchObject({
    liveTPS: 5,
    tickP99Ms: 190,
    debtChangeMs: 59900,
  });
  window.record(0, 0, 1, 0);
  expect(window.summary()).toMatchObject({ samples: 1, liveTPS: null });
});
