import {
  isStructureDropOnMap,
  startStructureDrag,
} from "../../src/client/StructureDrag";
import type { EventBus } from "../../src/core/EventBus";
import { UnitType } from "../../src/core/game/Game";

function pointer(name: string, id: number, x: number, y: number) {
  const event = new Event(name, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType: "touch",
  });
  return event as PointerEvent;
}
test("structure drag uses relative fine adjustment and releases only with primary finger", () => {
  const button = document.createElement("button");
  const canvas = document.createElement("div");
  canvas.id = "game-input-overlay";
  document.body.append(button, canvas);
  const emit = vi.fn();
  button.addEventListener("pointerdown", (event) =>
    startStructureDrag(event, UnitType.Factory, {
      emit,
    } as unknown as EventBus),
  );
  const previous = document.elementFromPoint;
  document.elementFromPoint = () => canvas;
  button.dispatchEvent(pointer("pointerdown", 1, 20, 100));
  window.dispatchEvent(pointer("pointermove", 1, 30, 60));
  window.dispatchEvent(pointer("pointerdown", 2, 200, 100));
  const pinch = new Event("gesturechange", { bubbles: true, cancelable: true });
  const zoom = vi.fn();
  canvas.addEventListener("gesturechange", zoom);
  canvas.dispatchEvent(pinch);
  expect(pinch.defaultPrevented).toBe(true);
  expect(zoom).not.toHaveBeenCalled();
  window.dispatchEvent(pointer("pointermove", 2, 220, 80));
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: "move", x: 35, y: 55 }),
  );
  window.dispatchEvent(pointer("pointerup", 2, 220, 80));
  expect(emit.mock.calls.some(([event]) => event.phase === "drop")).toBe(false);
  window.dispatchEvent(pointer("pointerup", 1, 30, 60));
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: "drop", x: 35, y: 55 }),
  );
  canvas.dispatchEvent(new Event("gesturechange", { bubbles: true }));
  expect(zoom).toHaveBeenCalledOnce();
  document.elementFromPoint = previous;
  button.remove();
  canvas.remove();
});

test.each([true, false])(
  "fine placement uses the ghost when the primary finger is over UI (secondary lifted: %s)",
  (liftSecondary) => {
    const button = document.createElement("button");
    const map = document.createElement("div");
    map.id = "game-input-overlay";
    document.body.append(button, map);
    const emit = vi.fn();
    button.addEventListener("pointerdown", (event) =>
      startStructureDrag(event, UnitType.Factory, {
        emit,
      } as unknown as EventBus),
    );
    const previous = document.elementFromPoint;
    document.elementFromPoint = (_x, y) => (y >= 100 ? button : map);
    button.dispatchEvent(pointer("pointerdown", 1, 20, 120));
    window.dispatchEvent(pointer("pointermove", 1, 30, 60));
    window.dispatchEvent(pointer("pointerdown", 2, 200, 120));
    window.dispatchEvent(pointer("pointermove", 2, 220, 100));
    window.dispatchEvent(pointer("pointermove", 1, 30, 120));
    if (liftSecondary) window.dispatchEvent(pointer("pointerup", 2, 220, 100));
    window.dispatchEvent(pointer("pointerup", 1, 30, 120));
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "drop", x: 35, y: 55 }),
    );
    document.elementFromPoint = previous;
    button.remove();
    map.remove();
  },
);

test("HUD and the bottom margin cannot receive a structure drop", () => {
  const deck = document.createElement("div");
  deck.className = "atlas-control-deck";
  deck.getBoundingClientRect = () =>
    ({ top: 500, bottom: 750, width: 380, height: 250 }) as DOMRect;
  const canvas = document.createElement("canvas");
  document.body.append(deck, canvas);
  const previous = document.elementFromPoint;
  document.elementFromPoint = () => canvas;
  expect(isStructureDropOnMap(100, 450)).toBe(true);
  expect(isStructureDropOnMap(100, 550)).toBe(false);
  expect(isStructureDropOnMap(100, 755)).toBe(false);
  document.elementFromPoint = () => deck;
  expect(isStructureDropOnMap(100, 450)).toBe(false);
  document.elementFromPoint = previous;
  deck.remove();
  canvas.remove();
});

test("releasing back over UI cancels instead of placing at the last ghost", () => {
  const button = document.createElement("button");
  const canvas = document.createElement("canvas");
  document.body.append(button, canvas);
  const emit = vi.fn();
  button.addEventListener("pointerdown", (event) =>
    startStructureDrag(event, UnitType.Factory, {
      emit,
    } as unknown as EventBus),
  );
  const previous = document.elementFromPoint;
  document.elementFromPoint = (_x, y) => (y >= 100 ? button : canvas);
  button.dispatchEvent(pointer("pointerdown", 1, 20, 100));
  window.dispatchEvent(pointer("pointermove", 1, 30, 60));
  window.dispatchEvent(pointer("pointerup", 1, 20, 100));
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: "cancel" }),
  );
  document.elementFromPoint = previous;
  button.remove();
  canvas.remove();
});
test("a simple tap emits no placement events", () => {
  const button = document.createElement("button");
  document.body.append(button);
  const emit = vi.fn();
  button.addEventListener("pointerdown", (event) =>
    startStructureDrag(event, UnitType.City, { emit } as unknown as EventBus),
  );
  button.dispatchEvent(pointer("pointerdown", 1, 20, 100));
  window.dispatchEvent(pointer("pointerup", 1, 20, 100));
  expect(emit).not.toHaveBeenCalled();
  button.remove();
});
