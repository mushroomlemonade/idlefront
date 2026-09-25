import { z } from "zod";
import { PressurePacingSchema } from "./PressurePacing";

export const WorldStartModeSchema = z.enum(["scheduled", "host"]);
export const WorldPresetSchema = z.enum([
  "quickplay",
  "longplay",
  "idlefront",
  "scheduled-earth",
  "great-lakes",
  "enormous-earth",
  "hd-earth-9x",
  "uhd-earth-27x",
  "pixel-earth-27x",
  "fog-earth-27x",
]);

export const PersistentWorldDurationSchema = z.enum(["1h", "1d", "7d"]);
export type PersistentWorldDuration = z.infer<
  typeof PersistentWorldDurationSchema
>;

export const PERSISTENT_WORLD_DURATION_MS: Readonly<
  Record<PersistentWorldDuration, number>
> = Object.freeze({
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
});

export function persistentWorldDurationMs(
  duration: PersistentWorldDuration,
): number {
  return PERSISTENT_WORLD_DURATION_MS[duration];
}

export const PersistentWorldAccessSchema = z.enum(["private", "public"]);
export type PersistentWorldAccess = z.infer<typeof PersistentWorldAccessSchema>;

export const PersistentWorldModeSchema = z.enum(["ffa", "teams"]);
export type PersistentWorldMode = z.infer<typeof PersistentWorldModeSchema>;

export const PersistentWorldPhaseSchema = z.enum([
  "scheduled",
  "active",
  "finished",
  "cancelled",
]);
export type PersistentWorldPhase = z.infer<typeof PersistentWorldPhaseSchema>;

export const PersistentWorldIdentityKindSchema = z.enum([
  "account",
  "email",
  "guest",
]);
export type PersistentWorldIdentityKind = z.infer<
  typeof PersistentWorldIdentityKindSchema
>;

export const PersistentWorldIdentityIdSchema = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

export const PersistentWorldIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const PersistentWorldTimestampSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

/**
 * A stable identity supplied by the authentication boundary. `subject` is an
 * opaque provider identifier, not a display name. `verifiedEmail` must only be
 * populated after the caller has verified ownership of that address.
 */
export const PersistentWorldIdentitySchema = z
  .object({
    id: PersistentWorldIdentityIdSchema,
    kind: PersistentWorldIdentityKindSchema,
    subject: z.string().trim().min(1).max(255),
    displayName: z.string().trim().min(1).max(80),
    verifiedEmail: z.string().trim().email().max(320).nullable(),
  })
  .strict();
export type PersistentWorldIdentity = z.infer<
  typeof PersistentWorldIdentitySchema
>;

export const CreatePersistentWorldGuestInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
  })
  .strict();
export type CreatePersistentWorldGuestInput = z.input<
  typeof CreatePersistentWorldGuestInputSchema
>;

export const PersistentWorldControllerSessionSchema = z
  .object({
    id: z
      .string()
      .min(8)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/),
    identity: PersistentWorldIdentitySchema,
    createdAt: PersistentWorldTimestampSchema,
    lastUsedAt: PersistentWorldTimestampSchema,
  })
  .strict();
export type PersistentWorldControllerSession = z.infer<
  typeof PersistentWorldControllerSessionSchema
>;

/** Returned only when a session is created; the token cannot be read back. */
export const NewPersistentWorldControllerSessionSchema = z
  .object({
    session: PersistentWorldControllerSessionSchema,
    bearerToken: z.string().min(32).max(512),
  })
  .strict();
export type NewPersistentWorldControllerSession = z.infer<
  typeof NewPersistentWorldControllerSessionSchema
>;

export const AttachPersistentWorldAccountInputSchema = z
  .object({
    accountSubject: z.string().trim().min(1).max(255),
    displayName: z.string().trim().min(1).max(80).optional(),
    verifiedEmail: z.string().trim().email().max(320).optional(),
  })
  .strict();
export type AttachPersistentWorldAccountInput = z.input<
  typeof AttachPersistentWorldAccountInputSchema
>;

export const AttachPersistentWorldVerifiedEmailInputSchema = z
  .object({
    verifiedEmail: z.string().trim().email().max(320),
    displayName: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type AttachPersistentWorldVerifiedEmailInput = z.input<
  typeof AttachPersistentWorldVerifiedEmailInputSchema
>;

export const PersistentWorldTeamIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);

export const PersistentWorldInvitationSecretSchema = z
  .string()
  .min(16)
  .max(512);

export const CreatePersistentWorldInputSchema = z
  .object({
    pressurePacing: PressurePacingSchema.optional(),
    startMode: WorldStartModeSchema.optional(),
    gamePreset: WorldPresetSchema.optional(),
    id: PersistentWorldIdSchema,
    name: z.string().trim().min(1).max(100),
    targetDuration: PersistentWorldDurationSchema,
    access: PersistentWorldAccessSchema,
    mode: PersistentWorldModeSchema,
    maxHumans: z.number().int().min(2).max(16),
    startsAt: PersistentWorldTimestampSchema,
    host: PersistentWorldIdentitySchema,
    hostTeamId: PersistentWorldTeamIdSchema.nullable().optional(),
    invitationSecret: PersistentWorldInvitationSecretSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.access === "private" && !value.invitationSecret) {
      context.addIssue({
        code: "custom",
        path: ["invitationSecret"],
        message: "Private worlds require an invitation secret",
      });
    }
    if (value.access === "public" && value.invitationSecret) {
      context.addIssue({
        code: "custom",
        path: ["invitationSecret"],
        message: "Public worlds do not store an invitation secret",
      });
    }
    if (
      value.mode === "ffa" &&
      value.hostTeamId !== null &&
      value.hostTeamId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["hostTeamId"],
        message: "FFA worlds cannot have team choices",
      });
    }
  });
export type CreatePersistentWorldInput = z.input<
  typeof CreatePersistentWorldInputSchema
>;

export const PersistentWorldRsvpInputSchema = z
  .object({
    worldId: PersistentWorldIdSchema,
    identity: PersistentWorldIdentitySchema,
    teamId: PersistentWorldTeamIdSchema.nullable().optional(),
    invitationSecret: PersistentWorldInvitationSecretSchema.optional(),
  })
  .strict();
export type PersistentWorldRsvpInput = z.input<
  typeof PersistentWorldRsvpInputSchema
>;

/** Persisted membership. Live presence is deliberately absent from this type. */
export const PersistentWorldRsvpSchema = z
  .object({
    worldId: PersistentWorldIdSchema,
    identity: PersistentWorldIdentitySchema,
    isHost: z.boolean(),
    teamId: PersistentWorldTeamIdSchema.nullable(),
    joinedAt: PersistentWorldTimestampSchema,
    lastSeenAt: PersistentWorldTimestampSchema,
  })
  .strict();
export type PersistentWorldRsvp = z.infer<typeof PersistentWorldRsvpSchema>;

/**
 * Presence is composed by a WebSocket/presence service at read time and must
 * never be written to the persistent-world repository.
 */
export const PersistentWorldLobbyMemberSchema =
  PersistentWorldRsvpSchema.extend({
    presence: z.enum(["online", "offline"]),
  }).strict();
export type PersistentWorldLobbyMember = z.infer<
  typeof PersistentWorldLobbyMemberSchema
>;

export const PersistentWorldSchema = z
  .object({
    pressurePacing: PressurePacingSchema.optional(),
    startMode: WorldStartModeSchema.optional(),
    gamePreset: WorldPresetSchema.optional(),
    id: PersistentWorldIdSchema,
    name: z.string().min(1).max(100),
    targetDuration: PersistentWorldDurationSchema,
    access: PersistentWorldAccessSchema,
    mode: PersistentWorldModeSchema,
    maxHumans: z.number().int().min(2).max(16),
    phase: PersistentWorldPhaseSchema,
    startsAt: PersistentWorldTimestampSchema,
    joinClosesAt: PersistentWorldTimestampSchema,
    host: PersistentWorldIdentitySchema,
    rsvps: z.array(PersistentWorldRsvpSchema),
    scheduleLockedAt: PersistentWorldTimestampSchema.nullable(),
    createdAt: PersistentWorldTimestampSchema,
    updatedAt: PersistentWorldTimestampSchema,
    activatedAt: PersistentWorldTimestampSchema.nullable(),
    finishedAt: PersistentWorldTimestampSchema.nullable(),
    cancelledAt: PersistentWorldTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((world, context) => {
    const expectedJoinClose =
      world.startsAt + persistentWorldDurationMs(world.targetDuration) / 3;
    if (world.joinClosesAt !== expectedJoinClose) {
      context.addIssue({
        code: "custom",
        path: ["joinClosesAt"],
        message:
          "joinClosesAt must be one third of the target duration after startsAt",
      });
    }
  });
export type PersistentWorld = z.infer<typeof PersistentWorldSchema>;

/** Quick chat stores a catalog key, never user-authored message text. */
export const PersistentWorldQuickChatPhraseKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export const PersistentWorldQuickChatSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/),
    worldId: PersistentWorldIdSchema,
    sender: PersistentWorldIdentitySchema,
    phraseKey: PersistentWorldQuickChatPhraseKeySchema,
    sentAt: PersistentWorldTimestampSchema,
  })
  .strict();
export type PersistentWorldQuickChat = z.infer<
  typeof PersistentWorldQuickChatSchema
>;

export const PostPersistentWorldQuickChatInputSchema = z
  .object({
    id: PersistentWorldQuickChatSchema.shape.id,
    worldId: PersistentWorldIdSchema,
    sender: PersistentWorldIdentitySchema,
    phraseKey: PersistentWorldQuickChatPhraseKeySchema,
  })
  .strict();
export type PostPersistentWorldQuickChatInput = z.input<
  typeof PostPersistentWorldQuickChatInputSchema
>;

// Browser-safe identity. Authentication subjects and verified email addresses
// never cross the lobby API merely because someone RSVPed.
export const PersistentWorldPublicIdentitySchema = z
  .object({
    id: PersistentWorldIdentityIdSchema,
    displayName: z.string().trim().min(1).max(80),
  })
  .strict();
export type PersistentWorldPublicIdentity = z.infer<
  typeof PersistentWorldPublicIdentitySchema
>;

export const PersistentWorldLobbyMemberViewSchema = z
  .object({
    identity: PersistentWorldPublicIdentitySchema,
    isHost: z.boolean(),
    teamId: PersistentWorldTeamIdSchema.nullable(),
    joinedAt: PersistentWorldTimestampSchema,
    presence: z.enum(["online", "offline"]),
    isViewer: z.boolean(),
  })
  .strict();
export type PersistentWorldLobbyMemberView = z.infer<
  typeof PersistentWorldLobbyMemberViewSchema
>;

export const PersistentWorldQuickChatViewSchema = z
  .object({
    id: PersistentWorldQuickChatSchema.shape.id,
    sender: PersistentWorldPublicIdentitySchema,
    phraseKey: PersistentWorldQuickChatPhraseKeySchema,
    sentAt: PersistentWorldTimestampSchema,
  })
  .strict();
export type PersistentWorldQuickChatView = z.infer<
  typeof PersistentWorldQuickChatViewSchema
>;

export const PersistentWorldReminderSelectionSchema = z
  .object({
    worldId: PersistentWorldIdSchema,
    identityId: PersistentWorldIdentityIdSchema,
    leadTimesMs: z
      .array(
        z
          .number()
          .int()
          .min(30_000)
          .max(14 * 24 * 60 * 60 * 1000),
      )
      .max(3),
    updatedAt: PersistentWorldTimestampSchema,
  })
  .strict();
export type PersistentWorldReminderSelection = z.infer<
  typeof PersistentWorldReminderSelectionSchema
>;

export const PersistentWorldViewSchema = z
  .object({
    pressurePacing: PressurePacingSchema.optional(),
    startMode: WorldStartModeSchema.optional(),
    gamePreset: WorldPresetSchema.optional(),
    id: PersistentWorldIdSchema,
    name: z.string().min(1).max(100),
    targetDuration: PersistentWorldDurationSchema,
    access: PersistentWorldAccessSchema,
    mode: PersistentWorldModeSchema,
    maxHumans: z.number().int().min(2).max(16),
    phase: PersistentWorldPhaseSchema,
    startsAt: PersistentWorldTimestampSchema,
    joinClosesAt: PersistentWorldTimestampSchema,
    scheduleLocked: z.boolean(),
    createdAt: PersistentWorldTimestampSchema,
    activatedAt: PersistentWorldTimestampSchema.nullable(),
  })
  .strict();
export type PersistentWorldView = z.infer<typeof PersistentWorldViewSchema>;

export const PersistentWorldCardSchema = z
  .object({
    world: PersistentWorldViewSchema,
    host: PersistentWorldPublicIdentitySchema,
    rsvpCount: z.number().int().nonnegative(),
    isViewerMember: z.boolean(),
    /** Last durably observed simulation state for the signed-in RSVP seat. */
    viewerEliminated: z.boolean(),
  })
  .strict();
export type PersistentWorldCard = z.infer<typeof PersistentWorldCardSchema>;

export const PersistentWorldViewerSchema = z
  .object({
    identity: PersistentWorldPublicIdentitySchema.nullable(),
    isMember: z.boolean(),
    isHost: z.boolean(),
    canRsvp: z.boolean(),
    canChat: z.boolean(),
    canCancel: z.boolean(),
    hasVerifiedEmail: z.boolean(),
  })
  .strict();
export type PersistentWorldViewer = z.infer<typeof PersistentWorldViewerSchema>;

export const PersistentWorldLobbySnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    serverTime: PersistentWorldTimestampSchema,
    world: PersistentWorldViewSchema,
    members: z.array(PersistentWorldLobbyMemberViewSchema),
    quickChat: z.array(PersistentWorldQuickChatViewSchema),
    reminderOptionsMs: z.array(z.number().int().min(30_000)).max(3),
    selectedReminderLeadTimesMs: z.array(z.number().int().min(30_000)).max(3),
    viewer: PersistentWorldViewerSchema,
    runtimeGameId: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type PersistentWorldLobbySnapshot = z.infer<
  typeof PersistentWorldLobbySnapshotSchema
>;

export const CreatePersistentWorldRequestSchema = z
  .object({
    pressurePacing: PressurePacingSchema.optional(),
    startMode: WorldStartModeSchema.optional(),
    gamePreset: WorldPresetSchema.optional(),
    password: z.string().min(1).max(128).optional(),
    name: z.string().trim().min(1).max(100),
    targetDuration: PersistentWorldDurationSchema,
    access: PersistentWorldAccessSchema,
    mode: PersistentWorldModeSchema,
    maxHumans: z.number().int().min(2).max(16),
    startsAt: PersistentWorldTimestampSchema,
    teamId: PersistentWorldTeamIdSchema.nullable().optional(),
  })
  .strict();
export type CreatePersistentWorldRequest = z.input<
  typeof CreatePersistentWorldRequestSchema
>;

export const PersistentWorldRsvpRequestSchema = z
  .object({
    teamId: PersistentWorldTeamIdSchema.nullable().optional(),
    invitationSecret: PersistentWorldInvitationSecretSchema.optional(),
  })
  .strict();

export const PersistentWorldQuickChatRequestSchema = z
  .object({
    id: PersistentWorldQuickChatSchema.shape.id,
    phraseKey: PersistentWorldQuickChatPhraseKeySchema,
  })
  .strict();

export const PersistentWorldReminderRequestSchema = z
  .object({
    leadTimesMs: PersistentWorldReminderSelectionSchema.shape.leadTimesMs,
  })
  .strict();

export const PersistentWorldSessionRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
  })
  .strict();

export const PersistentWorldNotificationKindSchema = z.enum([
  "reminder",
  "start",
]);
export type PersistentWorldNotificationKind = z.infer<
  typeof PersistentWorldNotificationKindSchema
>;

export const PersistentWorldNotificationChannelSchema = z.enum([
  "in_app",
  "email",
]);
export type PersistentWorldNotificationChannel = z.infer<
  typeof PersistentWorldNotificationChannelSchema
>;

/**
 * Browser-safe notification feed item. Recipient contact information and
 * delivery-worker state deliberately live outside this contract.
 */
export const PersistentWorldInAppNotificationSchema = z
  .object({
    id: z
      .string()
      .min(8)
      .max(240)
      .regex(/^[A-Za-z0-9_-]+$/),
    world: z
      .object({
        id: PersistentWorldIdSchema,
        name: z.string().trim().min(1).max(100),
        startsAt: PersistentWorldTimestampSchema,
      })
      .strict(),
    kind: PersistentWorldNotificationKindSchema,
    leadTimeMs: z.number().int().positive().nullable(),
    deliveredAt: PersistentWorldTimestampSchema,
    readAt: PersistentWorldTimestampSchema.nullable(),
  })
  .strict();
export type PersistentWorldInAppNotification = z.infer<
  typeof PersistentWorldInAppNotificationSchema
>;
