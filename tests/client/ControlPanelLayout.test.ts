import { ControlPanel } from "../../src/client/hud/layers/ControlPanel";

describe("control-panel layout", () => {
  it("labels total population separately from available and deployed military", async () => {
    const panel = new ControlPanel();
    const player = {
      troops: () => 16100,
      totalUnitLevels: () => 3,
      pressure: {
        civilians: 19400,
        military: 18530,
        target: 0.5,
        effectiveTarget: 0.5,
        automatic: false,
        growthPerSecond: 125,
        autoDefenceEnabled: true,
      },
    };
    panel.game = {
      myPlayer: () => player,
      elapsedGameSeconds: () => 68,
      config: () => ({
        maxTroops: () => 577000,
        gameConfig: () => ({
          continuousPressure: "v1",
          pressureGraceSeconds: 180,
        }),
      }),
    } as any;
    document.body.append(panel);
    await panel.updateComplete;
    const text = panel.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("+12.5/sec");
    expect(
      panel.querySelector('[aria-label="Population growth per second"]')
        ?.textContent,
    ).toContain("+12.5/sec");
    expect(
      panel.querySelector('[aria-label="Total population"]')?.textContent,
    ).not.toContain("/sec");
    player.pressure.growthPerSecond = 245000;
    panel.requestUpdate();
    await panel.updateComplete;
    expect(
      panel.querySelector('[aria-label="Population growth per second"]')
        ?.textContent,
    ).toContain("+24.5k/sec");
    expect(text).not.toContain("Civilians");
    expect(text).not.toContain("Available 1.61K");
    const compact = panel.querySelector(".atlas-mobilisation-compact")!;
    expect(compact.querySelectorAll("population-ratio-slider")).toHaveLength(2);
    expect(text).not.toContain("Grace 1:52");
    expect(panel.querySelector(".atlas-actual-troops")).toBeNull();
    const emit = vi.fn();
    panel.eventBus = { emit } as any;
    expect(
      compact.querySelector('[aria-label="Automatic AFK defence"]'),
    ).toBeNull();
    const dials = compact.querySelectorAll("population-ratio-slider");
    for (const slider of dials) await slider.updateComplete;
    expect(compact.querySelectorAll('input[type="range"]')).toHaveLength(2);
    expect(dials[0].label).toBe("attack");
    expect(dials[0].querySelector(".atlas-ratio-bar-value")?.textContent).toBe(
      "322",
    );
    expect(dials[1].label).toBe("troops");
    expect(dials[1].querySelector(".atlas-ratio-bar-value")?.textContent).toBe(
      "1.85K",
    );
    expect(dials[1].value).toBe(50);
    expect(compact.querySelectorAll("output")).toHaveLength(2);
    dials[1].value = 100;
    await dials[1].updateComplete;
    expect(dials[1].querySelector("output")!.textContent).toBe("100%");
    expect(dials[1].min).toBe(0);
    expect(dials[0].classList.contains("atlas-primary-attack")).toBe(true);
    expect(dials[1].classList.contains("atlas-population-dial")).toBe(true);
    const register = compact.querySelector(".atlas-structure-register")!;
    expect(compact.lastElementChild).toBe(register);
    expect(register.querySelectorAll("button")).toHaveLength(6);
    const city = register.querySelector("button")!;
    city.click();
    await panel.updateComplete;
    expect(city.getAttribute("aria-pressed")).toBe("true");
    expect(
      emit.mock.calls[emit.mock.calls.length - 1][0].structureTypes,
    ).toHaveLength(1);
    city.click();
    await panel.updateComplete;
    expect(
      emit.mock.calls[emit.mock.calls.length - 1][0].structureTypes,
    ).toBeNull();
    for (const meter of panel.querySelectorAll(
      '[aria-label="Total population"]',
    )) {
      expect(meter.getAttribute("aria-valuenow")).toBe("37930");
      expect(meter.getAttribute("aria-valuemax")).toBe("577000");
      expect(meter.getAttribute("aria-valuetext")).toContain(
        "available military 1.61K, deployed military 243",
      );
    }
    expect(
      panel.querySelectorAll('[aria-label="Total population"]'),
    ).toHaveLength(1);
  });
  afterEach(() => {
    document
      .querySelectorAll("control-panel")
      .forEach((panel) => panel.remove());
  });

  it("omits the duplicate structure count in both layouts and keeps both dials", async () => {
    const panel = new ControlPanel();
    document.body.append(panel);
    await panel.updateComplete;

    expect(panel.querySelector(".atlas-structure-count")).toBeNull();
    expect(panel.querySelectorAll("attack-ratio-dial")).toHaveLength(2);
    const desktop = panel.querySelector(".atlas-desktop-control-layout");
    expect(desktop?.children).toHaveLength(2);
    expect(desktop?.lastElementChild?.tagName).toBe("ATTACK-RATIO-DIAL");
    expect(
      panel.querySelector(".atlas-mobile-control-ledger")?.children,
    ).toHaveLength(2);

    for (const dial of panel.querySelectorAll("attack-ratio-dial")) {
      await dial.updateComplete;
      expect(dial.querySelector(".atlas-attack-dial__ratio")?.textContent).toBe(
        "20%",
      );
    }
  });
});
