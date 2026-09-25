import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeInvitationFragment,
  invitationFromHash,
  invitationStorageKey,
  PersistentWorldApi,
  persistentWorldShareUrl,
} from "../../src/client/PersistentWorldApi";

const SECRET = "invite_this-is-a-long-tab-scoped-secret";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("persistent-world invitation capabilities", () => {
  it("reads only the named invite fragment parameter", () => {
    expect(invitationFromHash(`#invite=${SECRET}`)).toBe(SECRET);
    expect(invitationFromHash("#modal=account")).toBeNull();
    expect(invitationFromHash("#invite=short")).toBeNull();
  });

  it("binds the game identity with an authenticated JSON request", async () => {
    const controllerToken = "session_this-is-a-long-controller-token";
    const playToken = "play_this-value-must-remain-in-the-request-body";
    localStorage.setItem("pressure-atlas.world-controller.v1", controllerToken);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ bound: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new PersistentWorldApi().bindGameIdentity(playToken);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("/api/worlds/session/game-identity");
    expect(init.method).toBe("POST");
    expect(headers.get("Authorization")).toBe(`Bearer ${controllerToken}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ playToken });
  });

  it("moves an invite into tab storage and scrubs it from the URL", () => {
    history.replaceState(null, "", `/world/world_123#invite=${SECRET}`);

    expect(consumeInvitationFragment("world_123")).toBe(SECRET);
    expect(location.pathname).toBe("/world/world_123");
    expect(location.hash).toBe("");
    expect(sessionStorage.getItem(invitationStorageKey("world_123"))).toBe(
      SECRET,
    );
  });

  it("keeps private credentials in the fragment of share links", () => {
    const url = new URL(persistentWorldShareUrl("world_123", SECRET));
    expect(url.pathname).toBe("/world/world_123");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("invite")).toBe(SECRET);
  });

  it("sends RSVP capabilities in a header, never in JSON", async () => {
    localStorage.setItem(
      "pressure-atlas.world-controller.v1",
      "session_this-is-a-long-controller-token",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          revision: 1,
          serverTime: 1,
          world: {
            id: "world_123",
            name: "Seven Evenings",
            targetDuration: "7d",
            access: "private",
            mode: "ffa",
            maxHumans: 8,
            phase: "scheduled",
            startsAt: 10_000,
            joinClosesAt: 20_000,
            scheduleLocked: false,
            createdAt: 1,
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new PersistentWorldApi().rsvp("world_123", null, SECRET);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("x-world-invite")).toBe(SECRET);
    expect(JSON.parse(String(init.body))).toEqual({ teamId: null });
    expect(String(init.body)).not.toContain(SECRET);
  });
});
