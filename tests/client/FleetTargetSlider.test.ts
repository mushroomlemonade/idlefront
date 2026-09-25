import { afterEach, expect, it, vi } from "vitest";
import { ResolveMapPositionEvent } from "../../src/client/TransformHandler";
import { SendFleetOrdersEvent } from "../../src/client/Transport";
import { FleetTargetSlider } from "../../src/client/components/FleetTargetSlider";
import type { PopulationRatioSlider } from "../../src/client/components/PopulationRatioSlider";
import type { GameView } from "../../src/client/view";
import { EventBus } from "../../src/core/EventBus";
import { UnitType } from "../../src/core/game/Game";

afterEach(() => document.body.replaceChildren());
it("can drag back from the maximum within a gesture and on the next gesture", async () => {
  const slider = document.createElement(
    "population-ratio-slider",
  ) as PopulationRatioSlider;
  slider.snapInteger = true;
  slider.max = 40;
  document.body.append(slider);
  await slider.updateComplete;
  const input = slider.querySelector("input")!;
  input.setPointerCapture = vi.fn();
  vi.spyOn(input.parentElement!, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 200,
  } as DOMRect);
  const change = vi.fn();
  slider.addEventListener("change", change);
  const pointer = (type: string, clientX: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX, pointerId: 1, isPrimary: true, button: 0 });
    input.dispatchEvent(event);
  };
  pointer("pointerdown", 200);
  pointer("pointermove", 250);
  expect(slider.value).toBe(40);
  pointer("pointermove", 100);
  expect(slider.value).toBe(20);
  pointer("pointerup", 200);
  expect(slider.value).toBe(40);
  pointer("pointerdown", 200);
  pointer("pointermove", 53);
  pointer("pointerup", 53);
  expect(slider.value).toBe(9);
  expect(change).toHaveBeenCalledTimes(2);
});
it("drags the behavior switch, commits only on release, and cancels safely", async () => {
  const el = new FleetTargetSlider();
  el.game = {
    myPlayer: () => ({
      isAlive: () => true,
      units: () => [],
      gold: () => 0n,
      fleet: { target: 2, order: "defend", reserve: 100000 },
    }),
  } as unknown as GameView;
  const bus = new EventBus();
  el.eventBus = bus;
  const send = vi.fn();
  bus.on(SendFleetOrdersEvent, send);
  document.body.append(el);
  await el.updateComplete;
  const control = el.querySelector<HTMLElement>(".fleet-mode-switch")!;
  control.setPointerCapture = vi.fn();
  vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 150,
  } as DOMRect);
  const pointer = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: x,
    });
    control.dispatchEvent(event);
  };
  pointer("pointerdown", 25);
  pointer("pointermove", 75);
  await el.updateComplete;
  expect(control.classList.contains("is-dragging")).toBe(true);
  expect(send).not.toHaveBeenCalled();
  pointer("pointerup", 75);
  await el.updateComplete;
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      orders: expect.objectContaining({ order: "escort", target: 2 }),
    }),
  );
  expect(control.classList.contains("is-dragging")).toBe(false);
  pointer("pointerdown", 25);
  pointer("pointermove", 125);
  pointer("pointercancel", 125);
  await el.updateComplete;
  expect(send).toHaveBeenCalledTimes(1);
  expect(el.querySelector('[role="dialog"]')).toBeNull();
  expect(
    el.querySelector(".fleet-control-grid population-ratio-slider"),
  ).not.toBeNull();
});
it("only commits patrol after selecting visible water, and supports cancel", async () => {
  let visible = false;
  const player = {
    isAlive: () => true,
    units: () => [],
    gold: () => 0n,
    fleet: { target: 2, order: "defend", reserve: 100000 },
  };
  const el = new FleetTargetSlider();
  el.game = {
    myPlayer: () => player,
    isValidCoord: () => true,
    ref: () => 25,
    isWater: () => true,
    isTileVisible: () => visible,
  } as unknown as GameView;
  const bus = new EventBus();
  el.eventBus = bus;
  const send = vi.fn();
  bus.on(SendFleetOrdersEvent, send);
  bus.on(ResolveMapPositionEvent, (e) => e.resolve({ x: 2, y: 5 } as never));
  document.body.append(el);
  await el.updateComplete;
  el.querySelector<HTMLButtonElement>(
    '[aria-label="choose patrol area"]',
  )!.click();
  await el.updateComplete;
  const picker = el.querySelector<HTMLElement>('[role="dialog"]')!;
  picker.click();
  expect(send).not.toHaveBeenCalled();
  visible = true;
  picker.click();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      orders: expect.objectContaining({
        target: 2,
        order: "patrol",
        patrolTile: 25,
      }),
    }),
  );
  await el.updateComplete;
  expect(el.querySelector('[role="dialog"]')).toBeNull();
  el.querySelector<HTMLButtonElement>(
    '[aria-label="choose patrol area"]',
  )!.click();
  await el.updateComplete;
  el.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click();
  await el.updateComplete;
  expect(el.querySelector('[role="dialog"]')).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
});
it("uses affordability headroom, holds the drag across ticks, and commits once with existing fleet settings", async () => {
  const bus = new EventBus(),
    send = vi.fn();
  bus.on(SendFleetOrdersEvent, send);
  const el = new FleetTargetSlider();
  el.eventBus = bus;
  el.game = {
    myPlayer: () => ({
      isAlive: () => true,
      gold: () => 100000000n,
      buildables: async () => [{ type: UnitType.Warship, cost: 250000n }],
      fleet: {
        target: 2,
        enabled: true,
        reserve: 456,
        ports: [7, 8],
        order: "patrol",
        patrolTile: 99,
        status: "target met",
      },
      units: (type: UnitType) =>
        type === UnitType.Port ? [{ id: () => 7 }] : [],
    }),
  } as unknown as GameView;
  const player = el.game.myPlayer();
  el.game.myPlayer = () => player;
  document.body.append(el);
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  const slider = el.querySelector(
    "population-ratio-slider",
  ) as PopulationRatioSlider;
  await slider.updateComplete;
  const input = slider.querySelector("input")!;
  expect(input.max).toBe("112");
  expect(input.min).toBe("0");
  expect(slider.label).toBe("auto warship fleet");
  expect(slider.querySelector("output")!.textContent).toContain(
    "gold fleet value",
  );
  expect(slider.barValue).toBe("actual 0");
  expect(slider.barEndValue).toBe("target 2");
  input.value = "49.7";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  el.tick = 100;
  await el.updateComplete;
  await slider.updateComplete;
  expect(input.value).toBe("49.7");
  expect(input.step).toBe("any");
  expect(slider.barEndValue).toBe("target 50");
  expect(send).not.toHaveBeenCalled();
  input.dispatchEvent(new Event("change", { bubbles: true }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      orders: {
        target: 50,
        enabled: true,
        reserve: 456,
        automaticPorts: true,
        ports: [],
        order: "patrol",
        patrolTile: 99,
      },
    }),
  );
  // Ship updates must refresh independently of the game object's identity.
  el.actualCount = 6;
  await el.updateComplete;
  await slider.updateComplete;
  expect(slider.barValue).toBe("actual 6");
  expect(slider.value).toBe(50);
  el.querySelector<HTMLButtonElement>(
    '[aria-label="escort trade ships and transports"]',
  )!.click();
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      orders: expect.objectContaining({ order: "escort", target: 50 }),
    }),
  );
});

it("keeps the saved count while rising gold expands headroom", async () => {
  let gold = 600000n;
  const player = {
    isAlive: () => true,
    gold: () => gold,
    units: () => [],
    buildables: async () => [{ type: UnitType.Warship, cost: 250000n }],
    fleet: { target: 2, reserve: 100000, enabled: true, status: "target met" },
  };
  const el = new FleetTargetSlider();
  el.game = { myPlayer: () => player } as unknown as GameView;
  el.eventBus = new EventBus();
  document.body.append(el);
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  const slider = el.querySelector(
    "population-ratio-slider",
  ) as PopulationRatioSlider;
  await slider.updateComplete;
  expect(slider.value).toBe(2);
  expect(slider.max).toBe(2);
  gold = 10000000n;
  el.tick++;
  await el.updateComplete;
  await slider.updateComplete;
  expect(slider.value).toBe(2);
  expect(slider.max).toBeGreaterThan(2);
});
