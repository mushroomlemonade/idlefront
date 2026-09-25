import { expect, it } from "vitest";
// @ts-expect-error Standalone operational JavaScript has no declaration file.
import { componentSpec } from "../../../scripts/idle-dev-supervisor.mjs";

const config = {
  Workspace: "C:/checkout/idlefront",
  ConfigPath: "C:/config/dev.json",
};
it("keeps Expo loopback-only and uses the permanent game endpoint", () => {
  const spec = componentSpec("Expo", config);
  expect(spec.args).toContain("--localhost");
  expect(spec.args).not.toContain("--tunnel");
  expect(spec.env.EXPO_PUBLIC_GAME_URL).toBe(
    "https://atlas-dev.sightings.today/?debug=1",
  );
});
it("uses the current checkout and never launches the legacy standalone authority", () => {
  const spec = componentSpec("Backend", config);
  expect(spec.cwd).toBe(config.Workspace);
  expect(spec.args).toEqual(["--import", "tsx", "src/server/Server.ts"]);
  expect(spec.env.NUM_WORKERS).toBe("2");
  expect(componentSpec("Gateway", config).args.at(-1)).toBe(config.ConfigPath);
  expect(componentSpec("Web", config).args).toContain("--strictPort");
  expect(() => componentSpec("Unknown", config)).toThrow();
});
