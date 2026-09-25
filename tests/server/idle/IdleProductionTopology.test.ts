import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { IdleService } from "../../../src/server/idle";
import { PersistentWorldRepository } from "../../../src/server/persistent";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

describe("IdleFront production topology", () => {
  it("installs worker streaming before master body parsing", () => {
    const master = source("src/server/Master.ts");
    const proxyInstall = master.indexOf(
      "installWorkerReverseProxy(app, server",
    );
    const jsonParser = master.indexOf("app.use(express.json())");

    expect(proxyInstall).toBeGreaterThan(-1);
    expect(jsonParser).toBeGreaterThan(proxyInstall);
  });

  it("keeps persistent worlds in the mounted and atomically backed-up store", () => {
    const dockerfile = source("deploy/idle/Dockerfile");
    const environment = source("deploy/idle/openfront-idle.env.example");
    const generalEnvironment = source("example.env");
    const deployment = source("deploy/idle/deploy.sh");
    const databasePath = "/var/lib/openfront-idle/idle.sqlite";

    expect(dockerfile).toContain(
      `ENV PERSISTENT_WORLD_DB_PATH=${databasePath}`,
    );
    expect(environment).toContain(`IDLE_DB_PATH=${databasePath}`);
    expect(environment).toContain(`PERSISTENT_WORLD_DB_PATH=${databasePath}`);
    expect(generalEnvironment).toContain(
      "PERSISTENT_WORLD_DB_PATH=.data/idle-demo.sqlite",
    );
    expect(deployment).toContain(
      'if [ "$persistent_world_db_path" != "$db_path" ]',
    );
    expect(dockerfile).toContain(
      "ENV IDLE_DEPLOY_DRAIN_STATUS_PATH=/var/lib/openfront-idle/deployment-drain.status",
    );
    expect(environment).toContain(
      "IDLE_DEPLOY_DRAIN_STATUS_PATH=/var/lib/openfront-idle/deployment-drain.status",
    );
    expect(deployment).toContain("docker kill --signal=USR2 openfront-idle");
    expect(deployment).toContain("docker kill --signal=USR1 openfront-idle");
  });

  it("can open both namespaced stores in one SQLite file", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "idlefront-shared-db-test-"),
    );
    const databasePath = path.join(directory, "idle.sqlite");
    let idle: IdleService | undefined;
    let worlds: PersistentWorldRepository | undefined;
    let inspection: DatabaseSync | undefined;
    try {
      idle = new IdleService({ dbPath: databasePath });
      worlds = new PersistentWorldRepository({ dbPath: databasePath });
      worlds.close();
      worlds = undefined;
      idle.close();
      idle = undefined;

      inspection = new DatabaseSync(databasePath);
      const tables = inspection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name));
      expect(tables).toContain("idle_worlds");
      expect(tables).toContain("persistent_worlds");
      expect(tables).toContain("persistent_world_schema_migrations");
    } finally {
      inspection?.close();
      worlds?.close();
      idle?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes only the master origin while keeping workers internal", () => {
    const dockerfile = source("deploy/idle/Dockerfile");
    const service = source("deploy/idle/openfront-idle.service");
    const tunnel = source("deploy/idle/cloudflared-config.yml.example");

    expect(dockerfile).toContain("EXPOSE 3000");
    expect(dockerfile).not.toContain("EXPOSE 3001");
    expect(service).toContain("--publish 127.0.0.1:3000:3000");
    expect(service).not.toContain("--publish 127.0.0.1:3001:3001");
    expect(tunnel).toContain("service: http://127.0.0.1:3000");
  });
});
