import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openDeveloperMenu,
  recordDeveloperMenuLogoTap,
  resetDeveloperMenuTapSequence,
  type IdleFrontDeveloperMenu,
} from "../../src/client/components/DeveloperMenu";

describe("secret developer menu", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetDeveloperMenuTapSequence();
  });

  afterEach(() => {
    document.querySelector("idlefront-developer-menu")?.remove();
    document.body.classList.remove("atlas-dev-menu-open");
  });

  it("opens only after seven logo taps", async () => {
    for (let tap = 0; tap < 6; tap++) recordDeveloperMenuLogoTap(tap * 100);
    expect(document.querySelector("idlefront-developer-menu")).toBeNull();

    recordDeveloperMenuLogoTap(600, { x: 32, y: 48 });
    const menu = document.querySelector<IdleFrontDeveloperMenu>(
      "idlefront-developer-menu",
    );
    expect(menu).not.toBeNull();
    expect(menu!.style.getPropertyValue("--atlas-dev-origin-x")).toBe("32px");
    expect(menu!.style.getPropertyValue("--atlas-dev-origin-y")).toBe("48px");
    await menu!.updateComplete;
    expect(menu!.querySelector(".atlas-dev-menu__unlock-flare")).not.toBeNull();
    expect(menu!.querySelector('a[href="/?ui-lab=1"]')).not.toBeNull();
    expect(
      menu!.querySelector('a[href="/?ui-lab=stone-buttons"]'),
    ).not.toBeNull();
  });

  it("expires an incomplete tap sequence and keeps the menu singleton", () => {
    for (let tap = 0; tap < 6; tap++) {
      expect(recordDeveloperMenuLogoTap(tap * 100)).toBe(false);
    }
    expect(recordDeveloperMenuLogoTap(5_000)).toBe(false);
    expect(document.querySelector("idlefront-developer-menu")).toBeNull();

    for (let tap = 1; tap < 7; tap++) {
      recordDeveloperMenuLogoTap(5_000 + tap * 100);
    }
    const first = document.querySelector("idlefront-developer-menu");
    expect(first).not.toBeNull();
    expect(openDeveloperMenu()).toBe(first);
    expect(document.querySelectorAll("idlefront-developer-menu")).toHaveLength(
      1,
    );
  });

  it("closes from its explicit close control", async () => {
    const menu = openDeveloperMenu();
    await menu.updateComplete;
    menu
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Close developer menu"]',
      )!
      .click();
    expect(document.querySelector("idlefront-developer-menu")).toBeNull();
  });
});
