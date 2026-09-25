import { describe, expect, it } from "vitest";
import { resolveRuntimeDebugMode } from "../../src/client/RuntimeDebug";

describe("resolveRuntimeDebugMode", () => {
  it("defaults to the build mode", () => {
    expect(resolveRuntimeDebugMode("", null, true)).toBe(true);
    expect(resolveRuntimeDebugMode("", null, false)).toBe(false);
  });

  it("lets a stored choice override the build default", () => {
    expect(resolveRuntimeDebugMode("", "1", false)).toBe(true);
    expect(resolveRuntimeDebugMode("", "0", true)).toBe(false);
  });

  it("gives an explicit URL flag highest priority", () => {
    expect(resolveRuntimeDebugMode("?debug=1", "0", false)).toBe(true);
    expect(resolveRuntimeDebugMode("?debug=false", "1", true)).toBe(false);
  });
});
