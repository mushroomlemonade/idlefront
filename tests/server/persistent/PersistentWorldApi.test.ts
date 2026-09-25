import express from "express";
import { mkdtempSync, rmSync } from "fs";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { PersistentWorldRepository } from "../../../src/server/persistent/PersistentWorldRepository";
import { createPersistentWorldRouter } from "../../../src/server/persistent/PersistentWorldRoutes";
import {
  PersistentWorldService,
  PersistentWorldServiceError,
} from "../../../src/server/persistent/PersistentWorldService";

interface SessionResponse {
  bearerToken: string;
  session: {
    id: string;
    identity: {
      id: string;
      displayName: string;
    };
  };
}

interface CreatedWorldResponse {
  invitationSecret: string | null;
  snapshot: {
    world: {
      id: string;
      phase: string;
      scheduleLocked: boolean;
    };
    members: Array<{
      identity: Record<string, unknown>;
      isViewer: boolean;
    }>;
    reminderOptionsMs: number[];
    viewer: {
      isHost: boolean;
      isMember: boolean;
    };
  };
}

describe("persistent-world HTTP API", () => {
  let directory: string;
  let service: PersistentWorldService;
  let server: Server;
  let baseUrl: string;
  let now: number;

  it("exposes an authenticated, host-only start endpoint for public custom rooms", async () => {
    const host = service.createGuestSession({ displayName: "Custom Host" });
    const guest = service.createGuestSession({ displayName: "Custom Guest" });
    const created = service.createWorld(host.bearerToken, {
      name: "Public custom game",
      startMode: "host",
      gamePreset: "great-lakes",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 8,
      startsAt: now,
    });
    const url = baseUrl + "/" + created.snapshot.world.id + "/start";
    const start = (token: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: "{}",
      });
    expect((await start(guest.bearerToken)).status).toBe(403);
    const response = await start(host.bearerToken);
    expect(response.status).toBe(200);
    expect((await response.json()).world).toMatchObject({
      phase: "active",
      startMode: "host",
      gamePreset: "great-lakes",
    });
    expect((await start(host.bearerToken)).status).toBe(200);
  });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "openfront-world-api-test-"));
    now = 2_000_000_000_000;
    const repository = new PersistentWorldRepository({
      dbPath: join(directory, "persistent-worlds.sqlite"),
      now: () => now,
    });
    service = new PersistentWorldService(repository, { now: () => now });

    const app = express();
    app.use(express.json({ limit: "16kb" }));
    app.use(
      "/api/worlds",
      createPersistentWorldRouter(service, {
        accountSessionFactory: async ({ authorization }) => {
          if (authorization !== "Bearer verified-account-jwt") {
            throw new PersistentWorldServiceError(
              401,
              "ACCOUNT_UNAUTHORIZED",
              "Account authentication failed",
            );
          }
          return repository.createControllerSession({
            id: "pwi_account_01",
            kind: "account",
            subject: "verified-provider-subject",
            displayName: "Account Player",
            verifiedEmail: "account@example.test",
          });
        },
        gameplayIdentityVerifier: async (playToken) => {
          if (playToken !== "verified-play-token") {
            throw new PersistentWorldServiceError(
              401,
              "GAME_IDENTITY_INVALID",
              "Gameplay authentication failed",
            );
          }
          return "a".repeat(64);
        },
      }),
    );
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/worlds`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function jsonRequest(
    path: string,
    init: RequestInit = {},
  ): Promise<{ response: Response; body: any }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : undefined };
  }

  async function createSession(displayName: string): Promise<SessionResponse> {
    const { response, body } = await jsonRequest("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body as SessionResponse;
  }

  function authenticatedJson(
    bearerToken: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json",
      ...extra,
    };
  }

  async function createWorld(
    host: SessionResponse,
    access: "private" | "public",
  ): Promise<CreatedWorldResponse> {
    const { response, body } = await jsonRequest("/", {
      method: "POST",
      headers: authenticatedJson(host.bearerToken),
      body: JSON.stringify({
        name: access === "private" ? "Cedar Compact" : "Open Meridian",
        targetDuration: "1d",
        access,
        mode: "ffa",
        maxHumans: 8,
        startsAt: now + 6 * 60 * 60 * 1000,
      }),
    });
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body as CreatedWorldResponse;
  }

  it("lets separate devices on the same IP unlock and reclaim a nation", async () => {
    const laptop = await createSession("Captain");
    const created = await jsonRequest("/", {
      method: "POST",
      headers: authenticatedJson(laptop.bearerToken),
      body: JSON.stringify({
        name: "LAN friends",
        password: "party",
        access: "private",
        targetDuration: "1d",
        mode: "ffa",
        maxHumans: 8,
        startsAt: now + 120_000,
      }),
    });
    expect(created.response.status).toBe(201);
    const id = created.body.snapshot.world.id;
    const phone = await createSession("Captain");
    const unlock = await jsonRequest(`/${id}/unlock`, {
      method: "POST",
      headers: authenticatedJson(phone.bearerToken),
      body: JSON.stringify({ password: "party", displayName: "Captain" }),
    });
    expect(unlock.response.status).toBe(200);
    const view = await jsonRequest(`/${id}`, {
      headers: authenticatedJson(phone.bearerToken),
    });
    expect(view.response.status).toBe(200);
    expect(view.body.viewer.identity.id).toBe(laptop.session.identity.id);
    expect(view.body.members).toHaveLength(1);
    const friend = await createSession("Friend");
    expect(
      (
        await jsonRequest(`/${id}`, {
          headers: authenticatedJson(friend.bearerToken),
        })
      ).response.status,
    ).toBe(403);
    const bad = await jsonRequest(`/${id}/unlock`, {
      method: "POST",
      headers: authenticatedJson(friend.bearerToken),
      body: JSON.stringify({ password: "wrong", displayName: "Captain" }),
    });
    expect(bad.response.status).toBe(403);
  });

  it("keeps private invitations out of URLs and lobby identity data", async () => {
    const formSession = await jsonRequest("/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "displayName=Host",
    });
    expect(formSession.response.status).toBe(415);
    expect(formSession.body).toEqual({
      error: {
        code: "JSON_REQUIRED",
        message: "This endpoint accepts application/json only",
      },
    });

    const host = await createSession("Host");
    const guest = await createSession("Guest");

    const bound = await jsonRequest("/session/game-identity", {
      method: "POST",
      headers: authenticatedJson(host.bearerToken),
      body: JSON.stringify({ playToken: "verified-play-token" }),
    });
    expect(bound.response.status).toBe(200);
    expect(bound.body).toEqual({ bound: true });
    expect(
      service.repository.gameplayIdentityHash(host.session.identity.id),
    ).toBe("a".repeat(64));

    const invalidBinding = await jsonRequest("/session/game-identity", {
      method: "POST",
      headers: authenticatedJson(guest.bearerToken),
      body: JSON.stringify({ playToken: "wrong" }),
    });
    expect(invalidBinding.response.status).toBe(401);
    expect(invalidBinding.body.error.code).toBe("GAME_IDENTITY_INVALID");

    const missingSession = await jsonRequest("/session");
    expect(missingSession.response.status).toBe(401);
    expect(missingSession.body.error.code).toBe("SESSION_REQUIRED");

    const resumed = await jsonRequest("/session", {
      headers: { authorization: `Bearer ${host.bearerToken}` },
    });
    expect(resumed.response.status).toBe(200);
    expect(resumed.body.identity.id).toBe(host.session.identity.id);

    const created = await createWorld(host, "private");
    const worldId = created.snapshot.world.id;
    expect(created.invitationSecret).toMatch(/^invite_/);
    expect(created.snapshot.viewer).toMatchObject({
      isHost: true,
      isMember: true,
    });
    expect(created.snapshot.members[0].identity).toEqual({
      id: host.session.identity.id,
      displayName: "Host",
    });
    expect(created.snapshot.members[0].identity).not.toHaveProperty("subject");
    expect(created.snapshot.members[0].identity).not.toHaveProperty(
      "verifiedEmail",
    );

    const noInvite = await jsonRequest(`/${worldId}`);
    expect(noInvite.response.status).toBe(403);
    expect(noInvite.body.error.code).toBe("INVITATION_REQUIRED");

    const queryInvite = await jsonRequest(
      `/${worldId}?invite=${encodeURIComponent(created.invitationSecret!)}`,
    );
    expect(queryInvite.response.status).toBe(400);
    expect(queryInvite.body.error.code).toBe("QUERY_NOT_ALLOWED");

    const invitedView = await jsonRequest(`/${worldId}`, {
      headers: { "x-world-invite": created.invitationSecret! },
    });
    expect(invitedView.response.status).toBe(200);
    expect(invitedView.body.viewer.identity).toBeNull();

    const secretInBody = await jsonRequest(`/${worldId}/rsvp`, {
      method: "PUT",
      headers: authenticatedJson(guest.bearerToken),
      body: JSON.stringify({ invitationSecret: created.invitationSecret }),
    });
    expect(secretInBody.response.status).toBe(400);
    expect(secretInBody.body.error.code).toBe("INVALID_REQUEST");

    const joined = await jsonRequest(`/${worldId}/rsvp`, {
      method: "PUT",
      headers: authenticatedJson(guest.bearerToken, {
        "x-world-invite": created.invitationSecret!,
      }),
      body: JSON.stringify({}),
    });
    expect(joined.response.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.world.scheduleLocked).toBe(true);
    expect(joined.body.members).toHaveLength(2);
    const guestMember = joined.body.members.find(
      (member: { isViewer: boolean }) => member.isViewer,
    );
    expect(guestMember.identity).toEqual({
      id: guest.session.identity.id,
      displayName: "Guest",
    });

    const mine = await jsonRequest("/mine", {
      headers: { authorization: `Bearer ${guest.bearerToken}` },
    });
    expect(mine.response.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({
      rsvpCount: 2,
      isViewerMember: true,
      viewerEliminated: false,
      world: { id: worldId },
    });

    const chat = await jsonRequest(`/${worldId}/quick-chat`, {
      method: "POST",
      headers: authenticatedJson(guest.bearerToken),
      body: JSON.stringify({ id: "message_01", phraseKey: "help.troops" }),
    });
    expect(chat.response.status, JSON.stringify(chat.body)).toBe(201);
    expect(chat.body).toEqual({
      id: "message_01",
      sender: { id: guest.session.identity.id, displayName: "Guest" },
      phraseKey: "help.troops",
      sentAt: now,
    });
    expect(chat.body.sender).not.toHaveProperty("subject");

    const leadTime = joined.body.reminderOptionsMs[0] as number;
    const reminders = await jsonRequest(`/${worldId}/reminders`, {
      method: "PUT",
      headers: authenticatedJson(guest.bearerToken),
      body: JSON.stringify({ leadTimesMs: [leadTime] }),
    });
    expect(reminders.response.status, JSON.stringify(reminders.body)).toBe(200);
    expect(reminders.body).toMatchObject({
      worldId,
      identityId: guest.session.identity.id,
      leadTimesMs: [leadTime],
    });

    const left = await jsonRequest(`/${worldId}/rsvp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${guest.bearerToken}` },
    });
    expect(left.response.status).toBe(204);

    const formerMemberView = await jsonRequest(`/${worldId}`, {
      headers: { authorization: `Bearer ${guest.bearerToken}` },
    });
    expect(formerMemberView.response.status).toBe(403);
  });

  it("supports public discovery, RSVP, host cancellation, and stable errors", async () => {
    const untrustedIdentityBody = await jsonRequest("/session/account", {
      method: "POST",
      headers: {
        authorization: "Bearer verified-account-jwt",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        identity: { id: "attacker", displayName: "Attacker" },
      }),
    });
    expect(untrustedIdentityBody.response.status).toBe(400);
    expect(untrustedIdentityBody.body.error.code).toBe("INVALID_REQUEST");

    const accountSession = await jsonRequest("/session/account", {
      method: "POST",
      headers: {
        authorization: "Bearer verified-account-jwt",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(accountSession.response.status).toBe(201);
    expect(accountSession.body.session.identity).toMatchObject({
      id: "pwi_account_01",
      kind: "account",
      displayName: "Account Player",
    });
    expect(accountSession.body.bearerToken).toEqual(expect.any(String));

    const host = await createSession("Public Host");
    const player = await createSession("Public Player");
    const created = await createWorld(host, "public");
    const worldId = created.snapshot.world.id;
    expect(created.invitationSecret).toBeNull();

    const discovery = await jsonRequest("/public");
    expect(discovery.response.status).toBe(200);
    expect(discovery.body).toHaveLength(1);
    expect(discovery.body[0]).toMatchObject({
      world: { id: worldId, access: "public", phase: "scheduled" },
      host: { id: host.session.identity.id, displayName: "Public Host" },
      rsvpCount: 1,
      isViewerMember: false,
      viewerEliminated: false,
    });
    expect(discovery.body[0].host).not.toHaveProperty("subject");

    const publicSnapshot = await jsonRequest(`/${worldId}`);
    expect(publicSnapshot.response.status).toBe(200);

    const joined = await jsonRequest(`/${worldId}/rsvp`, {
      method: "PUT",
      headers: authenticatedJson(player.bearerToken),
      body: JSON.stringify({}),
    });
    expect(joined.response.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.viewer).toMatchObject({
      isMember: true,
      isHost: false,
      canChat: true,
    });

    const unknownPhrase = await jsonRequest(`/${worldId}/quick-chat`, {
      method: "POST",
      headers: authenticatedJson(player.bearerToken),
      body: JSON.stringify({
        id: "message_02",
        phraseKey: "lobby.not_in_catalog",
      }),
    });
    expect(unknownPhrase.response.status).toBe(400);
    expect(unknownPhrase.body).toEqual({
      error: {
        code: "QUICK_CHAT_UNKNOWN",
        message: "Lobby chat accepts only phrases from the quick-chat catalog",
      },
    });

    const unauthorizedCancel = await jsonRequest(`/${worldId}/cancel`, {
      method: "POST",
      headers: authenticatedJson(player.bearerToken),
      body: JSON.stringify({}),
    });
    expect(unauthorizedCancel.response.status).toBe(403);
    expect(unauthorizedCancel.body.error.code).toBe("FORBIDDEN");

    const cancelled = await jsonRequest(`/${worldId}/cancel`, {
      method: "POST",
      headers: authenticatedJson(host.bearerToken),
      body: JSON.stringify({}),
    });
    expect(cancelled.response.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.world.phase).toBe("cancelled");

    const afterCancelDiscovery = await jsonRequest("/public");
    expect(afterCancelDiscovery.body).toEqual([]);

    const invalidBearer = await jsonRequest("/mine", {
      headers: { authorization: "Bearer invalid" },
    });
    expect(invalidBearer.response.status).toBe(401);
    expect(invalidBearer.body.error.code).toBe("SESSION_REQUIRED");

    const malformedWorldId = await jsonRequest("/not%20a%20world");
    expect(malformedWorldId.response.status).toBe(400);
    expect(malformedWorldId.body.error.code).toBe("INVALID_REQUEST");
  });

  it("serves only the authenticated identity's privacy-safe notification feed", async () => {
    const host = await createSession("Notification Host");
    const outsider = await createSession("Outsider");
    const created = await createWorld(host, "public");
    now += 6 * 60 * 60 * 1000;

    const claims = service.repository.claimDueNotificationJobs({ now });
    expect(claims).toHaveLength(1);
    expect(claims[0].job.channel).toBe("in_app");
    service.repository.acknowledgeNotificationJob(claims[0].claimToken, now);

    const unauthenticated = await jsonRequest("/notifications");
    expect(unauthenticated.response.status).toBe(401);

    const feed = await jsonRequest("/notifications", {
      headers: { authorization: `Bearer ${host.bearerToken}` },
    });
    expect(feed.response.status).toBe(200);
    expect(feed.body).toEqual([
      expect.objectContaining({
        id: claims[0].job.id,
        world: {
          id: created.snapshot.world.id,
          name: "Open Meridian",
          startsAt: now,
        },
        kind: "start",
        leadTimeMs: null,
        readAt: null,
      }),
    ]);
    expect(JSON.stringify(feed.body)).not.toContain("verifiedEmail");
    expect(JSON.stringify(feed.body)).not.toContain("subject");

    const cannotReadAnotherIdentity = await jsonRequest(
      `/notifications/${claims[0].job.id}/read`,
      {
        method: "PUT",
        headers: authenticatedJson(outsider.bearerToken),
        body: JSON.stringify({}),
      },
    );
    expect(cannotReadAnotherIdentity.response.status).toBe(404);

    const read = await jsonRequest(`/notifications/${claims[0].job.id}/read`, {
      method: "PUT",
      headers: authenticatedJson(host.bearerToken),
      body: JSON.stringify({}),
    });
    expect(read.response.status).toBe(200);
    expect(read.body).toMatchObject({ id: claims[0].job.id, readAt: now });
  });
});
