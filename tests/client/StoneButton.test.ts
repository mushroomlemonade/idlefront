import fs from "fs";
import path from "path";
import {
  IdlefrontStoneButton,
  STONE_BUTTON_MIRRORS,
  STONE_BUTTON_SIZES,
  STONE_BUTTON_VARIANTS,
  stoneButtonMirrorFor,
} from "../../src/client/components/StoneButton";

type FrameCallback = (time: number) => void;

function pointerEvent(
  type: string,
  init: { clientX: number; clientY: number; pointerId?: number },
): PointerEvent {
  const event = new Event(type, { bubbles: true, composed: true });
  Object.defineProperties(event, {
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: "touch" },
  });
  return event as PointerEvent;
}

function keyEvent(type: string, key: string): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, key });
}

describe("idlefront-stone-button", () => {
  let element: IdlefrontStoneButton;

  afterEach(() => {
    element?.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount(): Promise<HTMLButtonElement> {
    document.body.append(element);
    await element.updateComplete;
    const control = element.shadowRoot?.querySelector("button");
    if (!(control instanceof HTMLButtonElement)) {
      throw new Error("Stone button did not render its native control");
    }
    return control;
  }

  test("renders the public material, size, and named-slot API around a native button", async () => {
    element = document.createElement("idlefront-stone-button");
    element.variant = "amethyst";
    element.size = "hero";
    element.type = "reset";
    element.name = "world-action";
    element.value = "join";
    element.accessibleLabel = "Join Violet Reach";
    element.innerHTML = `
      <svg slot="icon" aria-hidden="true"></svg>
      <span slot="label">Join world</span>
      <small slot="detail">Three players online</small>
    `;

    const control = await mount();
    const root = element.shadowRoot;
    const hasInlineStyles =
      (root?.querySelector("style")?.textContent.length ?? 0) > 0;
    const hasAdoptedStyles = (root?.adoptedStyleSheets?.length ?? 0) > 0;

    expect(STONE_BUTTON_VARIANTS).toEqual([
      "quartz",
      "obsidian",
      "amethyst",
      "ruby",
      "emerald",
    ]);
    expect(STONE_BUTTON_SIZES).toEqual(["compact", "standard", "hero"]);
    expect(STONE_BUTTON_MIRRORS).toEqual(["auto", "normal", "flipped"]);
    expect(element.getAttribute("variant")).toBe("amethyst");
    expect(element.getAttribute("size")).toBe("hero");
    expect(control.type).toBe("reset");
    expect(control.name).toBe("world-action");
    expect(control.value).toBe("join");
    expect(control.getAttribute("aria-label")).toBe("Join Violet Reach");
    expect(hasInlineStyles || hasAdoptedStyles).toBe(true);
    expect(
      element.shadowRoot?.querySelector('slot[name="icon"]'),
    ).not.toBeNull();
    expect(
      element.shadowRoot?.querySelector('slot[name="label"]'),
    ).not.toBeNull();
    expect(
      element.shadowRoot?.querySelector('slot[name="detail"]'),
    ).not.toBeNull();
    expect(
      element.shadowRoot?.querySelector("slot:not([name])"),
    ).not.toBeNull();
    expect(element.querySelector('[slot="icon"]')).not.toBeNull();
    expect(element.querySelector('[slot="label"]')?.textContent).toBe(
      "Join world",
    );
    expect(element.querySelector('[slot="detail"]')?.textContent).toBe(
      "Three players online",
    );
  });

  test("deterministically mirrors the existing cut from variant and stable content", async () => {
    const seen = new Set(
      Array.from({ length: 80 }, (_, index) =>
        stoneButtonMirrorFor("quartz", `world-action-${index}`),
      ),
    );

    expect(seen).toEqual(new Set(["normal", "flipped"]));
    expect(stoneButtonMirrorFor("ruby", "Join world")).toBe(
      stoneButtonMirrorFor("ruby", "Join world"),
    );

    element = document.createElement("idlefront-stone-button");
    element.variant = "emerald";
    element.innerHTML = `
      <span slot="label">  Return   to world </span>
      <span slot="detail">Three players online</span>
    `;
    await mount();
    const assembly =
      element.shadowRoot?.querySelector<HTMLElement>(".assembly");
    const firstMirror = assembly?.dataset.mirror;

    expect(firstMirror).toBe(
      stoneButtonMirrorFor("emerald", "Return to world Three players online"),
    );

    element.loading = true;
    await element.updateComplete;
    expect(assembly?.dataset.mirror).toBe(firstMirror);
  });

  test("supports a stable shape key and explicit designer orientation", async () => {
    element = document.createElement("idlefront-stone-button");
    element.variant = "amethyst";
    element.shapeKey = "lobby-primary-action";
    element.innerHTML = `<span slot="label">Send</span>`;
    await mount();
    const assembly =
      element.shadowRoot?.querySelector<HTMLElement>(".assembly");
    const keyedMirror = stoneButtonMirrorFor(
      "amethyst",
      "lobby-primary-action",
    );

    expect(assembly?.dataset.mirror).toBe(keyedMirror);

    element.querySelector('[slot="label"]')!.textContent = "Sending";
    element.requestUpdate();
    await element.updateComplete;
    expect(assembly?.dataset.mirror).toBe(keyedMirror);

    element.mirror = "flipped";
    await element.updateComplete;
    expect(element.getAttribute("mirror")).toBe("flipped");
    expect(assembly?.dataset.mirror).toBe("flipped");
  });

  test("keeps the hitbox rectangular while quietly mirroring paint radii", () => {
    const styleText = String(IdlefrontStoneButton.styles);

    expect(styleText).toContain('.assembly[data-mirror="flipped"]');
    expect(styleText).toContain("--stone-radius-flipped");
    expect(styleText).toContain("--stone-texture-flip");
    expect(styleText).not.toContain("clip-path");
    expect(styleText).toContain("border-radius: var(--stone-radius)");
    expect(styleText).toContain("contain: layout style");
  });

  test("offers an explicitly controlled toggle mode with native pressed semantics", async () => {
    element = document.createElement("idlefront-stone-button");
    element.setAttribute("pressed", "false");
    const requested: boolean[] = [];
    element.addEventListener("stone-toggle-request", (event) => {
      requested.push(
        (event as CustomEvent<{ pressed: boolean }>).detail.pressed,
      );
    });
    const control = await mount();

    expect(element.pressed).toBe(false);
    expect(element.getAttribute("pressed")).toBe("false");
    expect(control.getAttribute("aria-pressed")).toBe("false");

    control.click();
    expect(requested).toEqual([true]);
    expect(element.pressed).toBe(false);
    expect(control.getAttribute("aria-pressed")).toBe("false");

    element.pressed = true;
    await element.updateComplete;
    expect(element.getAttribute("pressed")).toBe("true");
    expect(control.getAttribute("aria-pressed")).toBe("true");

    control.click();
    expect(requested).toEqual([true, false]);
    expect(element.pressed).toBe(true);

    element.pressed = undefined;
    await element.updateComplete;
    expect(element.hasAttribute("pressed")).toBe(false);
    expect(control.hasAttribute("aria-pressed")).toBe(false);
    control.click();
    expect(requested).toEqual([true, false]);
  });

  test("uses translucent neutral bodies and denser colored stone transmission", () => {
    const styleText = String(IdlefrontStoneButton.styles);

    expect(styleText).toContain("--stone-body-opacity: 44%");
    expect(styleText).toContain("--stone-body-opacity: 60%");
    expect(styleText).toContain("--stone-body-opacity: 90%");
    expect(styleText).toContain("--stone-mineral-opacity");
    expect(styleText).toContain("backdrop-filter");
    expect(styleText).toContain("var(--stone-light-body)");
  });

  test("gives each size meaningful hover travel while keeping reduced motion flat", () => {
    const styleText = String(IdlefrontStoneButton.styles);

    expect(styleText).toContain("--stone-hover-lift: 1.5px");
    expect(styleText).toContain("--stone-hover-lift: 2.25px");
    expect(styleText).toContain("--stone-hover-lift: 3px");
    expect(styleText).toContain(
      "calc(var(--stone-press-depth) + var(--stone-hover-offset))",
    );
    expect(styleText).toContain("translateY(var(--stone-press-depth))");
  });

  test("ships high-resolution optical maps through separate depth and caustic planes", () => {
    const styleText = String(IdlefrontStoneButton.styles);

    for (const variant of STONE_BUTTON_VARIANTS) {
      const materialPath = path.join(
        process.cwd(),
        "resources",
        "images",
        "ui",
        "materials",
        "stones",
        `${variant}.webp`,
      );
      const material = fs.readFileSync(materialPath);

      expect(material.byteLength).toBeGreaterThan(150_000);
      expect(material.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(material.subarray(8, 12).toString("ascii")).toBe("WEBP");
      expect(styleText).toContain(
        `/images/ui/materials/stones/${variant}.webp`,
      );
    }

    expect(styleText).toContain(".marbling::before");
    expect(styleText).toContain(".projection::before");
    expect(styleText).toContain("var(--stone-image)");
  });

  test("clips every face optic on its own WebKit-safe plane", async () => {
    element = document.createElement("idlefront-stone-button");
    await mount();
    const faceMask = element.shadowRoot?.querySelector(".face-mask");

    expect(
      Array.from(faceMask?.children ?? [], (child) => child.className),
    ).toEqual([
      "base",
      "mineral",
      "marbling",
      "frost",
      "diffraction",
      "ridge",
      "glare",
      "impact",
    ]);
    const styleText = String(IdlefrontStoneButton.styles);
    expect(styleText).toContain("overflow: clip");
    expect(styleText).toContain(
      "-webkit-mask-image: -webkit-radial-gradient(white, black)",
    );
  });

  test("anchors impact at the tap while freezing hover parallax during a press", async () => {
    const frames = new Map<number, FrameCallback>();
    let frameId = 0;
    const requestFrame = vi.fn((callback: FrameCallback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    element = document.createElement("idlefront-stone-button");
    const control = await mount();
    vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 210,
      bottom: 120,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    });

    control.dispatchEvent(
      pointerEvent("pointermove", { clientX: 190, clientY: 95 }),
    );
    expect(requestFrame).toHaveBeenCalledTimes(1);
    frames.get(1)?.(0);
    expect(element.style.getPropertyValue("--stone-tilt-x")).toBe("-1.050deg");
    expect(element.style.getPropertyValue("--stone-tilt-y")).toBe("2.160deg");
    expect(element.style.getPropertyValue("--stone-parallax-x")).toBe(
      "2.080px",
    );
    expect(element.style.getPropertyValue("--stone-parallax-y")).toBe(
      "0.950px",
    );

    control.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 60, clientY: 45 }),
    );

    expect(element.style.getPropertyValue("--stone-origin-x")).toBe("25.00%");
    expect(element.style.getPropertyValue("--stone-origin-y")).toBe("25.00%");
    expect(element.hasAttribute("data-pressed")).toBe(true);
    expect(
      element.shadowRoot?.querySelector<HTMLElement>(".impact")?.dataset.impact,
    ).toBe("a");
    expect(element.style.getPropertyValue("--stone-tilt-x")).toBe("0deg");
    expect(element.style.getPropertyValue("--stone-tilt-y")).toBe("0deg");
    expect(element.style.getPropertyValue("--stone-parallax-x")).toBe("0px");
    expect(element.style.getPropertyValue("--stone-parallax-y")).toBe("0px");

    control.dispatchEvent(
      pointerEvent("pointermove", { clientX: 210, clientY: 70 }),
    );
    expect(requestFrame).toHaveBeenCalledTimes(1);

    control.dispatchEvent(
      pointerEvent("pointercancel", { clientX: 210, clientY: 70 }),
    );
    expect(element.hasAttribute("data-pressed")).toBe(false);
  });

  test("tracks hover from the stable assembly rather than the transformed face", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    element = document.createElement("idlefront-stone-button");
    const control = await mount();
    const assembly =
      element.shadowRoot?.querySelector<HTMLElement>(".assembly");
    if (!assembly) throw new Error("Stone button assembly was not rendered");

    control.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 10 }),
    );
    expect(element.hasAttribute("data-pressed")).toBe(true);

    // A tilted child may momentarily leave the pointer hit-test. That must not
    // release the visual press or flip the cursor while its stable assembly is
    // still under the pointer.
    control.dispatchEvent(new Event("pointerleave"));
    expect(element.hasAttribute("data-pressed")).toBe(true);

    assembly.dispatchEvent(new Event("pointerleave"));
    expect(element.hasAttribute("data-pressed")).toBe(true);

    control.dispatchEvent(
      pointerEvent("pointercancel", { clientX: 10, clientY: 10 }),
    );
    expect(element.hasAttribute("data-pressed")).toBe(false);
    expect(String(IdlefrontStoneButton.styles)).toContain("cursor: inherit");
  });

  test("cancels a queued animation frame when removed", async () => {
    const cancelFrame = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 73),
    );
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    element = document.createElement("idlefront-stone-button");
    const control = await mount();
    control.dispatchEvent(
      pointerEvent("pointermove", { clientX: 12, clientY: 18 }),
    );
    element.remove();

    expect(cancelFrame).toHaveBeenCalledWith(73);
    expect(element.hasAttribute("data-pressed")).toBe(false);
  });

  test("uses native disabled behavior for both disabled and loading states", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    element = document.createElement("idlefront-stone-button");
    element.disabled = true;
    const control = await mount();
    const onClick = vi.fn();
    element.addEventListener("click", onClick);

    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    control.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 10, clientY: 10 }),
    );
    control.click();
    expect(element.hasAttribute("data-pressed")).toBe(false);
    expect(onClick).not.toHaveBeenCalled();

    element.disabled = false;
    element.loading = true;
    await element.updateComplete;
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(element.shadowRoot?.querySelector(".spinner")).not.toBeNull();

    element.loading = false;
    await element.updateComplete;
    expect(control.disabled).toBe(false);
    expect(control.hasAttribute("aria-busy")).toBe(false);
    expect(element.shadowRoot?.querySelector(".spinner")).toBeNull();
  });

  test("mirrors native keyboard press feedback without replacing activation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    element = document.createElement("idlefront-stone-button");
    const control = await mount();
    const onClick = vi.fn();
    element.addEventListener("click", onClick);

    control.dispatchEvent(keyEvent("keydown", "Enter"));
    expect(element.hasAttribute("data-pressed")).toBe(true);
    expect(
      element.shadowRoot?.querySelector<HTMLElement>(".impact")?.dataset.impact,
    ).toBe("a");

    control.dispatchEvent(keyEvent("keyup", "Enter"));
    expect(element.hasAttribute("data-pressed")).toBe(true);
    vi.advanceTimersByTime(149);
    expect(element.hasAttribute("data-pressed")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(element.hasAttribute("data-pressed")).toBe(false);

    control.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("keeps a rapid Mac-style pointer click visibly depressed for one painted beat", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    element = document.createElement("idlefront-stone-button");
    const control = await mount();

    control.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 24, clientY: 18 }),
    );
    control.dispatchEvent(
      pointerEvent("pointerup", { clientX: 24, clientY: 18 }),
    );

    expect(element.hasAttribute("data-pressed")).toBe(true);
    vi.advanceTimersByTime(149);
    expect(element.hasAttribute("data-pressed")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(element.hasAttribute("data-pressed")).toBe(false);
    expect(String(IdlefrontStoneButton.styles)).toContain(
      ".stone-button:active:not(:disabled)",
    );
    expect(String(IdlefrontStoneButton.styles)).toContain(
      "transform: translate3d(0, var(--stone-lip), 0) scale(0.985)",
    );
  });
});
