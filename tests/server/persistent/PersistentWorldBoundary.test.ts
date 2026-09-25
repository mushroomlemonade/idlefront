import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("persistent-world upstream boundary", () => {
  it("does not fork OpenFront simulation, structure, or renderer rules", () => {
    const persistentServer = readdirSync(join(root, "src/server/persistent"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => read(`src/server/persistent/${name}`))
      .join("\n");

    expect(persistentServer).not.toMatch(
      /(?:\.\.\/)+core\/(?:game|execution|pathfinding|configuration)\//,
    );
    expect(persistentServer).not.toMatch(
      /(?:\bBuildingType\b|\bDefensePost\b|\bFactory\b|\bRailroad\b|\bconquestSpeed\b|\bgoldPerSecond\b|\bpopulationGrowth\b)/,
    );
  });

  it("leaves ordinary matches and the map renderer unaware of persistent lobbies", () => {
    const physicsOwners = [
      "src/server/GameServer.ts",
      "src/server/GameManager.ts",
      "src/server/Worker.ts",
      "src/client/ClientGameRunner.ts",
      "src/client/InputHandler.ts",
      "src/client/TransformHandler.ts",
    ];

    for (const path of physicsOwners) {
      expect(read(path), path).not.toMatch(/PersistentWorld|persistent-world/i);
    }
  });
});
