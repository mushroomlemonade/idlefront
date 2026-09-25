import { expect, it } from "vitest";
import { WORLD_PRESETS } from "../src/core/WorldPresets";

it("uses normal attack pace in every custom and scheduled world preset", () => {
  for (const preset of Object.values(WORLD_PRESETS)) {
    expect(preset.attackDivisor).toBe(1);
  }
});
