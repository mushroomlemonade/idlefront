import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { mkdirSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "path";
import { inferredReminderLeadTimes } from "../../core/PersistentWorldReminders";
import {
  AttachPersistentWorldAccountInputSchema,
  AttachPersistentWorldVerifiedEmailInputSchema,
  CreatePersistentWorldGuestInputSchema,
  CreatePersistentWorldInputSchema,
  NewPersistentWorldControllerSessionSchema,
  PersistentWorldControllerSessionSchema,
  PersistentWorldIdentitySchema,
  PersistentWorldInAppNotificationSchema,
  PersistentWorldNotificationChannelSchema,
  PersistentWorldNotificationKindSchema,
  PersistentWorldQuickChatSchema,
  PersistentWorldReminderSelectionSchema,
  PersistentWorldRsvpInputSchema,
  PersistentWorldRsvpSchema,
  PersistentWorldSchema,
  PersistentWorldTimestampSchema,
  PostPersistentWorldQuickChatInputSchema,
  persistentWorldDurationMs,
  type AttachPersistentWorldAccountInput,
  type AttachPersistentWorldVerifiedEmailInput,
  type CreatePersistentWorldGuestInput,
  type CreatePersistentWorldInput,
  type NewPersistentWorldControllerSession,
  type PersistentWorld,
  type PersistentWorldControllerSession,
  type PersistentWorldIdentity,
  type PersistentWorldInAppNotification,
  type PersistentWorldNotificationChannel,
  type PersistentWorldNotificationKind,
  type PersistentWorldQuickChat,
  type PersistentWorldReminderSelection,
  type PersistentWorldRsvp,
  type PersistentWorldRsvpInput,
  type PostPersistentWorldQuickChatInput,
} from "../../core/PersistentWorldSchemas";
import {
  GameConfigSchema,
  TurnSchema,
  type GameConfig,
  type Turn,
} from "../../core/Schemas";

const SCHEMA_VERSION = 8;
const DEFAULT_DUE_LIMIT = 100;
const MAX_DUE_LIMIT = 500;
const DEFAULT_CHAT_LIMIT = 100;
const MAX_CHAT_LIMIT = 200;
const DEFAULT_NOTIFICATION_LIMIT = 50;
const MAX_NOTIFICATION_LIMIT = 200;
const DEFAULT_NOTIFICATION_LEASE_MS = 60_000;
const MIN_NOTIFICATION_LEASE_MS = 5_000;
const MAX_NOTIFICATION_LEASE_MS = 15 * 60_000;
const GAMEPLAY_PERSISTENT_ID_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const RUNTIME_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const RUNTIME_GAME_ID_PATTERN = /^[A-Za-z0-9]{8}$/;

type SqlRow = Record<string, unknown>;

export type PersistentWorldRepositoryErrorCode =
  | "CONFLICT"
  | "FORBIDDEN"
  | "INVALID_ARGUMENT"
  | "INVALID_INVITATION"
  | "INVALID_PHASE"
  | "JOIN_CLOSED"
  | "LEASE_INVALID"
  | "NOT_DUE"
  | "NOT_FOUND"
  | "SCHEDULE_LOCKED"
  | "WORLD_FULL";

export type PersistentWorldNotificationJobState =
  "pending" | "claimed" | "delivered" | "suppressed";

export interface PersistentWorldNotificationJob {
  id: string;
  worldId: string;
  identityId: string;
  kind: PersistentWorldNotificationKind;
  channel: PersistentWorldNotificationChannel;
  leadTimeMs: number | null;
  dueAt: number;
  availableAt: number;
  state: PersistentWorldNotificationJobState;
  attemptCount: number;
  leaseExpiresAt: number | null;
  deliveredAt: number | null;
  suppressedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Server-worker contract. Never return this object from a browser route. */
export interface PersistentWorldNotificationDispatchClaim {
  claimToken: string;
  job: PersistentWorldNotificationJob;
  recipient: {
    identityId: string;
    displayName: string;
    /** Present only for an email-channel claim. */
    verifiedEmail: string | null;
  };
  world: {
    id: string;
    name: string;
    startsAt: number;
  };
}

export interface ClaimPersistentWorldNotificationsOptions {
  limit?: number;
  leaseMs?: number;
  now?: number;
}

export type PersistentWorldRuntimeState = "provisioning" | "ready";

/** Server-only durable link between an invitation world and its game worker. */
export interface PersistentWorldRuntime {
  worldId: string;
  requestId: string;
  gameId: string;
  /** Immutable, schema-validated worker input captured before map rotation. */
  gameConfig: GameConfig;
  state: PersistentWorldRuntimeState;
  startsAt: number;
  expiresAt: number;
  requestedAt: number;
  readyAt: number | null;
  updatedAt: number;
}

/**
 * Server-worker roster material. The gameplay hash is an authentication
 * binding and must never be copied into a browser-facing world schema.
 */
export interface PersistentWorldRuntimeSeat {
  identityId: string;
  displayName: string;
  gameplayPersistentIdHash: string | null;
  isHost: boolean;
  teamId: string | null;
  joinedAt: number;
}

/** Latest consensus-backed simulation status for a durable RSVP seat. */
export interface PersistentWorldRuntimePlayerStatus {
  worldId: string;
  identityId: string;
  clientId: string;
  isAlive: boolean;
  killedBy: string | null;
  deathPosition: number | null;
  observedTurn: number;
  updatedAt: number;
}

export interface PersistentWorldArchiveSweep {
  /** Worlds whose game runtime became ready and subsequently reached its end. */
  finished: PersistentWorld[];
  /** Invitations or runtimes that never became playable within the grace period. */
  cancelled: PersistentWorld[];
}

export class PersistentWorldRepositoryError extends Error {
  constructor(
    readonly code: PersistentWorldRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PersistentWorldRepositoryError";
  }
}

export interface PersistentWorldRepositoryOptions {
  dbPath?: string;
  now?: () => number;
  /** Test seam. Production uses cryptographically secure random bytes. */
  randomBytes?: (size: number) => Buffer;
}

function numberValue(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}

function normalizeSubject(kind: string, subject: string): string {
  return kind === "email" ? subject.trim().toLowerCase() : subject.trim();
}

function normalizeEmail(email: string | null): string | null {
  return email === null ? null : email.trim().toLowerCase();
}

function hashSecret(
  domain: "controller" | "invitation" | "notification-claim",
  secret: string,
): string {
  return `sha256-v1:${createHash("sha256")
    .update(`persistent-world:${domain}:`, "utf8")
    .update(secret, "utf8")
    .digest("base64url")}`;
}

function hashesMatch(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

function notificationJobId(
  worldId: string,
  identityId: string,
  kind: PersistentWorldNotificationKind,
  channel: PersistentWorldNotificationChannel,
  leadTimeMs: number | null,
): string {
  const digest = createHash("sha256")
    .update(
      `${worldId}\0${identityId}\0${kind}\0${channel}\0${leadTimeMs ?? 0}`,
      "utf8",
    )
    .digest("base64url");
  return `pwn_${digest}`;
}

/**
 * Durable storage for scheduled persistent-world lobbies.
 *
 * It intentionally owns no WebSockets, timers, or live presence. Callers use
 * `listWorldsDueToStart` from their scheduler and compose online/offline
 * presence onto the returned durable RSVP rows in memory.
 */
export class PersistentWorldRepository {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly secureRandomBytes: (size: number) => Buffer;
  private closed = false;

  constructor(options: PersistentWorldRepositoryOptions = {}) {
    this.dbPath =
      options.dbPath ??
      resolve(process.cwd(), ".data", "persistent-worlds.sqlite");
    this.now = options.now ?? Date.now;
    this.secureRandomBytes = options.randomBytes ?? randomBytes;

    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.configureDatabase();
    this.migrate();
    this.ensureWorldModeColumns();
  }

  private configureDatabase(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  /** Migrations are transactional and use a namespaced ledger, not user_version. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persistent_world_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT
    `);
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM persistent_world_schema_migrations",
      )
      .get() as SqlRow;
    const version = numberValue(row.version);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `Persistent-world database schema ${version} is newer than supported ${SCHEMA_VERSION}`,
      );
    }

    if (version < 1) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE persistent_world_identities (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('account', 'email', 'guest')),
            subject TEXT NOT NULL,
            display_name TEXT NOT NULL,
            verified_email TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(kind, subject)
          ) STRICT;

          CREATE TABLE persistent_world_controller_sessions (
            id TEXT PRIMARY KEY,
            identity_id TEXT NOT NULL REFERENCES persistent_world_identities(id),
            token_hash TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL,
            revoked_at INTEGER
          ) STRICT;
          CREATE INDEX persistent_world_sessions_identity_idx
            ON persistent_world_controller_sessions(identity_id, revoked_at);

          CREATE TABLE persistent_worlds (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            target_duration TEXT NOT NULL CHECK (target_duration IN ('1h', '1d', '7d')),
            access TEXT NOT NULL CHECK (access IN ('private', 'public')),
            mode TEXT NOT NULL CHECK (mode IN ('ffa', 'teams')),
            max_humans INTEGER NOT NULL CHECK (max_humans BETWEEN 2 AND 16),
            phase TEXT NOT NULL CHECK (phase IN ('scheduled', 'active', 'finished', 'cancelled')),
            starts_at INTEGER NOT NULL,
            join_closes_at INTEGER NOT NULL,
            host_identity_id TEXT NOT NULL REFERENCES persistent_world_identities(id),
            invitation_secret_hash TEXT,
            schedule_locked_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            activated_at INTEGER,
            finished_at INTEGER,
            cancelled_at INTEGER,
            CHECK (
              (access = 'private' AND invitation_secret_hash IS NOT NULL) OR
              (access = 'public' AND invitation_secret_hash IS NULL)
            )
          ) STRICT;
          CREATE INDEX persistent_worlds_due_idx
            ON persistent_worlds(phase, starts_at);

          CREATE TABLE persistent_world_rsvps (
            world_id TEXT NOT NULL REFERENCES persistent_worlds(id) ON DELETE CASCADE,
            identity_id TEXT NOT NULL REFERENCES persistent_world_identities(id),
            team_id TEXT,
            joined_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            PRIMARY KEY(world_id, identity_id)
          ) STRICT;
          CREATE INDEX persistent_world_rsvps_identity_idx
            ON persistent_world_rsvps(identity_id, world_id);

          CREATE TABLE persistent_world_quick_chat (
            id TEXT PRIMARY KEY,
            world_id TEXT NOT NULL,
            sender_identity_id TEXT NOT NULL,
            phrase_key TEXT NOT NULL,
            sent_at INTEGER NOT NULL,
            FOREIGN KEY(world_id, sender_identity_id)
              REFERENCES persistent_world_rsvps(world_id, identity_id)
              ON DELETE CASCADE
          ) STRICT;
          CREATE INDEX persistent_world_quick_chat_world_idx
            ON persistent_world_quick_chat(world_id, sent_at, id);
        `);
        this.db
          .prepare(
            "INSERT INTO persistent_world_schema_migrations(version, applied_at) VALUES (1, ?)",
          )
          .run(this.validNow());
      });
    }

    if (version < 2) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE persistent_world_reminders (
            world_id TEXT NOT NULL,
            identity_id TEXT NOT NULL,
            lead_times_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(world_id, identity_id),
            FOREIGN KEY(world_id, identity_id)
              REFERENCES persistent_world_rsvps(world_id, identity_id)
              ON DELETE CASCADE
          ) STRICT;
        `);
        this.db
          .prepare(
            "INSERT INTO persistent_world_schema_migrations(version, applied_at) VALUES (2, ?)",
          )
          .run(this.validNow());
      });
    }

    if (version < 3) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE persistent_world_notification_jobs (
            id TEXT PRIMARY KEY,
            world_id TEXT NOT NULL REFERENCES persistent_worlds(id) ON DELETE CASCADE,
            identity_id TEXT NOT NULL REFERENCES persistent_world_identities(id),
            kind TEXT NOT NULL CHECK (kind IN ('reminder', 'start')),
            channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email')),
            lead_time_ms INTEGER NOT NULL CHECK (lead_time_ms >= 0),
            due_at INTEGER NOT NULL,
            available_at INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'delivered', 'suppressed')),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
            claim_token_hash TEXT,
            lease_expires_at INTEGER,
            delivered_at INTEGER,
            suppressed_at INTEGER,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(world_id, identity_id, kind, channel, lead_time_ms),
            CHECK (
              (kind = 'start' AND lead_time_ms = 0) OR
              (kind = 'reminder' AND lead_time_ms > 0)
            )
          ) STRICT;
          CREATE INDEX persistent_world_notification_jobs_due_idx
            ON persistent_world_notification_jobs(state, due_at, available_at);
          CREATE INDEX persistent_world_notification_jobs_recipient_idx
            ON persistent_world_notification_jobs(identity_id, state, due_at);
          CREATE UNIQUE INDEX persistent_world_notification_jobs_claim_idx
            ON persistent_world_notification_jobs(claim_token_hash)
            WHERE claim_token_hash IS NOT NULL;

          CREATE TABLE persistent_world_in_app_notifications (
            id TEXT PRIMARY KEY,
            identity_id TEXT NOT NULL REFERENCES persistent_world_identities(id),
            world_id TEXT NOT NULL REFERENCES persistent_worlds(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('reminder', 'start')),
            lead_time_ms INTEGER,
            delivered_at INTEGER NOT NULL,
            read_at INTEGER,
            CHECK (
              (kind = 'start' AND lead_time_ms IS NULL) OR
              (kind = 'reminder' AND lead_time_ms > 0)
            )
          ) STRICT;
          CREATE INDEX persistent_world_in_app_notifications_feed_idx
            ON persistent_world_in_app_notifications(identity_id, delivered_at DESC, id DESC);
        `);

        // Backfill without SQLite JSON1 so deployments work with the bundled
        // SQLite feature set as well as full desktop SQLite builds.
        const now = this.validNow();
        const memberships = this.db
          .prepare(
            `SELECT r.world_id, r.identity_id, w.starts_at,
                    reminder.lead_times_json
             FROM persistent_world_rsvps r
             JOIN persistent_worlds w ON w.id = r.world_id
             LEFT JOIN persistent_world_reminders reminder
               ON reminder.world_id = r.world_id
              AND reminder.identity_id = r.identity_id`,
          )
          .all() as SqlRow[];
        for (const membership of memberships) {
          const worldId = String(membership.world_id);
          const identityId = String(membership.identity_id);
          const startsAt = numberValue(membership.starts_at);
          this.ensureNotificationJobRows(
            worldId,
            identityId,
            "start",
            null,
            startsAt,
            now,
          );
          if (
            membership.lead_times_json === null ||
            membership.lead_times_json === undefined
          ) {
            continue;
          }
          const leads = JSON.parse(
            String(membership.lead_times_json),
          ) as unknown;
          if (!Array.isArray(leads)) {
            throw new Error("Persistent-world reminder selection is corrupt");
          }
          for (const lead of leads) {
            const leadTimeMs = Number(lead);
            if (!Number.isSafeInteger(leadTimeMs) || leadTimeMs <= 0) {
              throw new Error("Persistent-world reminder selection is corrupt");
            }
            this.ensureNotificationJobRows(
              worldId,
              identityId,
              "reminder",
              leadTimeMs,
              startsAt - leadTimeMs,
              now,
            );
          }
        }

        this.db
          .prepare(
            "INSERT INTO persistent_world_schema_migrations(version, applied_at) VALUES (3, ?)",
          )
          .run(now);
      });
    }

    if (version < 4) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE persistent_world_identities
            ADD COLUMN gameplay_persistent_id_hash TEXT
            CHECK (
              gameplay_persistent_id_hash IS NULL OR (
                length(gameplay_persistent_id_hash) = 64 AND
                gameplay_persistent_id_hash NOT GLOB '*[^0-9a-f]*'
              )
            );
          CREATE UNIQUE INDEX persistent_world_identities_gameplay_hash_idx
            ON persistent_world_identities(gameplay_persistent_id_hash)
            WHERE gameplay_persistent_id_hash IS NOT NULL;

          CREATE TABLE persistent_world_runtimes (
            world_id TEXT PRIMARY KEY
              REFERENCES persistent_worlds(id) ON DELETE CASCADE,
            request_id TEXT NOT NULL UNIQUE
              CHECK (
                length(request_id) BETWEEN 8 AND 128 AND
                request_id NOT GLOB '*[^A-Za-z0-9_-]*'
              ),
            game_id TEXT NOT NULL UNIQUE
              CHECK (
                length(game_id) = 8 AND
                game_id NOT GLOB '*[^A-Za-z0-9]*'
              ),
            game_config_json TEXT NOT NULL
              CHECK (length(game_config_json) >= 2),
            state TEXT NOT NULL
              CHECK (state IN ('provisioning', 'ready')),
            starts_at INTEGER NOT NULL CHECK (starts_at >= 0),
            expires_at INTEGER NOT NULL CHECK (expires_at > starts_at),
            requested_at INTEGER NOT NULL CHECK (requested_at >= 0),
            ready_at INTEGER CHECK (
              ready_at IS NULL OR
              ready_at BETWEEN requested_at AND expires_at
            ),
            updated_at INTEGER NOT NULL CHECK (updated_at >= requested_at),
            CHECK (
              (state = 'provisioning' AND ready_at IS NULL) OR
              (state = 'ready' AND ready_at IS NOT NULL)
            )
          ) STRICT;
          CREATE INDEX persistent_world_runtimes_state_idx
            ON persistent_world_runtimes(state, starts_at, world_id);
          CREATE INDEX persistent_world_runtimes_expiry_idx
            ON persistent_world_runtimes(state, expires_at, world_id);
        `);
        this.db
          .prepare(
            "INSERT INTO persistent_world_schema_migrations(version, applied_at) VALUES (4, ?)",
          )
          .run(this.validNow());
      });
    }

    if (version < 5) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE persistent_world_runtime_turns (
            world_id TEXT NOT NULL
              REFERENCES persistent_world_runtimes(world_id) ON DELETE CASCADE,
            turn_number INTEGER NOT NULL CHECK (turn_number >= 0),
            turn_json TEXT NOT NULL CHECK (length(turn_json) >= 2),
            committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
            PRIMARY KEY(world_id, turn_number)
          ) STRICT;
        `);
        this.db
          .prepare(
            "INSERT INTO persistent_world_schema_migrations(version, applied_at) VALUES (5, ?)",
          )
          .run(this.validNow());
      });
    }

    if (version < 6) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE persistent_world_runtime_player_status (
            world_id TEXT NOT NULL
              REFERENCES persistent_world_runtimes(world_id) ON DELETE CASCADE,
            identity_id TEXT NOT NULL,
            client_id TEXT NOT NULL
              CHECK (length(client_id) = 8),
            is_alive INTEGER NOT NULL CHECK (is_alive IN (0, 1)),
            killed_by TEXT CHECK (
              killed_by IS NULL OR length(killed_by) = 8
            ),
            death_position INTEGER CHECK (
              death_position IS NULL OR death_position > 0
            ),
            observed_turn INTEGER NOT NULL CHECK (observed_turn >= 0),
            updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
            PRIMARY KEY(world_id, identity_id),
            FOREIGN KEY(world_id, identity_id)
              REFERENCES persistent_world_rsvps(world_id, identity_id)
              ON DELETE CASCADE
          ) STRICT;
          CREATE UNIQUE INDEX persistent_world_runtime_player_client_idx
            ON persistent_world_runtime_player_status(world_id, client_id);
        `);
        this.db
          .prepare(
            "INSERT INTO persistent_world_schema_migrations(version, applied_at) VALUES (6, ?)",
          )
          .run(this.validNow());
      });
    }
    if (version < 7) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE persistent_world_passwords (
            world_id TEXT PRIMARY KEY REFERENCES persistent_worlds(id),
            password_hash TEXT NOT NULL
          ) STRICT;
          CREATE TABLE persistent_world_claims (
            world_id TEXT NOT NULL REFERENCES persistent_worlds(id),
            controller_id TEXT NOT NULL REFERENCES persistent_world_identities(id),
            identity_id TEXT NOT NULL REFERENCES persistent_world_identities(id),
            PRIMARY KEY(world_id, controller_id)
          ) STRICT;
        `);
        this.db
          .prepare(
            "INSERT INTO persistent_world_schema_migrations(version, applied_at) VALUES (7, ?)",
          )
          .run(this.validNow());
      });
    }
  }

  private ensureWorldModeColumns(): void {
    // Additive migration: existing runtime configurations and journals are untouched.
    const columns = this.db
      .prepare("PRAGMA table_info(persistent_worlds)")
      .all() as SqlRow[];
    if (!columns.some((column) => column.name === "pressure_pacing")) {
      this.db.exec(
        "ALTER TABLE persistent_worlds ADD COLUMN pressure_pacing TEXT",
      );
    }
    if (columns.some((column) => column.name === "start_mode")) return;
    this.transaction(() => {
      this.db.exec(`
        ALTER TABLE persistent_worlds ADD COLUMN start_mode TEXT NOT NULL
          DEFAULT 'scheduled' CHECK(start_mode IN ('scheduled', 'host'));
        ALTER TABLE persistent_worlds ADD COLUMN game_preset TEXT;
      `);
      this.db
        .prepare(
          "INSERT INTO persistent_world_schema_migrations(version, applied_at) VALUES (8, ?)",
        )
        .run(this.validNow());
    });
  }

  setWorldPassword(worldId: string, hash: string): void {
    this.db
      .prepare(
        "INSERT INTO persistent_world_passwords(world_id, password_hash) VALUES (?, ?)",
      )
      .run(worldId, hash);
  }

  worldPassword(worldId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT password_hash FROM persistent_world_passwords WHERE world_id = ?",
      )
      .get(worldId) as SqlRow | undefined;
    return row ? String(row.password_hash) : null;
  }

  claimWorldIdentity(
    worldId: string,
    controllerId: string,
    identityId: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO persistent_world_claims(world_id, controller_id, identity_id)
      VALUES (?, ?, ?) ON CONFLICT(world_id, controller_id) DO UPDATE SET identity_id = excluded.identity_id`,
      )
      .run(worldId, controllerId, identityId);
  }

  claimedWorldIdentity(
    worldId: string,
    controllerId: string,
  ): PersistentWorldIdentity | undefined {
    const row = this.db
      .prepare(
        `SELECT i.* FROM persistent_world_claims c
      JOIN persistent_world_identities i ON i.id = c.identity_id
      WHERE c.world_id = ? AND c.controller_id = ?`,
      )
      .get(worldId, controllerId) as SqlRow | undefined;
    return row ? this.identityFromRow(row) : undefined;
  }

  claimedWorldIds(controllerId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT world_id FROM persistent_world_claims WHERE controller_id = ?",
        )
        .all(controllerId) as SqlRow[]
    ).map((row) => String(row.world_id));
  }

  private validNow(): number {
    return PersistentWorldTimestampSchema.parse(this.now());
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private randomId(prefix: "pwi" | "pws"): string {
    return `${prefix}_${this.secureRandomBytes(16).toString("base64url")}`;
  }

  private randomBearerToken(): string {
    return this.secureRandomBytes(32).toString("base64url");
  }

  private ensureNotificationJobRows(
    worldId: string,
    identityId: string,
    kindValue: PersistentWorldNotificationKind,
    leadTimeMs: number | null,
    dueAtValue: number,
    atValue: number = this.validNow(),
  ): void {
    const kind = PersistentWorldNotificationKindSchema.parse(kindValue);
    const dueAt = PersistentWorldTimestampSchema.parse(dueAtValue);
    const at = PersistentWorldTimestampSchema.parse(atValue);
    const storedLeadTime = leadTimeMs ?? 0;
    const initialState: PersistentWorldNotificationJobState =
      dueAt < at ? "suppressed" : "pending";
    for (const channelValue of ["in_app", "email"] as const) {
      const channel =
        PersistentWorldNotificationChannelSchema.parse(channelValue);
      this.db
        .prepare(
          `INSERT INTO persistent_world_notification_jobs(
             id, world_id, identity_id, kind, channel, lead_time_ms,
             due_at, available_at, state, suppressed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(world_id, identity_id, kind, channel, lead_time_ms)
           DO NOTHING`,
        )
        .run(
          notificationJobId(worldId, identityId, kind, channel, leadTimeMs),
          worldId,
          identityId,
          kind,
          channel,
          storedLeadTime,
          dueAt,
          dueAt,
          initialState,
          initialState === "suppressed" ? at : null,
          at,
          at,
        );
    }
  }

  private notificationJobFromRow(row: SqlRow): PersistentWorldNotificationJob {
    return {
      id: String(row.id),
      worldId: String(row.world_id),
      identityId: String(row.identity_id),
      kind: PersistentWorldNotificationKindSchema.parse(row.kind),
      channel: PersistentWorldNotificationChannelSchema.parse(row.channel),
      leadTimeMs:
        String(row.kind) === "start" ? null : numberValue(row.lead_time_ms),
      dueAt: numberValue(row.due_at),
      availableAt: numberValue(row.available_at),
      state: String(row.state) as PersistentWorldNotificationJobState,
      attemptCount: numberValue(row.attempt_count),
      leaseExpiresAt: nullableNumber(row.lease_expires_at),
      deliveredAt: nullableNumber(row.delivered_at),
      suppressedAt: nullableNumber(row.suppressed_at),
      lastError:
        row.last_error === null || row.last_error === undefined
          ? null
          : String(row.last_error),
      createdAt: numberValue(row.created_at),
      updatedAt: numberValue(row.updated_at),
    };
  }

  private runtimeFromRow(row: SqlRow): PersistentWorldRuntime {
    const state = String(row.state);
    if (state !== "provisioning" && state !== "ready") {
      throw new Error(`Persistent-world runtime state is corrupt: ${state}`);
    }
    let gameConfigValue: unknown;
    try {
      gameConfigValue = JSON.parse(String(row.game_config_json));
    } catch {
      throw new Error("Persistent-world runtime game config is corrupt");
    }
    const gameConfig = GameConfigSchema.safeParse(gameConfigValue);
    if (!gameConfig.success) {
      throw new Error("Persistent-world runtime game config is invalid");
    }
    return {
      worldId: String(row.world_id),
      requestId: String(row.request_id),
      gameId: String(row.game_id),
      gameConfig: gameConfig.data,
      state,
      startsAt: numberValue(row.starts_at),
      expiresAt: numberValue(row.expires_at),
      requestedAt: numberValue(row.requested_at),
      readyAt: nullableNumber(row.ready_at),
      updatedAt: numberValue(row.updated_at),
    };
  }

  private identityFromRow(row: SqlRow): PersistentWorldIdentity {
    const verifiedEmail =
      "identity_verified_email" in row
        ? row.identity_verified_email
        : row.verified_email;
    return PersistentWorldIdentitySchema.parse({
      id: String(row.identity_id ?? row.id),
      kind: String(row.identity_kind ?? row.kind),
      subject: String(row.identity_subject ?? row.subject),
      displayName: String(row.identity_display_name ?? row.display_name),
      verifiedEmail:
        verifiedEmail === null || verifiedEmail === undefined
          ? null
          : String(verifiedEmail),
    });
  }

  private identityRow(identityId: string): SqlRow | undefined {
    return this.db
      .prepare("SELECT * FROM persistent_world_identities WHERE id = ?")
      .get(identityId) as SqlRow | undefined;
  }

  /**
   * Inserts identity data supplied by a trusted authentication boundary. It
   * never downgrades an attached email/account identity back to guest data.
   */
  private ensureIdentity(identityValue: PersistentWorldIdentity): void {
    const identity = PersistentWorldIdentitySchema.parse(identityValue);
    const subject = normalizeSubject(identity.kind, identity.subject);
    const verifiedEmail = normalizeEmail(identity.verifiedEmail);
    const existing = this.identityRow(identity.id);
    if (!existing) {
      try {
        this.db
          .prepare(
            `INSERT INTO persistent_world_identities(
              id, kind, subject, display_name, verified_email, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            identity.id,
            identity.kind,
            subject,
            identity.displayName,
            verifiedEmail,
            this.validNow(),
            this.validNow(),
          );
        return;
      } catch {
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          "Identity subject is already attached to another identity",
        );
      }
    }

    const existingKind = String(existing.kind);
    const existingSubject = String(existing.subject);
    const isStaleGuest = identity.kind === "guest" && existingKind !== "guest";
    if (
      !isStaleGuest &&
      (existingKind !== identity.kind || existingSubject !== subject)
    ) {
      throw new PersistentWorldRepositoryError(
        "CONFLICT",
        "Identity credentials do not match the durable identity",
      );
    }

    this.db
      .prepare(
        `UPDATE persistent_world_identities
         SET display_name = ?,
             verified_email = COALESCE(?, verified_email),
             updated_at = MAX(updated_at, ?)
         WHERE id = ?`,
      )
      .run(identity.displayName, verifiedEmail, this.validNow(), identity.id);
  }

  /**
   * Creates a durable guest and one resumable controller session. The bearer
   * is returned once; only a domain-separated SHA-256 hash is stored.
   */
  createGuestIdentity(
    inputValue: CreatePersistentWorldGuestInput,
  ): NewPersistentWorldControllerSession {
    const input = CreatePersistentWorldGuestInputSchema.parse(inputValue);
    const identityId = this.randomId("pwi");
    const identity: PersistentWorldIdentity = {
      id: identityId,
      kind: "guest",
      subject: identityId,
      displayName: input.displayName,
      verifiedEmail: null,
    };
    return this.createControllerSession(identity);
  }

  /** Call only after the enclosing auth layer has authenticated `identity`. */
  createControllerSession(
    identityValue: PersistentWorldIdentity,
  ): NewPersistentWorldControllerSession {
    const identity = PersistentWorldIdentitySchema.parse(identityValue);
    return this.transaction(() => {
      this.ensureIdentity(identity);
      const sessionId = this.randomId("pws");
      const bearerToken = this.randomBearerToken();
      const now = this.validNow();
      this.db
        .prepare(
          `INSERT INTO persistent_world_controller_sessions(
            id, identity_id, token_hash, created_at, last_used_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          identity.id,
          hashSecret("controller", bearerToken),
          now,
          now,
        );
      const storedIdentity = this.identityFromRow(
        this.identityRow(identity.id)!,
      );
      return NewPersistentWorldControllerSessionSchema.parse({
        bearerToken,
        session: {
          id: sessionId,
          identity: storedIdentity,
          createdAt: now,
          lastUsedAt: now,
        },
      });
    });
  }

  /** Returns undefined for an unknown or revoked bearer token. */
  resumeControllerSession(
    bearerToken: string,
  ): PersistentWorldControllerSession | undefined {
    if (typeof bearerToken !== "string" || bearerToken.length < 32) {
      return undefined;
    }
    return this.transaction(() => {
      const tokenHash = hashSecret("controller", bearerToken);
      const row = this.db
        .prepare(
          `SELECT
             s.id, s.created_at, s.last_used_at,
             i.id AS identity_id, i.kind AS identity_kind,
             i.subject AS identity_subject,
             i.display_name AS identity_display_name,
             i.verified_email AS identity_verified_email
           FROM persistent_world_controller_sessions s
           JOIN persistent_world_identities i ON i.id = s.identity_id
           WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
        )
        .get(tokenHash) as SqlRow | undefined;
      if (!row) return undefined;
      const now = this.validNow();
      this.db
        .prepare(
          `UPDATE persistent_world_controller_sessions
           SET last_used_at = MAX(last_used_at, ?)
           WHERE id = ?`,
        )
        .run(now, String(row.id));
      this.db
        .prepare(
          `UPDATE persistent_world_rsvps
           SET last_seen_at = MAX(last_seen_at, ?)
           WHERE identity_id = ?`,
        )
        .run(now, String(row.identity_id));
      return PersistentWorldControllerSessionSchema.parse({
        id: String(row.id),
        identity: this.identityFromRow(row),
        createdAt: numberValue(row.created_at),
        lastUsedAt: Math.max(numberValue(row.last_used_at), now),
      });
    });
  }

  revokeControllerSession(bearerToken: string): void {
    if (typeof bearerToken !== "string" || bearerToken.length < 32) return;
    this.db
      .prepare(
        `UPDATE persistent_world_controller_sessions
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE token_hash = ?`,
      )
      .run(this.validNow(), hashSecret("controller", bearerToken));
  }

  private requireSessionIdentity(bearerToken: string): PersistentWorldIdentity {
    const session = this.resumeControllerSession(bearerToken);
    if (!session) {
      throw new PersistentWorldRepositoryError(
        "FORBIDDEN",
        "Controller session is invalid or revoked",
      );
    }
    return session.identity;
  }

  /** Upgrades a guest to email identity, or adds verified contact to an account. */
  attachVerifiedEmail(
    bearerToken: string,
    inputValue: AttachPersistentWorldVerifiedEmailInput,
  ): PersistentWorldIdentity {
    const input =
      AttachPersistentWorldVerifiedEmailInputSchema.parse(inputValue);
    const current = this.requireSessionIdentity(bearerToken);
    return this.transaction(() => {
      const kind = current.kind === "account" ? "account" : "email";
      const subject =
        kind === "account"
          ? current.subject
          : input.verifiedEmail.trim().toLowerCase();
      try {
        this.db
          .prepare(
            `UPDATE persistent_world_identities
             SET kind = ?, subject = ?, display_name = ?, verified_email = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            kind,
            subject,
            input.displayName ?? current.displayName,
            input.verifiedEmail.trim().toLowerCase(),
            this.validNow(),
            current.id,
          );
      } catch {
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          "Verified email is already attached to another identity",
        );
      }
      return this.identityFromRow(this.identityRow(current.id)!);
    });
  }

  /** Attaches a verified account without changing the stable identity ID. */
  attachAccount(
    bearerToken: string,
    inputValue: AttachPersistentWorldAccountInput,
  ): PersistentWorldIdentity {
    const input = AttachPersistentWorldAccountInputSchema.parse(inputValue);
    const current = this.requireSessionIdentity(bearerToken);
    const accountSubject = normalizeSubject("account", input.accountSubject);
    if (current.kind === "account" && current.subject !== accountSubject) {
      throw new PersistentWorldRepositoryError(
        "CONFLICT",
        "This identity is already attached to another account",
      );
    }
    return this.transaction(() => {
      try {
        this.db
          .prepare(
            `UPDATE persistent_world_identities
             SET kind = 'account', subject = ?, display_name = ?,
                 verified_email = COALESCE(?, verified_email), updated_at = ?
             WHERE id = ?`,
          )
          .run(
            accountSubject,
            input.displayName ?? current.displayName,
            input.verifiedEmail?.trim().toLowerCase() ?? null,
            this.validNow(),
            current.id,
          );
      } catch {
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          "Account is already attached to another identity",
        );
      }
      return this.identityFromRow(this.identityRow(current.id)!);
    });
  }

  /**
   * Binds a world identity to the domain-separated hash of the gameplay
   * persistent ID authenticated by the OpenFront join boundary. Both sides
   * are immutable after the first binding: changing an identity's gameplay
   * principal, or sharing one principal between identities, is a conflict.
   */
  bindGameplayIdentity(identityId: string, hashValue: string): string {
    const gameplayPersistentIdHash = hashValue.trim().toLowerCase();
    if (!GAMEPLAY_PERSISTENT_ID_HASH_PATTERN.test(gameplayPersistentIdHash)) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Gameplay persistent ID hash must be 64 hexadecimal characters",
      );
    }

    return this.transaction(() => {
      const identity = this.identityRow(identityId);
      if (!identity) {
        throw new PersistentWorldRepositoryError(
          "NOT_FOUND",
          `Identity ${identityId} does not exist`,
        );
      }
      const existing = identity.gameplay_persistent_id_hash;
      if (existing !== null && existing !== undefined) {
        if (String(existing) === gameplayPersistentIdHash) {
          return gameplayPersistentIdHash;
        }
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          "World identity is already bound to another gameplay identity",
        );
      }

      const claimed = this.db
        .prepare(
          `SELECT id FROM persistent_world_identities
           WHERE gameplay_persistent_id_hash = ?`,
        )
        .get(gameplayPersistentIdHash) as SqlRow | undefined;
      if (claimed) {
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          "Gameplay identity is already bound to another world identity",
        );
      }

      this.db
        .prepare(
          `UPDATE persistent_world_identities
           SET gameplay_persistent_id_hash = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(gameplayPersistentIdHash, this.validNow(), identityId);
      return gameplayPersistentIdHash;
    });
  }

  /** Server-only authentication lookup; never include its result in a route. */
  gameplayIdentityHash(identityId: string): string | null {
    const identity = this.identityRow(identityId);
    if (!identity) {
      throw new PersistentWorldRepositoryError(
        "NOT_FOUND",
        `Identity ${identityId} does not exist`,
      );
    }
    const value = identity.gameplay_persistent_id_hash;
    return value === null || value === undefined ? null : String(value);
  }

  /**
   * Returns the durable RSVP roster required to provision a runtime. This is
   * deliberately a server-only projection and omits identity subjects,
   * contact details, controller secrets, and invitation capabilities.
   */
  runtimeSeats(worldId: string): PersistentWorldRuntimeSeat[] {
    const world = this.requireWorldRow(worldId);
    const rows = this.db
      .prepare(
        `SELECT r.identity_id, r.team_id, r.joined_at,
                i.display_name, i.gameplay_persistent_id_hash
         FROM persistent_world_rsvps r
         JOIN persistent_world_identities i ON i.id = r.identity_id
         WHERE r.world_id = ?
         ORDER BY r.joined_at, r.identity_id`,
      )
      .all(worldId) as SqlRow[];
    return rows.map((row) => ({
      identityId: String(row.identity_id),
      displayName: String(row.display_name),
      gameplayPersistentIdHash:
        row.gameplay_persistent_id_hash === null ||
        row.gameplay_persistent_id_hash === undefined
          ? null
          : String(row.gameplay_persistent_id_hash),
      isHost: String(row.identity_id) === String(world.host_identity_id),
      teamId: row.team_id === null ? null : String(row.team_id),
      joinedAt: numberValue(row.joined_at),
    }));
  }

  /**
   * Reserves exactly one stable OpenFront game ID for a world. Repeating the
   * same request is idempotent; every changed parameter is a conflict so a
   * scheduler retry cannot silently point the invitation at another game.
   */
  reserveRuntime(
    worldId: string,
    requestIdValue: string,
    gameIdValue: string,
    gameConfigValue: GameConfig,
    startsAtValue: number,
    expiresAtValue: number,
  ): PersistentWorldRuntime {
    const requestId = requestIdValue.trim();
    const gameId = gameIdValue.trim();
    const gameConfig = GameConfigSchema.parse(gameConfigValue);
    const gameConfigJson = JSON.stringify(gameConfig);
    const startsAt = PersistentWorldTimestampSchema.parse(startsAtValue);
    const expiresAt = PersistentWorldTimestampSchema.parse(expiresAtValue);
    if (!RUNTIME_REQUEST_ID_PATTERN.test(requestId)) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Runtime request ID is invalid",
      );
    }
    if (!RUNTIME_GAME_ID_PATTERN.test(gameId)) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Runtime game ID must be eight alphanumeric characters",
      );
    }
    if (expiresAt <= startsAt) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Runtime expiry must be after its start time",
      );
    }

    return this.transaction(() => {
      const world = this.requireWorldRow(worldId);
      const phase = String(world.phase);
      if (phase === "finished" || phase === "cancelled") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          `Cannot reserve a runtime for a ${phase} world`,
        );
      }
      if (startsAt !== numberValue(world.starts_at)) {
        throw new PersistentWorldRepositoryError(
          "INVALID_ARGUMENT",
          "Runtime start must match the world's promised start time",
        );
      }

      const existing = this.getRuntime(worldId);
      if (existing) {
        if (
          existing.requestId === requestId &&
          existing.gameId === gameId &&
          JSON.stringify(existing.gameConfig) === gameConfigJson &&
          existing.startsAt === startsAt &&
          existing.expiresAt === expiresAt
        ) {
          return existing;
        }
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          `World ${worldId} already has another runtime reservation`,
        );
      }

      const requestedAt = this.validNow();
      try {
        this.db
          .prepare(
            `INSERT INTO persistent_world_runtimes(
               world_id, request_id, game_id, game_config_json, state,
               starts_at, expires_at, requested_at, updated_at
             ) VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?, ?)`,
          )
          .run(
            worldId,
            requestId,
            gameId,
            gameConfigJson,
            startsAt,
            expiresAt,
            requestedAt,
            requestedAt,
          );
      } catch {
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          "Runtime request ID or game ID is already reserved",
        );
      }
      this.db
        .prepare(
          `UPDATE persistent_worlds
           SET updated_at = MAX(updated_at, ?)
           WHERE id = ?`,
        )
        .run(requestedAt, worldId);
      return this.getRuntime(worldId)!;
    });
  }

  markRuntimeReady(
    worldId: string,
    requestIdValue: string,
    gameIdValue: string,
    atValue: number = this.validNow(),
  ): PersistentWorldRuntime {
    const requestId = requestIdValue.trim();
    const gameId = gameIdValue.trim();
    const at = PersistentWorldTimestampSchema.parse(atValue);
    if (
      !RUNTIME_REQUEST_ID_PATTERN.test(requestId) ||
      !RUNTIME_GAME_ID_PATTERN.test(gameId)
    ) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Runtime identity is invalid",
      );
    }

    return this.transaction(() => {
      const world = this.requireWorldRow(worldId);
      const runtime = this.getRuntime(worldId);
      if (!runtime) {
        throw new PersistentWorldRepositoryError(
          "NOT_FOUND",
          `World ${worldId} has no runtime reservation`,
        );
      }
      if (runtime.requestId !== requestId || runtime.gameId !== gameId) {
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          "Runtime readiness does not match the durable reservation",
        );
      }
      if (runtime.state === "ready") return runtime;
      if (["finished", "cancelled"].includes(String(world.phase))) {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          `Cannot ready a runtime for a ${String(world.phase)} world`,
        );
      }
      if (at < runtime.requestedAt) {
        throw new PersistentWorldRepositoryError(
          "INVALID_ARGUMENT",
          "Runtime readiness cannot predate its reservation",
        );
      }

      this.db
        .prepare(
          `UPDATE persistent_world_runtimes
           SET state = 'ready', ready_at = ?, updated_at = ?
           WHERE world_id = ? AND state = 'provisioning'`,
        )
        .run(at, at, worldId);
      this.db
        .prepare(
          `UPDATE persistent_worlds
           SET updated_at = MAX(updated_at, ?)
           WHERE id = ?`,
        )
        .run(at, worldId);
      return this.getRuntime(worldId)!;
    });
  }

  getRuntime(worldId: string): PersistentWorldRuntime | undefined {
    const row = this.db
      .prepare("SELECT * FROM persistent_world_runtimes WHERE world_id = ?")
      .get(worldId) as SqlRow | undefined;
    return row ? this.runtimeFromRow(row) : undefined;
  }

  /** Resolves a worker journal event to its durable world reservation. */
  getRuntimeByRequestId(
    requestIdValue: string,
  ): PersistentWorldRuntime | undefined {
    const requestId = requestIdValue.trim();
    if (!RUNTIME_REQUEST_ID_PATTERN.test(requestId)) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Runtime request ID is invalid",
      );
    }
    const row = this.db
      .prepare("SELECT * FROM persistent_world_runtimes WHERE request_id = ?")
      .get(requestId) as SqlRow | undefined;
    return row ? this.runtimeFromRow(row) : undefined;
  }

  /**
   * Durably appends an exact, contiguous slice of the managed game's turn
   * stream. A worker may replay any already-committed prefix after an IPC
   * timeout; byte-equivalent normalized turns are idempotent, while a gap or
   * divergent duplicate is rejected before any suffix is inserted.
   */
  appendRuntimeTurns(
    worldId: string,
    requestIdValue: string,
    turnsValue: readonly Turn[],
  ): void {
    const requestId = requestIdValue.trim();
    if (!RUNTIME_REQUEST_ID_PATTERN.test(requestId)) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Runtime request ID is invalid",
      );
    }

    const turns = turnsValue.map((value, index) => {
      const parsed = TurnSchema.safeParse(value);
      if (
        !parsed.success ||
        !Number.isSafeInteger(parsed.data.turnNumber) ||
        parsed.data.turnNumber < 0
      ) {
        throw new PersistentWorldRepositoryError(
          "INVALID_ARGUMENT",
          `Runtime turn at batch index ${index} is invalid`,
        );
      }
      if (
        index > 0 &&
        parsed.data.turnNumber !== turnsValue[index - 1].turnNumber + 1
      ) {
        throw new PersistentWorldRepositoryError(
          "INVALID_ARGUMENT",
          "Runtime turn batch must be contiguous and ordered",
        );
      }
      return {
        value: parsed.data,
        json: JSON.stringify(parsed.data),
      };
    });

    this.transaction(() => {
      this.requireWorldRow(worldId);
      const runtime = this.db
        .prepare(
          "SELECT request_id FROM persistent_world_runtimes WHERE world_id = ?",
        )
        .get(worldId) as SqlRow | undefined;
      if (!runtime) {
        throw new PersistentWorldRepositoryError(
          "NOT_FOUND",
          `World ${worldId} has no runtime reservation`,
        );
      }
      if (String(runtime.request_id) !== requestId) {
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          "Runtime turn batch does not match the durable reservation",
        );
      }

      const journal = this.db
        .prepare(
          `SELECT COUNT(*) AS count, MAX(turn_number) AS max_turn
           FROM persistent_world_runtime_turns
           WHERE world_id = ?`,
        )
        .get(worldId) as SqlRow;
      const count = numberValue(journal.count);
      let highWatermark = nullableNumber(journal.max_turn) ?? -1;
      if (count !== highWatermark + 1) {
        throw new Error("Persistent-world runtime turn journal has a gap");
      }

      const storedTurn = this.db.prepare(
        `SELECT turn_json FROM persistent_world_runtime_turns
         WHERE world_id = ? AND turn_number = ?`,
      );
      const insertTurn = this.db.prepare(
        `INSERT INTO persistent_world_runtime_turns(
           world_id, turn_number, turn_json, committed_at
         ) VALUES (?, ?, ?, ?)`,
      );
      const committedAt = this.validNow();
      for (const turn of turns) {
        if (turn.value.turnNumber <= highWatermark) {
          const stored = storedTurn.get(worldId, turn.value.turnNumber) as
            SqlRow | undefined;
          if (!stored || String(stored.turn_json) !== turn.json) {
            throw new PersistentWorldRepositoryError(
              "CONFLICT",
              `Runtime turn ${turn.value.turnNumber} conflicts with the journal`,
            );
          }
          continue;
        }
        if (turn.value.turnNumber !== highWatermark + 1) {
          throw new PersistentWorldRepositoryError(
            "CONFLICT",
            `Runtime turn journal expected turn ${highWatermark + 1}`,
          );
        }
        insertTurn.run(worldId, turn.value.turnNumber, turn.json, committedAt);
        highWatermark = turn.value.turnNumber;
      }
      if (turns.length > 0) {
        this.db
          .prepare(
            `UPDATE persistent_world_runtimes
             SET updated_at = MAX(updated_at, ?)
             WHERE world_id = ?`,
          )
          .run(committedAt, worldId);
      }
    });
  }

  /** Loads and validates the complete replay stream for worker recovery. */
  loadRuntimeTurns(worldId: string): Turn[] {
    this.requireWorldRow(worldId);
    const runtime = this.db
      .prepare(
        "SELECT 1 AS present FROM persistent_world_runtimes WHERE world_id = ?",
      )
      .get(worldId) as SqlRow | undefined;
    if (!runtime) {
      throw new PersistentWorldRepositoryError(
        "NOT_FOUND",
        `World ${worldId} has no runtime reservation`,
      );
    }

    const rows = this.db
      .prepare(
        `SELECT turn_number, turn_json
         FROM persistent_world_runtime_turns
         WHERE world_id = ?
         ORDER BY turn_number`,
      )
      .all(worldId) as SqlRow[];
    return rows.map((row, index) => {
      let json: unknown;
      try {
        json = JSON.parse(String(row.turn_json));
      } catch {
        throw new Error(
          `Persistent-world runtime turn ${index} contains invalid JSON`,
        );
      }
      const parsed = TurnSchema.safeParse(json);
      if (
        !parsed.success ||
        !Number.isSafeInteger(parsed.data.turnNumber) ||
        parsed.data.turnNumber !== index ||
        numberValue(row.turn_number) !== index
      ) {
        throw new Error(
          `Persistent-world runtime turn journal is corrupt at turn ${index}`,
        );
      }
      return parsed.data;
    });
  }

  /**
   * Persists the latest agreed client-simulation view of each RSVP seat.
   * Elimination is intentionally sticky: a stale or corrupt later report may
   * not resurrect a seat on the invitation card.
   */
  recordRuntimePlayerStatuses(
    worldId: string,
    requestIdValue: string,
    observedTurnValue: number,
    statuses: readonly Omit<
      PersistentWorldRuntimePlayerStatus,
      "worldId" | "observedTurn" | "updatedAt"
    >[],
  ): void {
    const requestId = requestIdValue.trim();
    if (!RUNTIME_REQUEST_ID_PATTERN.test(requestId)) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Runtime request ID is invalid",
      );
    }
    const observedTurn = Number(observedTurnValue);
    if (!Number.isSafeInteger(observedTurn) || observedTurn < 0) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Runtime status turn is invalid",
      );
    }

    this.transaction(() => {
      const runtime = this.db
        .prepare(
          "SELECT request_id FROM persistent_world_runtimes WHERE world_id = ?",
        )
        .get(worldId) as SqlRow | undefined;
      if (!runtime) {
        throw new PersistentWorldRepositoryError(
          "NOT_FOUND",
          `World ${worldId} has no runtime reservation`,
        );
      }
      if (String(runtime.request_id) !== requestId) {
        throw new PersistentWorldRepositoryError(
          "CONFLICT",
          "Runtime status does not match the durable reservation",
        );
      }

      const updatedAt = this.validNow();
      const upsert = this.db.prepare(`
        INSERT INTO persistent_world_runtime_player_status(
          world_id, identity_id, client_id, is_alive, killed_by,
          death_position, observed_turn, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(world_id, identity_id) DO UPDATE SET
          client_id = excluded.client_id,
          is_alive = MIN(persistent_world_runtime_player_status.is_alive, excluded.is_alive),
          killed_by = COALESCE(persistent_world_runtime_player_status.killed_by, excluded.killed_by),
          death_position = COALESCE(persistent_world_runtime_player_status.death_position, excluded.death_position),
          observed_turn = excluded.observed_turn,
          updated_at = excluded.updated_at
        WHERE excluded.observed_turn > persistent_world_runtime_player_status.observed_turn
      `);
      for (const status of statuses) {
        if (
          !RUNTIME_GAME_ID_PATTERN.test(status.clientId) ||
          (status.killedBy !== null &&
            !RUNTIME_GAME_ID_PATTERN.test(status.killedBy)) ||
          (status.deathPosition !== null &&
            (!Number.isSafeInteger(status.deathPosition) ||
              status.deathPosition <= 0))
        ) {
          throw new PersistentWorldRepositoryError(
            "INVALID_ARGUMENT",
            "Runtime player status is invalid",
          );
        }
        upsert.run(
          worldId,
          status.identityId,
          status.clientId,
          status.isAlive ? 1 : 0,
          status.killedBy,
          status.deathPosition,
          observedTurn,
          updatedAt,
        );
      }
    });
  }

  runtimePlayerStatus(
    worldId: string,
    identityId: string,
  ): PersistentWorldRuntimePlayerStatus | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM persistent_world_runtime_player_status
         WHERE world_id = ? AND identity_id = ?`,
      )
      .get(worldId, identityId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      worldId: String(row.world_id),
      identityId: String(row.identity_id),
      clientId: String(row.client_id),
      isAlive: numberValue(row.is_alive) === 1,
      killedBy: row.killed_by === null ? null : String(row.killed_by),
      deathPosition: nullableNumber(row.death_position),
      observedTurn: numberValue(row.observed_turn),
      updatedAt: numberValue(row.updated_at),
    };
  }

  /** Incomplete reservations to resend idempotently after a process restart. */
  listRuntimeProvisioning(
    limitValue: number = DEFAULT_DUE_LIMIT,
  ): PersistentWorldRuntime[] {
    const limit = Math.min(MAX_DUE_LIMIT, Math.max(1, Math.trunc(limitValue)));
    const rows = this.db
      .prepare(
        `SELECT runtime.*
         FROM persistent_world_runtimes runtime
         JOIN persistent_worlds world ON world.id = runtime.world_id
         WHERE runtime.state = 'provisioning'
           AND runtime.expires_at > ?
           AND world.phase IN ('scheduled', 'active')
         ORDER BY runtime.starts_at, runtime.world_id
         LIMIT ?`,
      )
      .all(this.validNow(), limit) as SqlRow[];
    return rows.map((row) => this.runtimeFromRow(row));
  }

  /** Ready runtimes whose active worlds must be recovered after restart. */
  listRuntimeReady(
    limitValue: number = DEFAULT_DUE_LIMIT,
  ): PersistentWorldRuntime[] {
    const limit = Math.min(MAX_DUE_LIMIT, Math.max(1, Math.trunc(limitValue)));
    const rows = this.db
      .prepare(
        `SELECT runtime.*
         FROM persistent_world_runtimes runtime
         JOIN persistent_worlds world ON world.id = runtime.world_id
         WHERE runtime.state = 'ready'
           AND runtime.expires_at > ?
           AND world.phase = 'active'
         ORDER BY runtime.starts_at, runtime.world_id
         LIMIT ?`,
      )
      .all(this.validNow(), limit) as SqlRow[];
    return rows.map((row) => this.runtimeFromRow(row));
  }

  /** Active v3/legacy worlds that still need a durable runtime association. */
  listActiveWithoutRuntime(
    limitValue: number = DEFAULT_DUE_LIMIT,
  ): PersistentWorld[] {
    const limit = Math.min(MAX_DUE_LIMIT, Math.max(1, Math.trunc(limitValue)));
    const rows = this.db
      .prepare(
        `SELECT
           world.*,
           identity.id AS identity_id, identity.kind AS identity_kind,
           identity.subject AS identity_subject,
           identity.display_name AS identity_display_name,
           identity.verified_email AS identity_verified_email
         FROM persistent_worlds world
         JOIN persistent_world_identities identity
           ON identity.id = world.host_identity_id
         LEFT JOIN persistent_world_runtimes runtime
           ON runtime.world_id = world.id
         WHERE world.phase = 'active'
           AND runtime.world_id IS NULL
           AND CASE world.target_duration
             WHEN '1h' THEN world.starts_at + 3600000
             WHEN '1d' THEN world.starts_at + 86400000
             WHEN '7d' THEN world.starts_at + 604800000
           END > ?
         ORDER BY world.starts_at, world.id
         LIMIT ?`,
      )
      .all(this.validNow(), limit) as SqlRow[];
    return rows.map((row) => this.worldFromRow(row));
  }

  createWorld(inputValue: CreatePersistentWorldInput): PersistentWorld {
    const input = CreatePersistentWorldInputSchema.parse(inputValue);
    const joinClosesAt =
      input.startsAt + persistentWorldDurationMs(input.targetDuration) / 3;
    if (!Number.isSafeInteger(joinClosesAt)) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "World schedule exceeds the supported timestamp range",
      );
    }

    return this.transaction(() => {
      const existing = this.getWorld(input.id);
      if (existing) {
        const sameDefinition =
          existing.name === input.name &&
          existing.startMode === (input.startMode ?? "scheduled") &&
          existing.gamePreset === input.gamePreset &&
          JSON.stringify(existing.pressurePacing) ===
            JSON.stringify(input.pressurePacing) &&
          existing.targetDuration === input.targetDuration &&
          existing.access === input.access &&
          existing.mode === input.mode &&
          existing.maxHumans === input.maxHumans &&
          existing.startsAt === input.startsAt &&
          existing.host.id === input.host.id &&
          existing.rsvps.find((rsvp) => rsvp.isHost)?.teamId ===
            (input.hostTeamId ?? null);
        const secretMatches =
          input.access === "public" ||
          this.invitationMatchesRow(
            this.requireWorldRow(input.id),
            input.invitationSecret!,
          );
        if (!sameDefinition || !secretMatches) {
          throw new PersistentWorldRepositoryError(
            "CONFLICT",
            `World ${input.id} already exists with different settings`,
          );
        }
        return existing;
      }

      this.ensureIdentity(input.host);
      const now = this.validNow();
      this.db
        .prepare(
          `INSERT INTO persistent_worlds(
            id, name, target_duration, access, mode, max_humans, phase,
            starts_at, join_closes_at, host_identity_id,
            invitation_secret_hash, created_at, updated_at, start_mode, game_preset, pressure_pacing
          ) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.targetDuration,
          input.access,
          input.mode,
          input.maxHumans,
          input.startsAt,
          joinClosesAt,
          input.host.id,
          input.invitationSecret
            ? hashSecret("invitation", input.invitationSecret)
            : null,
          now,
          now,
          input.startMode ?? "scheduled",
          input.gamePreset ?? null,
          input.pressurePacing ? JSON.stringify(input.pressurePacing) : null,
        );
      this.db
        .prepare(
          `INSERT INTO persistent_world_rsvps(
            world_id, identity_id, team_id, joined_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.host.id, input.hostTeamId ?? null, now, now);
      if (input.startMode !== "host")
        this.ensureNotificationJobRows(
          input.id,
          input.host.id,
          "start",
          null,
          input.startsAt,
          now,
        );
      return this.getWorld(input.id)!;
    });
  }

  getWorld(worldId: string): PersistentWorld | undefined {
    const row = this.worldRow(worldId);
    return row ? this.worldFromRow(row) : undefined;
  }

  listPublicWorlds(limitValue: number = 100): PersistentWorld[] {
    const limit = Math.min(200, Math.max(1, Math.trunc(limitValue)));
    const rows = this.db
      .prepare(
        `SELECT
           w.*,
           i.id AS identity_id, i.kind AS identity_kind,
           i.subject AS identity_subject,
           i.display_name AS identity_display_name,
           i.verified_email AS identity_verified_email
         FROM persistent_worlds w
         JOIN persistent_world_identities i ON i.id = w.host_identity_id
         WHERE w.access = 'public' AND w.phase IN ('scheduled', 'active')
         ORDER BY CASE w.phase WHEN 'scheduled' THEN 0 ELSE 1 END,
                  w.starts_at, w.id
         LIMIT ?`,
      )
      .all(limit) as SqlRow[];
    return rows.map((row) => this.worldFromRow(row));
  }

  listWorldsForIdentity(identityId: string): PersistentWorld[] {
    const rows = this.db
      .prepare(
        `SELECT
           w.*,
           host.id AS identity_id, host.kind AS identity_kind,
           host.subject AS identity_subject,
           host.display_name AS identity_display_name,
           host.verified_email AS identity_verified_email
         FROM persistent_worlds w
         JOIN persistent_world_rsvps member ON member.world_id = w.id
         JOIN persistent_world_identities host ON host.id = w.host_identity_id
         WHERE member.identity_id = ?
           AND w.phase IN ('scheduled', 'active')
         ORDER BY CASE w.phase
                    WHEN 'active' THEN 0
                    WHEN 'scheduled' THEN 1
                    WHEN 'finished' THEN 2
                    ELSE 3
                  END,
                  w.starts_at DESC, w.id`,
      )
      .all(identityId) as SqlRow[];
    return rows.map((row) => this.worldFromRow(row));
  }

  /**
   * Moves stale rows out of the live lobby indexes while preserving their
   * roster, chat, runtime journal, and terminal timestamp as an archive.
   * A ready runtime is a completed game at its configured end; a world that
   * never reached ready is a failed start once its grace period elapses.
   */
  archiveStaleWorlds(
    atValue: number = this.validNow(),
    startupGraceMsValue: number = 5 * 60_000,
  ): PersistentWorldArchiveSweep {
    const at = PersistentWorldTimestampSchema.parse(atValue);
    const startupGraceMs = Math.trunc(startupGraceMsValue);
    if (!Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0) {
      throw new PersistentWorldRepositoryError(
        "INVALID_ARGUMENT",
        "Runtime startup grace must be a non-negative safe integer",
      );
    }

    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT
             world.id, world.phase, world.starts_at, world.target_duration,
             EXISTS(
               SELECT 1
               FROM persistent_world_runtimes runtime
               WHERE runtime.world_id = world.id AND runtime.state = 'ready'
             ) AS runtime_ready
           FROM persistent_worlds world
           WHERE world.phase IN ('scheduled', 'active')
             AND NOT (world.phase = 'scheduled' AND world.start_mode = 'host')
           ORDER BY world.starts_at, world.id`,
        )
        .all() as SqlRow[];

      const finishedIds: string[] = [];
      const cancelledIds: string[] = [];
      const cancel = this.db.prepare(
        `UPDATE persistent_worlds
         SET phase = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE id = ? AND phase IN ('scheduled', 'active')`,
      );
      const suppressNotifications = this.db.prepare(
        `UPDATE persistent_world_notification_jobs
         SET state = 'suppressed', suppressed_at = ?,
             claim_token_hash = NULL, lease_expires_at = NULL,
             last_error = NULL, updated_at = ?
         WHERE world_id = ? AND state IN ('pending', 'claimed')`,
      );

      for (const row of rows) {
        const worldId = String(row.id);
        const phase = String(row.phase);
        const startsAt = numberValue(row.starts_at);
        const duration = persistentWorldDurationMs(
          PersistentWorldSchema.shape.targetDuration.parse(row.target_duration),
        );
        const runtimeReady = numberValue(row.runtime_ready) === 1;
        const reachedConfiguredEnd = startsAt + duration <= at;
        const missedRuntimeGrace = startsAt + startupGraceMs <= at;

        let changed = false;
        if (
          (!runtimeReady && phase === "active" && missedRuntimeGrace) ||
          (phase === "scheduled" && reachedConfiguredEnd)
        ) {
          changed = numberValue(cancel.run(at, at, worldId).changes) === 1;
          if (changed) cancelledIds.push(worldId);
        }
        if (changed) suppressNotifications.run(at, at, worldId);
      }

      return {
        finished: finishedIds.map((id) => this.getWorld(id)!),
        cancelled: cancelledIds.map((id) => this.getWorld(id)!),
      };
    });
  }

  private worldRow(worldId: string): SqlRow | undefined {
    return this.db
      .prepare(
        `SELECT
           w.*,
           i.id AS identity_id, i.kind AS identity_kind,
           i.subject AS identity_subject,
           i.display_name AS identity_display_name,
           i.verified_email AS identity_verified_email
         FROM persistent_worlds w
         JOIN persistent_world_identities i ON i.id = w.host_identity_id
         WHERE w.id = ?`,
      )
      .get(worldId) as SqlRow | undefined;
  }

  private requireWorldRow(worldId: string): SqlRow {
    const row = this.worldRow(worldId);
    if (!row) {
      throw new PersistentWorldRepositoryError(
        "NOT_FOUND",
        `World ${worldId} does not exist`,
      );
    }
    return row;
  }

  private rsvpRows(worldId: string): SqlRow[] {
    return this.db
      .prepare(
        `SELECT
           r.world_id, r.identity_id, r.team_id, r.joined_at, r.last_seen_at,
           w.host_identity_id,
           i.kind AS identity_kind, i.subject AS identity_subject,
           i.display_name AS identity_display_name,
           i.verified_email AS identity_verified_email
         FROM persistent_world_rsvps r
         JOIN persistent_worlds w ON w.id = r.world_id
         JOIN persistent_world_identities i ON i.id = r.identity_id
         WHERE r.world_id = ?
         ORDER BY r.joined_at, r.identity_id`,
      )
      .all(worldId) as SqlRow[];
  }

  private rsvpFromRow(row: SqlRow): PersistentWorldRsvp {
    return PersistentWorldRsvpSchema.parse({
      worldId: String(row.world_id),
      identity: this.identityFromRow(row),
      isHost: String(row.identity_id) === String(row.host_identity_id),
      teamId: row.team_id === null ? null : String(row.team_id),
      joinedAt: numberValue(row.joined_at),
      lastSeenAt: numberValue(row.last_seen_at),
    });
  }

  private worldFromRow(row: SqlRow): PersistentWorld {
    return PersistentWorldSchema.parse({
      pressurePacing:
        row.pressure_pacing === null || row.pressure_pacing === undefined
          ? undefined
          : JSON.parse(String(row.pressure_pacing)),
      startMode: String(row.start_mode),
      gamePreset:
        row.game_preset === null || row.game_preset === undefined
          ? undefined
          : String(row.game_preset),
      id: String(row.id),
      name: String(row.name),
      targetDuration: String(row.target_duration),
      access: String(row.access),
      mode: String(row.mode),
      maxHumans: numberValue(row.max_humans),
      phase: String(row.phase),
      startsAt: numberValue(row.starts_at),
      joinClosesAt: numberValue(row.join_closes_at),
      host: this.identityFromRow(row),
      rsvps: this.rsvpRows(String(row.id)).map((rsvp) =>
        this.rsvpFromRow(rsvp),
      ),
      scheduleLockedAt: nullableNumber(row.schedule_locked_at),
      createdAt: numberValue(row.created_at),
      updatedAt: numberValue(row.updated_at),
      activatedAt: nullableNumber(row.activated_at),
      finishedAt: nullableNumber(row.finished_at),
      cancelledAt: nullableNumber(row.cancelled_at),
    });
  }

  private invitationMatchesRow(row: SqlRow, secret: string): boolean {
    if (String(row.access) === "public") return true;
    const storedHash = String(row.invitation_secret_hash ?? "");
    return hashesMatch(storedHash, hashSecret("invitation", secret));
  }

  verifyInvitation(worldId: string, secret: string): boolean {
    const row = this.requireWorldRow(worldId);
    return this.invitationMatchesRow(row, secret);
  }

  updateSchedule(
    worldId: string,
    actor: PersistentWorldIdentity,
    startsAtValue: number,
  ): PersistentWorld {
    const startsAt = PersistentWorldTimestampSchema.parse(startsAtValue);
    return this.transaction(() => {
      const row = this.requireWorldRow(worldId);
      if (row.start_mode === "host") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          "Custom games have no automatic schedule",
        );
      }
      if (String(row.host_identity_id) !== actor.id) {
        throw new PersistentWorldRepositoryError(
          "FORBIDDEN",
          "Only the world host can change its schedule",
        );
      }
      if (numberValue(row.starts_at) === startsAt) {
        return this.worldFromRow(row);
      }
      if (String(row.phase) !== "scheduled") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          "Only scheduled worlds can be rescheduled",
        );
      }
      if (row.schedule_locked_at !== null) {
        throw new PersistentWorldRepositoryError(
          "SCHEDULE_LOCKED",
          "The schedule locked when the first non-host player RSVPed",
        );
      }
      const joinClosesAt =
        startsAt +
        persistentWorldDurationMs(
          String(row.target_duration) as "1h" | "1d" | "7d",
        ) /
          3;
      if (!Number.isSafeInteger(joinClosesAt)) {
        throw new PersistentWorldRepositoryError(
          "INVALID_ARGUMENT",
          "World schedule exceeds the supported timestamp range",
        );
      }
      this.db
        .prepare(
          `UPDATE persistent_worlds
           SET starts_at = ?, join_closes_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(startsAt, joinClosesAt, this.validNow(), worldId);
      this.db
        .prepare(
          `UPDATE persistent_world_notification_jobs
           SET due_at = ? - lead_time_ms,
               available_at = ? - lead_time_ms,
               state = 'pending', claim_token_hash = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE world_id = ? AND state IN ('pending', 'claimed')`,
        )
        .run(startsAt, startsAt, this.validNow(), worldId);
      return this.getWorld(worldId)!;
    });
  }

  rsvp(
    inputValue: PersistentWorldRsvpInput,
    passwordAuthenticated = false,
  ): PersistentWorldRsvp {
    const input = PersistentWorldRsvpInputSchema.parse(inputValue);
    return this.transaction(() => {
      const world = this.requireWorldRow(input.worldId);
      const existing = this.db
        .prepare(
          "SELECT * FROM persistent_world_rsvps WHERE world_id = ? AND identity_id = ?",
        )
        .get(input.worldId, input.identity.id) as SqlRow | undefined;

      if (
        String(world.mode) === "ffa" &&
        input.teamId !== null &&
        input.teamId !== undefined
      ) {
        throw new PersistentWorldRepositoryError(
          "INVALID_ARGUMENT",
          "FFA worlds cannot have team choices",
        );
      }

      this.ensureIdentity(input.identity);
      const now = this.validNow();
      if (existing) {
        if (
          input.teamId !== undefined &&
          input.teamId !== existing.team_id &&
          now >= numberValue(world.starts_at) &&
          !(world.start_mode === "host" && world.phase === "scheduled")
        ) {
          throw new PersistentWorldRepositoryError(
            "SCHEDULE_LOCKED",
            "Team choices cannot change after the world starts",
          );
        }
        this.db
          .prepare(
            `UPDATE persistent_world_rsvps
             SET team_id = ?, last_seen_at = MAX(last_seen_at, ?)
             WHERE world_id = ? AND identity_id = ?`,
          )
          .run(
            input.teamId === undefined
              ? existing.team_id === null
                ? null
                : String(existing.team_id)
              : input.teamId,
            now,
            input.worldId,
            input.identity.id,
          );
        if (!(world.start_mode === "host" && world.phase === "scheduled"))
          this.ensureNotificationJobRows(
            input.worldId,
            input.identity.id,
            "start",
            null,
            numberValue(world.starts_at),
            now,
          );
        return this.getRsvp(input.worldId, input.identity.id)!;
      }

      const phase = String(world.phase);
      if (phase === "finished" || phase === "cancelled") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          `Cannot join a ${phase} world`,
        );
      }
      if (
        String(world.access) === "public" &&
        now >= numberValue(world.starts_at) &&
        !(world.start_mode === "host" && world.phase === "scheduled")
      ) {
        throw new PersistentWorldRepositoryError(
          "JOIN_CLOSED",
          "Public worlds close to new players when they start",
        );
      }
      if (String(world.access) === "private") {
        if (
          !passwordAuthenticated &&
          (!input.invitationSecret ||
            !this.invitationMatchesRow(world, input.invitationSecret))
        ) {
          throw new PersistentWorldRepositoryError(
            "INVALID_INVITATION",
            "Invitation secret is invalid",
          );
        }
        if (
          now >= numberValue(world.join_closes_at) &&
          !(world.start_mode === "host" && world.phase === "scheduled")
        ) {
          throw new PersistentWorldRepositoryError(
            "JOIN_CLOSED",
            "This private world's late-join window has closed",
          );
        }
      }
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM persistent_world_rsvps WHERE world_id = ?",
        )
        .get(input.worldId) as SqlRow;
      if (numberValue(count.count) >= numberValue(world.max_humans)) {
        throw new PersistentWorldRepositoryError(
          "WORLD_FULL",
          "World has reached its human player limit",
        );
      }

      this.db
        .prepare(
          `INSERT INTO persistent_world_rsvps(
            world_id, identity_id, team_id, joined_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.worldId, input.identity.id, input.teamId ?? null, now, now);
      if (!(world.start_mode === "host" && world.phase === "scheduled"))
        this.ensureNotificationJobRows(
          input.worldId,
          input.identity.id,
          "start",
          null,
          numberValue(world.starts_at),
          now,
        );
      if (input.identity.id !== String(world.host_identity_id)) {
        this.db
          .prepare(
            `UPDATE persistent_worlds
             SET schedule_locked_at = COALESCE(schedule_locked_at, ?),
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(now, now, input.worldId);
      }
      return this.getRsvp(input.worldId, input.identity.id)!;
    });
  }

  getRsvp(
    worldId: string,
    identityId: string,
  ): PersistentWorldRsvp | undefined {
    const row = this.db
      .prepare(
        `SELECT
           r.world_id, r.identity_id, r.team_id, r.joined_at, r.last_seen_at,
           w.host_identity_id,
           i.kind AS identity_kind, i.subject AS identity_subject,
           i.display_name AS identity_display_name,
           i.verified_email AS identity_verified_email
         FROM persistent_world_rsvps r
         JOIN persistent_worlds w ON w.id = r.world_id
         JOIN persistent_world_identities i ON i.id = r.identity_id
         WHERE r.world_id = ? AND r.identity_id = ?`,
      )
      .get(worldId, identityId) as SqlRow | undefined;
    return row ? this.rsvpFromRow(row) : undefined;
  }

  leaveWorld(worldId: string, identityId: string): void {
    this.transaction(() => {
      const world = this.requireWorldRow(worldId);
      if (String(world.host_identity_id) === identityId) {
        throw new PersistentWorldRepositoryError(
          "FORBIDDEN",
          "The host must cancel the world instead of leaving it",
        );
      }
      if (String(world.phase) !== "scheduled") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          "A player can leave only before the world starts",
        );
      }
      this.db
        .prepare(
          `DELETE FROM persistent_world_notification_jobs
           WHERE world_id = ? AND identity_id = ?
             AND state != 'delivered'`,
        )
        .run(worldId, identityId);
      const result = this.db
        .prepare(
          "DELETE FROM persistent_world_rsvps WHERE world_id = ? AND identity_id = ?",
        )
        .run(worldId, identityId);
      if (numberValue(result.changes) === 0) {
        throw new PersistentWorldRepositoryError(
          "NOT_FOUND",
          "RSVP does not exist",
        );
      }
      this.db
        .prepare("UPDATE persistent_worlds SET updated_at = ? WHERE id = ?")
        .run(this.validNow(), worldId);
    });
  }

  setReminderSelection(
    worldId: string,
    identityId: string,
    leadTimesValue: number[],
  ): PersistentWorldReminderSelection {
    return this.transaction(() => {
      const world = this.requireWorldRow(worldId);
      if (!this.getRsvp(worldId, identityId)) {
        throw new PersistentWorldRepositoryError(
          "FORBIDDEN",
          "Only an RSVPed player can configure reminders",
        );
      }
      if (String(world.phase) !== "scheduled") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          "Reminder choices can change only before the world starts",
        );
      }
      const allowed = new Set(
        inferredReminderLeadTimes(
          numberValue(world.starts_at) - numberValue(world.created_at),
        ),
      );
      const leadTimesMs = [...new Set(leadTimesValue)]
        .sort((a, b) => b - a)
        .filter((lead) => allowed.has(lead));
      if (leadTimesMs.length !== new Set(leadTimesValue).size) {
        throw new PersistentWorldRepositoryError(
          "INVALID_ARGUMENT",
          "Reminder selection contains an unavailable lead time",
        );
      }
      const updatedAt = this.validNow();
      this.db
        .prepare(
          `INSERT INTO persistent_world_reminders(
             world_id, identity_id, lead_times_json, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(world_id, identity_id) DO UPDATE SET
             lead_times_json = excluded.lead_times_json,
             updated_at = excluded.updated_at`,
        )
        .run(worldId, identityId, JSON.stringify(leadTimesMs), updatedAt);

      const existingJobs = this.db
        .prepare(
          `SELECT * FROM persistent_world_notification_jobs
           WHERE world_id = ? AND identity_id = ? AND kind = 'reminder'`,
        )
        .all(worldId, identityId) as SqlRow[];
      const selectedLeads = new Set(leadTimesMs);
      for (const row of existingJobs) {
        const leadTimeMs = numberValue(row.lead_time_ms);
        if (!selectedLeads.has(leadTimeMs)) {
          if (["pending", "claimed"].includes(String(row.state))) {
            this.db
              .prepare(
                `UPDATE persistent_world_notification_jobs
                 SET state = 'suppressed', suppressed_at = ?,
                     claim_token_hash = NULL, lease_expires_at = NULL,
                     last_error = NULL, updated_at = ?
                 WHERE id = ?`,
              )
              .run(updatedAt, updatedAt, String(row.id));
          }
          continue;
        }
        if (String(row.state) === "suppressed") {
          const dueAt = numberValue(world.starts_at) - leadTimeMs;
          const state = dueAt < updatedAt ? "suppressed" : "pending";
          this.db
            .prepare(
              `UPDATE persistent_world_notification_jobs
               SET due_at = ?, available_at = ?, state = ?,
                   suppressed_at = ?, claim_token_hash = NULL,
                   lease_expires_at = NULL, last_error = NULL, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              dueAt,
              dueAt,
              state,
              state === "suppressed" ? updatedAt : null,
              updatedAt,
              String(row.id),
            );
        }
      }
      for (const leadTimeMs of leadTimesMs) {
        this.ensureNotificationJobRows(
          worldId,
          identityId,
          "reminder",
          leadTimeMs,
          numberValue(world.starts_at) - leadTimeMs,
          updatedAt,
        );
      }
      this.db
        .prepare("UPDATE persistent_worlds SET updated_at = ? WHERE id = ?")
        .run(updatedAt, worldId);
      return PersistentWorldReminderSelectionSchema.parse({
        worldId,
        identityId,
        leadTimesMs,
        updatedAt,
      });
    });
  }

  getReminderSelection(
    worldId: string,
    identityId: string,
  ): PersistentWorldReminderSelection | undefined {
    const row = this.db
      .prepare(
        `SELECT lead_times_json, updated_at
         FROM persistent_world_reminders
         WHERE world_id = ? AND identity_id = ?`,
      )
      .get(worldId, identityId) as SqlRow | undefined;
    if (!row) return undefined;
    return PersistentWorldReminderSelectionSchema.parse({
      worldId,
      identityId,
      leadTimesMs: JSON.parse(String(row.lead_times_json)),
      updatedAt: numberValue(row.updated_at),
    });
  }

  recordLastSeen(
    worldId: string,
    identityId: string,
    seenAtValue: number = this.validNow(),
  ): PersistentWorldRsvp {
    const seenAt = PersistentWorldTimestampSchema.parse(seenAtValue);
    const result = this.db
      .prepare(
        `UPDATE persistent_world_rsvps
         SET last_seen_at = MAX(last_seen_at, ?)
         WHERE world_id = ? AND identity_id = ?`,
      )
      .run(seenAt, worldId, identityId);
    if (numberValue(result.changes) === 0) {
      throw new PersistentWorldRepositoryError(
        "NOT_FOUND",
        "RSVP does not exist",
      );
    }
    return this.getRsvp(worldId, identityId)!;
  }

  /** Scheduler query; ordered deterministically by exact start time then ID. */
  listWorldsDueToStart(
    atValue: number = this.validNow(),
    limitValue: number = DEFAULT_DUE_LIMIT,
  ): PersistentWorld[] {
    const at = PersistentWorldTimestampSchema.parse(atValue);
    const limit = Math.min(MAX_DUE_LIMIT, Math.max(1, Math.trunc(limitValue)));
    const rows = this.db
      .prepare(
        `SELECT
           w.*,
           i.id AS identity_id, i.kind AS identity_kind,
           i.subject AS identity_subject,
           i.display_name AS identity_display_name,
           i.verified_email AS identity_verified_email
         FROM persistent_worlds w
         JOIN persistent_world_identities i ON i.id = w.host_identity_id
         WHERE w.phase = 'scheduled' AND w.start_mode = 'scheduled' AND w.starts_at <= ?
         ORDER BY w.starts_at, w.id
         LIMIT ?`,
      )
      .all(at, limit) as SqlRow[];
    return rows.map((row) => this.worldFromRow(row));
  }

  startCustomWorld(worldId: string, hostId: string): PersistentWorld {
    return this.transaction(() => {
      const row = this.requireWorldRow(worldId);
      if (String(row.host_identity_id) !== hostId) {
        throw new PersistentWorldRepositoryError(
          "FORBIDDEN",
          "Only the host can start this game",
        );
      }
      if (row.start_mode !== "host") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          "Scheduled games start at their scheduled time",
        );
      }
      // Repeated requests from the same host are harmless.
      if (row.phase === "active") return this.worldFromRow(row);
      if (row.phase !== "scheduled") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          "This game has ended",
        );
      }
      const now = this.validNow();
      const joinClosesAt =
        now +
        persistentWorldDurationMs(
          PersistentWorldSchema.shape.targetDuration.parse(row.target_duration),
        ) /
          3;
      this.db
        .prepare(
          `UPDATE persistent_worlds SET phase = 'active',
        starts_at = ?, join_closes_at = ?, activated_at = ?, updated_at = ?
        WHERE id = ? AND phase = 'scheduled'`,
        )
        .run(now, joinClosesAt, now, now, worldId);
      for (const member of this.rsvpRows(worldId)) {
        this.ensureNotificationJobRows(
          worldId,
          String(member.identity_id),
          "start",
          null,
          now,
          now,
        );
      }
      return this.getWorld(worldId)!;
    });
  }

  markActive(
    worldId: string,
    atValue: number = this.validNow(),
  ): PersistentWorld {
    const at = PersistentWorldTimestampSchema.parse(atValue);
    return this.transaction(() => {
      const row = this.requireWorldRow(worldId);
      if (String(row.phase) === "active") return this.worldFromRow(row);
      if (String(row.phase) !== "scheduled") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          `Cannot activate a ${String(row.phase)} world`,
        );
      }
      if (row.start_mode === "host") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          "Only the host can start a custom game",
        );
      }
      if (at < numberValue(row.starts_at)) {
        throw new PersistentWorldRepositoryError(
          "NOT_DUE",
          "World has not reached its exact start time",
        );
      }
      this.db
        .prepare(
          `UPDATE persistent_worlds
           SET phase = 'active', activated_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(at, at, worldId);
      return this.getWorld(worldId)!;
    });
  }

  markFinished(
    worldId: string,
    atValue: number = this.validNow(),
  ): PersistentWorld {
    const at = PersistentWorldTimestampSchema.parse(atValue);
    return this.transaction(() => {
      const row = this.requireWorldRow(worldId);
      if (String(row.phase) === "finished") return this.worldFromRow(row);
      if (String(row.phase) !== "active") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          `Cannot finish a ${String(row.phase)} world`,
        );
      }
      this.db
        .prepare(
          `UPDATE persistent_worlds
           SET phase = 'finished', finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(at, at, worldId);
      return this.getWorld(worldId)!;
    });
  }

  /** Temporary dev-only lifecycle escape hatch for clearing broken worlds. */
  endForDevelopment(
    worldId: string,
    atValue: number = this.validNow(),
  ): PersistentWorld {
    const at = PersistentWorldTimestampSchema.parse(atValue);
    return this.transaction(() => {
      const row = this.requireWorldRow(worldId);
      const phase = String(row.phase);
      if (phase === "finished" || phase === "cancelled") {
        return this.worldFromRow(row);
      }
      if (phase === "active") {
        this.db
          .prepare(
            `UPDATE persistent_worlds
             SET phase = 'finished', finished_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(at, at, worldId);
      } else if (phase === "scheduled") {
        this.db
          .prepare(
            `UPDATE persistent_worlds
             SET phase = 'cancelled', cancelled_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(at, at, worldId);
        this.db
          .prepare(
            `UPDATE persistent_world_notification_jobs
             SET state = 'suppressed', suppressed_at = ?,
                 claim_token_hash = NULL, lease_expires_at = NULL,
                 last_error = NULL, updated_at = ?
             WHERE world_id = ? AND state IN ('pending', 'claimed')`,
          )
          .run(at, at, worldId);
      } else {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          `Cannot end a ${phase} world`,
        );
      }
      return this.getWorld(worldId)!;
    });
  }

  cancelWorld(
    worldId: string,
    actor: PersistentWorldIdentity,
    atValue: number = this.validNow(),
  ): PersistentWorld {
    const at = PersistentWorldTimestampSchema.parse(atValue);
    return this.transaction(() => {
      const row = this.requireWorldRow(worldId);
      if (String(row.host_identity_id) !== actor.id) {
        throw new PersistentWorldRepositoryError(
          "FORBIDDEN",
          "Only the world host can cancel it",
        );
      }
      if (String(row.phase) === "cancelled") return this.worldFromRow(row);
      if (String(row.phase) === "finished") {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          "A finished world cannot be cancelled",
        );
      }
      this.db
        .prepare(
          `UPDATE persistent_worlds
           SET phase = 'cancelled', cancelled_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(at, at, worldId);
      this.db
        .prepare(
          `UPDATE persistent_world_notification_jobs
           SET state = 'suppressed', suppressed_at = ?,
               claim_token_hash = NULL, lease_expires_at = NULL,
               last_error = NULL, updated_at = ?
           WHERE world_id = ? AND state IN ('pending', 'claimed')`,
        )
        .run(at, at, worldId);
      return this.getWorld(worldId)!;
    });
  }

  /**
   * Atomically leases due work. Expired leases are reclaimable after restart;
   * email work is invisible until the identity has a verified address.
   */
  claimDueNotificationJobs(
    options: ClaimPersistentWorldNotificationsOptions = {},
  ): PersistentWorldNotificationDispatchClaim[] {
    const at = PersistentWorldTimestampSchema.parse(
      options.now ?? this.validNow(),
    );
    const limit = Math.min(
      MAX_NOTIFICATION_LIMIT,
      Math.max(1, Math.trunc(options.limit ?? DEFAULT_NOTIFICATION_LIMIT)),
    );
    const leaseMs = Math.min(
      MAX_NOTIFICATION_LEASE_MS,
      Math.max(
        MIN_NOTIFICATION_LEASE_MS,
        Math.trunc(options.leaseMs ?? DEFAULT_NOTIFICATION_LEASE_MS),
      ),
    );
    const leaseExpiresAt = PersistentWorldTimestampSchema.parse(at + leaseMs);

    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT j.*, i.display_name, i.verified_email,
                  w.name AS world_name, w.starts_at AS world_starts_at
           FROM persistent_world_notification_jobs j
           JOIN persistent_world_identities i ON i.id = j.identity_id
           JOIN persistent_worlds w ON w.id = j.world_id
           WHERE j.due_at <= ? AND j.available_at <= ?
             AND (
               j.state = 'pending' OR
               (j.state = 'claimed' AND j.lease_expires_at <= ?)
             )
             AND w.phase NOT IN ('finished', 'cancelled')
             AND (j.channel != 'email' OR i.verified_email IS NOT NULL)
           ORDER BY j.due_at, j.id
           LIMIT ?`,
        )
        .all(at, at, at, limit) as SqlRow[];

      return rows.map((row) => {
        const claimToken = this.randomBearerToken();
        this.db
          .prepare(
            `UPDATE persistent_world_notification_jobs
             SET state = 'claimed', attempt_count = attempt_count + 1,
                 claim_token_hash = ?, lease_expires_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            hashSecret("notification-claim", claimToken),
            leaseExpiresAt,
            at,
            String(row.id),
          );
        const claimedRow = this.db
          .prepare(
            "SELECT * FROM persistent_world_notification_jobs WHERE id = ?",
          )
          .get(String(row.id)) as SqlRow;
        const job = this.notificationJobFromRow(claimedRow);
        return {
          claimToken,
          job,
          recipient: {
            identityId: job.identityId,
            displayName: String(row.display_name),
            verifiedEmail:
              job.channel === "email" ? String(row.verified_email) : null,
          },
          world: {
            id: job.worldId,
            name: String(row.world_name),
            startsAt: numberValue(row.world_starts_at),
          },
        };
      });
    });
  }

  /**
   * Acknowledges a claimed delivery. In-app acknowledgements atomically create
   * their browser-safe feed record. Repeating the same acknowledgement is safe.
   */
  acknowledgeNotificationJob(
    claimToken: string,
    atValue: number = this.validNow(),
  ): PersistentWorldNotificationJob {
    const at = PersistentWorldTimestampSchema.parse(atValue);
    return this.transaction(() => {
      const row = this.notificationRowForClaim(claimToken);
      if (String(row.state) === "delivered") {
        return this.notificationJobFromRow(row);
      }
      this.requireLiveNotificationLease(row, at);
      if (String(row.channel) === "in_app") {
        this.db
          .prepare(
            `INSERT INTO persistent_world_in_app_notifications(
               id, identity_id, world_id, kind, lead_time_ms, delivered_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .run(
            String(row.id),
            String(row.identity_id),
            String(row.world_id),
            String(row.kind),
            String(row.kind) === "start" ? null : numberValue(row.lead_time_ms),
            at,
          );
      }
      this.db
        .prepare(
          `UPDATE persistent_world_notification_jobs
           SET state = 'delivered', delivered_at = ?, lease_expires_at = NULL,
               last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(at, at, String(row.id));
      return this.notificationJobFromRow(
        this.db
          .prepare(
            "SELECT * FROM persistent_world_notification_jobs WHERE id = ?",
          )
          .get(String(row.id)) as SqlRow,
      );
    });
  }

  /**
   * Releases a live lease for retry. The retained claim hash makes a repeated
   * fail call idempotent until another worker reclaims the job.
   */
  failNotificationJob(
    claimToken: string,
    errorValue: unknown,
    retryAfterMs: number = 30_000,
    atValue: number = this.validNow(),
  ): PersistentWorldNotificationJob {
    const at = PersistentWorldTimestampSchema.parse(atValue);
    const retryDelay = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(0, Math.trunc(retryAfterMs)),
    );
    const availableAt = PersistentWorldTimestampSchema.parse(at + retryDelay);
    const message = String(
      errorValue instanceof Error ? errorValue.message : errorValue,
    ).slice(0, 1_000);
    return this.transaction(() => {
      const row = this.notificationRowForClaim(claimToken);
      if (String(row.state) === "pending") {
        return this.notificationJobFromRow(row);
      }
      this.requireLiveNotificationLease(row, at);
      this.db
        .prepare(
          `UPDATE persistent_world_notification_jobs
           SET state = 'pending', available_at = ?, lease_expires_at = NULL,
               last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(availableAt, message, at, String(row.id));
      return this.notificationJobFromRow(
        this.db
          .prepare(
            "SELECT * FROM persistent_world_notification_jobs WHERE id = ?",
          )
          .get(String(row.id)) as SqlRow,
      );
    });
  }

  listInAppNotifications(
    identityId: string,
    limitValue: number = DEFAULT_NOTIFICATION_LIMIT,
  ): PersistentWorldInAppNotification[] {
    const limit = Math.min(
      MAX_NOTIFICATION_LIMIT,
      Math.max(1, Math.trunc(limitValue)),
    );
    const rows = this.db
      .prepare(
        `SELECT notification.*, world.name AS world_name,
                world.starts_at AS world_starts_at
         FROM persistent_world_in_app_notifications notification
         JOIN persistent_worlds world ON world.id = notification.world_id
         WHERE notification.identity_id = ?
         ORDER BY notification.delivered_at DESC, notification.id DESC
         LIMIT ?`,
      )
      .all(identityId, limit) as SqlRow[];
    return rows.map((row) => this.inAppNotificationFromRow(row));
  }

  markInAppNotificationRead(
    identityId: string,
    notificationId: string,
    atValue: number = this.validNow(),
  ): PersistentWorldInAppNotification {
    const at = PersistentWorldTimestampSchema.parse(atValue);
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE persistent_world_in_app_notifications
           SET read_at = COALESCE(read_at, ?)
           WHERE id = ? AND identity_id = ?`,
        )
        .run(at, notificationId, identityId);
      if (numberValue(result.changes) === 0) {
        throw new PersistentWorldRepositoryError(
          "NOT_FOUND",
          "In-app notification does not exist",
        );
      }
      const row = this.db
        .prepare(
          `SELECT notification.*, world.name AS world_name,
                  world.starts_at AS world_starts_at
           FROM persistent_world_in_app_notifications notification
           JOIN persistent_worlds world ON world.id = notification.world_id
           WHERE notification.id = ? AND notification.identity_id = ?`,
        )
        .get(notificationId, identityId) as SqlRow | undefined;
      if (!row) {
        throw new PersistentWorldRepositoryError(
          "NOT_FOUND",
          "In-app notification does not exist",
        );
      }
      return this.inAppNotificationFromRow(row);
    });
  }

  private inAppNotificationFromRow(
    row: SqlRow,
  ): PersistentWorldInAppNotification {
    return PersistentWorldInAppNotificationSchema.parse({
      id: String(row.id),
      world: {
        id: String(row.world_id),
        name: String(row.world_name),
        startsAt: numberValue(row.world_starts_at),
      },
      kind: String(row.kind),
      leadTimeMs:
        row.lead_time_ms === null || row.lead_time_ms === undefined
          ? null
          : numberValue(row.lead_time_ms),
      deliveredAt: numberValue(row.delivered_at),
      readAt: nullableNumber(row.read_at),
    });
  }

  private notificationRowForClaim(claimToken: string): SqlRow {
    if (typeof claimToken !== "string" || claimToken.length < 32) {
      throw new PersistentWorldRepositoryError(
        "LEASE_INVALID",
        "Notification delivery lease is invalid",
      );
    }
    const row = this.db
      .prepare(
        `SELECT * FROM persistent_world_notification_jobs
         WHERE claim_token_hash = ?`,
      )
      .get(hashSecret("notification-claim", claimToken)) as SqlRow | undefined;
    if (!row) {
      throw new PersistentWorldRepositoryError(
        "LEASE_INVALID",
        "Notification delivery lease is invalid",
      );
    }
    return row;
  }

  private requireLiveNotificationLease(row: SqlRow, at: number): void {
    if (
      String(row.state) !== "claimed" ||
      row.lease_expires_at === null ||
      row.lease_expires_at === undefined ||
      numberValue(row.lease_expires_at) <= at
    ) {
      throw new PersistentWorldRepositoryError(
        "LEASE_INVALID",
        "Notification delivery lease expired or was replaced",
      );
    }
  }

  postQuickChat(
    inputValue: PostPersistentWorldQuickChatInput,
  ): PersistentWorldQuickChat {
    const input = PostPersistentWorldQuickChatInputSchema.parse(inputValue);
    return this.transaction(() => {
      const existing = this.quickChatById(input.id);
      if (existing) {
        if (
          existing.worldId !== input.worldId ||
          existing.sender.id !== input.sender.id ||
          existing.phraseKey !== input.phraseKey
        ) {
          throw new PersistentWorldRepositoryError(
            "CONFLICT",
            `Quick-chat id ${input.id} already has another payload`,
          );
        }
        return existing;
      }
      const world = this.requireWorldRow(input.worldId);
      if (["finished", "cancelled"].includes(String(world.phase))) {
        throw new PersistentWorldRepositoryError(
          "INVALID_PHASE",
          "Quick chat is closed for this world",
        );
      }
      if (!this.getRsvp(input.worldId, input.sender.id)) {
        throw new PersistentWorldRepositoryError(
          "FORBIDDEN",
          "Only RSVPed players can use lobby quick chat",
        );
      }
      const sentAt = this.validNow();
      this.db
        .prepare(
          `INSERT INTO persistent_world_quick_chat(
            id, world_id, sender_identity_id, phrase_key, sent_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.worldId, input.sender.id, input.phraseKey, sentAt);
      return this.quickChatById(input.id)!;
    });
  }

  private quickChatById(
    messageId: string,
  ): PersistentWorldQuickChat | undefined {
    const row = this.db
      .prepare(
        `SELECT
           c.id, c.world_id, c.phrase_key, c.sent_at,
           i.id AS identity_id, i.kind AS identity_kind,
           i.subject AS identity_subject,
           i.display_name AS identity_display_name,
           i.verified_email AS identity_verified_email
         FROM persistent_world_quick_chat c
         JOIN persistent_world_identities i ON i.id = c.sender_identity_id
         WHERE c.id = ?`,
      )
      .get(messageId) as SqlRow | undefined;
    if (!row) return undefined;
    return PersistentWorldQuickChatSchema.parse({
      id: String(row.id),
      worldId: String(row.world_id),
      sender: this.identityFromRow(row),
      phraseKey: String(row.phrase_key),
      sentAt: numberValue(row.sent_at),
    });
  }

  listQuickChat(
    worldId: string,
    limitValue: number = DEFAULT_CHAT_LIMIT,
  ): PersistentWorldQuickChat[] {
    this.requireWorldRow(worldId);
    const limit = Math.min(MAX_CHAT_LIMIT, Math.max(1, Math.trunc(limitValue)));
    const rows = this.db
      .prepare(
        `SELECT
           c.id, c.world_id, c.phrase_key, c.sent_at,
           i.id AS identity_id, i.kind AS identity_kind,
           i.subject AS identity_subject,
           i.display_name AS identity_display_name,
           i.verified_email AS identity_verified_email
         FROM persistent_world_quick_chat c
         JOIN persistent_world_identities i ON i.id = c.sender_identity_id
         WHERE c.world_id = ?
         ORDER BY c.sent_at DESC, c.id DESC
         LIMIT ?`,
      )
      .all(worldId, limit) as SqlRow[];
    return rows.reverse().map((row) =>
      PersistentWorldQuickChatSchema.parse({
        id: String(row.id),
        worldId: String(row.world_id),
        sender: this.identityFromRow(row),
        phraseKey: String(row.phrase_key),
        sentAt: numberValue(row.sent_at),
      }),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
