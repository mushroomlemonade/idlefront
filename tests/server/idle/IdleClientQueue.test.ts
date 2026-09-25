import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const indexSource = readFileSync(
  resolve(process.cwd(), "resources/idle/index.html"),
  "utf8",
);
const appSource = readFileSync(
  resolve(process.cwd(), "resources/idle/app.js"),
  "utf8",
);

const queuedTap = (clientSeq: number) => ({
  v: 1,
  playerId: "ply_test_player",
  sessionId: "ses_read_only_origin",
  clientSeq,
  targetTerritoryId: "t02",
  clientMonoMs: 10_000 + clientSeq * 200,
  pointerType: "touch",
  visibility: "visible",
  xNormQ: 5000,
  yNormQ: 5000,
});

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? "Conflict" : "OK",
    text: async () => JSON.stringify(payload),
  };
}

function idleState(canCommand: boolean) {
  return {
    world: {
      name: "Test Reach",
      seasonEndsAt: Date.now() + 86_400_000,
      supplyCapHours: 24,
    },
    player: {
      id: "ply_test_player",
      name: "Tester",
      territoryId: "t01",
      supply: 40,
      influence: 0,
      supplyPerHour: 12,
      canCommand,
    },
    territories: [],
    pressure: [],
    recentActivity: [],
  };
}

function installReadOnlyClient(taps: unknown[]) {
  document.open();
  document.write(indexSource);
  document.close();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  localStorage.setItem("pressureAtlas.playerId", "ply_test_player");
  localStorage.setItem(
    "pressureAtlas.recoveryCode",
    "rec_test_recovery_code_long_enough",
  );
  localStorage.setItem("pressureAtlas.sessionId", "ses_read_only_origin");
  localStorage.setItem("pressureAtlas.tapQueue", JSON.stringify(taps));
}

describe("standalone idle client queue", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("paces and drops origin-bound taps after a remote lease takeover", async () => {
    vi.useFakeTimers();
    installReadOnlyClient([queuedTap(1), queuedTap(2)]);
    const tapTimes: number[] = [];
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/idle/state")) {
        return jsonResponse(200, idleState(false));
      }
      if (url === "/api/idle/tap" && options?.method === "POST") {
        tapTimes.push(Date.now());
        return jsonResponse(409, {
          error: {
            code: "SESSION_READ_ONLY",
            message: "A newer session owns the command lease",
          },
        });
      }
      throw new Error(`Unexpected request: ${options?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    window.eval(appSource);
    await vi.advanceTimersByTimeAsync(500);

    const tapCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/idle/tap",
    );
    expect(tapCalls).toHaveLength(2);
    expect(
      tapCalls.map(
        ([, options]) => JSON.parse(String(options?.body)).clientSeq,
      ),
    ).toEqual([1, 2]);
    expect(tapTimes[1] - tapTimes[0]).toBeGreaterThanOrEqual(135);
    expect(
      JSON.parse(localStorage.getItem("pressureAtlas.tapQueue") ?? "[]"),
    ).toEqual([]);

    document
      .querySelector<HTMLElement>(".territory")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/idle/tap"),
    ).toHaveLength(2);
  });

  it("drops an invalid origin before recovering without retry loops", async () => {
    vi.useFakeTimers();
    installReadOnlyClient([queuedTap(1), queuedTap(2)]);
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/idle/state")) {
        return jsonResponse(200, idleState(false));
      }
      if (url === "/api/idle/tap" && options?.method === "POST") {
        return jsonResponse(401, {
          error: { code: "INVALID_SESSION", message: "Session is invalid" },
        });
      }
      if (url === "/api/idle/session" && options?.method === "POST") {
        return jsonResponse(201, {
          playerId: "ply_test_player",
          sessionId: "ses_recovered_origin",
          recoveryCode: "rec_test_recovery_code_long_enough",
          resumed: true,
          state: idleState(true),
        });
      }
      throw new Error(`Unexpected request: ${options?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    window.eval(appSource);
    await vi.advanceTimersByTimeAsync(6000);

    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/idle/tap"),
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/idle/session"),
    ).toHaveLength(1);
    expect(
      JSON.parse(localStorage.getItem("pressureAtlas.tapQueue") ?? "[]"),
    ).toEqual([]);
    expect(localStorage.getItem("pressureAtlas.sessionId")).toBe(
      "ses_recovered_origin",
    );
  });
});
