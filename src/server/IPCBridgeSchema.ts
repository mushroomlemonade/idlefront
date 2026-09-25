import { z } from "zod";
import {
  ClanTagSchema,
  GameConfigSchema,
  ID,
  LiveStatsSchema,
  PublicGameInfoSchema,
  PublicGameTypeSchema,
  TurnSchema,
  UsernameSchema,
} from "../core/Schemas";

export type InternalGameInfo = z.infer<typeof InternalGameInfoSchema>;
export type InternalPublicGames = z.infer<typeof InternalPublicGamesSchema>;
export type WorkerLobbyList = z.infer<typeof WorkerLobbyListSchema>;
export type WorkerReady = z.infer<typeof WorkerReadySchema>;
export type MasterLobbiesBroadcast = z.infer<
  typeof MasterLobbiesBroadcastSchema
>;

export type MasterUpdateGame = z.infer<typeof MasterUpdateGameSchema>;
export type MasterCreateGame = z.infer<typeof MasterCreateGameSchema>;
export type ManagedReservedSeat = z.infer<typeof ManagedReservedSeatSchema>;
export type ManagedGameOptions = z.infer<typeof ManagedGameOptionsSchema>;
export type MasterCreateManagedGame = z.infer<
  typeof MasterCreateManagedGameSchema
>;
export type MasterEndManagedGame = z.infer<typeof MasterEndManagedGameSchema>;
export type WorkerManagedGameReady = z.infer<
  typeof WorkerManagedGameReadySchema
>;
export type WorkerManagedGameTurns = z.infer<
  typeof WorkerManagedGameTurnsSchema
>;
export type WorkerManagedGameStats = z.infer<
  typeof WorkerManagedGameStatsSchema
>;
export type WorkerDeploymentDrainStatus = z.infer<
  typeof WorkerDeploymentDrainStatusSchema
>;
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
export type MasterMessage = z.infer<typeof MasterMessageSchema>;

const ManagedRequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * An offline-capable seat in a server-managed match. The identity hash is a
 * SHA-256 digest of the authenticated persistent ID; the raw credential never
 * crosses IPC or enters a frozen game roster.
 */
export const ManagedReservedSeatSchema = z
  .object({
    clientID: ID,
    persistentIdHash: z.string().regex(/^[a-f0-9]{64}$/),
    username: UsernameSchema,
    clanTag: ClanTagSchema,
    teamIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ManagedGameOptionsSchema = z
  .object({
    requestId: ManagedRequestIdSchema,
    expiresAt: z.number().int().nonnegative(),
    reservedSeats: z.array(ManagedReservedSeatSchema).min(1).max(200),
    initialTurns: z.array(TurnSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const clientIDs = new Set<string>();
    const identityHashes = new Set<string>();
    for (const [index, seat] of value.reservedSeats.entries()) {
      if (clientIDs.has(seat.clientID)) {
        context.addIssue({
          code: "custom",
          path: ["reservedSeats", index, "clientID"],
          message: "Reserved client IDs must be unique",
        });
      }
      clientIDs.add(seat.clientID);
      if (identityHashes.has(seat.persistentIdHash)) {
        context.addIssue({
          code: "custom",
          path: ["reservedSeats", index, "persistentIdHash"],
          message: "Reserved identity hashes must be unique",
        });
      }
      identityHashes.add(seat.persistentIdHash);
    }
    for (const [index, turn] of (value.initialTurns ?? []).entries()) {
      if (turn.turnNumber !== index) {
        context.addIssue({
          code: "custom",
          path: ["initialTurns", index, "turnNumber"],
          message: "Managed initial turns must be contiguous from turn zero",
        });
      }
    }
  });

// Master/worker-internal lobby info: PublicGameInfo plus the hashed creator
// ID (hosted lobbies only) used for the one-listed-lobby-per-creator check.
// Never sent to browsers — WorkerLobbyService.sanitizeGames converts to plain
// PublicGameInfo before anything reaches a client.
export const InternalGameInfoSchema = PublicGameInfoSchema.extend({
  creatorID: z.string().optional(),
});

export const InternalPublicGamesSchema = z.object({
  serverTime: z.number(),
  games: z.partialRecord(PublicGameTypeSchema, z.array(InternalGameInfoSchema)),
});

// --- Worker Messages ---

// Worker tells the master about its lobbies. Entries are deliberately not
// validated here: the master checks each against InternalGameInfoSchema and
// drops bad ones (MasterLobbyService.validLobbies), so a single malformed
// lobby can't invalidate the whole report and freeze the master's view of
// this worker's lobbies.
const WorkerLobbyListSchema = z.object({
  type: z.literal("lobbyList"),
  lobbies: z.array(z.unknown()),
});

const WorkerReadySchema = z.object({
  type: z.literal("workerReady"),
  workerId: z.number(),
});

const WorkerManagedGameReadySchema = z
  .object({
    type: z.literal("managedGameReady"),
    requestId: ManagedRequestIdSchema,
    gameID: ID,
    workerId: z.number().int().nonnegative(),
    outcome: z.enum(["created", "exists", "conflict", "failed"]),
    error: z.string().max(500).optional(),
  })
  .strict();

const WorkerManagedGameTurnsSchema = z
  .object({
    type: z.literal("managedGameTurns"),
    requestId: ManagedRequestIdSchema,
    gameID: ID,
    workerId: z.number().int().nonnegative(),
    turns: z.array(TurnSchema).min(1).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.turns.length; index++) {
      if (
        value.turns[index].turnNumber !==
        value.turns[index - 1].turnNumber + 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["turns", index, "turnNumber"],
          message: "Managed turn batches must be contiguous",
        });
      }
    }
  });

const WorkerManagedGameStatsSchema = z
  .object({
    type: z.literal("managedGameStats"),
    requestId: ManagedRequestIdSchema,
    gameID: ID,
    workerId: z.number().int().nonnegative(),
    stats: LiveStatsSchema,
  })
  .strict();

const WorkerDeploymentDrainStatusSchema = z
  .object({
    type: z.literal("deploymentDrainStatus"),
    workerId: z.number().int().nonnegative(),
    draining: z.boolean(),
    blockingGames: z.number().int().nonnegative(),
    managedGames: z.number().int().nonnegative(),
    lobbyGames: z.number().int().nonnegative(),
    activeClients: z.number().int().nonnegative(),
    pendingAdmissions: z.number().int().nonnegative(),
  })
  .strict();

export const WorkerMessageSchema = z.discriminatedUnion("type", [
  WorkerLobbyListSchema,
  WorkerReadySchema,
  WorkerManagedGameReadySchema,
  WorkerManagedGameTurnsSchema,
  WorkerManagedGameStatsSchema,
  WorkerDeploymentDrainStatusSchema,
]);

// --- Master Messages ---

const MasterUpdateGameSchema = z.object({
  type: z.literal("updateLobby"),
  gameID: z.string(),
  startsAt: z.number(),
});

// Broadcasts all public game info to all workers.
// Workers need information on all public lobbies so
// it can send it to the client.
const MasterLobbiesBroadcastSchema = z.object({
  type: z.literal("lobbiesBroadcast"),
  publicGames: InternalPublicGamesSchema,
  // Hosted lobbies the master wants delisted: a creator got two lobbies
  // listed concurrently on different workers, and only the dedup winner may
  // stay advertised. The owning worker clears the loser's listed flag so
  // worker state, host UI, and the broadcast agree.
  delistGameIDs: z.array(z.string()).optional(),
});

// Master sends a message to worker to schedule a new public game/lobby.
const MasterCreateGameSchema = z.object({
  type: z.literal("createGame"),
  gameID: z.string(),
  gameConfig: GameConfigSchema,
  publicGameType: PublicGameTypeSchema,
});

const MasterCreateManagedGameSchema = z
  .object({
    type: z.literal("createManagedGame"),
    gameID: ID,
    gameConfig: GameConfigSchema,
    startsAt: z.number().int().nonnegative(),
    requestId: ManagedRequestIdSchema,
    expiresAt: z.number().int().nonnegative(),
    reservedSeats: z.array(ManagedReservedSeatSchema).min(1).max(200),
    initialTurns: z.array(TurnSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt <= value.startsAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Managed game expiry must be after its start time",
      });
    }
    const options = ManagedGameOptionsSchema.safeParse({
      requestId: value.requestId,
      expiresAt: value.expiresAt,
      reservedSeats: value.reservedSeats,
      initialTurns: value.initialTurns,
    });
    if (!options.success) {
      for (const issue of options.error.issues) {
        context.addIssue({
          ...issue,
          path: issue.path,
        });
      }
    }
    if (
      value.gameConfig.maxPlayers !== undefined &&
      value.gameConfig.maxPlayers < value.reservedSeats.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["gameConfig", "maxPlayers"],
        message: "Managed games must have room for every reserved seat",
      });
    }
  });

const MasterEndManagedGameSchema = z
  .object({
    type: z.literal("endManagedGame"),
    gameID: ID,
  })
  .strict();

const MasterDeploymentDrainSchema = z
  .object({
    type: z.literal("deploymentDrain"),
    enabled: z.boolean(),
  })
  .strict();

export const MasterMessageSchema = z.discriminatedUnion("type", [
  MasterLobbiesBroadcastSchema,
  MasterCreateGameSchema,
  MasterCreateManagedGameSchema,
  MasterEndManagedGameSchema,
  MasterUpdateGameSchema,
  MasterDeploymentDrainSchema,
]);
