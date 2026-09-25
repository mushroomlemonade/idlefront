import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistentWorldApi } from "../../src/client/PersistentWorldApi";
import "../../src/client/components/persistent-world/PersistentWorldPage";
import type { PersistentWorldPage } from "../../src/client/components/persistent-world/PersistentWorldPage";
import type { PersistentWorldLobbySnapshot } from "../../src/core/PersistentWorldSchemas";

const WORLD_ID = "world_polling_test";
const originalVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

let visibilityState: DocumentVisibilityState;

function snapshot(revision = 1): PersistentWorldLobbySnapshot {
  return {
    revision,
    serverTime: 2_000_000_000_000 + revision,
    world: {
      id: WORLD_ID,
      name: "Polling Table",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 8,
      phase: "scheduled",
      startsAt: 2_000_086_400_000,
      joinClosesAt: 2_000_115_200_000,
      scheduleLocked: false,
      createdAt: 2_000_000_000_000,
      activatedAt: null,
    },
    members: [],
    quickChat: [],
    reminderOptionsMs: [],
    selectedReminderLeadTimesMs: [],
    viewer: {
      identity: null,
      isMember: false,
      isHost: false,
      canRsvp: true,
      canChat: false,
      canCancel: false,
      hasVerifiedEmail: false,
    },
    runtimeGameId: null,
  };
}

async function settle(page?: PersistentWorldPage): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  if (page) await page.updateComplete;
}

async function mountPage(): Promise<PersistentWorldPage> {
  history.replaceState(null, "", `/world/${WORLD_ID}`);
  const page = document.createElement(
    "persistent-world-page",
  ) as PersistentWorldPage;
  document.body.appendChild(page);
  await settle(page);
  return page;
}

describe("PersistentWorldPage lobby polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    vi.spyOn(persistentWorldApi, "getSnapshot").mockResolvedValue(snapshot());
  });

  afterEach(() => {
    document.body.replaceChildren();
    history.replaceState(null, "", "/");
    if (originalVisibilityState) {
      Object.defineProperty(
        document,
        "visibilityState",
        originalVisibilityState,
      );
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refreshes a visible lobby every three seconds", async () => {
    const getSnapshot = vi.mocked(persistentWorldApi.getSnapshot);
    await mountPage();
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });

  it("does not fetch while the document is hidden", async () => {
    const getSnapshot = vi.mocked(persistentWorldApi.getSnapshot);
    await mountPage();
    visibilityState = "hidden";

    await vi.advanceTimersByTimeAsync(9_000);

    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("refreshes immediately when visibility or focus returns", async () => {
    const getSnapshot = vi.mocked(persistentWorldApi.getSnapshot);
    const page = await mountPage();
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(page);
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("focus"));
    await settle(page);
    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });

  it("keeps polling after a transient refresh rejection", async () => {
    const getSnapshot = vi.mocked(persistentWorldApi.getSnapshot);
    getSnapshot
      .mockReset()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValue(snapshot(2));
    await mountPage();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });

  it("replaces pending timers and tears down timers and listeners", async () => {
    const getSnapshot = vi.mocked(persistentWorldApi.getSnapshot);
    const page = await mountPage();

    window.dispatchEvent(new Event("focus"));
    await settle(page);
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(getSnapshot).toHaveBeenCalledTimes(3);

    page.remove();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(6_000);

    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });
});
