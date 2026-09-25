import { describe, expect, it } from "vitest";
import {
  sameOriginRecoveryUrl,
  surfacePhaseAfter,
} from "../../apps/mobile/src/GameSurfaceRecovery";

describe("native WebView recovery", () => {
  it("keeps process termination visible despite late navigation callbacks", () => {
    let phase = surfacePhaseAfter("live", "renderer-stopped");
    for (const event of ["load-start", "load-end", "network-error"] as const) {
      phase = surfacePhaseAfter(phase, event);
      expect(phase).toBe("renderer-stopped");
    }
    expect(surfacePhaseAfter(phase, "retry")).toBe("connecting");
  });

  it("does not cover a network error with onLoadEnd", () => {
    const phase = surfacePhaseAfter("connecting", "network-error");
    expect(surfacePhaseAfter(phase, "load-end")).toBe("network-error");
    expect(surfacePhaseAfter(phase, "load-start")).toBe("connecting");
    expect(surfacePhaseAfter("connecting", "load-end")).toBe("live");
  });

  it("retries the same match, not the landing page", () => {
    const home = "https://example.test/?debug=1";
    const match = "https://example.test/w0/game/abc123?live";
    expect(sameOriginRecoveryUrl(match, home)).toBe(match);
    for (const external of ["about:blank", "https://other.test/", "garbage"]) {
      expect(sameOriginRecoveryUrl(external, home)).toBe(home);
    }
  });
});
