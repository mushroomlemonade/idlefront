import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistentWorldRepository } from "../../../src/server/persistent/PersistentWorldRepository";
import {
  PersistentWorldService,
  PersistentWorldServiceError,
} from "../../../src/server/persistent/PersistentWorldService";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("PersistentWorldService lifecycle", () => {
  let directory: string;
  let dbPath: string;
  let now: number;
  let repository: PersistentWorldRepository;
  let service: PersistentWorldService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "persistent-world-lifecycle-"));
    dbPath = join(directory, "worlds.sqlite");
    now = 2_000_000_000_000;
    ({ repository, service } = openApplication());
  });

  afterEach(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function openApplication(): {
    repository: PersistentWorldRepository;
    service: PersistentWorldService;
  } {
    const nextRepository = new PersistentWorldRepository({
      dbPath,
      now: () => now,
    });
    return {
      repository: nextRepository,
      service: new PersistentWorldService(nextRepository, { now: () => now }),
    };
  }

  function restartApplication(): void {
    service.close();
    ({ repository, service } = openApplication());
  }

  function guest(displayName: string) {
    return service.createGuestSession({ displayName });
  }

  function createWorld(
    bearerToken: string,
    overrides: Partial<{
      name: string;
      targetDuration: "1h" | "1d" | "7d";
      access: "private" | "public";
      mode: "ffa" | "teams";
      maxHumans: number;
      startsAt: number;
      teamId: string | null;
      startMode: "host" | "scheduled";
      gamePreset: "great-lakes" | "scheduled-earth";
    }> = {},
  ) {
    return service.createWorld(bearerToken, {
      name: "Persistent Friday",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 8,
      startsAt: now + DAY,
      ...overrides,
    });
  }

  it("returns privacy-safe lobby snapshots even for verified account members", () => {
    const host = guest("Host");
    repository.attachVerifiedEmail(host.bearerToken, {
      verifiedEmail: "host.private@example.com",
    });
    repository.attachAccount(host.bearerToken, {
      accountSubject: "provider-secret-host-subject",
    });
    const player = guest("Player");
    repository.attachVerifiedEmail(player.bearerToken, {
      verifiedEmail: "player.private@example.com",
    });

    const created = createWorld(host.bearerToken);
    const worldId = created.snapshot.world.id;
    service.rsvp(worldId, player.bearerToken, {});

    const snapshot = service.getSnapshot(worldId, host.bearerToken);
    expect(snapshot.members.map((member) => member.identity)).toEqual(
      expect.arrayContaining([
        { id: host.session.identity.id, displayName: "Host" },
        { id: player.session.identity.id, displayName: "Player" },
      ]),
    );
    expect(snapshot.viewer).toMatchObject({
      identity: { id: host.session.identity.id, displayName: "Host" },
      hasVerifiedEmail: true,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("host.private@example.com");
    expect(serialized).not.toContain("player.private@example.com");
    expect(serialized).not.toContain("provider-secret-host-subject");
    expect(serialized).not.toContain('"subject"');
    expect(serialized).not.toContain('"verifiedEmail"');
  });

  it("resumes the same guest identity and membership after an application restart", () => {
    const host = guest("Night Host");
    const created = createWorld(host.bearerToken);
    const worldId = created.snapshot.world.id;
    const originalIdentity = host.session.identity;

    now += MINUTE;
    restartApplication();

    expect(service.resumeSession(host.bearerToken)).toMatchObject({
      id: host.session.id,
      identity: originalIdentity,
      lastUsedAt: now,
    });
    expect(service.listMine(host.bearerToken)).toEqual([
      expect.objectContaining({
        world: expect.objectContaining({ id: worldId }),
        isViewerMember: true,
        viewerEliminated: false,
      }),
    ]);
  });

  it("warns an eliminated RSVP on the world card before lobby entry", () => {
    const host = guest("Eliminated Host");
    const created = createWorld(host.bearerToken);
    vi.spyOn(repository, "runtimePlayerStatus").mockReturnValue({
      worldId: created.snapshot.world.id,
      identityId: host.session.identity.id,
      clientId: "Seat0001",
      isAlive: false,
      killedBy: "Seat0002",
      deathPosition: 3,
      observedTurn: 200,
      updatedAt: now,
    });

    expect(service.listMine(host.bearerToken)[0]).toMatchObject({
      isViewerMember: true,
      viewerEliminated: true,
    });
  });

  it("allows a shorter invitation floor only when explicitly configured", () => {
    service.close();
    repository = new PersistentWorldRepository({
      dbPath,
      now: () => now,
    });
    service = new PersistentWorldService(repository, {
      now: () => now,
      minimumStartDelayMs: 1_000,
    });
    const host = guest("Debug Host");

    expect(() =>
      createWorld(host.bearerToken, { startsAt: now + 500 }),
    ).toThrowError(
      expect.objectContaining({
        code: "START_TOO_SOON",
      }),
    );
    expect(
      createWorld(host.bearerToken, { startsAt: now + 1_000 }).snapshot.world,
    ).toMatchObject({ startsAt: now + 1_000, phase: "scheduled" });
  });

  it("requires a private invitation until a guest has durably RSVPed", () => {
    const host = guest("Host");
    const player = guest("Invitee");
    const created = createWorld(host.bearerToken, { access: "private" });
    const worldId = created.snapshot.world.id;
    const invitationSecret = created.invitationSecret!;

    expect(() => service.getSnapshot(worldId)).toThrowError(
      expect.objectContaining({
        name: "PersistentWorldServiceError",
        status: 403,
        code: "INVITATION_REQUIRED",
      }),
    );
    expect(() =>
      service.getSnapshot(
        worldId,
        player.bearerToken,
        "invite_this_is_not_the_valid_secret",
      ),
    ).toThrowError(PersistentWorldServiceError);

    const invitationView = service.getSnapshot(
      worldId,
      player.bearerToken,
      invitationSecret,
    );
    expect(invitationView.viewer).toMatchObject({
      isMember: false,
      canRsvp: true,
    });

    service.rsvp(worldId, player.bearerToken, { invitationSecret });
    restartApplication();
    expect(
      service.getSnapshot(worldId, player.bearerToken).viewer,
    ).toMatchObject({ isMember: true, canChat: true });
  });

  it("keeps RSVPs and team choices durable while treating presence as transient", () => {
    const host = guest("Host");
    const player = guest("Teammate");
    const created = createWorld(host.bearerToken, {
      access: "private",
      mode: "teams",
      teamId: "amber",
      startMode: "host",
      gamePreset: "great-lakes",
    });
    const worldId = created.snapshot.world.id;
    service.rsvp(worldId, player.bearerToken, {
      invitationSecret: created.invitationSecret,
      teamId: "violet",
    });

    expect(
      service
        .getSnapshot(worldId, host.bearerToken)
        .members.find(
          (member) => member.identity.id === player.session.identity.id,
        ),
    ).toMatchObject({ teamId: "violet", presence: "online" });

    restartApplication();
    const afterRestart = service.getSnapshot(worldId, host.bearerToken);
    expect(
      afterRestart.members.find(
        (member) => member.identity.id === player.session.identity.id,
      ),
    ).toMatchObject({
      identity: { displayName: "Teammate" },
      teamId: "violet",
      presence: "offline",
    });
    expect(afterRestart.world.scheduleLocked).toBe(true);
  });

  it("offers and durably selects the inferred fourteen-day reminder offsets", () => {
    const host = guest("Host");
    const created = createWorld(host.bearerToken, {
      startsAt: now + 14 * DAY,
    });
    const worldId = created.snapshot.world.id;

    expect(created.snapshot.reminderOptionsMs).toEqual([
      2 * DAY,
      12 * HOUR,
      90 * MINUTE,
    ]);
    service.setReminders(worldId, host.bearerToken, {
      leadTimesMs: [90 * MINUTE, 2 * DAY],
    });

    restartApplication();
    expect(
      service.getSnapshot(worldId, host.bearerToken)
        .selectedReminderLeadTimesMs,
    ).toEqual([2 * DAY, 90 * MINUTE]);
  });

  it("accepts catalog quick-chat keys and rejects arbitrary or unknown text", () => {
    const host = guest("Host");
    const created = createWorld(host.bearerToken);
    const worldId = created.snapshot.world.id;

    expect(
      service.postQuickChat(worldId, host.bearerToken, {
        id: "chat_message_001",
        phraseKey: "greet.hello",
      }),
    ).toMatchObject({ phraseKey: "greet.hello" });
    expect(() =>
      service.postQuickChat(worldId, host.bearerToken, {
        id: "chat_message_002",
        phraseKey: "greet.user_authored_message",
      }),
    ).toThrowError(
      expect.objectContaining({
        status: 400,
        code: "QUICK_CHAT_UNKNOWN",
      }),
    );
    expect(() =>
      service.postQuickChat(worldId, host.bearerToken, {
        id: "chat_message_003",
        phraseKey: "meet me at 8",
      }),
    ).toThrow();

    const snapshot = service.getSnapshot(worldId, host.bearerToken);
    expect(snapshot.quickChat).toEqual([
      expect.objectContaining({
        phraseKey: "greet.hello",
        sender: { id: host.session.identity.id, displayName: "Host" },
      }),
    ]);
  });

  it("auto-starts a due world after restart without any online presence", () => {
    const host = guest("Sleeping Host");
    const created = createWorld(host.bearerToken, {
      startsAt: now + MINUTE,
    });
    const worldId = created.snapshot.world.id;

    restartApplication();
    now += MINUTE;
    expect(service.activateDueWorlds()).toEqual([
      expect.objectContaining({
        id: worldId,
        phase: "active",
        activatedAt: now,
      }),
    ]);
    expect(service.activateDueWorlds()).toEqual([]);
    expect(repository.getWorld(worldId)).toMatchObject({
      phase: "active",
      activatedAt: now,
    });
  });

  it("archives a world that never provisions and hides it from the active hub", () => {
    const host = guest("Sleeping Host");
    const created = createWorld(host.bearerToken, {
      targetDuration: "1h",
      startsAt: now + MINUTE,
    });
    const worldId = created.snapshot.world.id;

    now += MINUTE;
    service.activateDueWorlds();
    now += 5 * MINUTE;

    expect(service.archiveStaleWorlds()).toMatchObject({
      finished: [],
      cancelled: [{ id: worldId, phase: "cancelled" }],
    });
    expect(service.listPublic().map((card) => card.world.id)).not.toContain(
      worldId,
    );
    expect(service.listMine(host.bearerToken)).toEqual([]);
    expect(service.getSnapshot(worldId, host.bearerToken).world.phase).toBe(
      "cancelled",
    );
  });

  it("separates public discovery from a player's public and private worlds", () => {
    const host = guest("Host");
    const player = guest("Player");
    const publicWorld = createWorld(host.bearerToken, {
      name: "Discoverable",
      access: "public",
    });
    const privateWorld = createWorld(player.bearerToken, {
      name: "Invitation Only",
      access: "private",
    });
    service.rsvp(publicWorld.snapshot.world.id, player.bearerToken, {});

    expect(service.listPublic().map((card) => card.world.id)).toEqual([
      publicWorld.snapshot.world.id,
    ]);
    expect(service.listPublic(player.bearerToken)[0]).toMatchObject({
      host: { displayName: "Host" },
      rsvpCount: 2,
      isViewerMember: true,
      viewerEliminated: false,
    });
    expect(
      new Set(
        service.listMine(player.bearerToken).map((card) => card.world.id),
      ),
    ).toEqual(
      new Set([publicWorld.snapshot.world.id, privateWorld.snapshot.world.id]),
    );
  });

  it("allows only the host to cancel and leaves a failed attempt unchanged", () => {
    const host = guest("Host");
    const outsider = guest("Outsider");
    const created = createWorld(host.bearerToken);
    const worldId = created.snapshot.world.id;

    expect(() => service.cancel(worldId, outsider.bearerToken)).toThrowError(
      expect.objectContaining({
        name: "PersistentWorldRepositoryError",
        code: "FORBIDDEN",
      }),
    );
    expect(repository.getWorld(worldId)?.phase).toBe("scheduled");

    expect(service.cancel(worldId, host.bearerToken)).toMatchObject({
      world: { id: worldId, phase: "cancelled" },
      viewer: { isHost: true, canCancel: false },
    });
    expect(service.listPublic().map((card) => card.world.id)).not.toContain(
      worldId,
    );
  });
});
