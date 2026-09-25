import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CinematicFollowEvent,
  GoToPlayerEvent,
  GoToPositionEvent,
  IdleCameraEvent,
  TransformHandler,
} from "../../src/client/TransformHandler";
import {
  GameSessionEndedEvent,
  SendFleetOrdersEvent,
  SendIdleModeEvent,
  SendMobilisationIntentEvent,
  Transport,
} from "../../src/client/Transport";
import "../../src/client/components/IdleDashboard";
import { IdleDashboard } from "../../src/client/components/IdleDashboard";
import type { GameView, UnitView } from "../../src/client/view";
import { EventBus } from "../../src/core/EventBus";
import { GameType, UnitType } from "../../src/core/game/Game";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(visible = true) {
  const bus = new EventBus();
  const units = [
    { tile: () => 12, isActive: () => true, type: () => UnitType.Train },
  ] as UnitView[];
  const player = {
    isAlive: () => true,
    id: () => "a",
    smallID: () => 1,
    name: () => "A",
    gold: () => 1000n,
    numTilesOwned: () => 100,
    units: (type: UnitType) => (type === UnitType.Train ? units : []),
    incomingAttacks: () => [],
    outgoingAttacks: () => [],
    pressure: { explicitIdle: true },
  };
  const game = {
    myPlayer: () => player,
    players: () => [player],
    ticks: () => 100,
    isTileVisible: () => visible,
    x: () => 2,
    y: () => 3,
  } as unknown as GameView;
  const el = document.createElement("idle-dashboard") as IdleDashboard;
  el.game = game;
  el.eventBus = bus;
  const emit = vi.spyOn(bus, "emit");
  document.body.append(el);
  await el.updateComplete;
  return { el, bus, emit };
}
describe("idle dashboard lifecycle", () => {
  it("focuses the dialog rather than highlighting the mobile resume button", async () => {
    const { el } = await mount();
    expect(document.activeElement).toBe(el.querySelector("dialog"));
    expect(el.querySelector("button")!.hasAttribute("tabindex")).toBe(false);
  });
  it("starts a fast hydro pullback before visible impact", () => {
    const bus = new EventBus();
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      width: 393,
      height: 852,
      left: 0,
      top: 0,
    } as DOMRect);
    const game = {
      width: () => 1000,
      height: () => 1000,
      x: (t: number) => t,
      y: () => 500,
      isTileVisible: () => true,
      config: () => ({
        msPerTick: () => 100,
        nukeMagnitudes: () => ({ outer: 100 }),
      }),
      lastViewUpdateMs: 0,
    } as unknown as GameView;
    const unit = {
      type: () => UnitType.HydrogenBomb,
      tile: () => 490,
      targetTile: () => 500,
      isActive: () => true,
      state: { lastPos: 480 },
    } as unknown as UnitView;
    const transform = new TransformHandler(game, bus, canvas);
    bus.emit(new IdleCameraEvent(true));
    bus.emit(new CinematicFollowEvent(unit));
    vi.advanceTimersByTime(200);
    expect(transform.scale).toBeLessThan(3);
    bus.emit(new IdleCameraEvent(false));
  });
  it("interrupts a train for nearby warship combat, then prefers MIRV over hydro", async () => {
    const { el, emit } = await mount();
    const ship = {
      type: () => UnitType.Warship,
      isActive: () => true,
      tile: () => 12,
      isInCombat: () => true,
      warshipState: () => ({ isInCombat: true }),
      isUnderConstruction: () => false,
    } as unknown as UnitView;
    const original = el.game.myPlayer()!.units.bind(el.game.myPlayer());
    vi.spyOn(el.game.myPlayer()!, "units").mockImplementation((type) =>
      type === UnitType.Warship ? [ship] : original(type),
    );
    vi.advanceTimersByTime(500);
    expect(emit).toHaveBeenCalledWith(new CinematicFollowEvent(ship, 5.6));
    const hydro = {
      type: () => UnitType.HydrogenBomb,
      isActive: () => true,
      tile: () => 12,
    } as UnitView;
    const mirv = {
      type: () => UnitType.MIRV,
      isActive: () => true,
      tile: () => 12,
    } as UnitView;
    Object.assign(el.game, { cinematicNukes: () => [hydro, mirv] });
    vi.advanceTimersByTime(500);
    expect(emit).toHaveBeenLastCalledWith(new CinematicFollowEvent(mirv, 4.8));
  });
  it("holds a local delivery using its actual received gold event", async () => {
    const { el, emit } = await mount();
    Object.assign(el.game, {
      cinematicDeliveries: [{ id: 1, tick: 100, tile: 12, gold: 1234 }],
    });
    vi.advanceTimersByTime(500);
    expect(el["deliveryGold"]).toBe(1234);
    expect(emit).toHaveBeenCalledWith(new GoToPositionEvent(2, 3, 5.6));
  });
  it("does not cross the map for a distant missile or return to a distant nation label", async () => {
    const { el, emit } = await mount();
    const player = el.game.myPlayer()!;
    const missile = {
      type: () => UnitType.AtomBomb,
      isActive: () => true,
      tile: () => 900,
    } as unknown as UnitView;
    Object.assign(el.game, {
      x: (tile: number) => tile,
      cinematicNukes: () => [missile],
    });
    emit.mockClear();
    vi.advanceTimersByTime(31000);
    expect(emit).not.toHaveBeenCalledWith(
      new CinematicFollowEvent(missile, 4.8),
    );
    vi.spyOn(player, "units").mockReturnValue([]);
    el["subject"] = undefined;
    Object.assign(player, {
      nameLocation: () => ({ x: 900, y: 900, size: 10 }),
    });
    emit.mockClear();
    vi.advanceTimersByTime(500);
    expect(emit).not.toHaveBeenCalledWith(new GoToPlayerEvent(player));
  });
  it("follows a specific moving unit without repeatedly resetting the camera target", () => {
    const bus = new EventBus();
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      width: 393,
      height: 852,
      left: 0,
      top: 0,
    } as DOMRect);
    const game = {
      width: () => 1000,
      height: () => 1000,
      x: (t: number) => t,
      y: () => 500,
      isTileVisible: () => true,
      config: () => ({ msPerTick: () => 100 }),
      lastViewUpdateMs: 0,
    } as unknown as GameView;
    let tile = 500;
    const unit = {
      tile: () => tile,
      isActive: () => true,
      state: { lastPos: 500 },
    } as unknown as UnitView;
    const transform = new TransformHandler(game, bus, canvas);
    bus.emit(new IdleCameraEvent(true));
    bus.emit(new CinematicFollowEvent(unit));
    vi.advanceTimersByTime(3000);
    const before = transform.offsetX;
    tile = 650;
    game.lastViewUpdateMs = performance.now();
    vi.advanceTimersByTime(3000);
    expect(transform.offsetX).toBeGreaterThan(before + 100);
    bus.emit(new IdleCameraEvent(false));
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([true, false])(
    "prioritizes nukes and only pulls back for confirmed impact (%s)",
    async (landed) => {
      const { el, emit } = await mount();
      let active = true;
      const missile = {
        type: () => UnitType.AtomBomb,
        isActive: () => active,
        tile: () => 12,
        reachedTarget: () => landed,
        state: { ownerID: 1 },
      } as unknown as UnitView;
      Object.assign(el.game, {
        cinematicNukes: () => (active ? [missile] : []),
      });
      vi.advanceTimersByTime(500);
      expect(emit).toHaveBeenCalledWith(new CinematicFollowEvent(missile, 4.8));
      active = false;
      emit.mockClear();
      vi.advanceTimersByTime(500);
      const impact = new GoToPositionEvent(2, 3, 1.8, true);
      if (landed) expect(emit).toHaveBeenCalledWith(impact);
      else expect(emit).not.toHaveBeenCalledWith(impact);
    },
  );
  it("keeps a widening group shot through visible MIRV separation", async () => {
    const { el, emit } = await mount();
    let active = true;
    const carrier = {
      type: () => UnitType.MIRV,
      isActive: () => active,
      tile: () => 12,
      reachedTarget: () => false,
      state: { ownerID: 1 },
    } as unknown as UnitView;
    const warhead = {
      type: () => UnitType.MIRVWarhead,
      isActive: () => true,
      tile: () => 12,
      state: { ownerID: 1 },
    } as unknown as UnitView;
    Object.assign(el.game, {
      cinematicNukes: () => (active ? [carrier] : [warhead]),
    });
    vi.advanceTimersByTime(500);
    active = false;
    vi.advanceTimersByTime(500);
    expect(emit).toHaveBeenCalledWith(
      new GoToPositionEvent(2, 3, 2.4, true, 0.35),
    );
    vi.advanceTimersByTime(2500);
    expect(emit).not.toHaveBeenCalledWith(
      new CinematicFollowEvent(warhead, 4.8),
    );
    expect(emit).toHaveBeenLastCalledWith(
      new GoToPositionEvent(2, 3, 2.4, true, 0.35),
    );
  });
  it("falls back to the visible nation label when there are no unit subjects", async () => {
    const { el, emit } = await mount(false);
    const player = el.game.myPlayer()!;
    vi.spyOn(player, "units").mockReturnValue([]);
    Object.assign(player, { nameLocation: () => ({ x: 20, y: 30, size: 10 }) });
    Object.assign(el.game, {
      isValidCoord: () => true,
      ref: () => 1,
      isTileVisible: () => true,
    });
    vi.advanceTimersByTime(500);
    expect(emit).toHaveBeenCalledWith(new GoToPlayerEvent(player));
  });
  it("keeps map edges outside the idle viewport on entry, tracking and resize", () => {
    const bus = new EventBus();
    const canvas = document.createElement("canvas");
    let width = 393,
      height = 852;
    Object.defineProperty(canvas, "clientWidth", { get: () => width });
    Object.defineProperty(canvas, "clientHeight", { get: () => height });
    vi.spyOn(canvas, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          left: 0,
          top: 0,
          width,
          height,
        }) as DOMRect,
    );
    const transform = new TransformHandler(
      { width: () => 1000, height: () => 500 } as GameView,
      bus,
      canvas,
    );
    transform.override(-500, -250, 0.2);
    const check = () => {
      const a = transform.screenToWorldCoordinatesFloat(0, 0);
      const b = transform.screenToWorldCoordinatesFloat(width, height);
      expect(a.x).toBeGreaterThan(0);
      expect(a.y).toBeGreaterThan(0);
      expect(b.x).toBeLessThan(1000);
      expect(b.y).toBeLessThan(500);
    };
    bus.emit(new IdleCameraEvent(true));
    check();
    bus.emit(new GoToPositionEvent(1000, 500, 3.2));
    vi.advanceTimersByTime(5000);
    check();
    width = 1920;
    height = 1080;
    transform.updateCanvasBoundingRect();
    check();
    bus.emit(new IdleCameraEvent(false));
    expect(transform.scale).toBe(0.2);
  });
  it("consumes Space before resuming", async () => {
    const { emit } = await mount();
    const downstream = vi.fn();
    window.addEventListener("keydown", downstream);
    const key = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(new SendIdleModeEvent(false));
    window.removeEventListener("keydown", downstream);
  });
  it("requires three short taps to resume", async () => {
    const { el, emit } = await mount();
    const dialog = el.querySelector("dialog")!;
    for (let i = 0; i < 2; i++) {
      dialog.dispatchEvent(
        new MouseEvent("pointerdown", { clientX: 50, clientY: 50 }),
      );
      dialog.dispatchEvent(
        new MouseEvent("pointerup", { clientX: 50, clientY: 50 }),
      );
    }
    expect(emit).not.toHaveBeenCalledWith(new SendIdleModeEvent(false));
    dialog.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 50, clientY: 50 }),
    );
    dialog.dispatchEvent(
      new MouseEvent("pointerup", { clientX: 50, clientY: 50 }),
    );
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledWith(new SendIdleModeEvent(false));
  });
  it("cleans up even when game navigation hides rather than removes the HUD", async () => {
    const { bus, emit } = await mount();
    bus.emit(new GameSessionEndedEvent());
    expect(document.body.classList.contains("idlefront-dashboard-active")).toBe(
      false,
    );
    const calls = emit.mock.calls.length;
    vi.advanceTimersByTime(20000);
    expect(emit).toHaveBeenCalledTimes(calls);
  });
  it("restores the exact native camera transform and stops its tracking timer", () => {
    const bus = new EventBus(),
      canvas = document.createElement("canvas");
    const game = { width: () => 100, height: () => 100 } as GameView;
    const transform = new TransformHandler(game, bus, canvas);
    transform.override(10, 20, 3);
    bus.emit(new IdleCameraEvent(true));
    transform.override(60, 70, 2);
    bus.emit(new GoToPositionEvent(50, 50));
    bus.emit(new IdleCameraEvent(false));
    expect([transform.offsetX, transform.offsetY, transform.scale]).toEqual([
      10, 20, 3,
    ]);
    vi.advanceTimersByTime(1000);
    expect([transform.offsetX, transform.offsetY, transform.scale]).toEqual([
      10, 20, 3,
    ]);
  });
  it("enters AFK, follows a visible native subject, and restores camera on removal", async () => {
    const { el, emit } = await mount();
    expect(emit).toHaveBeenCalledWith(new SendIdleModeEvent(true));
    expect(emit).toHaveBeenCalledWith(
      new CinematicFollowEvent(
        el.game.myPlayer()!.units(UnitType.Train)[0],
        5.6,
      ),
    );
    el.remove();
    expect(emit).toHaveBeenCalledWith(new IdleCameraEvent(false));
    expect(emit).toHaveBeenCalledWith(new SendIdleModeEvent(false));
    expect(document.body.classList.contains("idlefront-dashboard-active")).toBe(
      false,
    );
    const calls = emit.mock.calls.length;
    vi.advanceTimersByTime(20000);
    expect(emit).toHaveBeenCalledTimes(calls);
  });
  it("never directs the camera at a fog-hidden subject", async () => {
    const { emit } = await mount(false);
    vi.advanceTimersByTime(1000);
    expect(
      emit.mock.calls.some(
        ([event]) =>
          event instanceof GoToPositionEvent ||
          event instanceof CinematicFollowEvent,
      ),
    ).toBe(false);
  });
  it("honours reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const { emit } = await mount();
    expect(
      emit.mock.calls.some(
        ([event]) =>
          event instanceof GoToPositionEvent ||
          event instanceof CinematicFollowEvent,
      ),
    ).toBe(false);
  });
});

it("blocks gameplay intents on only the idle transport, and unlocks on resume", () => {
  const firstBus = new EventBus(),
    secondBus = new EventBus();
  const lobby = { gameStartInfo: { config: { gameType: GameType.Private } } };
  const first = new Transport(lobby as never, firstBus),
    second = new Transport(lobby as never, secondBus);
  const sendA = vi.fn(),
    sendB = vi.fn();
  first["socket"] = {
    readyState: WebSocket.OPEN,
    send: sendA,
  } as unknown as WebSocket;
  second["socket"] = {
    readyState: WebSocket.OPEN,
    send: sendB,
  } as unknown as WebSocket;
  firstBus.emit(new SendIdleModeEvent(true));
  sendA.mockClear();
  firstBus.emit(new SendMobilisationIntentEvent(0.7));
  firstBus.emit(
    new SendFleetOrdersEvent({
      enabled: true,
      target: 2,
      reserve: 0,
      ports: [],
      order: "defend",
    }),
  );
  expect(sendA).not.toHaveBeenCalled();
  secondBus.emit(new SendMobilisationIntentEvent(0.7));
  expect(sendB).toHaveBeenCalledTimes(1);
  firstBus.emit(new SendIdleModeEvent(false));
  sendA.mockClear();
  firstBus.emit(new SendMobilisationIntentEvent(0.7));
  expect(sendA).toHaveBeenCalledTimes(1);
});
