import { describe, expect, it } from "vitest";
import { simulationInitializationTimeout } from "../../../src/server/simulation/SimulationHost";

describe("simulation initialization timeout", () => {
  it("retains the normal boot floor", () => {
    expect(simulationInitializationTimeout(0)).toBe(180_000);
    expect(simulationInitializationTimeout(1_000)).toBe(180_000);
  });

  it("gives large durable journals enough bounded replay time", () => {
    expect(simulationInitializationTimeout(42_000)).toBe(3_150_000);
    expect(simulationInitializationTimeout(1_000_000)).toBe(3_600_000);
  });
});
