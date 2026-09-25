import { mkdtempSync, rmSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../../src/core/game/Game";
import { inferredReminderLeadTimes } from "../../../src/core/PersistentWorldReminders";
import {
  CreatePersistentWorldInputSchema,
  PersistentWorldLobbyMemberSchema,
  PersistentWorldRsvpSchema,
  persistentWorldDurationMs,
  type PersistentWorldIdentity,
} from "../../../src/core/PersistentWorldSchemas";
import type { GameConfig } from "../../../src/core/Schemas";
import {
  PersistentWorldRepository,
  PersistentWorldRepositoryError,
  type PersistentWorldRepositoryErrorCode,
} from "../../../src/server/persistent/PersistentWorldRepository";

const INVITATION_SECRET = "invite_secret_with_enough_entropy_123";
const RUNTIME_GAME_CONFIG: GameConfig = {
  gameMap: GameMapType.World,
  difficulty: Difficulty.Medium,
  donateGold: true,
  donateTroops: true,
  gameType: GameType.Private,
  gameMode: GameMode.FFA,
  gameMapSize: GameMapSize.Normal,
  nations: "default",
  bots: 20,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
  maxPlayers: 4,
};

function account(
  id: string,
  displayName: string = id,
): PersistentWorldIdentity {
  return {
    id,
    kind: "account",
    subject: `${id}-subject`,
    displayName,
    verifiedEmail: null,
  };
}

function expectRepositoryError(
  operation: () => unknown,
  code: PersistentWorldRepositoryErrorCode,
): void {
  try {
    operation();
    throw new Error(`Expected repository error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PersistentWorldRepositoryError);
    expect((error as PersistentWorldRepositoryError).code).toBe(code);
  }
}

describe("PersistentWorldRepository", () => {
  let directory: string;
  let dbPath: string;
  let now: number;
  let repository: PersistentWorldRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "persistent-world-test-"));
    dbPath = join(directory, "worlds.sqlite");
    now = 2_000_000_000_000;
    repository = new PersistentWorldRepository({
      dbPath,
      now: () => now,
    });
  });

  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("validates the bounded world contract and keeps presence transient", () => {
    const base = {
      id: "world_contract",
      name: "Friday World",
      targetDuration: "1d" as const,
      access: "public" as const,
      mode: "ffa" as const,
      maxHumans: 16,
      startsAt: now + 60_000,
      host: account("identity_host"),
    };

    expect(CreatePersistentWorldInputSchema.parse(base)).toMatchObject(base);
    expect(
      CreatePersistentWorldInputSchema.safeParse({ ...base, maxHumans: 17 })
        .success,
    ).toBe(false);
    expect(
      CreatePersistentWorldInputSchema.safeParse({
        ...base,
        targetDuration: "30d",
      }).success,
    ).toBe(false);
    expect(
      CreatePersistentWorldInputSchema.safeParse({
        ...base,
        access: "private",
      }).success,
    ).toBe(false);

    const durableRsvp = {
      worldId: base.id,
      identity: base.host,
      isHost: true,
      teamId: null,
      joinedAt: now,
      lastSeenAt: now,
    };
    expect(PersistentWorldRsvpSchema.parse(durableRsvp)).not.toHaveProperty(
      "presence",
    );
    expect(
      PersistentWorldLobbyMemberSchema.parse({
        ...durableRsvp,
        presence: "offline",
      }).presence,
    ).toBe("offline");
  });

  it("creates resumable guests without storing raw secrets and upgrades identity in place", () => {
    const created = repository.createGuestIdentity({
      displayName: "Night Owl",
    });
    const identityId = created.session.identity.id;
    expect(created.bearerToken.length).toBeGreaterThanOrEqual(32);

    const audit = new DatabaseSync(dbPath, { readOnly: true });
    const storedSession = audit
      .prepare(
        "SELECT token_hash FROM persistent_world_controller_sessions WHERE id = ?",
      )
      .get(created.session.id) as { token_hash: string };
    expect(storedSession.token_hash).not.toBe(created.bearerToken);
    expect(storedSession.token_hash).not.toContain(created.bearerToken);
    audit.close();

    now += 1_000;
    const resumed = repository.resumeControllerSession(created.bearerToken);
    expect(resumed).toMatchObject({
      id: created.session.id,
      identity: { id: identityId, kind: "guest" },
      lastUsedAt: now,
    });

    const withEmail = repository.attachVerifiedEmail(created.bearerToken, {
      verifiedEmail: "Player@Example.com",
    });
    expect(withEmail).toMatchObject({
      id: identityId,
      kind: "email",
      subject: "player@example.com",
      verifiedEmail: "player@example.com",
    });

    const withAccount = repository.attachAccount(created.bearerToken, {
      accountSubject: "account-42",
      displayName: "Commander",
    });
    expect(withAccount).toMatchObject({
      id: identityId,
      kind: "account",
      subject: "account-42",
      displayName: "Commander",
      verifiedEmail: "player@example.com",
    });

    repository.close();
    repository = new PersistentWorldRepository({ dbPath, now: () => now });
    expect(
      repository.resumeControllerSession(created.bearerToken)?.identity,
    ).toEqual(withAccount);

    repository.revokeControllerSession(created.bearerToken);
    repository.revokeControllerSession(created.bearerToken);
    expect(
      repository.resumeControllerSession(created.bearerToken),
    ).toBeUndefined();
  });

  it("migrates v3 identities and binds each gameplay principal exactly once without public leakage", () => {
    const host = account("identity_runtime_host", "Runtime Host");
    const guest = account("identity_runtime_guest", "Runtime Guest");
    const world = repository.createWorld({
      id: "world_v3_upgrade",
      name: "Upgrade-safe World",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt: now + 60_000,
      host,
    });
    repository.rsvp({ worldId: world.id, identity: guest });

    // Turn the freshly-created fixture back into the exact v3 shape. This
    // proves the additive migration works with existing identities, worlds,
    // RSVP rows, reminders, and notification data instead of only from v0.
    repository.close();
    const v3 = new DatabaseSync(dbPath);
    v3.exec(`
      DROP TABLE persistent_world_claims;
      DROP TABLE persistent_world_passwords;
      DROP TABLE persistent_world_runtime_player_status;
      DROP TABLE persistent_world_runtime_turns;
      DROP TABLE persistent_world_runtimes;
      DROP INDEX persistent_world_identities_gameplay_hash_idx;
      ALTER TABLE persistent_world_identities
        DROP COLUMN gameplay_persistent_id_hash;
      DELETE FROM persistent_world_schema_migrations WHERE version >= 4;
    `);
    v3.close();
    repository = new PersistentWorldRepository({ dbPath, now: () => now });

    expect(repository.getWorld(world.id)?.rsvps).toHaveLength(2);
    expect(repository.gameplayIdentityHash(host.id)).toBeNull();

    const hostHash = "A".repeat(64);
    const normalizedHostHash = hostHash.toLowerCase();
    expect(repository.bindGameplayIdentity(host.id, hostHash)).toBe(
      normalizedHostHash,
    );
    expect(repository.bindGameplayIdentity(host.id, normalizedHostHash)).toBe(
      normalizedHostHash,
    );
    expect(repository.gameplayIdentityHash(host.id)).toBe(normalizedHostHash);

    expectRepositoryError(
      () => repository.bindGameplayIdentity(host.id, "b".repeat(64)),
      "CONFLICT",
    );
    expectRepositoryError(
      () => repository.bindGameplayIdentity(guest.id, normalizedHostHash),
      "CONFLICT",
    );
    expectRepositoryError(
      () => repository.bindGameplayIdentity(guest.id, "not-a-sha256"),
      "INVALID_ARGUMENT",
    );
    expectRepositoryError(
      () => repository.bindGameplayIdentity("identity_missing", "c".repeat(64)),
      "NOT_FOUND",
    );

    const publicWorld = repository.getWorld(world.id)!;
    expect(publicWorld.host).not.toHaveProperty("gameplayPersistentIdHash");
    expect(publicWorld.rsvps[0].identity).not.toHaveProperty(
      "gameplayPersistentIdHash",
    );
    expect(JSON.stringify(publicWorld)).not.toContain(normalizedHostHash);

    const audit = new DatabaseSync(dbPath, { readOnly: true });
    const migrations = audit
      .prepare(
        "SELECT version FROM persistent_world_schema_migrations ORDER BY version",
      )
      .all() as Array<{ version: number }>;
    expect(migrations.map(({ version }) => version)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    const stored = audit
      .prepare(
        "SELECT gameplay_persistent_id_hash FROM persistent_world_identities WHERE id = ?",
      )
      .get(host.id) as { gameplay_persistent_id_hash: string };
    expect(stored.gameplay_persistent_id_hash).toBe(normalizedHostHash);
    audit.close();
  });

  it("projects the current durable RSVP roster for runtime provisioning", () => {
    const host = account("identity_seat_host", "Amber Host");
    const guest = account("identity_seat_guest", "Violet Guest");
    const startsAt = now + 60_000;
    repository.createWorld({
      id: "world_runtime_seats",
      name: "Runtime Seats",
      targetDuration: "1d",
      access: "private",
      mode: "teams",
      maxHumans: 4,
      startsAt,
      host,
      hostTeamId: "amber",
      invitationSecret: INVITATION_SECRET,
    });
    now += 1_000;
    repository.rsvp({
      worldId: "world_runtime_seats",
      identity: guest,
      teamId: "violet",
      invitationSecret: INVITATION_SECRET,
    });
    const hostHash = "1".repeat(64);
    repository.bindGameplayIdentity(host.id, hostHash);

    expect(repository.runtimeSeats("world_runtime_seats")).toEqual([
      {
        identityId: host.id,
        displayName: "Amber Host",
        gameplayPersistentIdHash: hostHash,
        isHost: true,
        teamId: "amber",
        joinedAt: now - 1_000,
      },
      {
        identityId: guest.id,
        displayName: "Violet Guest",
        gameplayPersistentIdHash: null,
        isHost: false,
        teamId: "violet",
        joinedAt: now,
      },
    ]);

    const guestHash = "2".repeat(64);
    repository.bindGameplayIdentity(guest.id, guestHash);
    expect(repository.runtimeSeats("world_runtime_seats")[1]).toMatchObject({
      identityId: guest.id,
      gameplayPersistentIdHash: guestHash,
    });
    expectRepositoryError(
      () => repository.runtimeSeats("world_missing"),
      "NOT_FOUND",
    );

    repository.close();
    repository = new PersistentWorldRepository({ dbPath, now: () => now });
    expect(repository.runtimeSeats("world_runtime_seats")).toHaveLength(2);
    expect(
      repository
        .runtimeSeats("world_runtime_seats")
        .map((seat) => seat.gameplayPersistentIdHash),
    ).toEqual([hostHash, guestHash]);
  });

  it("durably reserves one runtime per world and recovers provisioning and ready work", () => {
    const host = account("identity_runtime_owner", "Runtime Owner");
    const startsAt = now + 10_000;
    const expiresAt = startsAt + persistentWorldDurationMs("1d");
    repository.createWorld({
      id: "world_runtime",
      name: "One Day Runtime",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt,
      host,
    });
    repository.createWorld({
      id: "world_runtime_other",
      name: "Other Runtime",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt,
      host,
    });

    const reservation = repository.reserveRuntime(
      "world_runtime",
      "request_runtime_001",
      "Ab12Cd34",
      RUNTIME_GAME_CONFIG,
      startsAt,
      expiresAt,
    );
    expect(reservation).toEqual({
      worldId: "world_runtime",
      requestId: "request_runtime_001",
      gameId: "Ab12Cd34",
      gameConfig: RUNTIME_GAME_CONFIG,
      state: "provisioning",
      startsAt,
      expiresAt,
      requestedAt: now,
      readyAt: null,
      updatedAt: now,
    });
    expect(
      repository.reserveRuntime(
        "world_runtime",
        "request_runtime_001",
        "Ab12Cd34",
        RUNTIME_GAME_CONFIG,
        startsAt,
        expiresAt,
      ),
    ).toEqual(reservation);
    expect(repository.getRuntime("world_runtime")).toEqual(reservation);
    expect(repository.getRuntimeByRequestId("request_runtime_001")).toEqual(
      reservation,
    );
    expect(
      repository.getRuntimeByRequestId("request_runtime_missing"),
    ).toBeUndefined();
    expectRepositoryError(
      () => repository.getRuntimeByRequestId("short"),
      "INVALID_ARGUMENT",
    );
    expect(repository.listRuntimeProvisioning()).toEqual([reservation]);
    expect(repository.listRuntimeReady()).toEqual([]);

    expectRepositoryError(
      () =>
        repository.reserveRuntime(
          "world_runtime",
          "request_runtime_002",
          "Ef56Gh78",
          RUNTIME_GAME_CONFIG,
          startsAt,
          expiresAt,
        ),
      "CONFLICT",
    );
    expectRepositoryError(
      () =>
        repository.reserveRuntime(
          "world_runtime",
          "request_runtime_001",
          "Ab12Cd34",
          { ...RUNTIME_GAME_CONFIG, bots: RUNTIME_GAME_CONFIG.bots + 1 },
          startsAt,
          expiresAt,
        ),
      "CONFLICT",
    );
    expectRepositoryError(
      () =>
        repository.reserveRuntime(
          "world_runtime_other",
          "request_runtime_001",
          "Ij90Kl12",
          RUNTIME_GAME_CONFIG,
          startsAt,
          expiresAt,
        ),
      "CONFLICT",
    );
    expectRepositoryError(
      () =>
        repository.reserveRuntime(
          "world_runtime_other",
          "request_runtime_003",
          "Ab12Cd34",
          RUNTIME_GAME_CONFIG,
          startsAt,
          expiresAt,
        ),
      "CONFLICT",
    );
    expectRepositoryError(
      () =>
        repository.reserveRuntime(
          "world_runtime_other",
          "short",
          "invalid",
          RUNTIME_GAME_CONFIG,
          startsAt,
          expiresAt,
        ),
      "INVALID_ARGUMENT",
    );
    expectRepositoryError(
      () =>
        repository.markRuntimeReady(
          "world_runtime_other",
          "request_runtime_003",
          "Ij90Kl12",
        ),
      "NOT_FOUND",
    );
    expectRepositoryError(
      () =>
        repository.markRuntimeReady(
          "world_runtime",
          "request_runtime_999",
          "Ab12Cd34",
        ),
      "CONFLICT",
    );

    now += 1_000;
    const ready = repository.markRuntimeReady(
      "world_runtime",
      "request_runtime_001",
      "Ab12Cd34",
    );
    expect(ready).toEqual({
      ...reservation,
      state: "ready",
      readyAt: now,
      updatedAt: now,
    });
    expect(repository.listRuntimeProvisioning()).toEqual([]);
    // A ready-but-scheduled worker is not yet an active recovery target.
    expect(repository.listRuntimeReady()).toEqual([]);

    repository.close();
    repository = new PersistentWorldRepository({ dbPath, now: () => now });
    expect(repository.getRuntime("world_runtime")).toEqual(ready);
    now = startsAt;
    repository.markActive("world_runtime");
    repository.markActive("world_runtime_other");
    expect(repository.listRuntimeReady()).toEqual([ready]);
    expect(
      repository.listActiveWithoutRuntime().map((world) => world.id),
    ).toEqual(["world_runtime_other"]);
    expect(
      repository.markRuntimeReady(
        "world_runtime",
        "request_runtime_001",
        "Ab12Cd34",
        now + 1_000,
      ),
    ).toEqual(ready);

    repository.markFinished("world_runtime", now + 2_000);
    expect(repository.listRuntimeReady()).toEqual([]);
    expect(repository.getRuntime("world_runtime")).toEqual(ready);
    expectRepositoryError(
      () =>
        repository.reserveRuntime(
          "world_runtime",
          "request_runtime_004",
          "Mn34Op56",
          RUNTIME_GAME_CONFIG,
          startsAt,
          expiresAt,
        ),
      "INVALID_PHASE",
    );

    repository.close();
    const corrupt = new DatabaseSync(dbPath);
    corrupt
      .prepare(
        "UPDATE persistent_world_runtimes SET game_config_json = '{}' WHERE world_id = ?",
      )
      .run("world_runtime");
    corrupt.close();
    repository = new PersistentWorldRepository({ dbPath, now: () => now });
    expect(() => repository.getRuntime("world_runtime")).toThrow(
      "Persistent-world runtime game config is invalid",
    );
  });

  it("journals an exact contiguous managed turn stream across retries and restarts", () => {
    const host = account("identity_turn_owner", "Turn Owner");
    const startsAt = now + 10_000;
    repository.createWorld({
      id: "world_turn_journal",
      name: "Turn Journal",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt,
      host,
    });
    repository.createWorld({
      id: "world_without_runtime",
      name: "No Runtime",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt,
      host,
    });
    repository.reserveRuntime(
      "world_turn_journal",
      "request_turn_journal",
      "Qr78St90",
      RUNTIME_GAME_CONFIG,
      startsAt,
      startsAt + persistentWorldDurationMs("1d"),
    );

    repository.appendRuntimeTurns(
      "world_turn_journal",
      "request_turn_journal",
      [],
    );
    expect(repository.loadRuntimeTurns("world_turn_journal")).toEqual([]);

    const firstTurns = [
      { turnNumber: 0, intents: [] },
      {
        turnNumber: 1,
        intents: [
          {
            type: "mark_disconnected" as const,
            clientID: "Seat0001",
            isDisconnected: true,
          },
        ],
        hash: 42,
      },
    ];
    repository.appendRuntimeTurns(
      "world_turn_journal",
      "request_turn_journal",
      firstTurns,
    );
    expect(repository.loadRuntimeTurns("world_turn_journal")).toEqual(
      firstTurns,
    );

    // An acknowledgement can be lost after commit. Retrying an overlapping
    // prefix is safe and appends only the previously unseen suffix.
    const turnTwo = { turnNumber: 2, intents: [], hash: null };
    repository.appendRuntimeTurns(
      "world_turn_journal",
      "request_turn_journal",
      [firstTurns[1], turnTwo],
    );
    expect(repository.loadRuntimeTurns("world_turn_journal")).toEqual([
      ...firstTurns,
      turnTwo,
    ]);

    expectRepositoryError(
      () =>
        repository.appendRuntimeTurns(
          "world_turn_journal",
          "request_turn_journal",
          [
            { ...turnTwo, hash: 99 },
            { turnNumber: 3, intents: [] },
          ],
        ),
      "CONFLICT",
    );
    expect(repository.loadRuntimeTurns("world_turn_journal")).toHaveLength(3);
    expectRepositoryError(
      () =>
        repository.appendRuntimeTurns(
          "world_turn_journal",
          "request_turn_journal",
          [{ turnNumber: 4, intents: [] }],
        ),
      "CONFLICT",
    );
    expectRepositoryError(
      () =>
        repository.appendRuntimeTurns(
          "world_turn_journal",
          "request_turn_journal",
          [
            { turnNumber: 3, intents: [] },
            { turnNumber: 5, intents: [] },
          ],
        ),
      "INVALID_ARGUMENT",
    );
    expectRepositoryError(
      () =>
        repository.appendRuntimeTurns(
          "world_turn_journal",
          "request_another_runtime",
          [{ turnNumber: 3, intents: [] }],
        ),
      "CONFLICT",
    );
    expectRepositoryError(
      () =>
        repository.appendRuntimeTurns(
          "world_turn_journal",
          "request_turn_journal",
          [{ turnNumber: 3.5, intents: [] }],
        ),
      "INVALID_ARGUMENT",
    );
    expectRepositoryError(
      () => repository.loadRuntimeTurns("world_without_runtime"),
      "NOT_FOUND",
    );

    repository.close();
    repository = new PersistentWorldRepository({ dbPath, now: () => now });
    expect(repository.loadRuntimeTurns("world_turn_journal")).toEqual([
      ...firstTurns,
      turnTwo,
    ]);

    repository.close();
    const corrupt = new DatabaseSync(dbPath);
    corrupt
      .prepare(
        `UPDATE persistent_world_runtime_turns
         SET turn_json = '{"turnNumber":8,"intents":[]}'
         WHERE world_id = ? AND turn_number = 1`,
      )
      .run("world_turn_journal");
    corrupt.close();
    repository = new PersistentWorldRepository({ dbPath, now: () => now });
    expect(() => repository.loadRuntimeTurns("world_turn_journal")).toThrow(
      "Persistent-world runtime turn journal is corrupt at turn 1",
    );
  });

  it("durably records sticky elimination state for an RSVP seat", () => {
    const host = account("identity_status_owner", "Status Owner");
    const startsAt = now + 10_000;
    repository.createWorld({
      id: "world_player_status",
      name: "Player Status",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt,
      host,
    });
    repository.reserveRuntime(
      "world_player_status",
      "request_player_status",
      "Stat0001",
      RUNTIME_GAME_CONFIG,
      startsAt,
      startsAt + persistentWorldDurationMs("1d"),
    );

    repository.recordRuntimePlayerStatuses(
      "world_player_status",
      "request_player_status",
      200,
      [
        {
          identityId: host.id,
          clientId: "Seat0001",
          isAlive: false,
          killedBy: "Seat0002",
          deathPosition: 3,
        },
      ],
    );
    expect(
      repository.runtimePlayerStatus("world_player_status", host.id),
    ).toMatchObject({
      clientId: "Seat0001",
      isAlive: false,
      killedBy: "Seat0002",
      deathPosition: 3,
      observedTurn: 200,
    });

    // Older reports are ignored; even a newer inconsistent report cannot
    // resurrect a player after an agreed elimination.
    repository.recordRuntimePlayerStatuses(
      "world_player_status",
      "request_player_status",
      199,
      [
        {
          identityId: host.id,
          clientId: "Seat0001",
          isAlive: true,
          killedBy: null,
          deathPosition: null,
        },
      ],
    );
    repository.recordRuntimePlayerStatuses(
      "world_player_status",
      "request_player_status",
      201,
      [
        {
          identityId: host.id,
          clientId: "Seat0001",
          isAlive: true,
          killedBy: null,
          deathPosition: null,
        },
      ],
    );
    expect(
      repository.runtimePlayerStatus("world_player_status", host.id),
    ).toMatchObject({ isAlive: false, observedTurn: 201 });

    repository.close();
    repository = new PersistentWorldRepository({ dbPath, now: () => now });
    expect(
      repository.runtimePlayerStatus("world_player_status", host.id),
    ).toMatchObject({ isAlive: false, observedTurn: 201 });
  });

  it("persists private invitations, durable RSVPs, schedule locking, and quick-chat keys", () => {
    const host = account("identity_host", "Host");
    const player = account("identity_player", "Player");
    const startsAt = now + 7 * 24 * 60 * 60 * 1000;

    const world = repository.createWorld({
      id: "private_week",
      name: "The Long Weekend",
      targetDuration: "7d",
      access: "private",
      mode: "teams",
      maxHumans: 8,
      startsAt,
      host,
      hostTeamId: "amber",
      invitationSecret: INVITATION_SECRET,
    });
    expect(world).toMatchObject({
      phase: "scheduled",
      startsAt,
      joinClosesAt: startsAt + persistentWorldDurationMs("7d") / 3,
      rsvps: [{ identity: host, isHost: true, teamId: "amber" }],
    });

    const replay = repository.createWorld({
      id: "private_week",
      name: "The Long Weekend",
      targetDuration: "7d",
      access: "private",
      mode: "teams",
      maxHumans: 8,
      startsAt,
      host,
      hostTeamId: "amber",
      invitationSecret: INVITATION_SECRET,
    });
    expect(replay.createdAt).toBe(world.createdAt);

    expectRepositoryError(
      () =>
        repository.rsvp({
          worldId: world.id,
          identity: player,
          teamId: "violet",
          invitationSecret: "incorrect_invitation_secret",
        }),
      "INVALID_INVITATION",
    );

    now += 5_000;
    const rsvp = repository.rsvp({
      worldId: world.id,
      identity: player,
      teamId: "violet",
      invitationSecret: INVITATION_SECRET,
    });
    expect(rsvp).toMatchObject({
      identity: player,
      isHost: false,
      teamId: "violet",
      joinedAt: now,
      lastSeenAt: now,
    });
    expect(repository.getWorld(world.id)?.scheduleLockedAt).toBe(now);
    expectRepositoryError(
      () => repository.updateSchedule(world.id, host, startsAt + 60_000),
      "SCHEDULE_LOCKED",
    );
    expect(repository.updateSchedule(world.id, host, startsAt).startsAt).toBe(
      startsAt,
    );

    now += 5_000;
    const replayedRsvp = repository.rsvp({
      worldId: world.id,
      identity: player,
      teamId: "violet",
    });
    expect(replayedRsvp.joinedAt).toBe(rsvp.joinedAt);
    expect(replayedRsvp.lastSeenAt).toBe(now);

    const message = repository.postQuickChat({
      id: "message_001",
      worldId: world.id,
      sender: player,
      phraseKey: "lobby.ready",
    });
    expect(
      repository.postQuickChat({
        id: "message_001",
        worldId: world.id,
        sender: player,
        phraseKey: "lobby.ready",
      }),
    ).toEqual(message);
    expect(repository.listQuickChat(world.id)).toEqual([message]);
    expect(() =>
      repository.postQuickChat({
        id: "message_002",
        worldId: world.id,
        sender: player,
        phraseKey: "hello there",
      }),
    ).toThrow();

    const audit = new DatabaseSync(dbPath, { readOnly: true });
    const storedWorld = audit
      .prepare(
        "SELECT invitation_secret_hash FROM persistent_worlds WHERE id = ?",
      )
      .get(world.id) as { invitation_secret_hash: string };
    expect(storedWorld.invitation_secret_hash).not.toContain(INVITATION_SECRET);
    const rsvpColumns = audit
      .prepare("PRAGMA table_info(persistent_world_rsvps)")
      .all() as Array<{ name: string }>;
    expect(rsvpColumns.map((column) => column.name)).not.toContain("presence");
    const chatColumns = audit
      .prepare("PRAGMA table_info(persistent_world_quick_chat)")
      .all() as Array<{ name: string }>;
    expect(chatColumns.map((column) => column.name)).toContain("phrase_key");
    expect(chatColumns.map((column) => column.name)).not.toContain("message");
    audit.close();

    repository.close();
    repository = new PersistentWorldRepository({ dbPath, now: () => now });
    expect(repository.getWorld(world.id)?.rsvps).toHaveLength(2);
    expect(repository.listQuickChat(world.id)).toEqual([message]);
  });

  it("allows invited private late joins for one third of the duration but closes public worlds at start", () => {
    const host = account("identity_host");
    const privateStart = now + 10_000;
    repository.createWorld({
      id: "private_late",
      name: "Private Late Join",
      targetDuration: "1h",
      access: "private",
      mode: "ffa",
      maxHumans: 3,
      startsAt: privateStart,
      host,
      invitationSecret: INVITATION_SECRET,
    });
    repository.createWorld({
      id: "public_closed",
      name: "Public Start",
      targetDuration: "1h",
      access: "public",
      mode: "ffa",
      maxHumans: 3,
      startsAt: privateStart,
      host,
    });

    now = privateStart + 1;
    expect(
      repository.rsvp({
        worldId: "private_late",
        identity: account("identity_late"),
        invitationSecret: INVITATION_SECRET,
      }).identity.id,
    ).toBe("identity_late");
    expectRepositoryError(
      () =>
        repository.rsvp({
          worldId: "public_closed",
          identity: account("identity_public_late"),
        }),
      "JOIN_CLOSED",
    );

    now = privateStart + persistentWorldDurationMs("1h") / 3;
    expectRepositoryError(
      () =>
        repository.rsvp({
          worldId: "private_late",
          identity: account("identity_too_late"),
          invitationSecret: INVITATION_SECRET,
        }),
      "JOIN_CLOSED",
    );
  });

  it("orders due worlds, transitions idempotently, and authorizes cancellation", () => {
    const host = account("identity_host");
    repository.createWorld({
      id: "world_second",
      name: "Second",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt: now + 2_000,
      host,
    });
    repository.createWorld({
      id: "world_first",
      name: "First",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt: now + 1_000,
      host,
    });
    repository.createWorld({
      id: "world_cancelled",
      name: "Cancelled",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt: now + 1_000,
      host,
    });
    repository.cancelWorld("world_cancelled", host);
    repository.cancelWorld("world_cancelled", host);
    expectRepositoryError(
      () => repository.cancelWorld("world_first", account("identity_other")),
      "FORBIDDEN",
    );

    now += 2_000;
    expect(repository.listWorldsDueToStart().map((world) => world.id)).toEqual([
      "world_first",
      "world_second",
    ]);
    expect(repository.markActive("world_first").phase).toBe("active");
    expect(repository.markActive("world_first").phase).toBe("active");
    expect(repository.listWorldsDueToStart().map((world) => world.id)).toEqual([
      "world_second",
    ]);
    expect(repository.markFinished("world_first").phase).toBe("finished");
    expect(repository.markFinished("world_first").phase).toBe("finished");
  });

  it("archives completed runtimes and failed starts out of live world lists", () => {
    const host = account("identity_archive_host");
    const startsAt = now + 1_000;
    for (const id of ["world_completed", "world_failed_start"]) {
      repository.createWorld({
        id,
        name: id,
        targetDuration: "1h",
        access: "public",
        mode: "ffa",
        maxHumans: 4,
        startsAt,
        host,
      });
    }
    repository.createWorld({
      id: "world_future",
      name: "world_future",
      targetDuration: "1h",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt: startsAt + 2 * persistentWorldDurationMs("1h"),
      host,
    });
    repository.reserveRuntime(
      "world_completed",
      "request_completed_runtime",
      "Ar12Ch34",
      RUNTIME_GAME_CONFIG,
      startsAt,
      startsAt + persistentWorldDurationMs("1h"),
    );
    repository.markRuntimeReady(
      "world_completed",
      "request_completed_runtime",
      "Ar12Ch34",
      startsAt,
    );

    now = startsAt;
    repository.markActive("world_completed");
    repository.markActive("world_failed_start");

    now = startsAt + 4 * 60_000;
    expect(repository.archiveStaleWorlds(now, 5 * 60_000)).toEqual({
      finished: [],
      cancelled: [],
    });

    now = startsAt + 5 * 60_000;
    expect(repository.archiveStaleWorlds(now, 5 * 60_000)).toMatchObject({
      finished: [],
      cancelled: [{ id: "world_failed_start", phase: "cancelled" }],
    });

    now = startsAt + persistentWorldDurationMs("1h");
    expect(repository.archiveStaleWorlds(now, 5 * 60_000)).toMatchObject({
      finished: [],
      cancelled: [],
    });
    expect(repository.archiveStaleWorlds(now, 5 * 60_000)).toEqual({
      finished: [],
      cancelled: [],
    });
    expect(repository.listPublicWorlds().map((world) => world.id)).toEqual([
      "world_future",
      "world_completed",
    ]);
    expect(
      repository.listWorldsForIdentity(host.id).map((world) => world.id),
    ).toEqual(["world_completed", "world_future"]);
  });

  it("lists public and personal worlds and persists inferred reminder choices", () => {
    const hostSession = repository.createGuestIdentity({ displayName: "Host" });
    const guestSession = repository.createGuestIdentity({
      displayName: "Guest",
    });
    const startsAt = now + 14 * 24 * 60 * 60 * 1000;
    const world = repository.createWorld({
      id: "public_reminders",
      name: "Fourteen Day Invitation",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 4,
      startsAt,
      host: hostSession.session.identity,
    });
    repository.rsvp({
      worldId: world.id,
      identity: guestSession.session.identity,
    });

    expect(repository.listPublicWorlds().map((entry) => entry.id)).toContain(
      world.id,
    );
    expect(
      repository
        .listWorldsForIdentity(guestSession.session.identity.id)
        .map((entry) => entry.id),
    ).toEqual([world.id]);

    const options = inferredReminderLeadTimes(startsAt - world.createdAt);
    const selection = repository.setReminderSelection(
      world.id,
      guestSession.session.identity.id,
      [options[2], options[0]],
    );
    expect(selection.leadTimesMs).toEqual([options[0], options[2]]);
    expect(
      repository.getReminderSelection(
        world.id,
        guestSession.session.identity.id,
      ),
    ).toEqual(selection);
    expectRepositoryError(
      () =>
        repository.setReminderSelection(
          world.id,
          guestSession.session.identity.id,
          [123_456],
        ),
      "INVALID_ARGUMENT",
    );

    repository.leaveWorld(world.id, guestSession.session.identity.id);
    expect(
      repository.getRsvp(world.id, guestSession.session.identity.id),
    ).toBeUndefined();
    expect(
      repository.getReminderSelection(
        world.id,
        guestSession.session.identity.id,
      ),
    ).toBeUndefined();
    expectRepositoryError(
      () => repository.leaveWorld(world.id, hostSession.session.identity.id),
      "FORBIDDEN",
    );
  });
});
