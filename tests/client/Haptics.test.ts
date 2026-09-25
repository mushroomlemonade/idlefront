import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHaptic, UiHapticController } from "../../src/client/ui/Haptics";

describe("IdleFront semantic haptics", () => {
  afterEach(() => {
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "ReactNativeWebView");
    vi.restoreAllMocks();
  });

  it("routes ordinary and primary buttons through the native bridge", () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    const controller = new UiHapticController();
    const ordinary = document.createElement("button");
    const primary = document.createElement("button");
    primary.className = "pw-button--primary";
    document.body.append(ordinary, primary);

    ordinary.click();
    primary.click();

    expect(
      postMessage.mock.calls.map(([message]) => JSON.parse(message)),
    ).toEqual([
      { type: "idlefront:haptic", pattern: "selection" },
      { type: "idlefront:haptic", pattern: "medium" },
    ]);
    controller.dispose();
  });

  it("preserves explicit signatures for strategic actions", () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    const controller = new UiHapticController();
    const nuke = document.createElement("button");
    nuke.dataset.haptic = "nuke";
    document.body.append(nuke);

    nuke.click();

    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({
      type: "idlefront:haptic",
      pattern: "nuke",
    });
    controller.dispose();
  });

  it("never lets a broken native bridge interrupt an action", () => {
    window.ReactNativeWebView = {
      postMessage: vi.fn(() => {
        throw new Error("bridge unavailable");
      }),
    };

    expect(() => requestHaptic("alert")).not.toThrow();
  });
});
