import { describe, expect, it } from "vitest";
import { ServerMessageSchema } from "../src/core/Schemas";

describe("simulation recovery server message", () => {
  it("accepts measured replay progress", () => {
    expect(
      ServerMessageSchema.parse({
        type: "simulation_recovery",
        status: "replaying",
        completedTurns: 12_000,
        totalTurns: 23_287,
        elapsedMs: 420_000,
      }),
    ).toMatchObject({ completedTurns: 12_000, totalTurns: 23_287 });
  });

  it("rejects impossible negative progress", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "simulation_recovery",
        status: "replaying",
        completedTurns: -1,
        totalTurns: 100,
        elapsedMs: 10,
      }).success,
    ).toBe(false);
  });
});
