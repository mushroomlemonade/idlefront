import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import {
  CreatePersistentWorldRequestSchema,
  PersistentWorldIdSchema,
  PersistentWorldInAppNotificationSchema,
  PersistentWorldInvitationSecretSchema,
  PersistentWorldQuickChatRequestSchema,
  PersistentWorldQuickChatViewSchema,
  PersistentWorldReminderRequestSchema,
  PersistentWorldRsvpRequestSchema,
  PersistentWorldSessionRequestSchema,
  type NewPersistentWorldControllerSession,
} from "../../core/PersistentWorldSchemas";
import { PersistentIdSchema } from "../../core/Schemas";
import { verifyGuestPlayToken } from "../GuestPlayToken";
import {
  PersistentWorldService,
  persistentWorldServiceError,
} from "./PersistentWorldService";

const BearerTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const EmptyBodySchema = z.object({}).strict();
const GameplayIdentityBodySchema = z
  .object({ playToken: z.string().min(1).max(8192) })
  .strict();
const RsvpBodySchema = PersistentWorldRsvpRequestSchema.omit({
  invitationSecret: true,
});

export interface PersistentWorldRouterOptions {
  /** Receives unexpected server errors without exposing them to the client. */
  onInternalError?: (error: unknown) => void;
  /**
   * Authenticates the existing OpenFront account credential and creates a
   * persistent-world controller session. The HTTP body is required to be
   * empty so identity claims can only come from this trusted callback.
   */
  accountSessionFactory?: (context: {
    authorization: string | undefined;
  }) =>
    | NewPersistentWorldControllerSession
    | Promise<NewPersistentWorldControllerSession>;
  /**
   * Verifies the ordinary game credential at the application boundary and
   * returns a one-way SHA-256 identity digest. The token itself is never
   * stored in the persistent-world database.
   */
  gameplayIdentityVerifier?: (playToken: string) => string | Promise<string>;
  /** Mints a short-lived worker-verifiable credential for guest playtesting. */
  guestGameplayTokenFactory?: (identityId: string) => string;
  /** Temporary public dev control; never enable this in staging or prod. */
  allowPublicDevControls?: boolean;
}

function requireJson(req: Request): void {
  if (!req.is(["application/json", "application/*+json"])) {
    throw new PersistentWorldHttpError(
      415,
      "JSON_REQUIRED",
      "This endpoint accepts application/json only",
    );
  }
}

function bearerToken(req: Request, required: true): string;
function bearerToken(req: Request, required: false): string | undefined;
function bearerToken(req: Request, required: boolean): string | undefined {
  const authorization = req.get("authorization");
  if (!authorization && !required) return undefined;
  const value = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const parsed = BearerTokenSchema.safeParse(value);
  if (!parsed.success) {
    throw new PersistentWorldHttpError(
      401,
      "SESSION_REQUIRED",
      "A valid session bearer token is required",
    );
  }
  return parsed.data;
}

function invitationSecret(req: Request): string | undefined {
  const value = req.get("x-world-invite");
  if (value === undefined) return undefined;
  return PersistentWorldInvitationSecretSchema.parse(value);
}

function worldId(req: Request): string {
  return PersistentWorldIdSchema.parse(req.params.id);
}

function notificationId(req: Request): string {
  return PersistentWorldInAppNotificationSchema.shape.id.parse(req.params.id);
}

function requireNoQuery(req: Request): void {
  if (Object.keys(req.query).length !== 0) {
    throw new PersistentWorldHttpError(
      400,
      "QUERY_NOT_ALLOWED",
      "Persistent-world capabilities and request data must not appear in URLs",
    );
  }
}

function route(operation: RequestHandler): RequestHandler {
  return (req, res, next) => {
    try {
      const result = operation(req, res, next);
      if (result instanceof Promise) result.catch(next);
    } catch (error) {
      next(error);
    }
  };
}

class PersistentWorldHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PersistentWorldHttpError";
  }
}

/**
 * Mounted at `/api/worlds`. The collection itself is therefore `POST /`, not
 * the redundant `/api/worlds/worlds`. Invitation capabilities are accepted
 * only in `x-world-invite`, never in a URL or RSVP body.
 */
export function createPersistentWorldRouter(
  service: PersistentWorldService,
  options: PersistentWorldRouterOptions = {},
): Router {
  const router = Router();

  router.post(
    "/session",
    route((req, res) => {
      requireNoQuery(req);
      requireJson(req);
      const input = PersistentWorldSessionRequestSchema.parse(req.body);
      res.status(201).json(service.createGuestSession(input));
    }),
  );

  router.post(
    "/session/account",
    route(async (req, res) => {
      requireNoQuery(req);
      requireJson(req);
      EmptyBodySchema.parse(req.body);
      if (!options.accountSessionFactory) {
        throw new PersistentWorldHttpError(
          501,
          "ACCOUNT_SESSION_UNAVAILABLE",
          "Account-backed world sessions are not configured",
        );
      }
      const session = await options.accountSessionFactory({
        authorization: req.get("authorization"),
      });
      res.status(201).json(session);
    }),
  );

  router.get(
    "/session",
    route((req, res) => {
      requireNoQuery(req);
      res.json(service.resumeSession(bearerToken(req, true)));
    }),
  );

  router.post(
    "/session/game-identity",
    route(async (req, res) => {
      requireNoQuery(req);
      requireJson(req);
      const { playToken } = GameplayIdentityBodySchema.parse(req.body);
      const guestIdentityId = verifyGuestPlayToken(playToken);
      if (guestIdentityId !== null) {
        const session = service.resumeSession(bearerToken(req, true));
        if (session.identity.id !== guestIdentityId) {
          throw new PersistentWorldHttpError(
            403,
            "GUEST_GAMEPLAY_MISMATCH",
            "The guest gameplay credential belongs to another world session",
          );
        }
        res.json({ bound: true, playToken });
        return;
      }
      if (PersistentIdSchema.safeParse(playToken).success) {
        if (!options.guestGameplayTokenFactory) {
          throw new PersistentWorldHttpError(
            501,
            "GUEST_GAMEPLAY_UNAVAILABLE",
            "Guest gameplay is not configured",
          );
        }
        const guestToken = service.bindGuestGameplayIdentity(
          bearerToken(req, true),
          options.guestGameplayTokenFactory,
        );
        res.json({ bound: true, playToken: guestToken });
        return;
      }
      if (!options.gameplayIdentityVerifier) {
        throw new PersistentWorldHttpError(
          501,
          "GAME_IDENTITY_UNAVAILABLE",
          "Gameplay identity binding is not configured",
        );
      }
      const hash = await options.gameplayIdentityVerifier(playToken);
      service.bindGameplayIdentity(bearerToken(req, true), hash);
      res.json({ bound: true });
    }),
  );

  router.get(
    "/public",
    route((req, res) => {
      requireNoQuery(req);
      res.json(service.listPublic(bearerToken(req, false)));
    }),
  );

  router.get(
    "/mine",
    route((req, res) => {
      requireNoQuery(req);
      res.json(service.listMine(bearerToken(req, true)));
    }),
  );

  router.get(
    "/notifications",
    route((req, res) => {
      requireNoQuery(req);
      res.json(service.listNotifications(bearerToken(req, true)));
    }),
  );

  router.put(
    "/notifications/:id/read",
    route((req, res) => {
      requireNoQuery(req);
      requireJson(req);
      EmptyBodySchema.parse(req.body);
      res.json(
        service.markNotificationRead(
          bearerToken(req, true),
          notificationId(req),
        ),
      );
    }),
  );

  router.post(
    "/",
    route((req, res) => {
      requireNoQuery(req);
      requireJson(req);
      const input = CreatePersistentWorldRequestSchema.parse(req.body);
      res.status(201).json(service.createWorld(bearerToken(req, true), input));
    }),
  );

  router.get(
    "/:id",
    route((req, res) => {
      requireNoQuery(req);
      res.json(
        service.getSnapshot(
          worldId(req),
          bearerToken(req, false),
          invitationSecret(req),
        ),
      );
    }),
  );

  router.post(
    "/:id/unlock",
    route(async (req, res) => {
      requireNoQuery(req);
      requireJson(req);
      const input = z
        .object({
          password: z.string().min(1).max(128),
          displayName: z.string().trim().min(1).max(80),
        })
        .strict()
        .parse(req.body);
      await service.unlockWorld(
        worldId(req),
        bearerToken(req, true),
        input.password,
        input.displayName,
      );
      res.json({ unlocked: true });
    }),
  );

  router.post(
    "/:id/play-token",
    route((req, res) => {
      requireNoQuery(req);
      requireJson(req);
      EmptyBodySchema.parse(req.body);
      res.json({
        playToken: service.worldPlayToken(worldId(req), bearerToken(req, true)),
      });
    }),
  );

  router.put(
    "/:id/rsvp",
    route((req, res) => {
      requireNoQuery(req);
      requireJson(req);
      const input = RsvpBodySchema.parse(req.body);
      res.json(
        service.rsvp(worldId(req), bearerToken(req, true), {
          ...input,
          invitationSecret: invitationSecret(req),
        }),
      );
    }),
  );

  router.delete(
    "/:id/rsvp",
    route((req, res) => {
      requireNoQuery(req);
      service.leave(worldId(req), bearerToken(req, true));
      res.status(204).end();
    }),
  );

  router.post(
    "/:id/quick-chat",
    route((req, res) => {
      requireNoQuery(req);
      requireJson(req);
      const input = PersistentWorldQuickChatRequestSchema.parse(req.body);
      const message = service.postQuickChat(
        worldId(req),
        bearerToken(req, true),
        input,
      );
      res.status(201).json(
        PersistentWorldQuickChatViewSchema.parse({
          id: message.id,
          sender: {
            id: message.sender.id,
            displayName: message.sender.displayName,
          },
          phraseKey: message.phraseKey,
          sentAt: message.sentAt,
        }),
      );
    }),
  );

  router.put(
    "/:id/reminders",
    route((req, res) => {
      requireNoQuery(req);
      requireJson(req);
      const input = PersistentWorldReminderRequestSchema.parse(req.body);
      res.json(
        service.setReminders(worldId(req), bearerToken(req, true), input),
      );
    }),
  );

  router.post(
    "/:id/cancel",
    route((req, res) => {
      requireNoQuery(req);
      requireJson(req);
      EmptyBodySchema.parse(req.body);
      res.json(service.cancel(worldId(req), bearerToken(req, true)));
    }),
  );

  // TODO(remove-after-playtests): intentionally visible to every development
  // client so a broken world can be cleared without database access.
  router.post(
    "/:id/dev-end",
    route(async (req, res) => {
      requireNoQuery(req);
      requireJson(req);
      EmptyBodySchema.parse(req.body);
      if (!options.allowPublicDevControls) {
        throw new PersistentWorldHttpError(
          404,
          "DEV_CONTROL_UNAVAILABLE",
          "Development controls are unavailable on this server",
        );
      }
      const world = await service.endForDevelopment(
        worldId(req),
        bearerToken(req, true),
      );
      res.json({ ended: true, phase: world.phase });
    }),
  );

  router.post(
    "/:id/start",
    route((req, res) => {
      requireNoQuery(req);
      requireJson(req);
      EmptyBodySchema.parse(req.body);
      res.json(service.startCustomWorld(worldId(req), bearerToken(req, true)));
    }),
  );

  router.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) return;
      if (error instanceof PersistentWorldHttpError) {
        res.status(error.status).json({
          error: { code: error.code, message: error.message },
        });
        return;
      }
      const response = persistentWorldServiceError(error);
      if (response.status >= 500) options.onInternalError?.(error);
      res.status(response.status).json({
        error: { code: response.code, message: response.message },
      });
    },
  );

  return router;
}
