import { AttacksDisplay } from "../../src/client/hud/layers/AttacksDisplay";
import { MessageType } from "../../src/core/game/Game";

test("ticker indicators reflect live notices and disappear when notices are removed", async () => {
  const display = new AttacksDisplay();
  Object.assign(display, {
    active: true,
    _isVisible: true,
    tickerTypes: [
      MessageType.MIRV_INBOUND,
      MessageType.ALLIANCE_REQUEST,
      MessageType.RENEW_ALLIANCE,
      MessageType.DONATION_RECEIVED,
    ],
    game: { myPlayer: () => ({ gold: () => 100n }) },
  });
  document.body.append(display);
  await display.updateComplete;
  expect(
    display
      .querySelector('img[alt="Incoming MIRV"]')
      ?.classList.contains("is-urgent"),
  ).toBe(true);
  expect(display.querySelector('img[alt="Alliance request"]')).not.toBeNull();
  expect(display.querySelector('img[alt="Expiring alliance"]')).not.toBeNull();
  expect(display.querySelector('img[alt="Donation received"]')).not.toBeNull();
  Object.assign(display, { tickerTypes: [] });
  await display.updateComplete;
  expect(display.querySelectorAll(".atlas-ticker-indicators img")).toHaveLength(
    0,
  );
  display.remove();
});

test("mobile defense relocates live alerts and restores them when closed", async () => {
  const hud = document.createElement("atlas-game-hud");
  const notices = document.createElement("div");
  notices.className = "atlas-hud-notices";
  const alerts = document.createElement("events-display");
  const actions = document.createElement("actionable-events");
  notices.append(alerts, actions);
  const display = new AttacksDisplay();
  Object.assign(display, {
    active: true,
    _isVisible: true,
    mobileLayout: {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    game: {
      myPlayer: () => ({
        gold: () => 0n,
        troops: () => 100,
        isAlive: () => true,
        units: () => [],
      }),
      config: () => ({ gameConfig: () => ({ fleetAutomation: "v26.3" }) }),
      ticks: () => 100,
    },
  });
  hud.append(display, notices);
  document.body.append(hud);
  await display.updateComplete;
  const defense =
    display.querySelector<HTMLButtonElement>(".atlas-flow-gauge")!;
  defense.click();
  await display.updateComplete;
  expect(display.querySelector("fleet-target-slider")).not.toBeNull();
  expect(alerts.parentElement).toBe(
    display.querySelector(".atlas-defense-fronts"),
  );
  // Alliance actions stay in the visible popup, even while defense is open.
  expect(actions.parentElement).toBe(notices);
  defense.click();
  await display.updateComplete;
  expect(alerts.parentElement).toBe(notices);
  expect(actions.parentElement).toBe(notices);
  expect(hud.querySelectorAll("events-display")).toHaveLength(1);
  hud.remove();
});

test("outgoing attacks are collapsed but cancellation stays accessible", async () => {
  const display = new AttacksDisplay();
  Object.assign(display, {
    active: true,
    _isVisible: true,
    outgoingLandAttacks: [{ id: "expansion", troops: 200, retreating: false }],
    game: {
      config: () => ({ gameConfig: () => ({}) }),
      myPlayer: () => ({
        gold: () => 1500n,
        troops: () => 1000,
        pressure: { target: 0.4, military: 1000, autoDefenceEnabled: false },
      }),
    },
    eventBus: { emit: vi.fn() },
  });
  document.body.append(display);
  await display.updateComplete;
  const summary =
    display.querySelectorAll<HTMLButtonElement>(".atlas-flow-gauge")[1];
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(display.textContent).not.toContain("×");
  summary.click();
  await display.updateComplete;
  expect(display.textContent).toContain("×");
  const incoming =
    display.querySelector<HTMLButtonElement>(".atlas-flow-gauge")!;
  incoming.click();
  await display.updateComplete;
  expect(display.textContent).not.toContain("×");
  expect(display.querySelector(".atlas-flow-details")?.textContent).toContain(
    "No incoming attacks",
  );
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(display.querySelectorAll(".atlas-flow-gauge")).toHaveLength(2);
  expect(
    display.querySelectorAll(".atlas-flow-gauge")[0].getAttribute("aria-label"),
  ).toContain("Defense");
  expect(
    display.querySelectorAll(".atlas-flow-gauge")[1].getAttribute("aria-label"),
  ).toContain("Attack");
  expect(
    display.querySelectorAll(".atlas-flow-cluster > .atlas-instrument-readout"),
  ).toHaveLength(3);
  expect(display.querySelector(".atlas-flow-gauge__face")).toBeNull();
  const auto = display.querySelector(
    '[aria-label="Auto-defend while active"]',
  ) as HTMLButtonElement;
  expect(auto.getAttribute("aria-pressed")).toBe("false");
  auto.click();
  expect(display.eventBus.emit).toHaveBeenCalledWith(
    expect.objectContaining({ target: 0.4, autoDefenceEnabled: true }),
  );
  incoming.click();
  await display.updateComplete;
  expect(display.querySelector(".atlas-flow-details")).toBeNull();
  display.remove();
});
