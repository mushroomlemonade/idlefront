import { createHudReferenceGame } from "../../src/client/components/AtlasHudReference";
import { ActionableEvents } from "../../src/client/hud/layers/ActionableEvents";
import { ControlPanel } from "../../src/client/hud/layers/ControlPanel";
import { GameLeftSidebar } from "../../src/client/hud/layers/GameLeftSidebar";
import { GameRightSidebar } from "../../src/client/hud/layers/GameRightSidebar";
import { PlayerInfoOverlay } from "../../src/client/hud/layers/PlayerInfoOverlay";
import { ShowSettingsModalEvent } from "../../src/client/hud/layers/SettingsModal";
import { UnitDisplay } from "../../src/client/hud/layers/UnitDisplay";
import type { TransformHandler } from "../../src/client/TransformHandler";
import { SendAllianceRequestIntentEvent } from "../../src/client/Transport";
import type { UIState } from "../../src/client/UIState";
import { EventBus } from "../../src/core/EventBus";
import { GameUpdateType } from "../../src/core/game/GameUpdates";

describe("minimal HUD reference uses production controllers", () => {
  const game = createHudReferenceGame();
  let eventBus: EventBus;
  const uiState: UIState = {
    attackRatio: 0.2,
    ghostStructure: null,
    rocketDirectionUp: false,
    upgradeMultiplier: 1,
  };
  beforeEach(() => {
    eventBus = new EventBus();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("starts standings collapsed on desktop and toggles with a native button", async () => {
    const left = new GameLeftSidebar();
    left.game = game;
    left.eventBus = eventBus;
    document.body.append(left);
    left.init();
    left.tick();
    await left.updateComplete;
    const button = left.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    button.click();
    await left.updateComplete;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    button.click();
    await left.updateComplete;
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("retains settings behavior on a keyboard-accessible native control", async () => {
    const right = new GameRightSidebar();
    right.game = game;
    right.eventBus = eventBus;
    const settings = vi.fn();
    eventBus.on(ShowSettingsModalEvent, settings);
    document.body.append(right);
    right.init();
    right.tick();
    await right.updateComplete;
    right
      .querySelector<HTMLButtonElement>('button:has(img[alt="settings"])')!
      .click();
    expect(settings).toHaveBeenCalledOnce();
    expect(right.querySelectorAll(".cursor-pointer:not(button)")).toHaveLength(
      0,
    );
  });

  it("shows troop growth once per responsive layout and keeps a live dial value", async () => {
    const panel = new ControlPanel();
    Object.assign(panel, { game, eventBus, uiState });
    document.body.append(panel);
    panel.init();
    panel.tick();
    await panel.updateComplete;
    for (const layout of [
      ".atlas-mobile-control-layout",
      ".atlas-desktop-control-layout",
    ]) {
      const contents = panel.querySelector(layout)!.textContent!;
      expect(contents.match(/\/s/g)).toHaveLength(1);
    }
    const dial = panel.querySelector("attack-ratio-dial")!;
    await dial.updateComplete;
    const slider = dial.querySelector<HTMLElement>('[role="slider"]')!;
    slider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    await dial.updateComplete;
    expect(uiState.attackRatio).toBe(1);
    expect(slider.getAttribute("aria-valuenow")).toBe("100");
    expect(dial.querySelector(".atlas-attack-dial__ratio")!.textContent).toBe(
      "100%",
    );
  });

  it("opens contextual player information and removes it completely on close", async () => {
    const info = new PlayerInfoOverlay();
    Object.assign(info, {
      game,
      eventBus,
      transform: {
        screenToWorldCoordinates: () => ({ x: 1, y: 1 }),
      } as unknown as TransformHandler,
    });
    document.body.append(info);
    info.init();
    info.maybeShow(0, 0);
    await info.updateComplete;
    expect(info.querySelectorAll(".atlas-player-structure")).toHaveLength(6);
    expect(info.textContent).toContain("Franche-Comté");
    info.querySelector<HTMLButtonElement>(".atlas-player-info-close")!.click();
    await info.updateComplete;
    expect(info.querySelector(".atlas-player-info-surface")).toBeNull();
  });

  it("uses stone only for a primary notice action without changing its intent", async () => {
    const notice = new ActionableEvents();
    Object.assign(notice, { game, eventBus, uiState });
    const send = vi.fn();
    eventBus.on(SendAllianceRequestIntentEvent, send);
    document.body.append(notice);
    notice.tick();
    notice.onAllianceRequestEvent({
      type: GameUpdateType.AllianceRequest,
      requestorID: 2,
      recipientID: 1,
      createdAt: game.ticks(),
    });
    await notice.updateComplete;
    expect(notice.querySelectorAll(".atlas-war-button")).toHaveLength(1);
    expect(notice.querySelectorAll(".atlas-hud-button")).toHaveLength(2);
    notice
      .querySelector<HTMLButtonElement>(
        '.atlas-war-button[data-stone="quartz"]',
      )!
      .click();
    await notice.updateComplete;
    expect(send).toHaveBeenCalledOnce();
    expect(notice.querySelector(".atlas-action-notice")).toBeNull();
  });

  it("keeps build selection on native toggle controls", async () => {
    const units = new UnitDisplay();
    Object.assign(units, { game, eventBus, uiState });
    document.body.append(units);
    units.init();
    units.tick();
    await units.updateComplete;
    expect(units.querySelectorAll("button.atlas-build-control")).toHaveLength(
      10,
    );
    const city = units.querySelector<HTMLButtonElement>("button")!;
    city.click();
    await units.updateComplete;
    expect(city.getAttribute("aria-pressed")).toBe("true");
    city.click();
    await units.updateComplete;
    expect(city.getAttribute("aria-pressed")).toBe("false");
  });
});
