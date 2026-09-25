import { describe, expect, it, vi } from "vitest";
import { CatchupCamera } from "../../src/client/CatchupCamera";
import { ZoomEvent } from "../../src/client/InputHandler";
import {
  FitMapEvent,
  TransformHandler,
} from "../../src/client/TransformHandler";
import type { GameView } from "../../src/client/view/GameView";
import { EventBus } from "../../src/core/EventBus";
import { Cell } from "../../src/core/game/Game";

describe("catchup overview", () => {
  it("fits for initial catchup, never for a live conquest backlog", () => {
    const bus = new EventBus();
    const fit = vi.fn();
    bus.on(FitMapEvent, fit);
    const camera = new CatchupCamera(bus);
    camera.update(2);
    camera.update(300);
    camera.update(2);
    expect(camera.active).toBe(true);
    expect(fit).toHaveBeenCalledTimes(1);
    camera.update(0);
    expect(camera.active).toBe(false);
    camera.update(2);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(camera.active).toBe(false);
  });

  it("does not zoom out after an immediate live join", () => {
    const bus = new EventBus();
    const fit = vi.fn();
    bus.on(FitMapEvent, fit);
    const camera = new CatchupCamera(bus);
    camera.update(0);
    camera.update(300);
    expect(fit).not.toHaveBeenCalled();
  });

  it("fits initial snapshots once and ignores later fog-reveal snapshots", () => {
    const bus = new EventBus();
    const fit = vi.fn();
    bus.on(FitMapEvent, fit);
    const camera = new CatchupCamera(bus);
    camera.update(0, "begin");
    camera.update(0, "part");
    camera.update(0, "end");
    camera.update(20, "begin");
    camera.update(0, "end");
    expect(fit).toHaveBeenCalledTimes(1);
    expect(camera.active).toBe(false);
  });

  it.each([
    [390, 780],
    [1440, 900],
  ])(
    "shows every map corner in a %sx%s viewport and allows normal zoom from overview",
    (width, height) => {
      const bus = new EventBus();
      const rect = new DOMRect(12, 60, width, height);
      const canvas = { getBoundingClientRect: () => rect } as HTMLElement;
      const map = { width: () => 12324, height: () => 5844 } as GameView;
      const transform = new TransformHandler(map, bus, canvas);
      bus.emit(new FitMapEvent());
      for (const corner of [new Cell(0, 0), new Cell(12324, 5844)]) {
        const screen = transform.worldToScreenCoordinates(corner);
        expect(screen.x).toBeGreaterThanOrEqual(rect.left - 0.001);
        expect(screen.x).toBeLessThanOrEqual(rect.right + 0.001);
        expect(screen.y).toBeGreaterThanOrEqual(rect.top - 0.001);
        expect(screen.y).toBeLessThanOrEqual(rect.bottom + 0.001);
      }
      const overviewScale = transform.scale;
      transform.onZoom(new ZoomEvent(width / 2, height / 2, -1));
      expect(transform.scale).toBeGreaterThan(overviewScale);
      expect(transform.scale).toBeLessThan(overviewScale * 1.01);
    },
  );
});
