import { afterEach, expect, it, vi } from "vitest";
import "../../src/client/components/FleetPanel";
import type { FleetPanel } from "../../src/client/components/FleetPanel";
import type { GameView } from "../../src/client/view";
import { EventBus } from "../../src/core/EventBus";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("enters idle after two minutes of actual input inactivity, not simulation inactivity", async () => {
  vi.useFakeTimers();
  const el = document.createElement("fleet-panel") as FleetPanel;
  el.game = {
    myPlayer: () => ({ isAlive: () => true, pressure: {}, units: () => [] }),
  } as unknown as GameView;
  el.eventBus = new EventBus();
  vi.spyOn(el, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  document.body.append(el);
  await el.updateComplete;
  vi.advanceTimersByTime(119000);
  expect(el["idle"]).toBe(false);
  document.dispatchEvent(new Event("pointermove"));
  vi.advanceTimersByTime(119000);
  expect(el["idle"]).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(el["idle"]).toBe(true);
  el["idle"] = false;
  el.remove();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows focus and idle, without a separate fleet control surface", async () => {
  const el = document.createElement("fleet-panel") as FleetPanel;
  el.game = {
    myPlayer: () => ({ isAlive: () => true, pressure: {} }),
  } as unknown as GameView;
  el.eventBus = new EventBus();
  document.body.append(el);
  await el.updateComplete;
  expect(
    [...el.querySelectorAll("button")].map((b) => b.textContent?.trim()),
  ).toEqual(["focus", "idle"]);
  const emit = vi.spyOn(el.eventBus, "emit");
  el.querySelector("button")!.click();
  expect(emit).toHaveBeenCalledOnce();
  expect(el.querySelector(".fleet-dialog")).toBeNull();
});
