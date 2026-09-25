import cluster from "cluster";
import crypto from "crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { GameEnv } from "../core/configuration/Config";
import {
  removeDeploymentDrainStatus,
  writeDeploymentDrainStatus,
} from "./DeploymentDrainStatusFile";
import { issueGuestPlayToken } from "./GuestPlayToken";
import { createIdleRouter, IdleService } from "./idle";
import { verifyClientToken } from "./jwt";
import { logger } from "./Logger";
import { MapPlaylist } from "./MapPlaylist";
import { MasterLobbyService } from "./MasterLobbyService";
import { setNoStoreHeaders } from "./NoStoreHeaders";
import {
  createPersistentWorldRouter,
  PersistentWorldNotificationWorker,
  PersistentWorldRepository,
  PersistentWorldService,
  PersistentWorldServiceError,
} from "./persistent";
import { PersistentWorldRuntimeBridge } from "./PersistentWorldRuntimeBridge";
import { renderAppShell } from "./RenderHtml";
import { ServerEnv } from "./ServerEnv";
import { applyStaticAssetCacheControl } from "./StaticAssetCache";
import { createTrustedProxyPredicate } from "./TrustedProxy";
import { installWorkerReverseProxy } from "./WorkerReverseProxy";

const playlist = new MapPlaylist();
let lobbyService: MasterLobbyService;

const app = express();
const server = http.createServer(app);

const log = logger.child({ comp: "m" });
let idleService: IdleService | undefined;
let idleRouter: ReturnType<typeof createIdleRouter> | undefined;
let persistentWorldService: PersistentWorldService | undefined;
let persistentWorldRouter:
  ReturnType<typeof createPersistentWorldRouter> | undefined;
let persistentWorldNotificationTimer: NodeJS.Timeout | undefined;
let persistentWorldNotificationTickInFlight = false;
let persistentWorldRuntimeBridge: PersistentWorldRuntimeBridge | undefined;
let masterShutdownStarted = false;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Trust only local loopback in development or the exact, configured gateway
// of the isolated production container bridge. A direct LAN/public client
// therefore cannot spoof X-Forwarded-For to rotate rate-limit keys or
// telemetry pseudonyms.
app.set(
  "trust proxy",
  createTrustedProxyPredicate(process.env.IDLE_TRUSTED_PROXY_ADDRESS),
);

// Production exposes only the master port. Keep worker-owned HTTP and sockets
// on loopback and stream canonical /wN routes through this single origin. This
// must precede parsers and rate-limit middleware so gameplay payloads are not
// buffered or interpreted by the master.
if (cluster.isPrimary) {
  installWorkerReverseProxy(app, server, {
    numWorkers: ServerEnv.numWorkers(),
  });
}

// Run hard transport ceilings before JSON parsing. Human taps still reach the
// durable watchdog, while malformed or hostile floods cannot consume
// unbounded parser, synchronous SQLite, or disk capacity.
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
app.use(
  "/api/worlds/session",
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(
  "/api/worlds",
  rateLimit({
    windowMs: 60_000,
    max: 300,
    keyGenerator: (req) => {
      const token = req
        .get("authorization")
        ?.match(/^Bearer ([A-Za-z0-9_-]{32,512})$/)?.[1];
      const session = token
        ? persistentWorldService?.repository.resumeControllerSession(token)
        : undefined;
      return session
        ? `world-controller:${session.identity.id}`
        : ipKeyGenerator(req.ip ?? "unknown");
    },
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(express.json());

// Serve the shared app shell for the root document.
app.use(async (req, res, next) => {
  if (req.path === "/") {
    try {
      await renderAppShell(
        res,
        path.join(__dirname, "../../static/index.html"),
      );
    } catch (error) {
      log.error("Error rendering index.html:", error);
      res.status(500).send("Internal Server Error");
    }
  } else {
    next();
  }
});

app.use(
  express.static(path.join(__dirname, "../../static"), {
    maxAge: "1y", // Set max-age to 1 year for all static assets
    setHeaders: (res) => {
      applyStaticAssetCacheControl(
        res.setHeader.bind(res),
        res.req.originalUrl,
      );
    },
  }),
);

app.use(
  rateLimit({
    windowMs: 1000, // 1 second
    max: 20, // 20 requests per IP per second
    // The route-specific ceilings above protect transport resources. Beneath
    // those ceilings, every validly authenticated tap reaches the watchdog.
    skip: (req) =>
      req.path === "/api/idle/tap" ||
      req.path.startsWith("/api/worlds/") ||
      req.path === "/api/worlds",
  }),
);

app.use("/api", (_req, res, next) => {
  setNoStoreHeaders(res);
  next();
});

// This lazy mount must be registered before the SPA fallback. Only the primary
// process opens SQLite; workers import this module too, but never initialize it.
app.use("/api/idle", (req, res, next) => {
  if (!idleRouter) {
    res.status(503).json({
      error: { code: "IDLE_STARTING", message: "Idle service is starting" },
    });
    return;
  }
  idleRouter(req, res, next);
});

// Durable invitation lobbies live on the master and remain separate from the
// worker-owned ordinary OpenFront match lifecycle. Do not construct a normal
// GameServer merely because an invitation reaches its scheduled start time.
app.use("/api/worlds", (req, res, next) => {
  if (!persistentWorldRouter) {
    res.status(503).json({
      error: {
        code: "PERSISTENT_WORLDS_STARTING",
        message: "Persistent-world service is starting",
      },
    });
    return;
  }
  persistentWorldRouter(req, res, next);
});

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (
    !req.path.startsWith("/api/idle") &&
    !req.path.startsWith("/api/worlds")
  ) {
    next(error);
    return;
  }
  res.status(400).json({
    error: { code: "INVALID_JSON", message: "Request body is not valid JSON" },
  });
});

// Start the master process
export async function startMaster() {
  if (!cluster.isPrimary) {
    throw new Error(
      "startMaster() should only be called in the primary process",
    );
  }

  log.info(`Primary ${process.pid} is running`);
  idleService = new IdleService({ dbPath: process.env.IDLE_DB_PATH });
  idleRouter = createIdleRouter(idleService, {
    adminEnabled: process.env.IDLE_ADMIN_ENABLED === "true",
    adminToken: process.env.IDLE_ADMIN_TOKEN,
  });
  process.once("exit", () => idleService?.close());

  // Managed runtimes are dispatched through the same shard-aware master
  // service as ordinary lobbies. It is safe to construct this before workers:
  // durable provisioning requests remain retryable until their shard reports
  // ready.
  lobbyService = new MasterLobbyService(playlist, log);

  const persistentWorldRepository = new PersistentWorldRepository({
    dbPath: process.env.PERSISTENT_WORLD_DB_PATH,
  });
  persistentWorldRuntimeBridge = new PersistentWorldRuntimeBridge(
    persistentWorldRepository,
    playlist,
    (command) => lobbyService.createManagedGame(command),
    (gameID) => lobbyService.endManagedGame(gameID),
  );
  lobbyService.setManagedGameTurnHandler((message) =>
    persistentWorldRuntimeBridge!.persistTurns(message),
  );
  lobbyService.setManagedGameStatsHandler((message) =>
    persistentWorldRuntimeBridge!.persistStats(message),
  );
  persistentWorldService = new PersistentWorldService(
    persistentWorldRepository,
    {
      runtimeCoordinator: persistentWorldRuntimeBridge,
      // Debug quick-start schedules a world a few seconds out. Production
      // retains the domain's normal one-minute minimum.
      minimumStartDelayMs: ServerEnv.env() === GameEnv.Dev ? 1_000 : undefined,
      onRuntimeError: (error) =>
        log.warn("Persistent-world runtime reconciliation failed", error),
    },
  );
  persistentWorldService.activateDueWorlds();
  persistentWorldService.startScheduler();
  const persistentWorldNotificationWorker =
    new PersistentWorldNotificationWorker(persistentWorldRepository, {
      // In-app notices are delivered immediately by the same durable worker.
      // Email jobs remain retryable until an operator-owned provider replaces
      // this explicit unavailable sink; they are never marked delivered by a
      // fake or console-only transport.
      emailSink: {
        async send() {
          throw new Error("Persistent-world email delivery is not configured");
        },
      },
    });
  const runPersistentWorldNotifications = () => {
    if (persistentWorldNotificationTickInFlight) return;
    persistentWorldNotificationTickInFlight = true;
    void persistentWorldNotificationWorker
      .runDueBatch()
      .catch((error) =>
        log.error("Persistent-world notification worker failed", error),
      )
      .finally(() => {
        persistentWorldNotificationTickInFlight = false;
      });
  };
  runPersistentWorldNotifications();
  persistentWorldNotificationTimer = setInterval(
    runPersistentWorldNotifications,
    5_000,
  );
  persistentWorldNotificationTimer.unref?.();
  persistentWorldRouter = createPersistentWorldRouter(persistentWorldService, {
    allowPublicDevControls: ServerEnv.env() === GameEnv.Dev,
    onInternalError: (error) =>
      log.error("Persistent-world request failed", error),
    gameplayIdentityVerifier: async (playToken) => {
      const verified = await verifyClientToken(playToken);
      if (verified.type !== "success") {
        throw new PersistentWorldServiceError(
          401,
          "GAME_IDENTITY_INVALID",
          "The gameplay identity could not be verified",
        );
      }
      return crypto
        .createHash("sha256")
        .update(verified.persistentId)
        .digest("hex");
    },
    guestGameplayTokenFactory: (identityId) => issueGuestPlayToken(identityId),
  });
  process.once("exit", () => {
    if (persistentWorldNotificationTimer) {
      clearInterval(persistentWorldNotificationTimer);
    }
    persistentWorldService?.close();
  });
  log.info(`Setting up ${ServerEnv.numWorkers()} workers...`);

  const INSTANCE_ID =
    ServerEnv.env() === GameEnv.Dev
      ? "DEV_ID"
      : crypto.randomBytes(4).toString("hex");
  process.env.INSTANCE_ID = INSTANCE_ID;

  log.info(`Instance ID: ${INSTANCE_ID}`);

  const deploymentDrainStatusPath = process.env.IDLE_DEPLOY_DRAIN_STATUS_PATH;
  if (deploymentDrainStatusPath) {
    try {
      removeDeploymentDrainStatus(deploymentDrainStatusPath);
    } catch (error) {
      log.error("Could not clear stale deployment-drain status", error);
    }
    lobbyService.setDeploymentDrainStatusHandler((status) => {
      try {
        writeDeploymentDrainStatus(
          deploymentDrainStatusPath,
          INSTANCE_ID,
          status,
        );
      } catch (error) {
        log.error("Could not write deployment-drain status", error);
      }
    });
    process.once("exit", () => {
      try {
        removeDeploymentDrainStatus(deploymentDrainStatusPath);
      } catch {
        // The host-side deploy wrapper also removes stale status files.
      }
    });
  }

  process.on("SIGUSR2", () => {
    if (masterShutdownStarted) return;
    log.info("deployment drain requested; stopping new game scheduling");
    persistentWorldService?.stopScheduler();
    lobbyService.beginDeploymentDrain();
  });
  process.on("SIGUSR1", () => {
    if (masterShutdownStarted) return;
    log.info("deployment drain cancelled; resuming game scheduling");
    lobbyService.cancelDeploymentDrain();
    persistentWorldService?.activateDueWorlds();
    persistentWorldService?.startScheduler();
  });

  // Fork workers
  for (let i = 0; i < ServerEnv.numWorkers(); i++) {
    const worker = cluster.fork({
      WORKER_ID: i,
      INSTANCE_ID,
    });

    lobbyService.registerWorker(i, worker);
    log.info(`Started worker ${i} (PID: ${worker.process.pid})`);
  }

  // Handle worker crashes
  cluster.on("exit", (worker, code, signal) => {
    const workerId = (worker as any).process?.env?.WORKER_ID;
    if (workerId === undefined) {
      log.error(`worker crashed could not find id`);
      return;
    }

    const workerIdNum = parseInt(workerId);
    lobbyService.removeWorker(workerIdNum);
    persistentWorldRuntimeBridge?.invalidateAll();

    // During a controlled container stop each worker flushes its final managed
    // turn batch before disconnecting. Do not replace it while the master is
    // draining or the replacement can race the database close and keep the
    // container alive past Docker's stop timeout.
    if (masterShutdownStarted) {
      log.info(
        `Worker ${workerId} (PID: ${worker.process.pid}) drained during shutdown`,
      );
      return;
    }

    log.warn(
      `Worker ${workerId} (PID: ${worker.process.pid}) died with code: ${code} and signal: ${signal}`,
    );
    log.info(`Restarting worker ${workerId}...`);

    // Restart the worker with the same ID
    const newWorker = cluster.fork({
      WORKER_ID: workerId,
      INSTANCE_ID,
    });

    lobbyService.registerWorker(workerIdNum, newWorker);
    log.info(
      `Restarted worker ${workerId} (New PID: ${newWorker.process.pid})`,
    );
  });

  const PORT = 3000;
  server.listen(PORT, () => {
    log.info(`Master HTTP server listening on port ${PORT}`);
  });

  const gracefullyStopMaster = (signal: string) => {
    if (masterShutdownStarted) return;
    masterShutdownStarted = true;
    log.info(`master received ${signal}, draining gameplay workers`);

    // Stop accepting new HTTP and WebSocket upgrades while keeping IPC alive
    // long enough for every worker to persist its final turn batch.
    server.close();
    const workers = Object.values(cluster.workers ?? {}).filter(
      (worker): worker is NonNullable<typeof worker> => worker !== undefined,
    );
    if (workers.length === 0) {
      process.exit(0);
      return;
    }

    let remaining = workers.length;
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(forceExit);
      process.exit(0);
    };
    const forceExit = setTimeout(() => {
      log.warn("worker drain deadline elapsed; forcing master shutdown", {
        remaining,
      });
      for (const worker of workers) {
        if (!worker.isDead()) worker.kill("SIGKILL");
      }
      finish();
    }, 15_000);

    for (const worker of workers) {
      worker.once("exit", () => {
        remaining -= 1;
        if (remaining === 0) finish();
      });
      worker.kill("SIGTERM");
    }
  };

  process.once("SIGTERM", () => gracefullyStopMaster("SIGTERM"));
  process.once("SIGINT", () => gracefullyStopMaster("SIGINT"));
}

app.get("/api/client-config", (_req, res) => {
  setNoStoreHeaders(res);
  res.json({
    numWorkers: ServerEnv.numWorkers(),
    gameEnv: ServerEnv.gameEnvName(),
    jwtAudience: ServerEnv.jwtAudience(),
    turnstileSiteKey: ServerEnv.turnstileSiteKey(),
    instanceId: ServerEnv.instanceId(),
    gitCommit: ServerEnv.gitCommit(),
  });
});

app.get("/api/health", (_req, res) => {
  const ready =
    (lobbyService?.isHealthy() ?? false) &&
    persistentWorldService !== undefined;
  if (ready) {
    res.json({ status: "ok" });
  } else {
    res.status(503).json({ status: "unavailable" });
  }
});

// SPA fallback route
app.get("/{*splat}", async function (_req, res) {
  try {
    const htmlPath = path.join(__dirname, "../../static/index.html");
    await renderAppShell(res, htmlPath);
  } catch (error) {
    log.error("Error rendering SPA fallback:", error);
    res.status(500).send("Internal Server Error");
  }
});
