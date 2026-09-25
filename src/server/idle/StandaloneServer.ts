import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import http from "http";
import { pathToFileURL } from "url";
import { setNoStoreHeaders } from "../NoStoreHeaders";
import { createTrustedProxyPredicate } from "../TrustedProxy";
import { createIdleRouter } from "./IdleRoutes";
import { IdleService } from "./IdleService";

export function createStandaloneIdleApp(service: IdleService) {
  const app = express();
  app.disable("x-powered-by");
  app.set(
    "trust proxy",
    createTrustedProxyPredicate(process.env.IDLE_TRUSTED_PROXY_ADDRESS),
  );

  app.use(
    "/api/idle/tap",
    rateLimit({
      windowMs: 1000,
      max: 40,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    rateLimit({
      windowMs: 60_000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    "/api/idle/session",
    rateLimit({
      windowMs: 60_000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(express.json({ limit: "8kb" }));
  app.use("/api", (_req, res, next) => {
    setNoStoreHeaders(res);
    next();
  });
  app.use(
    "/api/idle",
    createIdleRouter(service, {
      // The public preview authority never exposes the watchdog console. A
      // future admin origin must have its own authenticated boundary.
      adminEnabled: false,
    }),
  );
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/idle")) {
      next(error);
      return;
    }
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 413
        ? 413
        : 400;
    setNoStoreHeaders(res);
    res.status(status).json({
      error: {
        code: status === 413 ? "REQUEST_TOO_LARGE" : "INVALID_JSON",
        message:
          status === 413
            ? "Request body is too large"
            : "Request body is not valid JSON",
      },
    });
  });
  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });
  return app;
}

export async function startStandaloneIdleServer() {
  const host = process.env.IDLE_AUTHORITY_HOST ?? "127.0.0.1";
  const port = Number(process.env.IDLE_AUTHORITY_PORT ?? "3000");
  if (
    host !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      "Idle authority must use loopback and a valid IDLE_AUTHORITY_PORT",
    );
  }

  const service = new IdleService({ dbPath: process.env.IDLE_DB_PATH });
  const server = http.createServer(createStandaloneIdleApp(service));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    service.close();
    throw error;
  }

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      service.close();
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return { server, service };
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  startStandaloneIdleServer()
    .then(({ server }) => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 3000;
      process.stdout.write(
        `Pressure Atlas authority listening on 127.0.0.1:${port}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `Pressure Atlas authority failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
