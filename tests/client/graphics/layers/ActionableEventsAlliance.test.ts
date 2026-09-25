import { GameUpdateType } from "../../../../src/core/game/GameUpdates";

vi.mock("lit", () => ({
  html: () => {},
  LitElement: class {},
}));

vi.mock("lit/decorators.js", () => ({
  customElement: () => (clazz: any) => clazz,
  query: () => () => {},
  state: () => () => {},
  property: () => () => {},
}));

vi.mock("lit/directive.js", () => ({
  DirectiveResult: class {},
}));

vi.mock("lit/directives/unsafe-html.js", () => ({
  unsafeHTML: () => {},
  UnsafeHTMLDirective: class {},
}));

import { ActionableEvents } from "../../../../src/client/hud/layers/ActionableEvents";
import { MessageType } from "../../../../src/core/game/Game";

describe("ActionableEvents - alliance renewal cleanup (allianceID based)", () => {
  test("expiration replaces its warning and does not reappear after dismissal until renewed", () => {
    const display = new ActionableEvents() as any;
    let ticks = 900;
    const alliance = { id: 1, other: "ally", expiresAt: 1000 };
    display.requestUpdate = vi.fn();
    display.game = {
      ticks: () => ticks,
      myPlayer: () => ({ isAlive: () => true, alliances: () => [alliance] }),
      config: () => ({
        allianceExtensionPromptOffset: () => 100,
        gameConfig: () => ({ continuousPressure: "v1" }),
      }),
      player: () => ({ displayName: () => "ally", smallID: () => 2 }),
    };
    display.checkForAllianceExpirations();
    expect(display.events).toHaveLength(1);
    expect(display.events[0].description).toContain("ending soon");
    ticks = 1000;
    display.checkForAllianceExpirations();
    expect(display.events).toHaveLength(1);
    expect(display.events[0].description).toContain("has ended");
    ticks = 5000;
    display.checkForAllianceExpirations();
    expect(display.events).toHaveLength(1);
    display.removeEvent(0);
    ticks = 6000;
    display.checkForAllianceExpirations();
    expect(display.events).toHaveLength(0);
    alliance.expiresAt = 6100;
    display.checkForAllianceExpirations();
    expect(display.events).toHaveLength(1);
    alliance.expiresAt = 9000;
    display.checkForAllianceExpirations();
    expect(display.events).toHaveLength(0);
  });

  test("repeated requests replace rather than duplicate the same requestor", () => {
    const display = new ActionableEvents() as any;
    display.requestUpdate = vi.fn();
    const request = { type: MessageType.ALLIANCE_REQUEST, requestorID: 2 };
    display.addEvent(request);
    display.addEvent({ ...request });
    display.addEvent({ ...request, requestorID: 3 });
    expect(display.events).toHaveLength(2);
  });
  function makeRenewal(
    allianceID: number,
    focusID: number,
    description = "Alliance about to expire",
  ) {
    return {
      description,
      type: MessageType.RENEW_ALLIANCE,
      allianceID,
      focusID,
      createdAt: 0,
    };
  }

  test("removes ONLY renewal events for the broken alliance", () => {
    const display = new ActionableEvents();

    const allianceAB = 1;
    const allianceAC = 2;
    const allianceBC = 3;

    (display as any).events = [
      makeRenewal(allianceAB, 1), // A–B
      makeRenewal(allianceAC, 1), // A–C
      makeRenewal(allianceBC, 2), // B–C
    ];

    // Break alliance A–B
    (display as any).removeAllianceRenewalEvents(allianceAB);

    const remaining = (display as any).events;

    // A–B renewal removed
    expect(remaining.some((e: any) => e.allianceID === allianceAB)).toBe(false);

    // Other alliances untouched
    expect(remaining.some((e: any) => e.allianceID === allianceAC)).toBe(true);

    expect(remaining.some((e: any) => e.allianceID === allianceBC)).toBe(true);
  });

  test("does NOT remove renewals just because the same player is involved", () => {
    const display = new ActionableEvents();

    const allianceAB = 10;
    const allianceAC = 11;

    (display as any).events = [
      makeRenewal(allianceAB, 1), // Player 1 involved
      makeRenewal(allianceAC, 1), // Same player, different alliance
    ];

    (display as any).removeAllianceRenewalEvents(allianceAB);

    const remaining = (display as any).events;

    expect(remaining.length).toBe(1);
    expect(remaining[0].allianceID).toBe(allianceAC);
  });

  test("breaking one alliance does not affect renewals between other players", () => {
    const display = new ActionableEvents();

    const allianceAB = 100;
    const allianceCD = 200;

    (display as any).events = [
      makeRenewal(allianceAB, 1), // A–B
      makeRenewal(allianceCD, 3), // C–D
    ];

    (display as any).removeAllianceRenewalEvents(allianceAB);

    const remaining = (display as any).events;

    expect(remaining.length).toBe(1);
    expect(remaining[0].allianceID).toBe(allianceCD);
  });

  test("onAllianceExtensionEvent removes renewal when playerID matches myPlayer", () => {
    const display = new ActionableEvents();

    const allianceID = 42;
    const mySmallID = 7;

    (display as any).game = {
      myPlayer: () => ({ smallID: () => mySmallID }),
    };
    (display as any).requestUpdate = () => {};
    (display as any).events = [makeRenewal(allianceID, mySmallID)];

    (display as any).onAllianceExtensionEvent({
      type: GameUpdateType.AllianceExtension,
      playerID: mySmallID,
      allianceID,
    });

    const remaining = (display as any).events;
    expect(remaining.some((e: any) => e.allianceID === allianceID)).toBe(false);
  });

  test("onAllianceExtensionEvent keeps renewal when playerID does not match myPlayer", () => {
    const display = new ActionableEvents();

    const allianceID = 42;
    const mySmallID = 7;
    const otherSmallID = 9;

    (display as any).game = {
      myPlayer: () => ({ smallID: () => mySmallID }),
    };
    (display as any).requestUpdate = () => {};
    (display as any).events = [makeRenewal(allianceID, mySmallID)];

    (display as any).onAllianceExtensionEvent({
      type: "AllianceExtension",
      playerID: otherSmallID,
      allianceID,
    });

    const remaining = (display as any).events;
    expect(remaining.some((e: any) => e.allianceID === allianceID)).toBe(true);
  });

  test("onAllianceExtensionEvent keeps renewal when myPlayer is null", () => {
    const display = new ActionableEvents();

    const allianceID = 42;

    (display as any).game = {
      myPlayer: () => null,
    };
    (display as any).requestUpdate = () => {};
    (display as any).events = [makeRenewal(allianceID, 1)];

    (display as any).onAllianceExtensionEvent({
      type: "AllianceExtension",
      playerID: 1,
      allianceID,
    });

    const remaining = (display as any).events;
    expect(remaining.some((e: any) => e.allianceID === allianceID)).toBe(true);
  });

  test("does not affect non-RENEW_ALLIANCE events", () => {
    const display = new ActionableEvents();

    (display as any).events = [
      {
        description: "Alliance broken",
        type: MessageType.ALLIANCE_BROKEN,
        createdAt: 0,
      },
      {
        description: "Alliance accepted",
        type: MessageType.ALLIANCE_ACCEPTED,
        createdAt: 0,
      },
      {
        description: "Renewal",
        type: MessageType.RENEW_ALLIANCE,
        allianceID: 999,
        createdAt: 0,
      },
    ];

    (display as any).removeAllianceRenewalEvents(999);

    const remaining = (display as any).events;

    expect(
      remaining.some((e: any) => e.type === MessageType.ALLIANCE_BROKEN),
    ).toBe(true);

    expect(
      remaining.some((e: any) => e.type === MessageType.ALLIANCE_ACCEPTED),
    ).toBe(true);

    expect(
      remaining.some((e: any) => e.type === MessageType.RENEW_ALLIANCE),
    ).toBe(false);
  });
});
