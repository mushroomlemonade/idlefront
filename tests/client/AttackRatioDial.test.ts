import {
  AttackRatioDial,
  attackRatioFromDialRotation,
  attackRatioFromLinearDrag,
  attackRatioFromVerticalDrag,
  clampAttackRatioPercent,
} from "../../src/client/components/AttackRatioDial";

function pointerEvent(
  type: string,
  init: {
    clientX?: number;
    clientY: number;
    pointerId?: number;
    pointerType?: string;
    button?: number;
  },
): PointerEvent {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX ?? 100 },
    clientY: { value: init.clientY },
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? "touch" },
  });
  return event as PointerEvent;
}

describe("attack-ratio-dial", () => {
  let element: AttackRatioDial;

  afterEach(() => {
    element?.remove();
    vi.useRealTimers();
  });

  async function mount(value = 20): Promise<HTMLElement> {
    element = document.createElement("attack-ratio-dial");
    element.value = value;
    document.body.append(element);
    await element.updateComplete;
    const control = element.querySelector<HTMLElement>(
      ".atlas-attack-dial__touchfield",
    );
    if (!control) throw new Error("Attack ratio dial did not render");
    Object.defineProperties(control, {
      setPointerCapture: { value: vi.fn(), configurable: true },
      hasPointerCapture: { value: vi.fn(() => true), configurable: true },
      releasePointerCapture: { value: vi.fn(), configurable: true },
    });
    return control;
  }

  test("clamps ratios and maps a vertical gesture to percentage points", () => {
    expect(clampAttackRatioPercent(-12)).toBe(1);
    expect(clampAttackRatioPercent(155)).toBe(100);
    expect(attackRatioFromVerticalDrag(20, 200, 142.5)).toBe(70);
    expect(attackRatioFromVerticalDrag(80, 100, 200)).toBe(1);
    expect(attackRatioFromLinearDrag(50, 100, 100, 50, 100)).toBe(7);
    expect(attackRatioFromLinearDrag(50, 100, 100, 100, 150)).toBe(7);
    expect(attackRatioFromLinearDrag(50, 100, 100, 150, 100)).toBe(93);
    expect(attackRatioFromDialRotation(20, 90)).toBe(53);
  });

  test("renders one accessible, generously sized slider target", async () => {
    const control = await mount(35);
    element.displayValue = "84K";
    await element.updateComplete;

    expect(control.getAttribute("role")).toBe("slider");
    expect(control.getAttribute("aria-valuemin")).toBe("1");
    expect(control.getAttribute("aria-valuemax")).toBe("100");
    expect(control.getAttribute("aria-valuenow")).toBe("35");
    expect(control.getAttribute("aria-valuetext")).toContain("35%; 84K");
    expect(
      element.querySelector(".atlas-attack-dial__value")?.textContent,
    ).toBe("84K");
    expect(
      element.querySelector(".atlas-attack-dial__ratio")?.textContent,
    ).toBe("35%");
    expect(element.querySelector("input")).toBeNull();
  });

  test("supports a zero military target without changing attack minimum", async () => {
    const control = await mount(50);
    element.min = 0;
    await element.updateComplete;
    control.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    await element.updateComplete;
    expect(element.value).toBe(0);
    expect(control.getAttribute("aria-valuemin")).toBe("0");
    control.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(element.value).toBe(1);
  });

  test("keeps the percentage alongside troop counts at rest and after a gesture", async () => {
    const control = await mount(100);
    element.displayValue = "1.2M";
    await element.updateComplete;
    const percentage = () =>
      element.querySelector(".atlas-attack-dial__ratio")?.textContent;
    expect(percentage()).toBe("100%");
    expect(element.hasAttribute("data-dragging")).toBe(false);

    control.dispatchEvent(pointerEvent("pointerdown", { clientY: 100 }));
    control.dispatchEvent(pointerEvent("pointermove", { clientY: 300 }));
    await element.updateComplete;
    expect(percentage()).toBe("1%");
    control.dispatchEvent(pointerEvent("pointerup", { clientY: 300 }));
    await element.updateComplete;
    expect(percentage()).toBe("1%");
    expect(
      element.querySelector(".atlas-attack-dial__value")?.textContent,
    ).toBe("1.2M");
  });

  test("increases on upward drag and decreases on downward drag", async () => {
    const control = await mount(20);
    const changes: number[] = [];
    element.addEventListener("attack-ratio-input", (event) => {
      changes.push((event as CustomEvent<{ value: number }>).detail.value);
    });

    control.dispatchEvent(pointerEvent("pointerdown", { clientY: 200 }));
    control.dispatchEvent(pointerEvent("pointermove", { clientY: 142.5 }));
    await element.updateComplete;
    expect(changes[changes.length - 1]).toBe(70);
    expect(control.getAttribute("aria-valuenow")).toBe("70");

    control.dispatchEvent(pointerEvent("pointermove", { clientY: 257.5 }));
    await element.updateComplete;
    expect(changes[changes.length - 1]).toBe(1);

    control.dispatchEvent(pointerEvent("pointerup", { clientY: 257.5 }));
    expect(element.hasAttribute("data-dragging")).toBe(false);
  });

  test("rotates on the face, then hands off to linear dragging outside it", async () => {
    const control = await mount(20);
    const bezel = element.querySelector<HTMLElement>(
      ".atlas-attack-dial__bezel",
    );
    if (!bezel) throw new Error("Attack ratio bezel did not render");
    bezel.getBoundingClientRect = vi.fn(
      () =>
        ({
          bottom: 150,
          height: 100,
          left: 50,
          right: 150,
          top: 50,
          width: 100,
          x: 50,
          y: 50,
          toJSON: () => ({}),
        }) as DOMRect,
    );

    control.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 100, clientY: 50 }),
    );
    expect(element.getAttribute("data-gesture-mode")).toBe("dial");

    control.dispatchEvent(
      pointerEvent("pointermove", { clientX: 150, clientY: 100 }),
    );
    expect(element.value).toBe(53);

    control.dispatchEvent(
      pointerEvent("pointermove", { clientX: 175, clientY: 100 }),
    );
    expect(element.getAttribute("data-gesture-mode")).toBe("linear");

    control.dispatchEvent(
      pointerEvent("pointermove", { clientX: 140, clientY: 100 }),
    );
    expect(element.value).toBe(23);
  });

  test("reverses immediately after an over-drag reaches either limit", async () => {
    const control = await mount(95);

    control.dispatchEvent(pointerEvent("pointerdown", { clientY: 200 }));
    control.dispatchEvent(pointerEvent("pointermove", { clientY: 100 }));
    expect(element.value).toBe(100);

    control.dispatchEvent(pointerEvent("pointermove", { clientY: 98 }));
    expect(element.value).toBe(100);

    control.dispatchEvent(pointerEvent("pointermove", { clientY: 100 }));
    expect(element.value).toBe(98);

    control.dispatchEvent(pointerEvent("pointermove", { clientY: 300 }));
    expect(element.value).toBe(1);

    control.dispatchEvent(pointerEvent("pointermove", { clientY: 298 }));
    expect(element.value).toBe(3);
  });

  test("keeps its pointer independent while a second finger acts on the map", async () => {
    const control = await mount(20);
    const map = document.createElement("canvas");
    const mapEvents: Array<[string, number]> = [];
    map.addEventListener("pointerdown", (event) => {
      mapEvents.push([event.type, event.pointerId]);
    });
    map.addEventListener("pointerup", (event) => {
      mapEvents.push([event.type, event.pointerId]);
    });
    document.body.append(map);

    control.dispatchEvent(
      pointerEvent("pointerdown", {
        clientX: 100,
        clientY: 200,
        pointerId: 1,
      }),
    );
    map.dispatchEvent(
      pointerEvent("pointerdown", {
        clientX: 30,
        clientY: 300,
        pointerId: 2,
      }),
    );
    map.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: 30,
        clientY: 300,
        pointerId: 2,
      }),
    );

    expect(mapEvents).toEqual([
      ["pointerdown", 2],
      ["pointerup", 2],
    ]);
    expect(element.hasAttribute("data-dragging")).toBe(true);

    control.dispatchEvent(
      pointerEvent("pointermove", {
        clientX: 100,
        clientY: 142.5,
        pointerId: 1,
      }),
    );
    expect(element.value).toBe(70);

    control.dispatchEvent(
      pointerEvent("pointerup", {
        clientX: 100,
        clientY: 142.5,
        pointerId: 1,
      }),
    );
    expect(element.hasAttribute("data-dragging")).toBe(false);
    map.remove();
  });

  test("does not let a second pointer steal an active dial gesture", async () => {
    const control = await mount(20);

    control.dispatchEvent(
      pointerEvent("pointerdown", { clientY: 200, pointerId: 1 }),
    );
    control.dispatchEvent(
      pointerEvent("pointerdown", { clientY: 120, pointerId: 2 }),
    );
    control.dispatchEvent(
      pointerEvent("pointermove", { clientY: 142.5, pointerId: 1 }),
    );

    expect(element.value).toBe(70);
    expect(element.hasAttribute("data-dragging")).toBe(true);

    control.dispatchEvent(
      pointerEvent("pointerup", { clientY: 142.5, pointerId: 1 }),
    );
    expect(element.hasAttribute("data-dragging")).toBe(false);
  });

  test("uses the configured coarse step for wheel input over the dial", async () => {
    const control = await mount(20);
    element.step = 10;
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -100,
    });

    control.dispatchEvent(wheel);
    await element.updateComplete;

    expect(wheel.defaultPrevented).toBe(true);
    expect(element.value).toBe(30);
    expect(control.getAttribute("aria-valuenow")).toBe("30");
  });

  test("supports precise arrows and coarse keyboard commands", async () => {
    const control = await mount(20);
    element.step = 10;

    control.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowUp",
      }),
    );
    expect(element.value).toBe(21);

    control.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "PageUp",
      }),
    );
    expect(element.value).toBe(31);

    control.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "End",
      }),
    );
    await element.updateComplete;
    expect(element.value).toBe(100);
    expect(control.getAttribute("aria-valuenow")).toBe("100");
  });
});
