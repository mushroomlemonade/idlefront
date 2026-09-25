import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { IdleApiError, IdleService } from "./IdleService";

const IdSchema = z.string().min(8).max(160);

const SessionSchema = z
  .object({
    playerId: IdSchema.optional(),
    recoveryCode: z.string().min(24).max(160).optional(),
  })
  .strict();

const StateQuerySchema = z
  .object({
    playerId: IdSchema,
  })
  .strict();

const TapSchema = z
  .object({
    v: z.literal(1),
    playerId: IdSchema,
    sessionId: IdSchema,
    clientSeq: z.number().int().nonnegative().max(2_147_483_647),
    targetTerritoryId: z.string().regex(/^t\d{2}$/),
    clientMonoMs: z
      .number()
      .finite()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    pointerType: z.enum(["mouse", "touch", "pen", "keyboard", "unknown"]),
    visibility: z.enum(["visible", "hidden"]),
    xNormQ: z.number().int().min(0).max(10_000),
    yNormQ: z.number().int().min(0).max(10_000),
  })
  .strict();

function invalidRequest(error: z.ZodError): IdleApiError {
  return new IdleApiError(400, "INVALID_REQUEST", "Request validation failed", {
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function sendError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof IdleApiError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }
  next(error);
}

function bearerSession(req: Request): string {
  const value = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) {
    throw new IdleApiError(
      401,
      "SESSION_REQUIRED",
      "A session bearer token is required",
    );
  }
  return parsed.data;
}

function requireJson(req: Request): void {
  if (!req.is("application/json")) {
    throw new IdleApiError(
      415,
      "JSON_REQUIRED",
      "This endpoint accepts application/json only",
    );
  }
}

export function createIdleRouter(
  service: IdleService,
  options: { adminEnabled?: boolean; adminToken?: string } = {},
): Router {
  const router = Router();

  router.get("/health", (_req, res, next) => {
    try {
      res.json(service.health());
    } catch (error) {
      next(error);
    }
  });

  router.post("/session", (req, res, next) => {
    try {
      requireJson(req);
      const parsed = SessionSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw invalidRequest(parsed.error);
      res
        .status(201)
        .json(
          service.createSession(parsed.data.playerId, parsed.data.recoveryCode),
        );
    } catch (error) {
      sendError(error, res, next);
    }
  });

  router.get("/state", (req, res, next) => {
    try {
      const parsed = StateQuerySchema.safeParse(req.query);
      if (!parsed.success) throw invalidRequest(parsed.error);
      res.json(service.getState(parsed.data.playerId, bearerSession(req)));
    } catch (error) {
      sendError(error, res, next);
    }
  });

  router.post("/tap", (req, res, next) => {
    try {
      requireJson(req);
      const parsed = TapSchema.safeParse(req.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      res.json(
        service.recordTap(parsed.data, {
          ip: req.ip,
          userAgent: req.get("user-agent"),
        }),
      );
    } catch (error) {
      sendError(error, res, next);
    }
  });

  router.get("/admin/summary", (req, res, next) => {
    if (!options.adminEnabled) {
      res.status(404).json({
        error: { code: "ADMIN_DISABLED", message: "Admin summary is disabled" },
      });
      return;
    }
    if (!options.adminToken) {
      res.status(503).json({
        error: {
          code: "ADMIN_MISCONFIGURED",
          message: "Admin diagnostics require a server-side token",
        },
      });
      return;
    }
    const supplied = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    const expectedBuffer = Buffer.from(options.adminToken, "utf8");
    const suppliedBuffer = Buffer.from(supplied ?? "", "utf8");
    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
      res.status(401).json({
        error: {
          code: "ADMIN_UNAUTHORIZED",
          message: "Admin diagnostics require authorization",
        },
      });
      return;
    }
    try {
      res.json(service.adminSummary());
    } catch (error) {
      next(error);
    }
  });

  router.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) return;
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({
        error: {
          code: "IDLE_INTERNAL_ERROR",
          message: "Idle service request failed",
        },
        ...(process.env.IDLE_DEBUG_ERRORS === "true" ? { debug: message } : {}),
      });
    },
  );

  return router;
}
