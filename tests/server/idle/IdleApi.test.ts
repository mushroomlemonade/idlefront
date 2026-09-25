import express from "express";
import { mkdtempSync, rmSync } from "fs";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import {
  createIdleRouter,
  IdleService,
  type TapInput,
} from "../../../src/server/idle";

interface SessionResponse {
  playerId: string;
  sessionId: string;
  recoveryCode: string;
  resumed: boolean;
  state: {
    world: { schemaVersion: number; revision: number };
    player: {
      territoryId: string;
      supply: number;
      influence: number;
      canCommand: boolean;
    };
    territories: Array<{ id: string; ownerId: string | null; isBot: boolean }>;
    recentActivity: unknown[];
  };
}

const ADMIN_TOKEN = "idle-test-admin-token-at-least-32-chars";

describe("idle authoritative API", () => {
  let directory: string;
  let service: IdleService;
  let server: Server;
  let baseUrl: string;
  let now: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "openfront-idle-test-"));
    now = 2_000_000_000_000;
    service = new IdleService({
      dbPath: join(directory, "idle.sqlite"),
      now: () => now,
    });
    const app = express();
    app.use(express.json());
    app.use(
      "/api/idle",
      createIdleRouter(service, {
        adminEnabled: true,
        adminToken: ADMIN_TOKEN,
      }),
    );
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/idle`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 FxiOS/123.0 Mobile/15E148 Safari/605.1",
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as T;
    expect(response.ok, JSON.stringify(payload)).toBe(true);
    return payload;
  }

  async function createSession(): Promise<SessionResponse> {
    return post<SessionResponse>("/session", {});
  }

  function tapBody(
    session: SessionResponse,
    clientSeq: number,
    targetTerritoryId: string,
  ): TapInput {
    return {
      v: 1,
      playerId: session.playerId,
      sessionId: session.sessionId,
      clientSeq,
      targetTerritoryId,
      clientMonoMs: 10_000 + clientSeq * 100,
      pointerType: "touch",
      visibility: "visible",
      xNormQ: 5000,
      yNormQ: 5000,
    };
  }

  it("creates a durable guest in the seeded world and caps offline accrual", async () => {
    const health = await fetch(`${baseUrl}/health`).then((response) =>
      response.json(),
    );
    expect(health).toMatchObject({
      status: "ok",
      database: "ready",
      schemaVersion: 6,
      worldId: "idle-demo-1",
      journalMode: "wal",
      secureDelete: true,
      synchronous: "full",
      retentionMaintenance: "ok",
    });

    const formPost = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "guest=true",
    });
    expect(formPost.status).toBe(415);

    const session = await createSession();
    expect(session.resumed).toBe(false);
    expect(session.recoveryCode).toMatch(/^rec_/);
    expect(session.state.player.territoryId).toBe("t01");
    expect(session.state.territories).toHaveLength(12);
    expect(session.state.world).toMatchObject({
      schemaVersion: 6,
      revision: expect.any(Number),
    });
    expect(
      session.state.territories.filter((territory) => territory.isBot),
    ).toHaveLength(8);

    const missingBearer = await fetch(
      `${baseUrl}/state?playerId=${encodeURIComponent(session.playerId)}`,
    );
    expect(missingBearer.status).toBe(401);
    const missingAdminBearer = await fetch(`${baseUrl}/admin/summary`);
    expect(missingAdminBearer.status).toBe(401);

    now += 30 * 60 * 60 * 1000;
    const state = await fetch(
      `${baseUrl}/state?playerId=${encodeURIComponent(session.playerId)}`,
      { headers: { authorization: `Bearer ${session.sessionId}` } },
    ).then((response) => response.json());
    expect(state.player.supply).toBe(328);
  });

  it("records taps idempotently without changing defender ownership or resources", async () => {
    const attacker = await createSession();
    const defender = await createSession();
    expect(defender.state.player.territoryId).toBe("t02");
    const defenderBefore = defender.state.player;

    const first = await post<any>("/tap", {
      ...tapBody(attacker, 1, "t02"),
      pointerType: "keyboard",
    });
    expect(first).toMatchObject({
      duplicate: false,
      outcome: {
        accepted: true,
        rewarded: true,
        influenceAwarded: 1,
        pressureAdded: 1,
      },
    });
    const duplicate = await post<any>("/tap", tapBody(attacker, 1, "t02"));
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.outcome).toEqual(first.outcome);
    expect(duplicate.stateDelta.player.influence).toBe(1);
    const invalidTarget = await post<any>("/tap", tapBody(attacker, 2, "t99"));
    expect(invalidTarget.outcome).toMatchObject({
      accepted: false,
      rewarded: false,
      reason: "unknown_territory",
      pressureAdded: 0,
    });
    const unclaimedTarget = await post<any>(
      "/tap",
      tapBody(attacker, 3, "t03"),
    );
    expect(unclaimedTarget.outcome).toMatchObject({
      accepted: false,
      rewarded: false,
      reason: "unclaimed_territory",
      pressureAdded: 0,
    });

    const defenderAfter = await fetch(
      `${baseUrl}/state?playerId=${encodeURIComponent(defender.playerId)}`,
      { headers: { authorization: `Bearer ${defender.sessionId}` } },
    ).then((response) => response.json());
    expect(defenderAfter.player).toMatchObject(defenderBefore);
    expect(
      defenderAfter.territories.find(
        (territory: { id: string }) => territory.id === "t02",
      ).ownerId,
    ).toBe(defender.playerId);
    expect(defenderAfter.recentActivity[0]).toMatchObject({
      actorId: attacker.playerId,
      targetTerritoryId: "t02",
      count: 1,
      isAgainstYou: true,
    });

    const unrelated = await createSession();
    expect(unrelated.state.player.territoryId).toBe("t03");
    expect(unrelated.state.recentActivity).toHaveLength(0);

    const admin = await fetch(`${baseUrl}/admin/summary`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then((response) => response.json());
    // The duplicate is idempotent, while the validly-shaped rejected attempt
    // remains in the audit ledger.
    expect(admin.volume).toMatchObject({
      total: 3,
      observationsTotal: 4,
      duplicatesTotal: 1,
    });
    const auditDb = new DatabaseSync(service.dbPath, { readOnly: true });
    const uaRows = auditDb
      .prepare(
        "SELECT DISTINCT user_agent_family FROM idle_taps ORDER BY user_agent_family",
      )
      .all();
    const observation = auditDb
      .prepare(
        `SELECT protocol_version, client_mono_ms, pointer_type, visibility,
                x_norm_q, y_norm_q, outcome_reason
         FROM idle_tap_observations ORDER BY id LIMIT 1`,
      )
      .get();
    auditDb.close();
    expect(uaRows).toEqual([
      expect.objectContaining({ user_agent_family: "firefox_ios" }),
    ]);
    expect(observation).toMatchObject({
      protocol_version: 1,
      client_mono_ms: 10_100,
      pointer_type: "keyboard",
      visibility: "visible",
      x_norm_q: 5000,
      y_norm_q: 5000,
      outcome_reason: "accepted",
    });
  });

  it("silently suppresses impossible input and quarantines it for admin review", async () => {
    const attacker = await createSession();
    const defender = await createSession();
    const outcomes: any[] = [];
    for (let index = 0; index < 5; index++) {
      now += 10;
      outcomes.push(
        await post<any>("/tap", {
          ...tapBody(attacker, index, defender.state.player.territoryId),
          clientMonoMs: 1000 + index * 10,
        }),
      );
    }
    expect(outcomes[0].outcome.rewarded).toBe(true);
    expect(
      outcomes.slice(1).every((outcome) => !outcome.outcome.rewarded),
    ).toBe(true);

    const admin = await fetch(`${baseUrl}/admin/summary`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then((response) => response.json());
    const watched = admin.players.find(
      (player: { playerId: string }) => player.playerId === attacker.playerId,
    );
    expect(watched).toMatchObject({
      riskTier: "restricted",
      quarantined: true,
      tapsLastMinute: 5,
      rewardsSuppressedLastHour: 4,
    });
    expect(watched.riskScore).toBeGreaterThanOrEqual(100);

    now += 60 * 60 * 1000;
    const decayedAdmin = await fetch(`${baseUrl}/admin/summary`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then((response) => response.json());
    const decayed = decayedAdmin.players.find(
      (player: { playerId: string }) => player.playerId === attacker.playerId,
    );
    expect(decayed).toMatchObject({
      riskTier: "clear",
      quarantined: false,
    });
  });

  it("persists recovery identity across a clean database reopen", async () => {
    const original = await createSession();
    const originalTap = await post<any>("/tap", tapBody(original, 1, "t05"));
    expect(originalTap).toMatchObject({
      duplicate: false,
      stateDelta: { player: { influence: 1 } },
    });
    const dbPath = service.dbPath;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    service.close();

    service = new IdleService({ dbPath, now: () => now });
    const app = express();
    app.use(express.json());
    app.use("/api/idle", createIdleRouter(service));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/idle`;

    const recovered = await post<SessionResponse>("/session", {
      playerId: original.playerId,
      recoveryCode: original.recoveryCode,
    });
    expect(recovered.resumed).toBe(true);
    expect(recovered.playerId).toBe(original.playerId);
    expect(recovered.state.player.territoryId).toBe(
      original.state.player.territoryId,
    );
    expect(recovered.state.player.canCommand).toBe(true);

    const priorStateResponse = await fetch(
      `${baseUrl}/state?playerId=${encodeURIComponent(original.playerId)}`,
      { headers: { authorization: `Bearer ${original.sessionId}` } },
    );
    expect(priorStateResponse.ok).toBe(true);
    const priorState = await priorStateResponse.json();
    expect(priorState.player.canCommand).toBe(false);

    const replayFromOldLease = await post<any>(
      "/tap",
      tapBody(original, 1, "t05"),
    );
    expect(replayFromOldLease).toMatchObject({
      duplicate: true,
      stateDelta: { player: { influence: 1, canCommand: false } },
    });

    const newTapFromOldLease = await fetch(`${baseUrl}/tap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tapBody(original, 2, "t05")),
    });
    expect(newTapFromOldLease.status).toBe(409);
    await expect(newTapFromOldLease.json()).resolves.toMatchObject({
      error: { code: "SESSION_READ_ONLY" },
    });
  });

  it("rolls the demo season forward instead of leaving a dead world", async () => {
    const attacker = await createSession();
    const defender = await createSession();
    now += 7 * 24 * 60 * 60 * 1000;

    const result = await post<any>(
      "/tap",
      tapBody(attacker, 1, defender.state.player.territoryId),
    );
    expect(result.outcome).toMatchObject({ accepted: true, rewarded: true });
    const rolledState = await fetch(
      `${baseUrl}/state?playerId=${encodeURIComponent(attacker.playerId)}`,
      { headers: { authorization: `Bearer ${attacker.sessionId}` } },
    ).then((response) => response.json());
    expect(rolledState.world.seasonEndsAt).toBeGreaterThan(now);
    const admin = await fetch(`${baseUrl}/admin/summary`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then((response) => response.json());
    expect(admin.volume).toMatchObject({
      total: 1,
      observationsTotal: 1,
      duplicatesTotal: 0,
    });
  });

  it("replaces seeded bots until twelve humans can join", async () => {
    const sessions: SessionResponse[] = [];
    for (let index = 0; index < 12; index++) {
      sessions.push(await createSession());
    }
    expect(sessions.map((session) => session.state.player.territoryId)).toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `t${String(index + 1).padStart(2, "0")}`,
      ),
    );
    expect(
      sessions[11].state.territories.filter((territory) => territory.isBot),
    ).toHaveLength(0);

    const full = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(full.status).toBe(503);
  });

  it("does not punish a normal offline queue burst or a reloaded client clock", async () => {
    const attacker = await createSession();
    const defender = await createSession();
    let clientMonoMs = 1000;
    const outcomes: any[] = [];
    for (let index = 1; index <= 24; index++) {
      now += 135;
      clientMonoMs += index % 2 === 0 ? 190 : 330;
      outcomes.push(
        await post<any>("/tap", {
          ...tapBody(attacker, index, defender.state.player.territoryId),
          clientMonoMs,
        }),
      );
    }
    now += 135;
    outcomes.push(
      await post<any>("/tap", {
        ...tapBody(attacker, 25, defender.state.player.territoryId),
        clientMonoMs: 5,
      }),
    );
    expect(outcomes.every((outcome) => outcome.outcome.rewarded === true)).toBe(
      true,
    );
    expect(outcomes[outcomes.length - 1]?.stateDelta.player.influence).toBe(25);

    const admin = await fetch(`${baseUrl}/admin/summary`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then((response) => response.json());
    const player = admin.players.find(
      (entry: { playerId: string }) => entry.playerId === attacker.playerId,
    );
    expect(player).toMatchObject({
      riskScore: 0,
      riskTier: "clear",
      quarantined: false,
    });
  });

  it("expires raw tap data without losing idempotency or recent duplicate receipts", async () => {
    const attacker = await createSession();
    const defender = await createSession();
    const tap = tapBody(attacker, 1, defender.state.player.territoryId);
    await post("/tap", tap);
    now += 13 * 24 * 60 * 60 * 1000;
    expect((await post<any>("/tap", tap)).duplicate).toBe(true);
    now += 2 * 24 * 60 * 60 * 1000;

    let admin = await fetch(`${baseUrl}/admin/summary`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then((response) => response.json());
    expect(admin.volume).toMatchObject({
      total: 0,
      observationsTotal: 1,
      duplicatesTotal: 1,
    });

    const replay = await post<any>("/tap", tap);
    expect(replay).toMatchObject({
      duplicate: true,
      outcome: {
        accepted: false,
        rewarded: false,
        reason: "expired_replay",
        influenceAwarded: 0,
        pressureAdded: 0,
      },
      stateDelta: { player: { influence: 1 }, pressure: null },
    });
    admin = await fetch(`${baseUrl}/admin/summary`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then((response) => response.json());
    expect(admin.volume).toMatchObject({
      total: 0,
      observationsTotal: 2,
      duplicatesTotal: 2,
    });

    const auditDb = new DatabaseSync(service.dbPath, { readOnly: true });
    expect(
      auditDb
        .prepare("SELECT last_client_seq FROM idle_sessions WHERE id = ?")
        .get(attacker.sessionId),
    ).toMatchObject({ last_client_seq: 1 });
    expect(
      auditDb
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'idle_tap_dedup'",
        )
        .get(),
    ).toMatchObject({ count: 0 });
    expect(
      auditDb
        .prepare(
          "SELECT COUNT(*) AS count FROM idle_tap_observations WHERE logical_tap_id IS NOT NULL",
        )
        .get(),
    ).toMatchObject({ count: 0 });
    auditDb.close();
  });

  it("expires raw taps on its maintenance timer without player traffic", async () => {
    let maintenanceNow = now;
    const maintenancePath = join(directory, "inactive-retention.sqlite");
    const maintenanceService = new IdleService({
      dbPath: maintenancePath,
      now: () => maintenanceNow,
      rawTapRetentionDays: 1,
      retentionMaintenancePollMs: 5,
    });
    try {
      const attacker = maintenanceService.createSession();
      const defender = maintenanceService.createSession();
      maintenanceService.recordTap(
        tapBody(attacker, 1, defender.state.player.territoryId),
      );

      const rawCounts = () => {
        const auditDb = new DatabaseSync(maintenancePath, { readOnly: true });
        try {
          return {
            taps: Number(
              (
                auditDb
                  .prepare("SELECT COUNT(*) AS count FROM idle_taps")
                  .get() as {
                  count: number | bigint;
                }
              ).count,
            ),
            observations: Number(
              (
                auditDb
                  .prepare(
                    "SELECT COUNT(*) AS count FROM idle_tap_observations",
                  )
                  .get() as { count: number | bigint }
              ).count,
            ),
          };
        } finally {
          auditDb.close();
        }
      };
      expect(rawCounts()).toEqual({ taps: 1, observations: 1 });

      maintenanceNow += 2 * 24 * 60 * 60 * 1000;
      await vi.waitFor(
        () => expect(rawCounts()).toEqual({ taps: 0, observations: 0 }),
        {
          timeout: 1000,
          interval: 5,
        },
      );
    } finally {
      maintenanceService.close();
    }
  });

  it("retries a busy retention checkpoint without taking the service down", async () => {
    let maintenanceNow = now;
    let checkpointAttempts = 0;
    let simulateBusy = false;
    const maintenancePath = join(directory, "busy-retention.sqlite");
    const maintenanceService = new IdleService({
      dbPath: maintenancePath,
      now: () => maintenanceNow,
      rawTapRetentionDays: 1,
      retentionMaintenancePollMs: 5,
      retentionWalCheckpoint: () => {
        checkpointAttempts += 1;
        return !(simulateBusy && checkpointAttempts === 2);
      },
    });
    try {
      const attacker = maintenanceService.createSession();
      const defender = maintenanceService.createSession();
      maintenanceService.recordTap(
        tapBody(attacker, 1, defender.state.player.territoryId),
      );
      expect(checkpointAttempts).toBe(1);

      simulateBusy = true;
      maintenanceNow += 2 * 24 * 60 * 60 * 1000;
      await vi.waitFor(() => expect(checkpointAttempts).toBe(2), {
        timeout: 1000,
        interval: 5,
      });
      expect(
        maintenanceService.getState(attacker.playerId, attacker.sessionId)
          .player.id,
      ).toBe(attacker.playerId);
      expect(maintenanceService.health()).toMatchObject({
        status: "ok",
        retentionMaintenance: "retrying",
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(checkpointAttempts).toBe(2);
      maintenanceNow += 60_000;
      await vi.waitFor(() => expect(checkpointAttempts).toBe(3), {
        timeout: 1000,
        interval: 5,
      });
      expect(maintenanceService.health()).toMatchObject({
        status: "ok",
        retentionMaintenance: "ok",
      });
    } finally {
      maintenanceService.close();
    }
  });

  it("contains maintenance exceptions and recovers on the next retry", async () => {
    let maintenanceNow = now;
    let checkpointAttempts = 0;
    const maintenanceService = new IdleService({
      dbPath: join(directory, "failed-retention.sqlite"),
      now: () => maintenanceNow,
      retentionMaintenancePollMs: 5,
      retentionWalCheckpoint: () => {
        checkpointAttempts += 1;
        if (checkpointAttempts === 2) {
          throw new Error("simulated checkpoint failure");
        }
        return true;
      },
    });
    try {
      maintenanceNow += 2 * 24 * 60 * 60 * 1000;
      await vi.waitFor(() => expect(checkpointAttempts).toBe(2), {
        timeout: 1000,
        interval: 5,
      });
      expect(maintenanceService.health()).toMatchObject({
        status: "ok",
        retentionMaintenance: "retrying",
      });

      maintenanceNow += 60_000;
      await vi.waitFor(() => expect(checkpointAttempts).toBe(3), {
        timeout: 1000,
        interval: 5,
      });
      expect(maintenanceService.health()).toMatchObject({
        status: "ok",
        retentionMaintenance: "ok",
      });
    } finally {
      maintenanceService.close();
    }
  });

  it("rejects the published telemetry-secret placeholder in production", () => {
    const previousGameEnv = process.env.GAME_ENV;
    process.env.GAME_ENV = "prod";
    try {
      expect(
        () =>
          new IdleService({
            dbPath: join(directory, "placeholder.sqlite"),
            telemetryHmacSecret: "replace_with_at_least_32_random_characters",
          }),
      ).toThrow(/non-placeholder secret/);
    } finally {
      if (previousGameEnv === undefined) delete process.env.GAME_ENV;
      else process.env.GAME_ENV = previousGameEnv;
    }
  });

  it("rejects raw retention beyond the disclosed live window", () => {
    expect(
      () =>
        new IdleService({
          dbPath: join(directory, "over-retention.sqlite"),
          rawTapRetentionDays: 15,
        }),
    ).toThrow(/between 1 and 14/);
  });
});
