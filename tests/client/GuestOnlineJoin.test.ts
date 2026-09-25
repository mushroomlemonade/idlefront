import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalSession,
  getOnlinePlayToken,
  getPlayToken,
  setGuestPlayToken,
  userAuth,
} from "../../src/client/Auth";
import { ClientEnv } from "../../src/client/ClientEnv";
import { persistentWorldApi } from "../../src/client/PersistentWorldApi";

beforeEach(() => {
  clearLocalSession();
  localStorage.clear();
  window.BOOTSTRAP_CONFIG = {
    gameEnv: "prod",
    numWorkers: 1,
    turnstileSiteKey: "test",
    jwtAudience: "idlefront.io",
    instanceId: "test",
    gitCommit: "test",
  };
  ClientEnv.reset();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 401 }),
  );
});
afterEach(() => {
  clearLocalSession();
  vi.restoreAllMocks();
  ClientEnv.reset();
});

describe("online guest credentials", () => {
  it("does not contact the account service or discard an already bound guest", async () => {
    setGuestPlayToken("guest_test-signed-credential");
    expect(await userAuth()).toBe(false);
    expect(await getOnlinePlayToken()).toBe("guest_test-signed-credential");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let an in-flight failed account refresh erase a new world token", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const refreshing = userAuth();
    setGuestPlayToken("guest_just-bound");
    finish(new Response(null, { status: 401 }));
    await refreshing;
    expect(await getPlayToken()).toBe("guest_just-bound");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses the durable world identity for ordinary multiplayer joins and deduplicates issuance", async () => {
    vi.spyOn(persistentWorldApi, "sessionToken").mockReturnValue(
      "controller-token",
    );
    vi.spyOn(persistentWorldApi, "resumeSession").mockResolvedValue({
      identity: { id: "existing" },
    } as any);
    const create = vi.spyOn(persistentWorldApi, "createGuestSession");
    const bind = vi
      .spyOn(persistentWorldApi, "bindGameIdentityWithToken")
      .mockResolvedValue("guest_signed");
    expect(
      await Promise.all([getOnlinePlayToken(), getOnlinePlayToken()]),
    ).toEqual(["guest_signed", "guest_signed"]);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(bind.mock.calls[0][0]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("fails clearly instead of sending a raw UUID when guest issuance fails", async () => {
    vi.spyOn(persistentWorldApi, "sessionToken").mockReturnValue(
      "controller-token",
    );
    vi.spyOn(persistentWorldApi, "resumeSession").mockResolvedValue({
      identity: { id: "existing" },
    } as any);
    vi.spyOn(persistentWorldApi, "bindGameIdentityWithToken").mockRejectedValue(
      new Error("Guest service unavailable"),
    );
    await expect(getOnlinePlayToken()).rejects.toThrow(
      "Guest service unavailable",
    );
  });
});
