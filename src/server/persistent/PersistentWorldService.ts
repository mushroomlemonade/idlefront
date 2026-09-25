import { createHash, randomBytes } from "crypto";
import quickChatData from "resources/QuickChat.json";
import { z } from "zod";
import { inferredReminderLeadTimes } from "../../core/PersistentWorldReminders";
import {
  CreatePersistentWorldRequestSchema,
  PersistentWorldCardSchema,
  PersistentWorldInAppNotificationSchema,
  PersistentWorldLobbySnapshotSchema,
  PersistentWorldQuickChatRequestSchema,
  PersistentWorldReminderRequestSchema,
  PersistentWorldRsvpRequestSchema,
  PersistentWorldSessionRequestSchema,
  PersistentWorldViewSchema,
  type NewPersistentWorldControllerSession,
  type PersistentWorld,
  type PersistentWorldCard,
  type PersistentWorldControllerSession,
  type PersistentWorldIdentity,
  type PersistentWorldInAppNotification,
  type PersistentWorldLobbySnapshot,
  type PersistentWorldQuickChat,
  type PersistentWorldReminderSelection,
} from "../../core/PersistentWorldSchemas";
import { pressurePacingForDuration } from "../../core/PressurePacing";
import {
  isCurrentWorldPreset,
  presetForDuration,
  WORLD_PRESETS,
} from "../../core/WorldPresets";
import { issueGuestPlayToken } from "../GuestPlayToken";
import {
  PersistentWorldRepository,
  PersistentWorldRepositoryError,
  type PersistentWorldArchiveSweep,
} from "./PersistentWorldRepository";
import { hashWorldPassword, matchesWorldPassword } from "./WorldPassword";

const MIN_START_DELAY_MS = 60_000;
const MAX_INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const PRESENCE_TTL_MS = 45_000;
const RUNTIME_START_GRACE_MS = 5 * 60_000;

const lobbyQuickChatKeys = new Set(
  Object.entries(quickChatData).flatMap(([category, phrases]) =>
    phrases.map((phrase) => `${category}.${phrase.key}`),
  ),
);

export class PersistentWorldServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PersistentWorldServiceError";
  }
}

export interface PersistentWorldServiceOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  runtimeCoordinator?: PersistentWorldRuntimeCoordinator;
  onRuntimeError?: (error: unknown) => void;
  /** Test/dev override. Production keeps the one-minute invitation floor. */
  minimumStartDelayMs?: number;
}

/**
 * Adapter owned by the application composition root. Keeping this interface
 * here lets the invitation domain request a runtime without importing game
 * configuration, worker IPC, or any simulation code.
 */
export interface PersistentWorldRuntimeCoordinator {
  ensure(world: PersistentWorld): Promise<void>;
  reconcile(): Promise<void>;
  /** Temporary lifecycle control used by the development world terminator. */
  stop?(worldId: string): void;
  /** True only while this process has a fully reconstructed authoritative game. */
  isRuntimeReady?(worldId: string): boolean;
}

export interface CreatedPersistentWorld {
  snapshot: PersistentWorldLobbySnapshot;
  invitationSecret: string | null;
}

export class PersistentWorldService {
  private readonly now: () => number;
  private readonly secureRandomBytes: (size: number) => Buffer;
  private readonly runtimeCoordinator?: PersistentWorldRuntimeCoordinator;
  private readonly onRuntimeError: (error: unknown) => void;
  private readonly minimumStartDelayMs: number;
  private readonly presence = new Map<string, Map<string, number>>();
  private scheduler: NodeJS.Timeout | undefined;
  private reconciling = false;

  constructor(
    readonly repository: PersistentWorldRepository,
    options: PersistentWorldServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.secureRandomBytes = options.randomBytes ?? randomBytes;
    this.runtimeCoordinator = options.runtimeCoordinator;
    this.onRuntimeError = options.onRuntimeError ?? (() => undefined);
    this.minimumStartDelayMs =
      options.minimumStartDelayMs ?? MIN_START_DELAY_MS;
  }

  createGuestSession(inputValue: unknown): NewPersistentWorldControllerSession {
    const input = PersistentWorldSessionRequestSchema.parse(inputValue);
    return this.repository.createGuestIdentity(input);
  }

  private worldSession(
    worldId: string,
    bearerToken: string,
  ): PersistentWorldControllerSession {
    const session = this.resumeSession(bearerToken);
    const identity = this.repository.claimedWorldIdentity(
      worldId,
      session.identity.id,
    );
    return identity ? { ...session, identity } : session;
  }

  async unlockWorld(
    worldId: string,
    bearerToken: string,
    password: string,
    displayName: string,
  ): Promise<void> {
    const controller = this.resumeSession(bearerToken);
    const hash = this.repository.worldPassword(worldId);
    if (!hash || !(await matchesWorldPassword(password, hash))) {
      throw new PersistentWorldServiceError(
        403,
        "WRONG_WORLD_PASSWORD",
        "The game password is incorrect.",
      );
    }
    const world = this.requireWorld(worldId);
    const matches = world.rsvps.filter(
      (member) => member.identity.displayName === displayName.trim(),
    );
    if (matches.length > 1) {
      throw new PersistentWorldServiceError(
        409,
        "AMBIGUOUS_USERNAME",
        "More than one nation has this username. Ask the host to resolve it.",
      );
    }
    const identity = matches[0]?.identity;
    if (identity) {
      const gameplayHash = this.repository.gameplayIdentityHash(identity.id);
      if (
        gameplayHash &&
        gameplayHash !== createHash("sha256").update(identity.id).digest("hex")
      ) {
        throw new PersistentWorldServiceError(
          409,
          "ACCOUNT_SEAT",
          "This nation uses a linked account. Sign in with that account to resume it.",
        );
      }
      this.repository.claimWorldIdentity(
        worldId,
        controller.identity.id,
        identity.id,
      );
      return;
    }
    if (controller.identity.displayName !== displayName.trim()) {
      throw new PersistentWorldServiceError(
        400,
        "USERNAME_MISMATCH",
        "Use the username you entered when signing in.",
      );
    }
    if (world.phase !== "scheduled") {
      throw new PersistentWorldServiceError(
        410,
        "JOIN_CLOSED",
        "No nation with that username is in this match.",
      );
    }
    this.repository.claimWorldIdentity(
      worldId,
      controller.identity.id,
      controller.identity.id,
    );
  }

  worldPlayToken(worldId: string, bearerToken: string): string {
    const session = this.worldSession(worldId, bearerToken);
    const world = this.requireWorld(worldId);
    const runtime = this.repository.getRuntime(worldId);
    if (
      !runtime ||
      !world.rsvps.some((member) => member.identity.id === session.identity.id)
    ) {
      throw new PersistentWorldServiceError(
        403,
        "NO_SEAT",
        "Join this lobby before playing.",
      );
    }
    const hash = this.repository.gameplayIdentityHash(session.identity.id);
    if (
      hash !== createHash("sha256").update(session.identity.id).digest("hex")
    ) {
      throw new PersistentWorldServiceError(
        409,
        "ACCOUNT_SEAT",
        "Use your linked account to play this nation.",
      );
    }
    return issueGuestPlayToken(session.identity.id, Date.now(), runtime.gameId);
  }

  resumeSession(bearerToken: string): PersistentWorldControllerSession {
    const session = this.repository.resumeControllerSession(bearerToken);
    if (!session) {
      throw new PersistentWorldServiceError(
        401,
        "SESSION_INVALID",
        "The world session is missing, expired, or revoked",
      );
    }
    return session;
  }

  bindGameplayIdentity(
    bearerToken: string,
    gameplayPersistentIdHash: string,
  ): void {
    const session = this.resumeSession(bearerToken);
    this.repository.bindGameplayIdentity(
      session.identity.id,
      gameplayPersistentIdHash,
    );

    // A legacy controller session may first acquire its gameplay binding
    // after the invitation has already elapsed. Give an active, not-yet-
    // provisioned world an immediate chance to attach its runtime.
    for (const world of this.repository.listWorldsForIdentity(
      session.identity.id,
    )) {
      if (world.phase === "active") this.queueRuntime(world);
    }
  }

  /**
   * Bind a guest world identity to the server-issued guest gameplay
   * principal. The controller bearer token is the authentication boundary;
   * callers never get to choose which identity is being bound.
   */
  bindGuestGameplayIdentity(
    bearerToken: string,
    issueToken: (identityId: string) => string,
  ): string {
    const session = this.resumeSession(bearerToken);
    const gameplayHash = createHash("sha256")
      .update(session.identity.id)
      .digest("hex");
    this.repository.bindGameplayIdentity(session.identity.id, gameplayHash);
    for (const world of this.repository.listWorldsForIdentity(
      session.identity.id,
    )) {
      if (world.phase === "active") this.queueRuntime(world);
    }
    return issueToken(session.identity.id);
  }

  createWorld(
    bearerToken: string,
    inputValue: unknown,
  ): CreatedPersistentWorld {
    const session = this.resumeSession(bearerToken);
    const input = CreatePersistentWorldRequestSchema.parse(inputValue);
    const now = this.now();
    const custom = input.startMode === "host";
    const currentPreset = isCurrentWorldPreset(input.gamePreset);
    if (!custom && input.pressurePacing) {
      throw new PersistentWorldServiceError(
        400,
        "SCHEDULED_PACING",
        "Scheduled games use their duration's pacing settings",
      );
    }
    if (
      !currentPreset &&
      (custom
        ? !input.gamePreset || input.gamePreset === "scheduled-earth"
        : input.gamePreset && input.gamePreset !== "scheduled-earth")
    ) {
      throw new PersistentWorldServiceError(
        400,
        "INVALID_PRESET",
        "Choose a valid mode for this game",
      );
    }
    if (!custom && input.mode !== "ffa" && input.startMode === "scheduled") {
      throw new PersistentWorldServiceError(
        400,
        "FIXED_MODE",
        "Scheduled games use the standard Earth rules",
      );
    }
    if (!custom && input.startsAt < now + this.minimumStartDelayMs) {
      throw new PersistentWorldServiceError(
        400,
        "START_TOO_SOON",
        "A world must be scheduled at least one minute in advance",
      );
    }
    if (!custom && input.startsAt > now + MAX_INVITATION_LIFETIME_MS) {
      throw new PersistentWorldServiceError(
        400,
        "START_TOO_LATE",
        "An invitation may count down for at most fourteen days",
      );
    }

    const id = this.randomToken("world", 12);
    const invitationSecret =
      input.access === "private" ? this.randomToken("invite", 32) : null;
    const { teamId, password, ...worldInput } = input;
    if (password && input.access !== "private") {
      throw new PersistentWorldServiceError(
        400,
        "PRIVATE_ONLY",
        "Passwords are available for private games.",
      );
    }
    const passwordHash = password ? hashWorldPassword(password) : null;
    const world = this.repository.createWorld({
      ...worldInput,
      pressurePacing:
        currentPreset || !custom
          ? custom && input.pressurePacing
            ? input.pressurePacing
            : pressurePacingForDuration(
                custom && isCurrentWorldPreset(input.gamePreset)
                  ? WORLD_PRESETS[input.gamePreset].duration
                  : input.targetDuration,
              )
          : undefined,
      startMode: custom ? "host" : "scheduled",
      gamePreset: custom
        ? input.gamePreset
        : presetForDuration(input.targetDuration),
      startsAt: custom ? now : input.startsAt,
      ...(currentPreset && custom
        ? {
            targetDuration:
              WORLD_PRESETS[
                input.gamePreset as "quickplay" | "longplay" | "idlefront"
              ].duration,
          }
        : {}),
      ...(!custom ? { mode: "ffa" as const } : {}),
      id,
      host: session.identity,
      hostTeamId: custom ? teamId : null,
      invitationSecret: invitationSecret ?? undefined,
    });
    if (passwordHash) this.repository.setWorldPassword(world.id, passwordHash);
    this.touch(world.id, session.identity.id);
    return {
      snapshot: this.snapshotFromWorld(
        world,
        session,
        invitationSecret ?? undefined,
      ),
      invitationSecret,
    };
  }

  getSnapshot(
    worldId: string,
    bearerToken?: string,
    invitationSecret?: string,
  ): PersistentWorldLobbySnapshot {
    const world = this.requireWorld(worldId);
    const session = bearerToken
      ? this.worldSession(worldId, bearerToken)
      : undefined;
    this.requireViewAccess(world, session?.identity, invitationSecret);
    if (session) this.touch(world.id, session.identity.id);
    return this.snapshotFromWorld(world, session, invitationSecret);
  }

  listPublic(bearerToken?: string): PersistentWorldCard[] {
    const viewer = bearerToken
      ? this.repository.resumeControllerSession(bearerToken)?.identity
      : undefined;
    return this.repository
      .listPublicWorlds()
      .map((world) => this.card(world, viewer));
  }

  listMine(bearerToken: string): PersistentWorldCard[] {
    const session = this.resumeSession(bearerToken);
    const worlds = new Map(
      this.repository
        .listWorldsForIdentity(session.identity.id)
        .map((world) => [world.id, world]),
    );
    for (const id of this.repository.claimedWorldIds(session.identity.id)) {
      const world = this.requireWorld(id);
      if (world.phase === "scheduled" || world.phase === "active")
        worlds.set(id, world);
    }
    return [...worlds.values()].map((world) =>
      this.card(world, this.worldSession(world.id, bearerToken).identity),
    );
  }

  listNotifications(bearerToken: string): PersistentWorldInAppNotification[] {
    const session = this.resumeSession(bearerToken);
    return z
      .array(PersistentWorldInAppNotificationSchema)
      .parse(this.repository.listInAppNotifications(session.identity.id));
  }

  markNotificationRead(
    bearerToken: string,
    notificationId: string,
  ): PersistentWorldInAppNotification {
    const session = this.resumeSession(bearerToken);
    return PersistentWorldInAppNotificationSchema.parse(
      this.repository.markInAppNotificationRead(
        session.identity.id,
        notificationId,
        this.now(),
      ),
    );
  }

  rsvp(
    worldId: string,
    bearerToken: string,
    inputValue: unknown,
  ): PersistentWorldLobbySnapshot {
    const session = this.worldSession(worldId, bearerToken);
    const input = PersistentWorldRsvpRequestSchema.parse(inputValue);
    const world = this.requireWorld(worldId);
    const isMember = world.rsvps.some(
      (member) => member.identity.id === session.identity.id,
    );
    if (
      isMember &&
      world.phase === "active" &&
      this.repository.getRuntime(worldId)
    )
      return this.getSnapshot(worldId, bearerToken);
    const controller = this.resumeSession(bearerToken);
    if (
      !isMember &&
      this.repository.worldPassword(worldId) &&
      !this.repository.claimedWorldIdentity(worldId, controller.identity.id)
    ) {
      throw new PersistentWorldServiceError(
        403,
        "WORLD_PASSWORD_REQUIRED",
        "Enter the game password to join.",
      );
    }
    if (
      !isMember &&
      this.repository.worldPassword(worldId) &&
      world.rsvps.some(
        (member) =>
          member.identity.displayName === session.identity.displayName,
      )
    ) {
      throw new PersistentWorldServiceError(
        409,
        "USERNAME_TAKEN",
        "This username already has a nation. Enter the game password to resume it.",
      );
    }
    if (world.phase === "active" && this.repository.getRuntime(worldId)) {
      throw new PersistentWorldServiceError(
        410,
        "JOIN_CLOSED",
        "The playable roster was sealed when this world began",
      );
    }
    this.repository.rsvp(
      {
        worldId,
        identity: session.identity,
        teamId: input.teamId,
        invitationSecret: input.invitationSecret,
      },
      Boolean(
        this.repository.claimedWorldIdentity(worldId, controller.identity.id),
      ),
    );
    this.touch(worldId, session.identity.id);
    return this.getSnapshot(worldId, bearerToken, input.invitationSecret);
  }

  leave(worldId: string, bearerToken: string): void {
    const session = this.worldSession(worldId, bearerToken);
    if (this.repository.getRuntime(worldId)) {
      throw new PersistentWorldServiceError(
        409,
        "ROSTER_SEALED",
        "The roster is sealed after the map has been provisioned",
      );
    }
    this.repository.leaveWorld(worldId, session.identity.id);
    this.presence.get(worldId)?.delete(session.identity.id);
  }

  postQuickChat(
    worldId: string,
    bearerToken: string,
    inputValue: unknown,
  ): PersistentWorldQuickChat {
    const session = this.worldSession(worldId, bearerToken);
    const input = PersistentWorldQuickChatRequestSchema.parse(inputValue);
    if (!lobbyQuickChatKeys.has(input.phraseKey)) {
      throw new PersistentWorldServiceError(
        400,
        "QUICK_CHAT_UNKNOWN",
        "Lobby chat accepts only phrases from the quick-chat catalog",
      );
    }
    this.touch(worldId, session.identity.id);
    return this.repository.postQuickChat({
      id: input.id,
      worldId,
      sender: session.identity,
      phraseKey: input.phraseKey,
    });
  }

  setReminders(
    worldId: string,
    bearerToken: string,
    inputValue: unknown,
  ): PersistentWorldReminderSelection {
    const session = this.worldSession(worldId, bearerToken);
    if (this.requireWorld(worldId).startMode === "host") {
      throw new PersistentWorldServiceError(
        400,
        "NO_SCHEDULE",
        "Custom games start when the host is ready",
      );
    }
    const input = PersistentWorldReminderRequestSchema.parse(inputValue);
    this.touch(worldId, session.identity.id);
    return this.repository.setReminderSelection(
      worldId,
      session.identity.id,
      input.leadTimesMs,
    );
  }

  startCustomWorld(
    worldId: string,
    bearerToken: string,
  ): PersistentWorldLobbySnapshot {
    const session = this.worldSession(worldId, bearerToken);
    const world = this.repository.startCustomWorld(
      worldId,
      session.identity.id,
    );
    this.queueRuntime(world);
    return this.snapshotFromWorld(world, session);
  }

  cancel(worldId: string, bearerToken: string): PersistentWorldLobbySnapshot {
    const session = this.worldSession(worldId, bearerToken);
    const world = this.repository.cancelWorld(worldId, session.identity);
    return this.snapshotFromWorld(world, session);
  }

  /** Temporary dev control; the router keeps this endpoint dev-only. */
  async endForDevelopment(
    worldId: string,
    bearerToken: string,
  ): Promise<PersistentWorld> {
    this.resumeSession(bearerToken);
    const world = this.repository.endForDevelopment(worldId, this.now());
    this.presence.delete(worldId);
    this.runtimeCoordinator?.stop?.(worldId);
    return world;
  }

  activateDueWorlds(): PersistentWorld[] {
    const activated: PersistentWorld[] = [];
    for (const due of this.repository.listWorldsDueToStart(this.now())) {
      const world = this.repository.markActive(due.id, this.now());
      activated.push(world);
      this.queueRuntime(world);
    }
    return activated;
  }

  archiveStaleWorlds(): PersistentWorldArchiveSweep {
    return this.repository.archiveStaleWorlds(
      this.now(),
      RUNTIME_START_GRACE_MS,
    );
  }

  startScheduler(intervalMs: number = 1000): void {
    if (this.scheduler) return;
    this.archiveStaleWorlds();
    this.activateDueWorlds();
    this.queueReconcile();
    this.scheduler = setInterval(() => {
      this.archiveStaleWorlds();
      this.activateDueWorlds();
      this.queueReconcile();
    }, intervalMs);
    this.scheduler.unref?.();
  }

  stopScheduler(): void {
    if (!this.scheduler) return;
    clearInterval(this.scheduler);
    this.scheduler = undefined;
  }

  close(): void {
    this.stopScheduler();
    this.repository.close();
  }

  private snapshotFromWorld(
    world: PersistentWorld,
    session?: PersistentWorldControllerSession,
    invitationSecret?: string,
  ): PersistentWorldLobbySnapshot {
    const identity = session?.identity;
    const viewerRsvp = identity
      ? world.rsvps.find((rsvp) => rsvp.identity.id === identity.id)
      : undefined;
    const runtime = this.repository.getRuntime(world.id);
    const reminderOptionsMs =
      world.startMode === "host"
        ? []
        : inferredReminderLeadTimes(world.startsAt - world.createdAt);
    const selectedReminderLeadTimesMs = identity
      ? (this.repository.getReminderSelection(world.id, identity.id)
          ?.leadTimesMs ?? [])
      : [];
    const quickChat = this.repository
      .listQuickChat(world.id)
      .map((message) => ({
        id: message.id,
        sender: this.publicIdentity(message.sender),
        phraseKey: message.phraseKey,
        sentAt: message.sentAt,
      }));
    const latestQuickChat = quickChat[quickChat.length - 1];
    const revision = Math.max(
      world.updatedAt,
      latestQuickChat?.sentAt ?? 0,
      this.repository.getReminderSelection(world.id, identity?.id ?? "")
        ?.updatedAt ?? 0,
    );
    const isFull = world.rsvps.length >= world.maxHumans;
    const inviteValid =
      world.access === "public" ||
      Boolean(
        invitationSecret && this.safeInvitation(world.id, invitationSecret),
      );
    const canRsvp =
      !viewerRsvp &&
      !isFull &&
      world.phase !== "finished" &&
      world.phase !== "cancelled" &&
      runtime === undefined &&
      (world.access === "public"
        ? world.phase === "scheduled" &&
          (world.startMode === "host" || this.now() < world.startsAt)
        : inviteValid &&
          ((world.startMode === "host" && world.phase === "scheduled") ||
            this.now() < world.joinClosesAt));

    return PersistentWorldLobbySnapshotSchema.parse({
      revision,
      serverTime: this.now(),
      world: this.worldView(world),
      members: world.rsvps.map((rsvp) => ({
        identity: this.publicIdentity(rsvp.identity),
        isHost: rsvp.isHost,
        teamId: rsvp.teamId,
        joinedAt: rsvp.joinedAt,
        presence: this.isOnline(world.id, rsvp.identity.id)
          ? "online"
          : "offline",
        isViewer: rsvp.identity.id === identity?.id,
      })),
      quickChat,
      reminderOptionsMs,
      selectedReminderLeadTimesMs,
      viewer: {
        identity: identity ? this.publicIdentity(identity) : null,
        isMember: Boolean(viewerRsvp),
        isHost: viewerRsvp?.isHost ?? false,
        canRsvp,
        canChat: Boolean(viewerRsvp),
        canCancel: viewerRsvp?.isHost === true && world.phase === "scheduled",
        hasVerifiedEmail:
          identity?.verifiedEmail !== null &&
          identity?.verifiedEmail !== undefined,
      },
      // A game ID is a capability to attempt a worker join. Reveal it only
      // after the worker acknowledged creation and only to an RSVP identity
      // that has been cryptographically bound to a gameplay principal.
      runtimeGameId:
        viewerRsvp &&
        runtime?.state === "ready" &&
        (this.runtimeCoordinator?.isRuntimeReady?.(world.id) ?? true) &&
        this.repository.gameplayIdentityHash(viewerRsvp.identity.id)
          ? runtime.gameId
          : null,
    });
  }

  private card(
    world: PersistentWorld,
    viewer?: PersistentWorldIdentity,
  ): PersistentWorldCard {
    const isViewerMember = world.rsvps.some(
      (rsvp) => rsvp.identity.id === viewer?.id,
    );
    const viewerStatus =
      viewer && isViewerMember
        ? this.repository.runtimePlayerStatus(world.id, viewer.id)
        : undefined;
    return PersistentWorldCardSchema.parse({
      world: this.worldView(world),
      host: this.publicIdentity(world.host),
      rsvpCount: world.rsvps.length,
      isViewerMember,
      viewerEliminated: viewerStatus?.isAlive === false,
    });
  }

  private worldView(world: PersistentWorld) {
    return PersistentWorldViewSchema.parse({
      pressurePacing: world.pressurePacing,
      startMode: world.startMode,
      gamePreset: world.gamePreset,
      id: world.id,
      name: world.name,
      targetDuration: world.targetDuration,
      access: world.access,
      mode: world.mode,
      maxHumans: world.maxHumans,
      phase: world.phase,
      startsAt: world.startsAt,
      joinClosesAt: world.joinClosesAt,
      scheduleLocked: world.scheduleLockedAt !== null,
      createdAt: world.createdAt,
      activatedAt: world.activatedAt,
    });
  }

  private publicIdentity(identity: PersistentWorldIdentity) {
    return { id: identity.id, displayName: identity.displayName };
  }

  private requireWorld(worldId: string): PersistentWorld {
    const world = this.repository.getWorld(worldId);
    if (!world) {
      throw new PersistentWorldServiceError(
        404,
        "WORLD_NOT_FOUND",
        "World does not exist",
      );
    }
    return world;
  }

  private requireViewAccess(
    world: PersistentWorld,
    identity?: PersistentWorldIdentity,
    invitationSecret?: string,
  ): void {
    if (world.access === "public") return;
    if (identity && this.repository.claimedWorldIdentity(world.id, identity.id))
      return;
    if (
      identity &&
      world.rsvps.some((rsvp) => rsvp.identity.id === identity.id)
    ) {
      return;
    }
    if (invitationSecret && this.safeInvitation(world.id, invitationSecret)) {
      return;
    }
    throw new PersistentWorldServiceError(
      403,
      "INVITATION_REQUIRED",
      "A valid private-world invitation is required",
    );
  }

  private safeInvitation(worldId: string, secret: string): boolean {
    try {
      return this.repository.verifyInvitation(worldId, secret);
    } catch (error) {
      if (error instanceof PersistentWorldRepositoryError) return false;
      throw error;
    }
  }

  private touch(worldId: string, identityId: string): void {
    const byIdentity = this.presence.get(worldId) ?? new Map<string, number>();
    byIdentity.set(identityId, this.now());
    this.presence.set(worldId, byIdentity);
    try {
      this.repository.recordLastSeen(worldId, identityId, this.now());
    } catch (error) {
      if (!(error instanceof PersistentWorldRepositoryError)) throw error;
    }
  }

  private isOnline(worldId: string, identityId: string): boolean {
    const lastSeen = this.presence.get(worldId)?.get(identityId);
    return lastSeen !== undefined && this.now() - lastSeen <= PRESENCE_TTL_MS;
  }

  private queueRuntime(world: PersistentWorld): void {
    if (!this.runtimeCoordinator) return;
    void this.runtimeCoordinator.ensure(world).catch(this.onRuntimeError);
  }

  private queueReconcile(): void {
    if (!this.runtimeCoordinator || this.reconciling) return;
    this.reconciling = true;
    void this.runtimeCoordinator
      .reconcile()
      .catch(this.onRuntimeError)
      .finally(() => {
        this.reconciling = false;
      });
  }

  private randomToken(prefix: string, bytes: number): string {
    return `${prefix}_${this.secureRandomBytes(bytes).toString("base64url")}`;
  }
}

export function persistentWorldServiceError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof PersistentWorldServiceError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof PersistentWorldRepositoryError) {
    const statusByCode: Partial<Record<typeof error.code, number>> = {
      FORBIDDEN: 403,
      INVALID_INVITATION: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      SCHEDULE_LOCKED: 409,
      WORLD_FULL: 409,
      JOIN_CLOSED: 410,
      INVALID_ARGUMENT: 400,
      INVALID_PHASE: 409,
      LEASE_INVALID: 409,
      NOT_DUE: 409,
    };
    return {
      status: statusByCode[error.code] ?? 400,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: z.prettifyError(error),
    };
  }
  return {
    status: 500,
    code: "WORLD_INTERNAL_ERROR",
    message: "Persistent-world request failed",
  };
}
