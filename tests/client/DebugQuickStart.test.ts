import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  quickJoinDebugGame,
  quickStartDebugGame,
} from "../../src/client/DebugQuickStart";
import { persistentWorldApi } from "../../src/client/PersistentWorldApi";
import { DEBUG_QUICK_START_PREFIX } from "../../src/core/DebugPlaytest";
import type {
  PersistentWorldCard,
  PersistentWorldLobbySnapshot,
} from "../../src/core/PersistentWorldSchemas";
vi.mock("../../src/client/Auth", () => ({
  getPlayToken: vi.fn(async () => "guest_play"),
  setGuestPlayToken: vi.fn(),
}));
vi.mock("../../src/client/RuntimeDebug", () => ({
  runtimeDebugEnabled: () => true,
}));
vi.mock("../../src/client/ClientEnv", () => ({
  ClientEnv: { workerPath: () => "w0" },
}));

function card(
  id: string,
  createdAt: number,
  viewerEliminated = false,
): PersistentWorldCard {
  return {
    world: {
      id,
      name: `${DEBUG_QUICK_START_PREFIX}fixture`,
      phase: "active",
      createdAt,
    },
    isViewerMember: true,
    viewerEliminated,
  } as PersistentWorldCard;
}
function snapshot(id: string): PersistentWorldLobbySnapshot {
  return {
    world: { id, phase: "active" },
    runtimeGameId: id,
    viewer: { isMember: true, canRsvp: false },
  } as PersistentWorldLobbySnapshot;
}
beforeEach(() => {
  vi.spyOn(persistentWorldApi, "sessionToken").mockReturnValue("controller");
  vi.spyOn(persistentWorldApi, "resumeSession").mockResolvedValue({} as any);
  vi.spyOn(persistentWorldApi, "bindGameIdentityWithToken").mockResolvedValue(
    "guest_play",
  );
  vi.spyOn(persistentWorldApi, "listMine").mockResolvedValue([]);
  vi.spyOn(persistentWorldApi, "listPublic").mockResolvedValue([]);
  vi.spyOn(persistentWorldApi, "getSnapshot").mockImplementation(async (id) =>
    snapshot(id),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("quick join", () => {
  it.each([undefined, "1d"] as const)(
    "creates a %s test without changing the short-test default",
    async (duration) => {
      const create = vi
        .spyOn(persistentWorldApi, "createWorld")
        .mockResolvedValue({
          snapshot: snapshot("newtest1"),
        } as any);
      const dispatch = vi.spyOn(document, "dispatchEvent");
      expect(await quickStartDebugGame(undefined, duration)).toBe("newtest1");
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          targetDuration: duration ?? "1h",
          maxHumans: 8,
          access: "public",
          mode: "ffa",
        }),
      );
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );
  it("skips eliminated seats and stale runtime IDs instead of joining a dead match", async () => {
    vi.mocked(persistentWorldApi.listMine).mockResolvedValue([
      card("eliminated", 30, true),
      card("stale", 20),
      card("healthy", 10),
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify({ exists: String(url).includes("healthy") }),
        ),
    );
    const dispatch = vi.spyOn(document, "dispatchEvent");
    expect(await quickJoinDebugGame()).toBe("healthy");
    expect(persistentWorldApi.getSnapshot).not.toHaveBeenCalledWith(
      "eliminated",
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect((dispatch.mock.calls[0][0] as CustomEvent).detail.gameID).toBe(
      "healthy",
    );
  });
  it("claims an open RSVP before trying to join the game", async () => {
    vi.mocked(persistentWorldApi.listPublic).mockResolvedValue([
      { ...card("available", 20), isViewerMember: false },
    ]);
    vi.mocked(persistentWorldApi.getSnapshot).mockResolvedValue({
      ...snapshot("available"),
      viewer: { isMember: false, canRsvp: true },
    } as PersistentWorldLobbySnapshot);
    const rsvp = vi
      .spyOn(persistentWorldApi, "rsvp")
      .mockResolvedValue(snapshot("available"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ exists: true })),
    );
    expect(await quickJoinDebugGame()).toBe("available");
    expect(rsvp).toHaveBeenCalledWith("available");
  });
  it("reports a worker outage before firing a broken join navigation", async () => {
    vi.mocked(persistentWorldApi.listMine).mockResolvedValue([
      card("offline", 1),
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 502 }),
    );
    const dispatch = vi.spyOn(document, "dispatchEvent");
    await expect(quickJoinDebugGame()).rejects.toThrow("worker is unavailable");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
