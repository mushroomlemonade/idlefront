import { mkdtempSync, rmSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inferredReminderLeadTimes } from "../../../src/core/PersistentWorldReminders";
import {
  PersistentWorldNotificationWorker,
  type PersistentWorldEmailNotificationSink,
} from "../../../src/server/persistent/PersistentWorldNotificationWorker";
import { PersistentWorldRepository } from "../../../src/server/persistent/PersistentWorldRepository";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("persistent-world notifications", () => {
  let directory: string;
  let dbPath: string;
  let now: number;
  let repository: PersistentWorldRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "persistent-world-notifications-"));
    dbPath = join(directory, "worlds.sqlite");
    now = 2_000_000_000_000;
    repository = openRepository();
  });

  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function openRepository(): PersistentWorldRepository {
    return new PersistentWorldRepository({ dbPath, now: () => now });
  }

  function restart(): void {
    repository.close();
    repository = openRepository();
  }

  function createScheduledHost(startsAt: number = now + 14 * DAY) {
    const controller = repository.createGuestIdentity({ displayName: "Host" });
    const world = repository.createWorld({
      id: `world_${startsAt}`,
      name: "A Durable Invitation",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 8,
      startsAt,
      host: controller.session.identity,
    });
    return { controller, world };
  }

  it("persists selected reminder jobs and gates email claims on verified contact", () => {
    const { controller, world } = createScheduledHost();
    const [twoDays, , ninetyMinutes] = inferredReminderLeadTimes(
      world.startsAt - world.createdAt,
    );
    repository.setReminderSelection(world.id, controller.session.identity.id, [
      twoDays,
      ninetyMinutes,
    ]);
    repository.setReminderSelection(world.id, controller.session.identity.id, [
      ninetyMinutes,
      twoDays,
    ]);

    now = world.startsAt - twoDays;
    restart();
    const withoutEmail = repository.claimDueNotificationJobs();
    expect(withoutEmail).toHaveLength(1);
    expect(withoutEmail[0]).toMatchObject({
      job: {
        kind: "reminder",
        channel: "in_app",
        leadTimeMs: twoDays,
      },
      recipient: { verifiedEmail: null },
    });
    repository.acknowledgeNotificationJob(withoutEmail[0].claimToken);

    const feed = repository.listInAppNotifications(
      controller.session.identity.id,
    );
    expect(feed).toEqual([
      expect.objectContaining({
        id: withoutEmail[0].job.id,
        world: {
          id: world.id,
          name: world.name,
          startsAt: world.startsAt,
        },
        kind: "reminder",
        leadTimeMs: twoDays,
        readAt: null,
      }),
    ]);
    expect(JSON.stringify(feed)).not.toContain("verifiedEmail");
    expect(JSON.stringify(feed)).not.toContain("subject");
    const read = repository.markInAppNotificationRead(
      controller.session.identity.id,
      feed[0].id,
    );
    expect(read.readAt).toBe(now);
    now += 1_000;
    expect(
      repository.markInAppNotificationRead(
        controller.session.identity.id,
        feed[0].id,
      ).readAt,
    ).toBe(read.readAt);

    repository.attachVerifiedEmail(controller.bearerToken, {
      verifiedEmail: "private.host@example.com",
    });
    const emailClaim = repository.claimDueNotificationJobs();
    expect(emailClaim).toHaveLength(1);
    expect(emailClaim[0]).toMatchObject({
      job: { channel: "email", leadTimeMs: twoDays },
      recipient: { verifiedEmail: "private.host@example.com" },
    });
    repository.acknowledgeNotificationJob(emailClaim[0].claimToken);
    expect(
      JSON.stringify(
        repository.listInAppNotifications(controller.session.identity.id),
      ),
    ).not.toContain("private.host@example.com");
  });

  it("backfills version-two reminder selections without SQLite JSON1", () => {
    const { controller, world } = createScheduledHost();
    const leadTimeMs = inferredReminderLeadTimes(
      world.startsAt - world.createdAt,
    )[0];
    repository.setReminderSelection(world.id, controller.session.identity.id, [
      leadTimeMs,
    ]);
    repository.close();

    // Recreate the exact upgrade boundary: durable worlds/reminder JSON exist,
    // while v3 notification data and later additive schema do not.
    const versionTwo = new DatabaseSync(dbPath);
    versionTwo.exec(`
      DROP TABLE persistent_world_claims;
      DROP TABLE persistent_world_passwords;
      DROP TABLE persistent_world_runtime_player_status;
      DROP TABLE persistent_world_runtime_turns;
      DROP TABLE persistent_world_runtimes;
      DROP INDEX persistent_world_identities_gameplay_hash_idx;
      ALTER TABLE persistent_world_identities
        DROP COLUMN gameplay_persistent_id_hash;
      DROP TABLE persistent_world_in_app_notifications;
      DROP TABLE persistent_world_notification_jobs;
      DELETE FROM persistent_world_schema_migrations WHERE version >= 3;
    `);
    versionTwo.close();

    now = world.startsAt - leadTimeMs;
    repository = openRepository();
    expect(repository.claimDueNotificationJobs()).toEqual([
      expect.objectContaining({
        job: expect.objectContaining({
          worldId: world.id,
          identityId: controller.session.identity.id,
          kind: "reminder",
          channel: "in_app",
          leadTimeMs,
        }),
      }),
    ]);
  });

  it("reclaims expired leases after restart and rejects a stale worker token", () => {
    const startsAt = now + MINUTE;
    const { controller, world } = createScheduledHost(startsAt);
    repository.attachVerifiedEmail(controller.bearerToken, {
      verifiedEmail: "host@example.com",
    });
    now = startsAt;
    const firstClaims = repository.claimDueNotificationJobs({ leaseMs: 5_000 });
    expect(firstClaims).toHaveLength(2);

    const staleToken = firstClaims[0].claimToken;
    restart();
    expect(repository.claimDueNotificationJobs()).toHaveLength(0);
    now += 5_001;
    const reclaimed = repository.claimDueNotificationJobs({ leaseMs: 5_000 });
    expect(reclaimed).toHaveLength(2);
    expect(reclaimed.map((claim) => claim.job.attemptCount)).toEqual([2, 2]);
    expect(() =>
      repository.acknowledgeNotificationJob(staleToken),
    ).toThrowError(
      expect.objectContaining({
        code: "LEASE_INVALID",
      }),
    );

    const retry = reclaimed[0];
    repository.failNotificationJob(
      retry.claimToken,
      "provider unavailable",
      1_000,
    );
    restart();
    expect(repository.claimDueNotificationJobs()).toHaveLength(0);
    now += 1_000;
    expect(repository.claimDueNotificationJobs({ limit: 1 })[0]).toMatchObject({
      job: { id: retry.job.id, attemptCount: 3 },
    });
    expect(repository.getWorld(world.id)?.phase).toBe("scheduled");
  });

  it("deletes a departing RSVP's future work and suppresses cancelled worlds", () => {
    const { controller: host, world } = createScheduledHost(now + DAY);
    const player = repository.createGuestIdentity({ displayName: "Player" });
    repository.rsvp({
      worldId: world.id,
      identity: player.session.identity,
    });
    repository.setReminderSelection(world.id, player.session.identity.id, [
      inferredReminderLeadTimes(world.startsAt - world.createdAt)[0],
    ]);
    repository.leaveWorld(world.id, player.session.identity.id);

    const cancelled = repository.createWorld({
      id: "world_cancelled_notifications",
      name: "Cancelled Invitation",
      targetDuration: "1d",
      access: "public",
      mode: "ffa",
      maxHumans: 8,
      startsAt: now + DAY,
      host: host.session.identity,
    });
    repository.cancelWorld(cancelled.id, host.session.identity);

    const audit = new DatabaseSync(dbPath, { readOnly: true });
    const departedJobs = audit
      .prepare(
        `SELECT COUNT(*) AS count FROM persistent_world_notification_jobs
         WHERE world_id = ? AND identity_id = ? AND state != 'delivered'`,
      )
      .get(world.id, player.session.identity.id) as { count: number };
    const cancelledStates = audit
      .prepare(
        `SELECT DISTINCT state FROM persistent_world_notification_jobs
         WHERE world_id = ?`,
      )
      .all(cancelled.id) as Array<{ state: string }>;
    audit.close();
    expect(Number(departedJobs.count)).toBe(0);
    expect(cancelledStates).toEqual([{ state: "suppressed" }]);

    now += DAY;
    expect(
      repository
        .claimDueNotificationJobs()
        .some((claim) => claim.job.worldId === cancelled.id),
    ).toBe(false);
  });

  it("uses an idempotency-aware email sink and retries failures", async () => {
    const startsAt = now + MINUTE;
    const { controller, world } = createScheduledHost(startsAt);
    repository.attachVerifiedEmail(controller.bearerToken, {
      verifiedEmail: "host@example.com",
    });
    now = startsAt;

    const sent: Parameters<PersistentWorldEmailNotificationSink["send"]>[0][] =
      [];
    let shouldFail = true;
    const worker = new PersistentWorldNotificationWorker(repository, {
      now: () => now,
      retryDelayMs: () => 1_000,
      emailSink: {
        async send(message) {
          sent.push(message);
          if (shouldFail) throw new Error("temporary provider failure");
        },
      },
    });

    expect(await worker.runDueBatch()).toEqual({
      claimed: 2,
      delivered: 1,
      failed: 1,
    });
    expect(
      repository.listInAppNotifications(controller.session.identity.id),
    ).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "host@example.com",
      kind: "start",
      world: { id: world.id, startsAt },
    });
    expect(sent[0].idempotencyKey).toMatch(/^pwn_/);

    shouldFail = false;
    now += 1_000;
    expect(await worker.runDueBatch()).toEqual({
      claimed: 1,
      delivered: 1,
      failed: 0,
    });
    expect(sent[1].idempotencyKey).toBe(sent[0].idempotencyKey);
  });
});
