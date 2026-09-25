import type { LitElement } from "lit";
import {
  AtlasGauge,
  AtlasNavItem,
  AtlasStatusLamp,
  AtlasSurface,
} from "../../src/client/components/AtlasPrimitives";

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("Pressure Atlas UI primitives", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("surfaces expose semantic material and elevation hooks", async () => {
    const surface = new AtlasSurface();
    surface.material = "felt";
    surface.elevation = "inset";
    await mount(surface);

    const compositor = surface.querySelector(".atlas-material-surface");
    expect(compositor?.classList).toContain("atlas-material-felt");
    expect(compositor?.classList).toContain("atlas-elevation-inset");
  });

  test("gauges clamp progress and expose an accessible meter", async () => {
    const gauge = new AtlasGauge();
    gauge.label = "Reserve";
    gauge.value = "100%";
    gauge.progress = 1.8;
    await mount(gauge);

    const meter = gauge.querySelector<HTMLElement>('[role="meter"]');
    expect(meter?.getAttribute("aria-label")).toBe("Reserve");
    expect(meter?.getAttribute("aria-valuenow")).toBe("100");
    expect(meter?.style.getPropertyValue("--atlas-gauge-progress")).toBe(
      "270deg",
    );
  });

  test("navigation items preserve canonical page routing hooks", async () => {
    const item = new AtlasNavItem();
    item.page = "page-settings";
    item.i18nKey = "main.settings";
    item.label = "Settings";
    item.active = true;
    await mount(item);

    const button = item.querySelector("button");
    expect(button?.dataset.page).toBe("page-settings");
    expect(button?.dataset.i18n).toBe("main.settings");
    expect(button?.classList).toContain("nav-menu-item");
    expect(button?.classList).toContain("active");
  });

  test("status lamps expose a translated live status", async () => {
    const status = new AtlasStatusLamp();
    status.label = "World online";
    status.i18nKey = "pressure_atlas.world_online";
    await mount(status);

    expect(status.querySelector('[role="status"]')).not.toBeNull();
    expect(status.querySelector("[data-i18n]")?.getAttribute("data-i18n")).toBe(
      "pressure_atlas.world_online",
    );
  });
});
