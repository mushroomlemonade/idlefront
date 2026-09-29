import path from "node:path";
import { defineConfig } from "vite";
// Isolated developer harness: no game backend or account requests.
export default defineConfig({
  resolve: {
    alias: { src: path.resolve("src"), resources: path.resolve("resources") },
  },
  optimizeDeps: { entries: ["scripts/owner16-gpu-check.html"] },
  server: { host: "127.0.0.1", port: 9001, strictPort: true },
});
