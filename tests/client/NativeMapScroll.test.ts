import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DragEvent,
  InputHandler,
  TouchEvent as MapTouchEvent,
} from "../../src/client/InputHandler";
import { NativeMapScroll } from "../../src/client/NativeMapScroll";
import type { UIState } from "../../src/client/UIState";
import type { GameView } from "../../src/client/view";
import { EventBus } from "../../src/core/EventBus";

describe("native map scrolling", () => {
  let scroll: NativeMapScroll | undefined;
  afterEach(() => {
    scroll?.destroy();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });
  function setup() {
    const surface = document.createElement("div");
    surface.style.touchAction = "none";
    document.body.append(surface);
    const pan = vi.fn(),
      zoom = vi.fn(),
      suppress = vi.fn();
    let blocked = false,
      selecting = false;
    scroll = new NativeMapScroll(
      surface,
      pan,
      zoom,
      () => blocked,
      () => selecting,
      suppress,
    );
    const touch = (type: string, points: [number, number][]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
      });
      surface.dispatchEvent(event);
      return event;
    };
    const move = (x: number, y: number) => {
      surface.scrollLeft += x;
      surface.scrollTop += y;
      surface.dispatchEvent(new Event("scroll"));
    };
    return {
      surface,
      pan,
      zoom,
      suppress,
      touch,
      move,
      block: () => {
        blocked = true;
      },
      select: () => {
        selecting = true;
      },
    };
  }
  it("uses native scrolling and translates scroll deltas, including after finger release", () => {
    const s = setup();
    expect(s.surface.style.overflow).toBe("scroll");
    expect(s.surface.style.touchAction).toBe("pan-x pan-y");
    s.touch("touchstart", [[100, 100]]);
    s.move(30, -20);
    expect(s.pan).toHaveBeenLastCalledWith(-30, 20);
    s.touch("touchend", []);
    s.move(10, -5);
    expect(s.pan).toHaveBeenLastCalledWith(-10, 5);
    // No JavaScript deceleration timer or synthetic physics involved.
  });
  it("keeps the native scroll node stable at touchstart and suppresses tapping a coasting map", () => {
    const s = setup();
    s.touch("touchstart", [[100, 100]]);
    s.move(50, 50);
    s.touch("touchend", []);
    s.touch("touchstart", [[100, 100]]);
    s.surface.dispatchEvent(new Event("scroll"));
    expect(s.pan).toHaveBeenCalledTimes(1);
    expect(s.suppress).toHaveBeenCalled();
    expect(s.surface.scrollLeft).toBe(50050);
    expect(s.surface.style.overflow).toBe("scroll");
  });
  it("handles pinch independently without scrolling or zooming the page", () => {
    const s = setup();
    s.touch("touchstart", [
      [0, 0],
      [100, 0],
    ]);
    expect(
      s.touch("touchmove", [
        [0, 0],
        [120, 0],
      ]).defaultPrevented,
    ).toBe(true);
    expect(s.zoom).toHaveBeenCalledWith(60, 0, -40);
    s.move(20, 20);
    expect(s.pan).not.toHaveBeenCalled();
    s.touch("touchend", [[0, 0]]);
    s.move(20, 20);
    expect(s.pan).not.toHaveBeenCalled();
  });
  it.each(["block", "select"] as const)("does not pan during %s", (mode) => {
    const s = setup();
    s[mode]();
    expect(s.touch("touchmove", [[120, 100]]).defaultPrevented).toBe(true);
    s.move(20, 20);
    expect(s.pan).not.toHaveBeenCalled();
  });
  it("HUD touches cancel native motion; teardown removes the surface and listeners", () => {
    const s = setup();
    s.move(30, 20);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(s.surface.scrollLeft).toBe(50000);
    scroll!.destroy();
    scroll = undefined;
    expect(s.surface.children.length).toBe(0);
    expect(s.surface.style.touchAction).toBe("none");
    s.pan.mockClear();
    s.move(20, 20);
    expect(s.pan).not.toHaveBeenCalled();
  });
});

describe("iOS input integration", () => {
  it("does not double-pan and does not turn native pointer cancellation into a tap", () => {
    vi.spyOn(NativeMapScroll, "supported").mockReturnValue(true);
    const surface = document.createElement("div");
    document.body.append(surface);
    const bus = new EventBus(),
      pan = vi.fn(),
      tap = vi.fn();
    bus.on(DragEvent, pan);
    bus.on(MapTouchEvent, tap);
    const handler = new InputHandler(
      { inSpawnPhase: () => false } as unknown as GameView,
      { ghostStructure: null } as UIState,
      surface,
      bus,
    );
    handler.initialize();
    try {
      for (const type of ["pointerdown", "pointermove", "pointercancel"]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, {
          pointerId: 1,
          pointerType: "touch",
          button: 0,
          clientX: 100,
          clientY: 100,
          x: 100,
          y: 100,
        });
        surface.dispatchEvent(event);
      }
      expect(pan).not.toHaveBeenCalled();
      expect(tap).not.toHaveBeenCalled();
      surface.scrollLeft += 20;
      surface.dispatchEvent(new Event("scroll"));
      expect(pan).toHaveBeenCalledTimes(1);
    } finally {
      handler.destroy();
      surface.remove();
      vi.restoreAllMocks();
    }
  });
});
