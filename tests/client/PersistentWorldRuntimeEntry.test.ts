import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/client/components/persistent-world/PersistentWorldComponents";
import type { PersistentWorldInvitationCard } from "../../src/client/components/persistent-world/PersistentWorldComponents";
import type { PersistentWorldLobbySnapshot } from "../../src/core/PersistentWorldSchemas";

function activeSnapshot(
  runtimeGameId: string | null,
): PersistentWorldLobbySnapshot {
  return {
    revision: 1,
    serverTime: 2_000,
    world: {
      id: "world_123",
      name: "One Day Table",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 8,
      phase: "active",
      startsAt: 1_000,
      joinClosesAt: 20_000,
      scheduleLocked: true,
      createdAt: 500,
      activatedAt: 1_000,
    },
    members: [],
    quickChat: [],
    reminderOptionsMs: [],
    selectedReminderLeadTimesMs: [],
    viewer: {
      identity: null,
      isMember: true,
      isHost: false,
      canRsvp: false,
      canChat: true,
      canCancel: false,
      hasVerifiedEmail: false,
    },
    runtimeGameId,
  };
}

async function renderCard(
  runtimeGameId: string | null,
): Promise<PersistentWorldInvitationCard> {
  const card = document.createElement(
    "persistent-world-invitation-card",
  ) as PersistentWorldInvitationCard;
  card.snapshot = activeSnapshot(runtimeGameId);
  document.body.appendChild(card);
  await card.updateComplete;
  return card;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("persistent-world runtime entry", () => {
  it("shows a disabled preparing state until the map is attached", async () => {
    const card = await renderCard(null);
    const button = card.querySelector<HTMLButtonElement>(".pw-entry-control");

    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Preparing map…");
    expect(button?.getAttribute("aria-label")).toBe("Preparing map");
  });

  it("enters the attached runtime from the enabled play control", async () => {
    const card = await renderCard("runtime_123");
    const listener = vi.fn();
    card.addEventListener("world-enter-runtime", listener);
    const button = card.querySelector<HTMLButtonElement>(".pw-entry-control");

    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toContain("Play world");
    expect(button?.title).toBe("Return to world");
    button?.click();

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      gameId: "runtime_123",
    });
  });
});
