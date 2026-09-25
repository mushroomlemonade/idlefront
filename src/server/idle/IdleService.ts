import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { mkdirSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "path";

const WORLD_ID = "idle-demo-1";
const SCHEMA_VERSION = 6;
const PRESSURE_DECAY_MS = 6 * 60 * 60 * 1000;
const PRESSURE_CAP = 100;
const OFFLINE_ACCRUAL_CAP_MS = 24 * 60 * 60 * 1000;
const SUPPLY_DIVISOR = 3_600_000;
const RISK_DECAY_INTERVAL_MS = 60_000;
const RISK_DECAY_POINTS_PER_INTERVAL = 2;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_MAINTENANCE_POLL_MS = 60_000;
const RETENTION_CHECKPOINT_RETRY_MS = 60_000;

const TERRITORY_SEEDS = [
  ["t01", "Amber Coast", "#f6c453", 0.13, 0.18, ["t02", "t05"]],
  ["t02", "Mossland", "#66c58f", 0.38, 0.14, ["t01", "t03", "t05", "t06"]],
  ["t03", "Cloud Steppe", "#76b7ed", 0.63, 0.18, ["t02", "t04", "t06", "t07"]],
  ["t04", "Rose Reach", "#e884a8", 0.87, 0.16, ["t03", "t07", "t08"]],
  ["t05", "Copper Vale", "#dd8759", 0.12, 0.5, ["t01", "t02", "t06", "t09"]],
  [
    "t06",
    "Quiet Basin",
    "#9187e8",
    0.37,
    0.48,
    ["t02", "t03", "t05", "t07", "t09", "t10"],
  ],
  [
    "t07",
    "Sunken Prairie",
    "#e7ca68",
    0.63,
    0.49,
    ["t03", "t04", "t06", "t08", "t10", "t11"],
  ],
  ["t08", "Juniper Rim", "#55bcb3", 0.88, 0.5, ["t04", "t07", "t11", "t12"]],
  ["t09", "Ember Shoals", "#ef765f", 0.13, 0.82, ["t05", "t06", "t10"]],
  ["t10", "Moonfield", "#7588df", 0.38, 0.84, ["t06", "t07", "t09", "t11"]],
  ["t11", "Silver Fen", "#8eb86c", 0.64, 0.81, ["t07", "t08", "t10", "t12"]],
  ["t12", "Cinder Crown", "#d27bc5", 0.88, 0.83, ["t08", "t11"]],
] as const;

const BOT_NAMES = [
  "Mosskeeper",
  "Copper Finch",
  "Quiet Comet",
  "Prairie Fox",
  "Juniper",
  "Emberling",
  "Moon Moth",
  "Silver Reed",
] as const;

type SqlRow = Record<string, unknown>;

export class IdleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface IdleServiceOptions {
  dbPath?: string;
  now?: () => number;
  randomToken?: (bytes: number) => string;
  rawTapRetentionDays?: number;
  telemetryHmacSecret?: string;
  /** Test seam; production retains the one-minute maintenance poll. */
  retentionMaintenancePollMs?: number;
  /** Test seam for WAL checkpoint contention. */
  retentionWalCheckpoint?: () => boolean;
}

export interface TapInput {
  v: 1;
  playerId: string;
  sessionId: string;
  clientSeq: number;
  targetTerritoryId: string;
  clientMonoMs: number;
  pointerType: "mouse" | "touch" | "pen" | "keyboard" | "unknown";
  visibility: "visible" | "hidden";
  xNormQ: number;
  yNormQ: number;
}

export interface TapContext {
  ip?: string;
  userAgent?: string;
}

export interface IdleState {
  world: {
    id: string;
    name: string;
    createdAt: number;
    seasonEndsAt: number;
    supplyCapHours: number;
    schemaVersion: number;
    revision: number;
  };
  player: {
    id: string;
    name: string;
    territoryId: string;
    supply: number;
    influence: number;
    supplyPerHour: number;
    canCommand: boolean;
  };
  territories: Array<{
    id: string;
    name: string;
    ownerId: string | null;
    ownerName: string | null;
    isBot: boolean;
    accent: string;
    x: number;
    y: number;
    neighbors: string[];
  }>;
  pressure: Array<{
    targetTerritoryId: string;
    total: number;
    lastMinute: number;
    uniqueAttackers: number;
    lastTapAt: number | null;
  }>;
  recentActivity: Array<{
    id: string;
    type: "pressure_summary";
    actorId: string;
    actorName: string;
    targetTerritoryId: string;
    at: number;
    count: number;
    isAgainstYou: boolean;
    detail: string;
  }>;
  serverTime: number;
}

function asRow(value: unknown): SqlRow | undefined {
  return value as SqlRow | undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function recoveryHash(code: string): Buffer {
  return createHash("sha256").update(code, "utf8").digest();
}

function riskTier(score: number): "clear" | "watched" | "restricted" {
  if (score >= 75) return "restricted";
  if (score >= 25) return "watched";
  return "clear";
}

function userAgentFamily(userAgent: string | undefined): string {
  const value = userAgent?.toLowerCase() ?? "";
  if (!value) return "unknown";
  if (/bot|crawler|spider|headless/.test(value)) return "automation";
  if (value.includes("fxios")) return "firefox_ios";
  if (value.includes("crios")) return "chrome_ios";
  if (value.includes("edgios")) return "edge_ios";
  if (/iphone|ipad|ipod/.test(value) && value.includes("safari")) {
    return "safari_ios";
  }
  if (value.includes("edg/")) return "edge";
  if (value.includes("firefox/")) return "firefox";
  if (value.includes("chrome/") || value.includes("chromium/")) return "chrome";
  if (value.includes("safari/")) return "safari";
  return "other";
}

export class IdleService {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly randomToken: (bytes: number) => string;
  private readonly rawTapRetentionMs: number;
  private readonly retentionMaintenancePollMs: number;
  private readonly retentionWalCheckpoint: () => boolean;
  private closed = false;
  private telemetrySalt = "";
  private lastRetentionSweepAt = 0;
  private nextRetentionSweepAttemptAt = 0;
  private retentionMaintenanceDegraded = false;
  private retentionMaintenanceTimer: NodeJS.Timeout | undefined;

  constructor(options: IdleServiceOptions = {}) {
    this.dbPath =
      options.dbPath ?? resolve(process.cwd(), ".data", "idle-demo.sqlite");
    this.now = options.now ?? Date.now;
    this.randomToken =
      options.randomToken ??
      ((bytes) => randomBytes(bytes).toString("base64url"));
    this.retentionMaintenancePollMs =
      options.retentionMaintenancePollMs ?? RETENTION_MAINTENANCE_POLL_MS;
    if (
      !Number.isFinite(this.retentionMaintenancePollMs) ||
      this.retentionMaintenancePollMs < 1
    ) {
      throw new Error("retentionMaintenancePollMs must be a positive number");
    }
    this.retentionWalCheckpoint =
      options.retentionWalCheckpoint ??
      (() => this.checkpointWalForRetention());
    const rawTapRetentionDays =
      options.rawTapRetentionDays ??
      Number(process.env.IDLE_RAW_TAP_RETENTION_DAYS ?? 14);
    if (
      !Number.isFinite(rawTapRetentionDays) ||
      rawTapRetentionDays < 1 ||
      rawTapRetentionDays > 14
    ) {
      throw new Error("IDLE_RAW_TAP_RETENTION_DAYS must be between 1 and 14");
    }
    this.rawTapRetentionMs = rawTapRetentionDays * 24 * 60 * 60 * 1000;
    const externalTelemetrySecret =
      options.telemetryHmacSecret ??
      process.env.IDLE_TELEMETRY_HMAC_SECRET ??
      "";
    if (
      process.env.GAME_ENV === "prod" &&
      (externalTelemetrySecret.length < 32 ||
        /^replace(?:_|-)/i.test(externalTelemetrySecret))
    ) {
      throw new Error(
        "IDLE_TELEMETRY_HMAC_SECRET must be a non-placeholder secret of at least 32 characters in production",
      );
    }
    if (this.dbPath !== ":memory:")
      mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.configureDatabase();
    this.migrate();
    this.seedWorld();
    this.telemetrySalt =
      externalTelemetrySecret || this.getOrCreateTelemetrySalt();
    this.maybeSweepRetention(this.now(), true);
    this.ensurePrivacyCompaction();
    this.scheduleRetentionMaintenance();
  }

  private configureDatabase(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA secure_delete = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    // A successful tap response promises that its observation and outcome
    // survive process and host crashes, so WAL commits must be fsynced.
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  private migrate(): void {
    const versionRow = asRow(this.db.prepare("PRAGMA user_version").get());
    const version = numberValue(versionRow?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `Idle database schema ${version} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    this.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS idle_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idle_worlds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        season_ends_at INTEGER NOT NULL,
        supply_cap_hours INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idle_players (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES idle_worlds(id),
        name TEXT NOT NULL,
        is_bot INTEGER NOT NULL CHECK (is_bot IN (0, 1)),
        recovery_hash BLOB,
        territory_id TEXT UNIQUE,
        supply_milli INTEGER NOT NULL,
        supply_rate_milli_per_hour INTEGER NOT NULL,
        supply_remainder INTEGER NOT NULL DEFAULT 0,
        supply_updated_at INTEGER NOT NULL,
        influence INTEGER NOT NULL DEFAULT 0,
        risk_score INTEGER NOT NULL DEFAULT 0,
        risk_updated_at INTEGER NOT NULL DEFAULT 0,
        quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idle_territories (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES idle_worlds(id),
        name TEXT NOT NULL,
        owner_player_id TEXT REFERENCES idle_players(id),
        sort_index INTEGER NOT NULL,
        accent TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        neighbors_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idle_sessions (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES idle_players(id),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        can_command INTEGER NOT NULL DEFAULT 1 CHECK (can_command IN (0, 1)),
        last_client_seq INTEGER NOT NULL DEFAULT -1
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idle_taps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        protocol_version INTEGER NOT NULL DEFAULT 1,
        player_id TEXT NOT NULL REFERENCES idle_players(id),
        session_id TEXT NOT NULL REFERENCES idle_sessions(id),
        client_seq INTEGER NOT NULL,
        target_territory_id TEXT NOT NULL,
        client_mono_ms REAL NOT NULL,
        pointer_type TEXT NOT NULL,
        visibility TEXT NOT NULL,
        x_norm_q INTEGER NOT NULL,
        y_norm_q INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        ip_hash TEXT NOT NULL,
        user_agent_family TEXT NOT NULL,
        accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
        outcome_reason TEXT NOT NULL,
        rewarded INTEGER NOT NULL CHECK (rewarded IN (0, 1)),
        influence_awarded INTEGER NOT NULL,
        pressure_added REAL NOT NULL,
        risk_delta INTEGER NOT NULL,
        risk_signals TEXT NOT NULL,
        UNIQUE(session_id, client_seq)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idle_taps_received_idx ON idle_taps(received_at);
      CREATE INDEX IF NOT EXISTS idle_taps_player_received_idx ON idle_taps(player_id, received_at);
      CREATE INDEX IF NOT EXISTS idle_taps_target_received_idx ON idle_taps(target_territory_id, received_at);
      CREATE TABLE IF NOT EXISTS idle_tap_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        player_id TEXT NOT NULL REFERENCES idle_players(id),
        session_id TEXT NOT NULL REFERENCES idle_sessions(id),
        client_seq INTEGER NOT NULL,
        target_territory_id TEXT NOT NULL,
        protocol_version INTEGER NOT NULL DEFAULT 1,
        client_mono_ms REAL,
        pointer_type TEXT,
        visibility TEXT,
        x_norm_q INTEGER,
        y_norm_q INTEGER,
        received_at INTEGER NOT NULL,
        ip_hash TEXT NOT NULL,
        user_agent_family TEXT NOT NULL,
        is_duplicate INTEGER NOT NULL CHECK (is_duplicate IN (0, 1)),
        outcome_reason TEXT NOT NULL DEFAULT 'observed',
        logical_tap_id INTEGER REFERENCES idle_taps(id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idle_tap_observations_received_idx
        ON idle_tap_observations(received_at);
      CREATE INDEX IF NOT EXISTS idle_tap_observations_player_received_idx
        ON idle_tap_observations(player_id, received_at);
      CREATE INDEX IF NOT EXISTS idle_tap_observations_logical_tap_idx
        ON idle_tap_observations(logical_tap_id);
    `);
      const sessionColumns = this.db
        .prepare("PRAGMA table_info(idle_sessions)")
        .all() as SqlRow[];
      if (!sessionColumns.some((column) => column.name === "can_command")) {
        this.db.exec(
          "ALTER TABLE idle_sessions ADD COLUMN can_command INTEGER NOT NULL DEFAULT 1 CHECK (can_command IN (0, 1))",
        );
      }
      if (!sessionColumns.some((column) => column.name === "last_client_seq")) {
        this.db.exec(
          "ALTER TABLE idle_sessions ADD COLUMN last_client_seq INTEGER NOT NULL DEFAULT -1",
        );
      }
      const playerColumns = this.db
        .prepare("PRAGMA table_info(idle_players)")
        .all() as SqlRow[];
      if (!playerColumns.some((column) => column.name === "risk_updated_at")) {
        this.db.exec(
          "ALTER TABLE idle_players ADD COLUMN risk_updated_at INTEGER NOT NULL DEFAULT 0",
        );
      }
      const worldColumns = this.db
        .prepare("PRAGMA table_info(idle_worlds)")
        .all() as SqlRow[];
      if (!worldColumns.some((column) => column.name === "revision")) {
        this.db.exec(
          "ALTER TABLE idle_worlds ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
        );
      }
      const tapColumns = this.db
        .prepare("PRAGMA table_info(idle_taps)")
        .all() as SqlRow[];
      if (
        tapColumns.some((column) => column.name === "user_agent") &&
        !tapColumns.some((column) => column.name === "user_agent_family")
      ) {
        this.db.exec(
          "ALTER TABLE idle_taps RENAME COLUMN user_agent TO user_agent_family",
        );
      }
      if (!tapColumns.some((column) => column.name === "protocol_version")) {
        this.db.exec(
          "ALTER TABLE idle_taps ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1",
        );
      }
      const observationColumns = this.db
        .prepare("PRAGMA table_info(idle_tap_observations)")
        .all() as SqlRow[];
      const observationAdditions = [
        ["protocol_version", "INTEGER NOT NULL DEFAULT 1"],
        ["client_mono_ms", "REAL"],
        ["pointer_type", "TEXT"],
        ["visibility", "TEXT"],
        ["x_norm_q", "INTEGER"],
        ["y_norm_q", "INTEGER"],
        ["outcome_reason", "TEXT NOT NULL DEFAULT 'observed'"],
      ] as const;
      for (const [name, definition] of observationAdditions) {
        if (!observationColumns.some((column) => column.name === name)) {
          this.db.exec(
            `ALTER TABLE idle_tap_observations ADD COLUMN ${name} ${definition}`,
          );
        }
      }
      if (version < 2) {
        this.db.exec(
          "UPDATE idle_taps SET user_agent_family = 'legacy_redacted' WHERE user_agent_family <> ''",
        );
      }
      if (version < 6) {
        const hasLegacyDedup = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'idle_tap_dedup'",
            )
            .get(),
        );
        this.db.exec(`
          UPDATE idle_sessions
          SET last_client_seq = MAX(
            last_client_seq,
            COALESCE((
              SELECT MAX(t.client_seq) FROM idle_taps t
              WHERE t.session_id = idle_sessions.id
            ), -1)
          )
        `);
        if (hasLegacyDedup) {
          this.db.exec(`
            UPDATE idle_sessions
            SET last_client_seq = MAX(
              last_client_seq,
              COALESCE((
                SELECT MAX(d.client_seq) FROM idle_tap_dedup d
                WHERE d.session_id = idle_sessions.id
              ), -1)
            );
            DROP TABLE idle_tap_dedup;
          `);
        }
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private seedWorld(): void {
    if (this.db.prepare("SELECT 1 FROM idle_worlds WHERE id = ?").get(WORLD_ID))
      return;
    const now = this.now();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO idle_worlds(id, name, created_at, season_ends_at, supply_cap_hours) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          WORLD_ID,
          "The Quiet Reach",
          now,
          now + 7 * 24 * 60 * 60 * 1000,
          24,
        );

      const addTerritory = this.db.prepare(
        "INSERT INTO idle_territories(id, world_id, name, sort_index, accent, x, y, neighbors_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      TERRITORY_SEEDS.forEach(([id, name, accent, x, y, neighbors], index) => {
        addTerritory.run(
          id,
          WORLD_ID,
          name,
          index,
          accent,
          x,
          y,
          JSON.stringify(neighbors),
        );
      });

      const addBot = this.db.prepare(
        `INSERT INTO idle_players(
          id, world_id, name, is_bot, recovery_hash, territory_id, supply_milli,
          supply_rate_milli_per_hour, supply_updated_at, influence, created_at, last_seen_at
        ) VALUES (?, ?, ?, 1, NULL, ?, 40000, 12000, ?, ?, ?, ?)`,
      );
      const setOwner = this.db.prepare(
        "UPDATE idle_territories SET owner_player_id = ? WHERE id = ?",
      );
      BOT_NAMES.forEach((name, index) => {
        const id = `bot-${String(index + 1).padStart(2, "0")}`;
        const territoryId = `t${String(index + 5).padStart(2, "0")}`;
        addBot.run(id, WORLD_ID, name, territoryId, now, index * 7, now, now);
        setOwner.run(id, territoryId);
      });
    });
  }

  private getOrCreateTelemetrySalt(): string {
    const row = asRow(
      this.db
        .prepare("SELECT value FROM idle_meta WHERE key = 'telemetry_salt'")
        .get(),
    );
    if (typeof row?.value === "string") return row.value;
    const salt = this.randomToken(32);
    this.db
      .prepare("INSERT INTO idle_meta(key, value) VALUES ('telemetry_salt', ?)")
      .run(salt);
    return salt;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private maybeSweepRetention(now: number, force = false): void {
    if (!force && now < this.nextRetentionSweepAttemptAt) return;
    if (
      !force &&
      now - this.lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS
    ) {
      this.nextRetentionSweepAttemptAt =
        this.lastRetentionSweepAt + RETENTION_SWEEP_INTERVAL_MS;
      return;
    }
    try {
      this.runRetentionSweep(now);
    } catch {
      // Retention is an isolated maintenance concern. Surface bounded degraded
      // health and retry without turning an otherwise healthy player request
      // into a 500 response.
      this.deferRetentionMaintenance(now);
    }
  }

  private runRetentionSweep(now: number): void {
    const cutoff = now - this.rawTapRetentionMs;
    this.transaction(() => {
      // A recent duplicate receipt can reference an older logical command.
      // Unlink it before deleting the raw command; the session sequence
      // watermark still prevents an expired command from earning twice.
      this.db
        .prepare(
          `UPDATE idle_tap_observations SET logical_tap_id = NULL
           WHERE logical_tap_id IN (
             SELECT id FROM idle_taps WHERE received_at < ?
           )`,
        )
        .run(cutoff);
      this.db
        .prepare("DELETE FROM idle_tap_observations WHERE received_at < ?")
        .run(cutoff);
      this.db
        .prepare("DELETE FROM idle_taps WHERE received_at < ?")
        .run(cutoff);
    });
    // Secure deletion overwrites freed cells; truncating the WAL removes older
    // frames that could otherwise outlive the logical retention window.
    if (!this.retentionWalCheckpoint()) {
      this.deferRetentionMaintenance(now);
      return;
    }
    this.retentionMaintenanceDegraded = false;
    this.lastRetentionSweepAt = now;
    this.nextRetentionSweepAttemptAt = now + RETENTION_SWEEP_INTERVAL_MS;
  }

  private deferRetentionMaintenance(now: number): void {
    this.retentionMaintenanceDegraded = true;
    this.nextRetentionSweepAttemptAt = now + RETENTION_CHECKPOINT_RETRY_MS;
  }

  private checkpointWalForRetention(): boolean {
    const result = asRow(
      this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(),
    );
    return numberValue(result?.busy ?? 1) === 0;
  }

  private scheduleRetentionMaintenance(): void {
    if (this.closed || this.retentionMaintenanceTimer) return;
    this.retentionMaintenanceTimer = setTimeout(() => {
      this.retentionMaintenanceTimer = undefined;
      if (this.closed) return;
      let attemptedAt: number | undefined;
      try {
        attemptedAt = this.now();
        this.maybeSweepRetention(attemptedAt);
      } catch {
        // Retention failure is surfaced as bounded health state and retried;
        // an internal maintenance exception must not become an uncaught error
        // that takes the authoritative API down.
        this.deferRetentionMaintenance(attemptedAt ?? Date.now());
      } finally {
        this.scheduleRetentionMaintenance();
      }
    }, this.retentionMaintenancePollMs);
    this.retentionMaintenanceTimer.unref();
  }

  private ensurePrivacyCompaction(): void {
    const compacted = this.db
      .prepare("SELECT 1 FROM idle_meta WHERE key = 'privacy_compaction_v1'")
      .get();
    if (compacted) return;

    // Existing pre-secure_delete databases can retain deleted payload bytes in
    // freelist pages. Rebuild once, then record completion in durable metadata.
    this.db.exec("VACUUM");
    this.db
      .prepare(
        "INSERT INTO idle_meta(key, value) VALUES ('privacy_compaction_v1', 'complete')",
      )
      .run();
    this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  }

  private riskAfterDecay(
    score: number,
    updatedAt: number,
    now: number,
  ): { score: number; updatedAt: number } {
    if (updatedAt <= 0 || now <= updatedAt) {
      return { score, updatedAt: updatedAt <= 0 ? now : updatedAt };
    }
    const intervals = Math.floor((now - updatedAt) / RISK_DECAY_INTERVAL_MS);
    if (intervals <= 0) return { score, updatedAt };
    return {
      score: Math.max(0, score - intervals * RISK_DECAY_POINTS_PER_INTERVAL),
      updatedAt: updatedAt + intervals * RISK_DECAY_INTERVAL_MS,
    };
  }

  private decayPlayerRisk(playerId: string, now: number): void {
    const row = asRow(
      this.db
        .prepare(
          "SELECT risk_score, risk_updated_at, quarantined FROM idle_players WHERE id = ?",
        )
        .get(playerId),
    );
    if (!row) return;
    const decayed = this.riskAfterDecay(
      numberValue(row.risk_score),
      numberValue(row.risk_updated_at),
      now,
    );
    const quarantined = decayed.score >= 100;
    if (
      decayed.score !== numberValue(row.risk_score) ||
      decayed.updatedAt !== numberValue(row.risk_updated_at) ||
      quarantined !== (numberValue(row.quarantined) === 1)
    ) {
      this.db
        .prepare(
          "UPDATE idle_players SET risk_score = ?, risk_updated_at = ?, quarantined = ? WHERE id = ?",
        )
        .run(decayed.score, decayed.updatedAt, quarantined ? 1 : 0, playerId);
    }
  }

  private decayAllPlayerRisk(now: number): void {
    const rows = this.db
      .prepare(
        "SELECT id, risk_score, risk_updated_at, quarantined FROM idle_players WHERE is_bot = 0",
      )
      .all() as SqlRow[];
    for (const row of rows) this.decayPlayerRisk(String(row.id), now);
  }

  private ensureActiveSeason(now: number): void {
    const row = asRow(
      this.db
        .prepare("SELECT season_ends_at FROM idle_worlds WHERE id = ?")
        .get(WORLD_ID),
    );
    if (!row) return;
    const priorEnd = numberValue(row.season_ends_at);
    if (priorEnd > now) return;
    const seasonLength = 7 * 24 * 60 * 60 * 1000;
    const elapsedSeasons = Math.floor((now - priorEnd) / seasonLength) + 1;
    const nextEnd = priorEnd + elapsedSeasons * seasonLength;
    this.db
      .prepare(
        `UPDATE idle_worlds
         SET created_at = ?, season_ends_at = ?, revision = revision + 1
         WHERE id = ?`,
      )
      .run(nextEnd - seasonLength, nextEnd, WORLD_ID);
  }

  createSession(
    playerId?: string,
    recoveryCode?: string,
  ): {
    playerId: string;
    sessionId: string;
    recoveryCode: string;
    resumed: boolean;
    world: IdleState["world"];
    state: IdleState;
    serverTime: number;
  } {
    const now = this.now();
    this.ensureActiveSeason(now);
    if ((playerId && !recoveryCode) || (!playerId && recoveryCode)) {
      throw new IdleApiError(
        400,
        "RECOVERY_PAIR_REQUIRED",
        "playerId and recoveryCode must be provided together",
      );
    }

    let activePlayerId: string;
    let activeRecoveryCode: string;
    let resumed = false;
    if (playerId && recoveryCode) {
      const row = asRow(
        this.db
          .prepare(
            "SELECT recovery_hash FROM idle_players WHERE id = ? AND is_bot = 0",
          )
          .get(playerId),
      );
      const stored = row?.recovery_hash;
      const storedBuffer = ArrayBuffer.isView(stored)
        ? Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength)
        : undefined;
      const supplied = recoveryHash(recoveryCode);
      if (
        !storedBuffer ||
        storedBuffer.length !== supplied.length ||
        !timingSafeEqual(storedBuffer, supplied)
      ) {
        throw new IdleApiError(
          401,
          "INVALID_RECOVERY",
          "Recovery credentials are invalid",
        );
      }
      activePlayerId = playerId;
      activeRecoveryCode = recoveryCode;
      resumed = true;
    } else {
      let territory = asRow(
        this.db
          .prepare(
            `SELECT id, NULL AS displaced_bot_id FROM idle_territories
             WHERE world_id = ? AND owner_player_id IS NULL
             ORDER BY sort_index LIMIT 1`,
          )
          .get(WORLD_ID),
      );
      // Seeded bots make a new world playable immediately, but they are
      // placeholders rather than permanent capacity reservations. Humans
      // replace them in map order until all twelve territories are occupied.
      territory ??= asRow(
        this.db
          .prepare(
            `SELECT t.id, p.id AS displaced_bot_id
             FROM idle_territories t
             JOIN idle_players p ON p.id = t.owner_player_id
             WHERE t.world_id = ? AND p.is_bot = 1
             ORDER BY t.sort_index LIMIT 1`,
          )
          .get(WORLD_ID),
      );
      if (!territory) {
        throw new IdleApiError(
          503,
          "WORLD_FULL",
          "The demo world has no free guest territory",
        );
      }
      activePlayerId = `ply_${this.randomToken(12)}`;
      activeRecoveryCode = `rec_${this.randomToken(32)}`;
      const suffix = activePlayerId.slice(-4).toUpperCase();
      this.transaction(() => {
        if (typeof territory.displaced_bot_id === "string") {
          this.db
            .prepare(
              "UPDATE idle_players SET territory_id = NULL WHERE id = ? AND is_bot = 1",
            )
            .run(territory.displaced_bot_id);
        }
        this.db
          .prepare(
            `INSERT INTO idle_players(
              id, world_id, name, is_bot, recovery_hash, territory_id, supply_milli,
              supply_rate_milli_per_hour, supply_updated_at, influence, created_at, last_seen_at
            ) VALUES (?, ?, ?, 0, ?, ?, 40000, 12000, ?, 0, ?, ?)`,
          )
          .run(
            activePlayerId,
            WORLD_ID,
            `Wanderer ${suffix}`,
            recoveryHash(activeRecoveryCode),
            String(territory.id),
            now,
            now,
            now,
          );
        this.db
          .prepare(
            "UPDATE idle_territories SET owner_player_id = ? WHERE id = ?",
          )
          .run(activePlayerId, territory.id as string);
        this.db
          .prepare(
            "UPDATE idle_worlds SET revision = revision + 1 WHERE id = ?",
          )
          .run(WORLD_ID);
      });
    }

    const sessionId = `ses_${this.randomToken(24)}`;
    this.transaction(() => {
      if (resumed) {
        this.db
          .prepare(
            "UPDATE idle_sessions SET can_command = 0 WHERE player_id = ?",
          )
          .run(activePlayerId);
      }
      this.db
        .prepare(
          `INSERT INTO idle_sessions(
            id, player_id, created_at, last_seen_at, can_command
          ) VALUES (?, ?, ?, ?, 1)`,
        )
        .run(sessionId, activePlayerId, now, now);
    });
    const state = this.getState(activePlayerId, sessionId);
    return {
      playerId: activePlayerId,
      sessionId,
      recoveryCode: activeRecoveryCode,
      resumed,
      world: state.world,
      state,
      serverTime: state.serverTime,
    };
  }

  private authenticate(
    playerId: string,
    sessionId: string,
    now: number,
    requireCommand = false,
  ): boolean {
    const row = asRow(
      this.db
        .prepare(
          "SELECT can_command FROM idle_sessions WHERE id = ? AND player_id = ?",
        )
        .get(sessionId, playerId),
    );
    if (!row)
      throw new IdleApiError(401, "INVALID_SESSION", "Session is invalid");
    const canCommand = numberValue(row.can_command) === 1;
    if (requireCommand && !canCommand) {
      throw new IdleApiError(
        409,
        "SESSION_READ_ONLY",
        "A newer recovered session owns this player's command lease",
      );
    }
    this.db
      .prepare("UPDATE idle_sessions SET last_seen_at = ? WHERE id = ?")
      .run(now, sessionId);
    this.db
      .prepare("UPDATE idle_players SET last_seen_at = ? WHERE id = ?")
      .run(now, playerId);
    return canCommand;
  }

  private accrueSupply(playerId: string, now: number): void {
    const row = asRow(
      this.db
        .prepare(
          `SELECT supply_milli, supply_rate_milli_per_hour, supply_remainder, supply_updated_at
           FROM idle_players WHERE id = ?`,
        )
        .get(playerId),
    );
    if (!row)
      throw new IdleApiError(404, "PLAYER_NOT_FOUND", "Player does not exist");
    const elapsed = Math.max(
      0,
      Math.min(
        now - numberValue(row.supply_updated_at),
        OFFLINE_ACCRUAL_CAP_MS,
      ),
    );
    const numerator =
      elapsed * numberValue(row.supply_rate_milli_per_hour) +
      numberValue(row.supply_remainder);
    const gained = Math.floor(numerator / SUPPLY_DIVISOR);
    const remainder = numerator % SUPPLY_DIVISOR;
    this.db
      .prepare(
        `UPDATE idle_players
         SET supply_milli = supply_milli + ?, supply_remainder = ?, supply_updated_at = ?
         WHERE id = ?`,
      )
      .run(gained, remainder, now, playerId);
  }

  getState(playerId: string, sessionId: string): IdleState {
    const now = this.now();
    const canCommand = this.authenticate(playerId, sessionId, now);
    this.ensureActiveSeason(now);
    this.maybeSweepRetention(now);
    this.decayPlayerRisk(playerId, now);
    this.accrueSupply(playerId, now);
    return this.buildState(playerId, now, canCommand);
  }

  private buildState(
    playerId: string,
    now: number,
    canCommand: boolean,
  ): IdleState {
    const world = asRow(
      this.db.prepare("SELECT * FROM idle_worlds WHERE id = ?").get(WORLD_ID),
    );
    const player = asRow(
      this.db.prepare("SELECT * FROM idle_players WHERE id = ?").get(playerId),
    );
    if (!world || !player)
      throw new IdleApiError(404, "PLAYER_NOT_FOUND", "Player does not exist");

    const territoryRows = this.db
      .prepare(
        `SELECT t.*, p.name AS owner_name, COALESCE(p.is_bot, 0) AS owner_is_bot
         FROM idle_territories t
         LEFT JOIN idle_players p ON p.id = t.owner_player_id
         WHERE t.world_id = ? ORDER BY t.sort_index`,
      )
      .all(WORLD_ID) as SqlRow[];

    const pressure = this.pressureSnapshot(
      now,
      territoryRows.map((row) => String(row.id)),
    );
    const recentRows = this.db
      .prepare(
        `SELECT t.player_id, p.name AS actor_name, t.target_territory_id,
                COUNT(*) AS tap_count, MAX(t.received_at) AS last_at
         FROM idle_taps t
         JOIN idle_players p ON p.id = t.player_id
         WHERE t.accepted = 1 AND t.received_at >= ?
           AND (t.player_id = ? OR t.target_territory_id = ?)
         GROUP BY t.player_id, p.name, t.target_territory_id
         ORDER BY last_at DESC LIMIT 12`,
      )
      .all(
        now - 24 * 60 * 60 * 1000,
        playerId,
        String(player.territory_id),
      ) as SqlRow[];

    return {
      world: {
        id: String(world.id),
        name: String(world.name),
        createdAt: numberValue(world.created_at),
        seasonEndsAt: numberValue(world.season_ends_at),
        supplyCapHours: numberValue(world.supply_cap_hours),
        schemaVersion: SCHEMA_VERSION,
        revision: numberValue(world.revision),
      },
      player: {
        id: String(player.id),
        name: String(player.name),
        territoryId: String(player.territory_id),
        supply: Math.round(numberValue(player.supply_milli)) / 1000,
        influence: numberValue(player.influence),
        supplyPerHour: numberValue(player.supply_rate_milli_per_hour) / 1000,
        canCommand,
      },
      territories: territoryRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        ownerId:
          row.owner_player_id === null ? null : String(row.owner_player_id),
        ownerName: row.owner_name === null ? null : String(row.owner_name),
        isBot: numberValue(row.owner_is_bot) === 1,
        accent: String(row.accent),
        x: numberValue(row.x),
        y: numberValue(row.y),
        neighbors: JSON.parse(String(row.neighbors_json)) as string[],
      })),
      pressure,
      recentActivity: recentRows.map((row) => {
        const actorName = String(row.actor_name);
        const count = numberValue(row.tap_count);
        const targetTerritoryId = String(row.target_territory_id);
        const at = numberValue(row.last_at);
        return {
          id: `${String(row.player_id)}:${targetTerritoryId}:${at}`,
          type: "pressure_summary" as const,
          actorId: String(row.player_id),
          actorName,
          targetTerritoryId,
          at,
          count,
          isAgainstYou: targetTerritoryId === String(player.territory_id),
          detail: `${actorName} applied ${count} pressure ${count === 1 ? "tap" : "taps"}`,
        };
      }),
      serverTime: now,
    };
  }

  private pressureSnapshot(
    now: number,
    territoryIds: string[],
  ): IdleState["pressure"] {
    if (territoryIds.length === 0) return [];
    const placeholders = territoryIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT target_territory_id,
                SUM(pressure_added *
                    CASE WHEN received_at >= ?
                         THEN 1.0 - CAST(? - received_at AS REAL) / ?
                         ELSE 0 END) AS pressure_total,
                SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS last_minute,
                COUNT(DISTINCT player_id) AS unique_attackers,
                MAX(received_at) AS last_tap_at
         FROM idle_taps
         WHERE accepted = 1 AND pressure_added > 0 AND received_at >= ?
           AND target_territory_id IN (${placeholders})
         GROUP BY target_territory_id`,
      )
      .all(
        now - PRESSURE_DECAY_MS,
        now,
        PRESSURE_DECAY_MS,
        now - 60_000,
        now - PRESSURE_DECAY_MS,
        ...territoryIds,
      ) as SqlRow[];
    const values = new Map(
      rows.map((row) => [String(row.target_territory_id), row]),
    );
    return territoryIds.map((targetTerritoryId) => {
      const current = values.get(targetTerritoryId);
      return {
        targetTerritoryId,
        total: current
          ? Math.round(
              Math.min(PRESSURE_CAP, numberValue(current.pressure_total)) * 100,
            ) / 100
          : 0,
        lastMinute: current ? numberValue(current.last_minute) : 0,
        uniqueAttackers: current ? numberValue(current.unique_attackers) : 0,
        lastTapAt: current ? numberValue(current.last_tap_at) : null,
      };
    });
  }

  recordTap(
    input: TapInput,
    context: TapContext = {},
  ): {
    duplicate: boolean;
    outcome: {
      accepted: boolean;
      rewarded: boolean;
      reason: string;
      influenceAwarded: number;
      pressureAdded: number;
    };
    stateDelta: {
      player: IdleState["player"];
      pressure: IdleState["pressure"][number] | null;
      recentActivity: IdleState["recentActivity"];
    };
    serverTime: number;
  } {
    const now = this.now();
    const canCommand = this.authenticate(input.playerId, input.sessionId, now);
    this.ensureActiveSeason(now);
    this.maybeSweepRetention(now);
    this.decayPlayerRisk(input.playerId, now);
    const duplicate = asRow(
      this.db
        .prepare(
          "SELECT * FROM idle_taps WHERE session_id = ? AND client_seq = ?",
        )
        .get(input.sessionId, input.clientSeq),
    );
    const sessionSequence = asRow(
      this.db
        .prepare("SELECT last_client_seq FROM idle_sessions WHERE id = ?")
        .get(input.sessionId),
    );
    const lastSequence = numberValue(sessionSequence?.last_client_seq ?? -1);
    const expiredReplay = !duplicate && input.clientSeq <= lastSequence;
    const ipHash = createHmac("sha256", this.telemetrySalt)
      .update(context.ip ?? "unknown", "utf8")
      .digest("hex");
    const requestId = `tap_${this.randomToken(18)}`;
    const uaFamily = userAgentFamily(context.userAgent);
    this.db
      .prepare(
        `INSERT INTO idle_tap_observations(
          request_id, protocol_version, player_id, session_id, client_seq,
          target_territory_id, client_mono_ms, pointer_type, visibility,
          x_norm_q, y_norm_q, received_at, ip_hash, user_agent_family,
          is_duplicate, outcome_reason, logical_tap_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        input.v,
        input.playerId,
        input.sessionId,
        input.clientSeq,
        input.targetTerritoryId,
        input.clientMonoMs,
        input.pointerType,
        input.visibility,
        input.xNormQ,
        input.yNormQ,
        now,
        ipHash,
        uaFamily,
        duplicate || expiredReplay ? 1 : 0,
        duplicate
          ? "duplicate"
          : expiredReplay
            ? "expired_replay"
            : canCommand
              ? "pending"
              : "session_read_only",
        duplicate ? (duplicate.id as number | bigint) : null,
      );
    if (duplicate)
      return this.tapResponse(input.playerId, duplicate, true, now, canCommand);
    if (expiredReplay) {
      return this.tapResponse(
        input.playerId,
        {
          accepted: 0,
          rewarded: 0,
          outcome_reason: "expired_replay",
          influence_awarded: 0,
          pressure_added: 0,
        },
        true,
        now,
        canCommand,
      );
    }
    if (!canCommand) {
      throw new IdleApiError(
        409,
        "SESSION_READ_ONLY",
        "A newer recovered session owns this player's command lease",
      );
    }

    const player = asRow(
      this.db
        .prepare(
          `SELECT p.territory_id, p.risk_score, p.risk_updated_at,
                  p.quarantined, w.season_ends_at
           FROM idle_players p JOIN idle_worlds w ON w.id = p.world_id
           WHERE p.id = ?`,
        )
        .get(input.playerId),
    )!;
    const recent = this.db
      .prepare(
        `SELECT client_seq, client_mono_ms, received_at
         FROM idle_taps WHERE session_id = ?
         ORDER BY client_seq DESC, id DESC LIMIT 300`,
      )
      .all(input.sessionId) as SqlRow[];
    const last = recent[0];
    const target = asRow(
      this.db
        .prepare("SELECT owner_player_id FROM idle_territories WHERE id = ?")
        .get(input.targetTerritoryId),
    );
    let accepted = false;
    let outcomeReason: string;
    if (now >= numberValue(player.season_ends_at)) {
      outcomeReason = "season_ended";
    } else if (!target) {
      outcomeReason = "unknown_territory";
    } else if (target.owner_player_id === null) {
      outcomeReason = "unclaimed_territory";
    } else if (input.targetTerritoryId === String(player.territory_id)) {
      outcomeReason = "own_territory";
    } else {
      accepted = true;
      outcomeReason = "accepted";
    }

    const tapsLastSecond = numberValue(
      asRow(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM idle_taps WHERE player_id = ? AND received_at >= ?",
          )
          .get(input.playerId, now - 1000),
      )?.count ?? 0,
    );
    const tapsLastMinute = numberValue(
      asRow(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM idle_taps WHERE player_id = ? AND received_at >= ?",
          )
          .get(input.playerId, now - 60_000),
      )?.count ?? 0,
    );
    const signals: string[] = [];
    let riskDelta = 0;
    const lastClientDelta = last
      ? input.clientMonoMs - numberValue(last.client_mono_ms)
      : Number.POSITIVE_INFINITY;
    if (
      last &&
      lastClientDelta > 0 &&
      lastClientDelta < 20 &&
      now - numberValue(last.received_at) < 20
    ) {
      signals.push("subhuman_interval");
      riskDelta += 35;
    }
    const clientWindowWithin = (count: number, spanMs: number): boolean => {
      const points = [
        input.clientMonoMs,
        ...recent
          .slice(0, count - 1)
          .map((row) => numberValue(row.client_mono_ms)),
      ];
      if (points.length < count) return false;
      const deltas = points
        .slice(0, -1)
        .map((point, index) => point - points[index + 1]);
      return (
        deltas.every((delta) => delta > 0) &&
        points[0] - points[points.length - 1] <= spanMs
      );
    };
    if (tapsLastSecond >= 19 && clientWindowWithin(20, 1000)) {
      signals.push("impossible_second_rate");
      riskDelta += 40;
    }
    if (tapsLastMinute >= 299 && clientWindowWithin(300, 60_000)) {
      signals.push("impossible_minute_rate");
      riskDelta += 50;
    }
    if (recent.length >= 7) {
      const points = [
        input.clientMonoMs,
        ...recent.slice(0, 7).map((row) => numberValue(row.client_mono_ms)),
      ];
      const deltas = points
        .slice(0, -1)
        .map((point, index) => point - points[index + 1]);
      const mean =
        deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
      const variance =
        deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        deltas.length;
      if (
        deltas.every((delta) => delta > 0) &&
        mean <= 250 &&
        Math.sqrt(variance) <= 1.5
      ) {
        signals.push("mechanical_cadence");
        riskDelta += 25;
      }
    }

    const priorRisk = numberValue(player.risk_score);
    const nextRisk = Math.min(1000, priorRisk + riskDelta);
    const quarantined = nextRisk >= 100;
    const rewardedLastSecond = numberValue(
      asRow(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM idle_taps WHERE player_id = ? AND rewarded = 1 AND received_at >= ?",
          )
          .get(input.playerId, now - 1000),
      )?.count ?? 0,
    );
    const riskSuppressed = signals.length > 0 || quarantined;
    const rewarded = accepted && !riskSuppressed && rewardedLastSecond < 8;
    if (accepted && !rewarded && !riskSuppressed)
      outcomeReason = "reward_rate_cap";
    const influenceAwarded = rewarded ? 1 : 0;

    let pressureAdded = 0;
    if (accepted && !quarantined) {
      const snapshot = this.pressureSnapshot(now, [input.targetTerritoryId])[0];
      pressureAdded =
        Math.round(
          Math.max(0, Math.min(1, PRESSURE_CAP - snapshot.total)) * 100,
        ) / 100;
    }
    this.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO idle_taps(
            request_id, protocol_version, player_id, session_id, client_seq,
            target_territory_id, client_mono_ms, pointer_type, visibility,
            x_norm_q, y_norm_q, received_at, ip_hash, user_agent_family,
            accepted, outcome_reason, rewarded, influence_awarded,
            pressure_added, risk_delta, risk_signals
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          input.v,
          input.playerId,
          input.sessionId,
          input.clientSeq,
          input.targetTerritoryId,
          input.clientMonoMs,
          input.pointerType,
          input.visibility,
          input.xNormQ,
          input.yNormQ,
          now,
          ipHash,
          uaFamily,
          accepted ? 1 : 0,
          outcomeReason,
          rewarded ? 1 : 0,
          influenceAwarded,
          pressureAdded,
          riskDelta,
          JSON.stringify(signals),
        );
      this.db
        .prepare("UPDATE idle_sessions SET last_client_seq = ? WHERE id = ?")
        .run(input.clientSeq, input.sessionId);
      this.db
        .prepare(
          `UPDATE idle_tap_observations
           SET logical_tap_id = ?, outcome_reason = ? WHERE request_id = ?`,
        )
        .run(result.lastInsertRowid, outcomeReason, requestId);
      this.db
        .prepare(
          `UPDATE idle_players
           SET influence = influence + ?, risk_score = ?, risk_updated_at = ?,
               quarantined = ?
           WHERE id = ?`,
        )
        .run(
          influenceAwarded,
          nextRisk,
          now,
          quarantined ? 1 : 0,
          input.playerId,
        );
      this.db
        .prepare("UPDATE idle_worlds SET revision = revision + 1 WHERE id = ?")
        .run(WORLD_ID);
    });

    const stored = asRow(
      this.db
        .prepare("SELECT * FROM idle_taps WHERE request_id = ?")
        .get(requestId),
    )!;
    return this.tapResponse(input.playerId, stored, false, now, true);
  }

  private tapResponse(
    playerId: string,
    tap: SqlRow,
    duplicate: boolean,
    now: number,
    canCommand: boolean,
  ): ReturnType<IdleService["recordTap"]> {
    this.accrueSupply(playerId, now);
    const state = this.buildState(playerId, now, canCommand);
    const targetTerritoryId =
      typeof tap.target_territory_id === "string"
        ? tap.target_territory_id
        : null;
    return {
      duplicate,
      outcome: {
        accepted: numberValue(tap.accepted) === 1,
        rewarded: numberValue(tap.rewarded) === 1,
        reason: String(tap.outcome_reason),
        influenceAwarded: numberValue(tap.influence_awarded),
        pressureAdded: numberValue(tap.pressure_added),
      },
      stateDelta: {
        player: state.player,
        pressure: targetTerritoryId
          ? (state.pressure.find(
              (entry) => entry.targetTerritoryId === targetTerritoryId,
            ) ?? null)
          : null,
        recentActivity: state.recentActivity.slice(0, 3),
      },
      serverTime: now,
    };
  }

  adminSummary(): {
    serverTime: number;
    volume: {
      total: number;
      lastMinute: number;
      lastHour: number;
      observationsTotal: number;
      observationsLastMinute: number;
      observationsLastHour: number;
      duplicatesTotal: number;
      duplicatesLastHour: number;
    };
    players: Array<{
      playerId: string;
      name: string;
      tapsLastMinute: number;
      tapsLastHour: number;
      observationsLastHour: number;
      duplicateObservationsLastHour: number;
      rewardsSuppressedLastHour: number;
      riskScore: number;
      riskTier: "clear" | "watched" | "restricted";
      quarantined: boolean;
      lastTapAt: number | null;
    }>;
  } {
    const now = this.now();
    this.maybeSweepRetention(now);
    this.decayAllPlayerRisk(now);
    const volume = asRow(
      this.db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS last_minute,
                  SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS last_hour
           FROM idle_taps`,
        )
        .get(now - 60_000, now - 3_600_000),
    )!;
    const observationVolume = asRow(
      this.db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS last_minute,
                  SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS last_hour,
                  SUM(is_duplicate) AS duplicates_total,
                  SUM(CASE WHEN received_at >= ? AND is_duplicate = 1 THEN 1 ELSE 0 END) AS duplicates_last_hour
           FROM idle_tap_observations`,
        )
        .get(now - 60_000, now - 3_600_000, now - 3_600_000),
    )!;
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.risk_score, p.quarantined,
                SUM(CASE WHEN t.received_at >= ? THEN 1 ELSE 0 END) AS taps_last_minute,
                SUM(CASE WHEN t.received_at >= ? THEN 1 ELSE 0 END) AS taps_last_hour,
                SUM(CASE WHEN t.received_at >= ? AND t.accepted = 1 AND t.rewarded = 0 THEN 1 ELSE 0 END) AS suppressed_last_hour,
                MAX(t.received_at) AS last_tap_at,
                (SELECT COUNT(*) FROM idle_tap_observations o
                 WHERE o.player_id = p.id AND o.received_at >= ?) AS observations_last_hour,
                (SELECT COUNT(*) FROM idle_tap_observations o
                 WHERE o.player_id = p.id AND o.received_at >= ? AND o.is_duplicate = 1) AS duplicate_observations_last_hour
         FROM idle_players p
         LEFT JOIN idle_taps t ON t.player_id = p.id
         WHERE p.is_bot = 0
         GROUP BY p.id, p.name, p.risk_score, p.quarantined
         ORDER BY p.risk_score DESC, last_tap_at DESC`,
      )
      .all(
        now - 60_000,
        now - 3_600_000,
        now - 3_600_000,
        now - 3_600_000,
        now - 3_600_000,
      ) as SqlRow[];
    return {
      serverTime: now,
      volume: {
        total: numberValue(volume.total),
        lastMinute: numberValue(volume.last_minute ?? 0),
        lastHour: numberValue(volume.last_hour ?? 0),
        observationsTotal: numberValue(observationVolume.total),
        observationsLastMinute: numberValue(observationVolume.last_minute ?? 0),
        observationsLastHour: numberValue(observationVolume.last_hour ?? 0),
        duplicatesTotal: numberValue(observationVolume.duplicates_total ?? 0),
        duplicatesLastHour: numberValue(
          observationVolume.duplicates_last_hour ?? 0,
        ),
      },
      players: rows.map((row) => ({
        playerId: String(row.id),
        name: String(row.name),
        tapsLastMinute: numberValue(row.taps_last_minute ?? 0),
        tapsLastHour: numberValue(row.taps_last_hour ?? 0),
        observationsLastHour: numberValue(row.observations_last_hour ?? 0),
        duplicateObservationsLastHour: numberValue(
          row.duplicate_observations_last_hour ?? 0,
        ),
        rewardsSuppressedLastHour: numberValue(row.suppressed_last_hour ?? 0),
        riskScore: numberValue(row.risk_score),
        riskTier: riskTier(numberValue(row.risk_score)),
        quarantined: numberValue(row.quarantined) === 1,
        lastTapAt:
          row.last_tap_at === null ? null : numberValue(row.last_tap_at),
      })),
    };
  }

  health(): {
    status: "ok";
    database: "ready";
    schemaVersion: number;
    worldId: string;
    journalMode: string;
    secureDelete: boolean;
    synchronous: string;
    retentionMaintenance: "ok" | "retrying";
    serverTime: number;
  } {
    const version = asRow(this.db.prepare("PRAGMA user_version").get());
    const mode = asRow(this.db.prepare("PRAGMA journal_mode").get());
    const secureDelete = asRow(this.db.prepare("PRAGMA secure_delete").get());
    const synchronous = asRow(this.db.prepare("PRAGMA synchronous").get());
    this.db.prepare("SELECT 1 FROM idle_worlds WHERE id = ?").get(WORLD_ID);
    return {
      status: "ok",
      database: "ready",
      schemaVersion: numberValue(version?.user_version),
      worldId: WORLD_ID,
      journalMode: String(mode?.journal_mode ?? "unknown"),
      secureDelete: numberValue(secureDelete?.secure_delete) === 1,
      synchronous:
        numberValue(synchronous?.synchronous) === 2
          ? "full"
          : String(synchronous?.synchronous ?? "unknown"),
      retentionMaintenance: this.retentionMaintenanceDegraded
        ? "retrying"
        : "ok",
      serverTime: this.now(),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retentionMaintenanceTimer) {
      clearTimeout(this.retentionMaintenanceTimer);
      this.retentionMaintenanceTimer = undefined;
    }
    this.db.close();
  }
}
