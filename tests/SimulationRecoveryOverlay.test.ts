import { describe, expect, it } from "vitest";
import {
  formatRecoveryDuration,
  SimulationRecoveryOverlay,
} from "../src/client/components/SimulationRecoveryOverlay";

describe("simulation recovery duration", () => {
  it("formats useful compact estimates", () => {
    expect(formatRecoveryDuration(9_700)).toBe("10s");
    expect(formatRecoveryDuration(125_000)).toBe("2m 5s");
    expect(formatRecoveryDuration(7_500_000)).toBe("2h 5m");
  });

  it("shows measured progress immediately and remains until the live view arrives", async () => {
    const overlay = document.createElement(
      "simulation-recovery-overlay",
    ) as SimulationRecoveryOverlay;
    document.body.append(overlay);
    window.dispatchEvent(
      new CustomEvent("idlefront:simulation-recovery", {
        detail: {
          type: "simulation_recovery",
          status: "replaying",
          completedTurns: 0,
          totalTurns: 23_287,
          elapsedMs: 0,
        },
      }),
    );
    await overlay.updateComplete;
    const initialText = overlay.textContent?.replace(/\s+/g, " ");
    expect(initialText).toContain("Restoring world");
    expect(initialText).toContain("0%");
    expect(initialText).toContain("0 of 23,287 turns");

    window.dispatchEvent(
      new CustomEvent("idlefront:simulation-recovery", {
        detail: {
          type: "simulation_recovery",
          status: "ready",
          completedTurns: 23_287,
          totalTurns: 23_287,
          elapsedMs: 800_000,
        },
      }),
    );
    await overlay.updateComplete;
    expect(overlay.textContent).toContain("Preparing your live view");

    window.dispatchEvent(new CustomEvent("idlefront:simulation-view-live"));
    await overlay.updateComplete;
    expect(overlay.textContent?.trim()).toBe("");
    overlay.remove();
  });
});
