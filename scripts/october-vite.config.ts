import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  plugins: [tailwindcss()],
  publicDir: "resources",
  resolve: {
    alias: { src: path.resolve("src"), resources: path.resolve("resources") },
  },
  optimizeDeps: { entries: ["scripts/october-ui-check.html"] },
  server: { host: "127.0.0.1", port: 9001, strictPort: true },
});
