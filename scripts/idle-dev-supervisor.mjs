import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function componentSpec(name, config) {
  const cwd = config.Workspace;
  switch (name) {
    case "Gateway":
      return {
        cwd,
        port: 3100,
        args: [
          "scripts/idle-windows-launcher.mjs",
          "Gateway",
          config.ConfigPath,
        ],
        env: {},
      };
    case "Expo":
      return {
        cwd: path.join(cwd, "apps/mobile"),
        port: 8081,
        args: [
          "node_modules/expo/bin/cli",
          "start",
          "--go",
          "--localhost",
          "--port",
          "8081",
        ],
        env: {
          EXPO_PUBLIC_GAME_URL: "https://atlas-dev.sightings.today/?debug=1",
        },
      };
    case "Web":
      return {
        cwd,
        port: 9000,
        args: [
          "node_modules/vite/bin/vite.js",
          "--host",
          "0.0.0.0",
          "--port",
          "9000",
          "--strictPort",
        ],
        env: {},
      };
    case "Backend":
      return {
        cwd,
        port: 3000,
        args: ["--import", "tsx", "src/server/Server.ts"],
        env: {
          GAME_ENV: "dev",
          NUM_WORKERS: "2",
          IDLE_DISABLE_PUBLIC_LOBBIES: "1",
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          API_KEY: "WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION",
          ADMIN_BOT_API_KEY:
            "WARNING_DEV_ADMIN_BOT_KEY_DO_NOT_USE_IN_PRODUCTION",
          DOMAIN: "localhost",
          GIT_COMMIT: "DEV",
        },
      };
    default:
      throw new Error(`Unknown component: ${name}`);
  }
}

export function portOpen(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}

async function main() {
  const [name, configPath] = process.argv.slice(2);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.ConfigPath = path.resolve(configPath);
  const spec = componentSpec(name, config);
  await mkdir(config.LogsPath, { recursive: true });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let failures = 0;
  for (;;) {
    // Do not kill, adopt, or duplicate existing sessions. Wait for their port
    // to become free; never restart a game just because it responds slowly.
    if (
      (await portOpen(spec.port, "127.0.0.1")) ||
      (await portOpen(spec.port, "::1"))
    ) {
      await delay(5000);
      continue;
    }
    // One log per launch. No automatic deletion of diagnostic history.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const log = createWriteStream(
      path.join(config.LogsPath, `${name}-${stamp}.log`),
      { flags: "a" },
    );
    const started = Date.now();
    const child = spawn(process.execPath, spec.args, {
      cwd: spec.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...spec.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    await new Promise((resolve) => {
      child.once("error", (error) => {
        log.write(`Launch failed: ${error.message}\n`);
        resolve();
      });
      child.once("close", (code, signal) => {
        log.write(`Exited: ${code}, ${signal}\n`);
        resolve();
      });
    });
    log.end();
    failures = Date.now() - started > 60000 ? 0 : Math.min(failures + 1, 5);
    await delay(Math.min(60000, 2000 * 2 ** failures));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
