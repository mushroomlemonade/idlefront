import { EventBus } from "../core/EventBus";
import { PlayerBuildableUnitType } from "../core/game/Game";

export class StructureDragEvent {
  constructor(
    public phase: "move" | "drop" | "cancel",
    public type: PlayerBuildableUnitType,
    public x: number,
    public y: number,
  ) {}
}

/** The HUD's edge margins are reserved too, even when hit testing sees canvas. */
export function isStructureDropOnMap(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight)
    return false;
  for (const selector of [
    ".atlas-control-deck",
    ".atlas-top-command-surface",
  ]) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (selector === ".atlas-control-deck" ? y >= rect.top : y <= rect.bottom)
      return false;
  }
  // The native renderer routes input through this transparent div above the
  // WebGL canvas. It is map space, not a HUD obstruction.
  return !!document
    .elementFromPoint(x, y)
    ?.closest("#game-input-overlay, canvas");
}

/** Captures only this gesture; a second pointer nudges the ghost at quarter speed. */
export function startStructureDrag(
  event: PointerEvent,
  type: PlayerBuildableUnitType,
  bus: EventBus,
  onStart?: () => void,
) {
  event.stopPropagation();
  if (event.pointerType !== "touch") return;
  const source = event.currentTarget as HTMLElement;
  const first = event.pointerId;
  let secondary: number | null = null;
  let sx = 0,
    sy = 0,
    x = event.clientX,
    y = event.clientY;
  let lastX = x,
    lastY = y,
    dragging = false,
    fine = false;
  const originX = x,
    originY = y;
  // Safari emits GestureEvents separately from PointerEvents. Blocking only
  // pointers leaves its pinch handler free to zoom behind the placement ghost.
  const blockGesture = (e: Event) => {
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  };
  const gestureEvents = [
    "gesturestart",
    "gesturechange",
    "gestureend",
    "touchmove",
  ];
  const stop = (e: PointerEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const down = (e: PointerEvent) => {
    if (e.pointerId === first || secondary !== null) return;
    secondary = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    fine = true;
    stop(e);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== first && e.pointerId !== secondary) return;
    stop(e);
    if (e.pointerId === secondary) {
      x += (e.clientX - sx) * 0.25;
      y += (e.clientY - sy) * 0.25;
      sx = e.clientX;
      sy = e.clientY;
    } else {
      if (!fine) {
        x += e.clientX - lastX;
        y += e.clientY - lastY;
      }
      lastX = e.clientX;
      lastY = e.clientY;
    }
    if (
      !dragging &&
      e.pointerId === first &&
      Math.hypot(e.clientX - originX, e.clientY - originY) >= 8
    ) {
      dragging = true;
      onStart?.();
    }
    if (dragging) bus.emit(new StructureDragEvent("move", type, x, y));
  };
  const cleanup = () => {
    for (const name of gestureEvents)
      window.removeEventListener(name, blockGesture, true);
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("blur", abort);
  };
  const finish = (cancelled: boolean) => {
    cleanup();
    if (!dragging) return;
    // Fine adjustment offsets the ghost from the fingers, even after the
    // second finger lifts. Validate the placement, not the controlling finger.
    const onMap = isStructureDropOnMap(x, y);
    bus.emit(
      new StructureDragEvent(
        cancelled || !onMap ? "cancel" : "drop",
        type,
        x,
        y,
      ),
    );
    // Suppress the synthesized tap, but never eat the next intentional click.
    const suppress = (e: MouseEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    source.addEventListener("click", suppress, { capture: true, once: true });
    setTimeout(() => source.removeEventListener("click", suppress, true), 350);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId === secondary) {
      stop(e);
      secondary = null;
      fine = false;
      return;
    }
    if (e.pointerId !== first) return;
    if (!fine) {
      x += e.clientX - lastX;
      y += e.clientY - lastY;
    }
    lastX = e.clientX;
    lastY = e.clientY;
    if (dragging) stop(e);
    finish(false);
  };
  const cancel = (e: PointerEvent) => {
    if (e.pointerId === first || e.pointerId === secondary) {
      stop(e);
      finish(true);
    }
  };
  const abort = () => finish(true);
  for (const name of gestureEvents)
    window.addEventListener(name, blockGesture, {
      capture: true,
      passive: false,
    });
  window.addEventListener("pointerdown", down, {
    capture: true,
    passive: false,
  });
  window.addEventListener("pointermove", move, {
    capture: true,
    passive: false,
  });
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", abort);
}
