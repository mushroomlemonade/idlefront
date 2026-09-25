import { includeIgnoreFile } from "@eslint/compat";
import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

/** @type {import('eslint').Linter.Config[]} */
export default [
  includeIgnoreFile(gitignorePath),
  {
    ignores: [
      "src/server/gatekeeper/**",
      "tests/pathfinding/playground/**",
      ".claude/**",
    ],
  },
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "__mocks__/fileMock.js",
            "eslint.config.js",
            "scripts/sync-assets.mjs",
            "tests/matchmaking/*.mjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Disable rules that would fail. The failures should be fixed, and the entries here removed.
      "@typescript-eslint/no-explicit-any": "off",
      "no-unused-vars": "off",
    },
  },
  {
    rules: {
      // Enable rules
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      eqeqeq: "error",
      "no-case-declarations": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
        },
      ],
    },
  },
  {
    // These are deliberately standalone compatibility/runtime scripts rather
    // than members of the TypeScript application project. Keeping them on the
    // untyped parser also avoids exhausting projectService's intentionally
    // small allowDefaultProject budget.
    files: [
      "scripts/**/*.{js,mjs,cjs,ts}",
      "apps/mobile/src/*.js",
      "resources/idle/app.js",
      "scripts/idle-db-backup.mjs",
      "scripts/idle-public-gateway.mjs",
      "scripts/idle-smoke.mjs",
      "scripts/idle-windows-launcher.mjs",
      "scripts/generate-expanded-earth.mjs",
      "src/server/simulation/Simulation.worker.mjs",
      "src/server/simulation/WaterRoute.worker.mjs",
      "src/server/simulation/WildernessPlanner.worker.mjs",
    ],
    languageOptions: { parserOptions: { projectService: false } },
    rules: { "@typescript-eslint/prefer-nullish-coalescing": "off" },
  },
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];
