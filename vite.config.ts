import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { createHtmlPlugin } from "vite-plugin-html";
import {
  type AssetManifest,
  buildAssetUrl,
  rewriteAssetsForCdn,
} from "./src/core/AssetUrls";
import {
  buildPublicAssetManifest,
  copyRootPublicFiles,
  createHashedPublicAssetFiles,
  getResourcesDir,
  writePublicAssetManifest,
} from "./src/server/PublicAssetManifest";

// Vite already handles these, but its good practice to define them explicitly
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dev-only stand-in for nginx's `location = /link` blocks (see nginx.conf).
//
// The desktop app's account-linking gate prints a short URL for the player to
// type by hand when it cannot open their browser for them. In production
// nginx 302s /link to /#steam-link, the client route that shows the code-entry
// form. Without this middleware the dev server falls through to Vite's SPA
// fallback and serves the home page instead -- a 200, so it does not look
// broken, but the printed URL silently would not work locally.
//
// A redirect rather than serving index.html directly, so dev matches
// production exactly and the desktop's siteUrlForAudience can emit one URL
// shape for every environment.
function steamLinkAliasRedirect(): Plugin {
  return {
    name: "steam-link-alias-redirect",
    configureServer(server) {
      // Matches on `originalUrl`, not `url`, and that is load-bearing.
      //
      // Whatever the documented middleware ordering, the measured behaviour
      // in this config is that by the time this handler runs `req.url` has
      // already been rewritten to "/index.html", while `originalUrl` still
      // holds what the browser asked for. Logging both showed a request to
      // /link arriving here as url="/index.html", originalUrl="/link".
      // Which middleware performs that rewrite was not established, so this
      // deliberately does not claim one.
      //
      // The practical warning: switching this to `req.url` type-checks,
      // lints, runs, and silently never matches -- the dev server just keeps
      // serving the home page with a 200. Re-verify against a running server
      // if you change it, and use a control path (e.g. /linkxyz) to prove a
      // 200 is not coming from the SPA fallback.
      server.middlewares.use((req, res, next) => {
        const requested = (req as { originalUrl?: string }).originalUrl;
        if (!requested) return next();

        // Decode before comparing, because nginx resolves percent-encoded
        // bytes before exact `location =` matching but URL.pathname does
        // not: "/link%2F" reaches production as /link/ and redirects, and
        // would otherwise fall straight through here. The whole point of
        // this plugin is that dev and production agree.
        let pathname: string;
        try {
          pathname = decodeURIComponent(
            new URL(requested, "http://x").pathname,
          );
        } catch {
          // Malformed percent-encoding -- not our route; let Vite answer.
          return next();
        }

        // Exact matches only, mirroring nginx's `location =`. A prefix match
        // would swallow any future /link/* route.
        if (pathname !== "/link" && pathname !== "/link/") return next();
        res.writeHead(302, { Location: "/#steam-link" });
        res.end();
      });
    },
  };
}

// `/idle/` was the first standalone prototype. Keep old phone bookmarks useful,
// but send them to the canonical client so every preview uses the real
// OpenFront map, input layer, lobby flow, and simulation.
function legacyIdlePreviewRedirect(): Plugin {
  return {
    name: "legacy-idle-preview-redirect",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET") return next();
        const requestedUrl =
          (req as { originalUrl?: string }).originalUrl ?? req.url;
        if (!requestedUrl) return next();
        const pathname = new URL(requestedUrl, "http://x").pathname;
        if (
          pathname !== "/idle" &&
          pathname !== "/idle/" &&
          pathname !== "/idle/index.html"
        ) {
          return next();
        }
        res.writeHead(302, { Location: "/" });
        res.end();
      });
    },
  };
}

// Keep the isolated renderer study out of the normal app's HTML rewrite.
function fogStudyPreview(): Plugin {
  return {
    name: "fog-study-preview",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requested =
          (req as { originalUrl?: string }).originalUrl ?? req.url ?? "";
        if (requested.split("?")[0] !== "/fog-preview.html") return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(
          fs.readFileSync(path.join(__dirname, "fog-preview.html"), "utf8"),
        );
      });
    },
  };
}

// Vite snapshots publicDir when the dev server starts. Generated maps can be
// added by a branch checkout or regeneration while that process stays alive,
// leaving a newly-added manifest outside Vite's cached public-file set even
// though its binary pages are present. Serve only map manifests dynamically so
// the client never receives the SPA HTML fallback where JSON is required.
function devMapManifestMiddleware(resourcesDir: string): Plugin {
  const mapsDir = path.resolve(resourcesDir, "maps");
  return {
    name: "dev-map-manifest-middleware",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const requestedUrl =
          (req as { originalUrl?: string }).originalUrl ?? req.url;
        if (!requestedUrl) return next();

        let pathname: string;
        try {
          pathname = decodeURIComponent(
            new URL(requestedUrl, "http://x").pathname,
          );
        } catch {
          return next();
        }
        const match = /^\/maps\/([a-z0-9][a-z0-9_-]*)\/manifest\.json$/i.exec(
          pathname,
        );
        if (!match) return next();

        const manifestPath = path.resolve(
          mapsDir,
          match[1].toLowerCase(),
          "manifest.json",
        );
        if (!manifestPath.startsWith(`${mapsDir}${path.sep}`)) return next();

        let size: number;
        try {
          const stat = fs.statSync(manifestPath);
          if (!stat.isFile()) return next();
          size = stat.size;
        } catch {
          return next();
        }

        res.writeHead(200, {
          "cache-control": "no-cache",
          "content-length": String(size),
          "content-type": "application/json; charset=utf-8",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(manifestPath).pipe(res);
      });
    },
  };
}

// Dev-only stand-in for the nginx random-worker routing (the openfront_workers
// upstream). Forwards these prefix-less POSTs to a randomly chosen worker port
// so the worker can mint a self-owned id. Runs as direct middleware (before
// vite's /api proxy).
const RANDOM_WORKER_PATHS = ["/api/create_game", "/api/adminbot/create_game"];
function randomWorkerCreateProxy(numWorkers: () => number): Plugin {
  return {
    name: "random-worker-create-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "POST") return next();
        const path = (req.url ?? "").split("?")[0];
        if (!RANDOM_WORKER_PATHS.includes(path)) return next();
        const port = 3001 + Math.floor(Math.random() * numWorkers());
        const proxyReq = http.request(
          {
            host: "localhost",
            port,
            path,
            method: "POST",
            headers: req.headers,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", (err) => {
          res.statusCode = 502;
          res.end(`create proxy error: ${err.message}`);
        });
        req.pipe(proxyReq);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isProduction = mode === "production";
  let devNumWorkers = parseInt(env.NUM_WORKERS ?? "2", 10);
  // Vite and the backend can be launched independently. Inject the running
  // server's public bootstrap, not an unrelated shell's worker-count default.
  const liveDevBootstrap = (): Plugin => ({
    name: "live-dev-bootstrap",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      async handler() {
        try {
          const response = await fetch(
            "http://127.0.0.1:3000/api/client-config",
            { signal: AbortSignal.timeout(2000) },
          );
          if (!response.ok) return;
          const config = await response.json();
          if (!Number.isSafeInteger(config.numWorkers) || config.numWorkers < 1)
            return;
          const safeConfig: Record<string, string | number> = {
            numWorkers: config.numWorkers,
          };
          for (const key of [
            "gameEnv",
            "jwtAudience",
            "turnstileSiteKey",
            "instanceId",
            "gitCommit",
          ])
            if (typeof config[key] === "string") safeConfig[key] = config[key];
          devNumWorkers = config.numWorkers;
          return [
            {
              tag: "script",
              injectTo: "body",
              children: `Object.assign(window.BOOTSTRAP_CONFIG, ${JSON.stringify(safeConfig).replace(/</g, "\\u003c")});`,
            },
          ];
        } catch {
          // Static UI work still loads while the backend is offline.
          return;
        }
      },
    },
  });
  const resourcesDir = getResourcesDir(__dirname);
  const sourceDirs = [resourcesDir];
  const assetManifest: AssetManifest = isProduction
    ? buildPublicAssetManifest(sourceDirs)
    : {};
  const cdnBase = env.CDN_BASE ?? "";
  const htmlAssetData = {
    assetManifest: JSON.stringify(assetManifest),
    cdnBase: JSON.stringify(cdnBase),
    gameEnv: JSON.stringify(env.GAME_ENV ?? "dev"),
    numWorkers: JSON.stringify(parseInt(env.NUM_WORKERS ?? "2", 10)),
    turnstileSiteKey: JSON.stringify(
      env.TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA",
    ),
    jwtAudience: JSON.stringify(env.DOMAIN ?? "localhost"),
    instanceId: JSON.stringify(env.INSTANCE_ID ?? "DEV_ID"),
    manifestHref: buildAssetUrl("manifest.json", assetManifest, cdnBase),
    faviconHref: buildAssetUrl("images/Favicon.svg", assetManifest, cdnBase),
    gameplayScreenshotUrl: buildAssetUrl(
      "images/GameplayScreenshot.png",
      assetManifest,
      cdnBase,
    ),
    backgroundImageUrl: buildAssetUrl(
      "images/background.webp",
      assetManifest,
      cdnBase,
    ),
  };

  // Vite's HTML transform replaces the source <script src="/src/client/Main.ts">
  // with the hashed bundle URL and injects <link rel="modulepreload"> /
  // <link rel="stylesheet"> tags. rewriteAssetsForCdn rewrites those refs to
  // an EJS placeholder so RenderHtml.ts can prefix them with CDN_BASE at
  // request time.
  const injectCdnBaseTemplate = (): Plugin => ({
    name: "inject-cdn-base-template",
    apply: "build" as const,
    enforce: "post",
    transformIndexHtml: rewriteAssetsForCdn,
  });

  let viteBundleFiles: string[] = [];
  const syncHashedPublicAssets = (): Plugin => ({
    name: "sync-hashed-public-assets",
    apply: "build" as const,
    writeBundle(_options, bundle) {
      viteBundleFiles = Object.keys(bundle);
    },
    closeBundle() {
      const outDir = path.join(__dirname, "static");
      copyRootPublicFiles(resourcesDir, outDir);
      // Run the source→hashed copy first; createHashedPublicAssetFiles iterates
      // assetManifest and expects every key to resolve to a file in resources/.
      // Vite's bundle output (assets/...) doesn't, so it's merged in after.
      createHashedPublicAssetFiles(sourceDirs, outDir, assetManifest);
      // Track Vite's own bundle output (vendor chunks, JS, CSS, workers under
      // static/assets/) in the manifest so the deploy-time R2 upload covers
      // them alongside the hashed source assets. Skip non-assets/ emits like
      // index.html — those are served by the app, not from R2.
      for (const fileName of viteBundleFiles) {
        if (!fileName.startsWith("assets/")) continue;
        assetManifest[fileName] = `/${fileName}`;
      }
      writePublicAssetManifest(outDir, assetManifest);
    },
  });

  // In dev, redirect visits to /w*/game/* to "/" so Vite serves the index.html.
  const devGameHtmlBypass = (req?: {
    url?: string;
    method?: string;
    headers?: { accept?: string | string[] };
  }) => {
    if (req?.method !== "GET") return undefined;
    const accept = req.headers?.accept;
    const acceptValue = Array.isArray(accept)
      ? accept.join(",")
      : (accept ?? "");
    if (!acceptValue.includes("text/html")) return undefined;
    if (!req.url) return undefined;
    if (/^\/w\d+\/game\/[^/]+/.test(req.url)) {
      return "/";
    }
    return undefined;
  };

  return {
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./tests/setup.ts",
    },
    root: "./",
    base: "/",
    publicDir: isProduction ? false : "resources",

    resolve: {
      tsconfigPaths: true,
      alias: {
        resources: path.resolve(__dirname, "resources"),
      },
    },

    plugins: [
      ...(!isProduction
        ? [
            devMapManifestMiddleware(resourcesDir),
            fogStudyPreview(),
            liveDevBootstrap(),
            randomWorkerCreateProxy(() => devNumWorkers),
            legacyIdlePreviewRedirect(),
            steamLinkAliasRedirect(),
          ]
        : []),
      ...(isProduction
        ? []
        : [
            createHtmlPlugin({
              minify: false,
              entry: "/src/client/Main.ts",
              template: "index.html",
              inject: {
                data: {
                  gitCommit: JSON.stringify("DEV"),
                  ...htmlAssetData,
                },
              },
            }),
          ]),
      ...(isProduction
        ? [injectCdnBaseTemplate(), syncHashedPublicAssets()]
        : []),
      tailwindcss(),
    ],

    define: {
      __ASSET_MANIFEST__: JSON.stringify(assetManifest),
      "process.env.WEBSOCKET_URL": JSON.stringify(
        isProduction ? "" : "localhost:3000",
      ),
      "process.env.GAME_ENV": JSON.stringify(isProduction ? "prod" : "dev"),
      "process.env.STRIPE_PUBLISHABLE_KEY": JSON.stringify(
        env.STRIPE_PUBLISHABLE_KEY,
      ),
      // Force empty under vitest (mode "test") so the getApiBase localhost-
      // fallback test is deterministic regardless of any API_DOMAIN in the
      // host shell / CI environment.
      "process.env.API_DOMAIN": JSON.stringify(
        mode === "test" ? "" : (env.API_DOMAIN ?? ""),
      ),
      // Add other process.env variables if needed, OR migrate code to import.meta.env
    },

    build: {
      outDir: "static", // Webpack outputs to 'static', assuming we want to keep this.
      emptyOutDir: true,
      assetsDir: "assets", // Sub-directory for assets
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            const vendorModules = ["howler", "zod"];
            if (vendorModules.some((module) => id.includes(module))) {
              return "vendor";
            }
          },
        },
      },
    },

    server: {
      port: 9000,
      watch: { ignored: ["**/.data/**", "**/.dev-logs/**"] },
      host: process.env.VITE_HOST === "lan",
      // Automatically open the browser when the server starts
      open: process.env.SKIP_BROWSER_OPEN !== "true",
      proxy: {
        "/lobbies": {
          target: "ws://localhost:3000",
          ws: true,
          changeOrigin: true,
        },
        // Worker proxies
        "^/w[0-9]+(?=/|$)": {
          target: "ws://127.0.0.1:3000",
          ws: true,
          secure: false,
          changeOrigin: true,
          bypass: (req) => devGameHtmlBypass(req),
        },
        "/dev-account-api": {
          target: "http://127.0.0.1:8787",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/dev-account-api/, ""),
        },
        // API proxies
        "/api": {
          target: "http://localhost:3000",
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
