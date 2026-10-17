import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * zod puts `@__PURE__` notes where Rollup cannot read them and says so on every build. They only
 * mark code that may be dropped, so the notice is noise; every other warning still shows.
 */
const rollupOptions = {
  onwarn(warning: { code?: string; id?: string }, warn: (warning: never) => void) {
    if (warning.code === "INVALID_ANNOTATION" && warning.id?.includes("/node_modules/zod/")) return;
    warn(warning as never);
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Dev and build use the packages' sources, so there is no stale `dist` to rebuild first.
    alias: {
      "@coasterworks/sim": source("../../packages/sim/src/index.ts"),
      "@coasterworks/protocol": source("../../packages/protocol/src/index.ts"),
      "@coasterworks/render": source("../../packages/render/src/index.ts"),
    },
  },
  // The sim runs in a module worker, which imports the packages the same way the page does.
  worker: { format: "es", rollupOptions },
  build: {
    // three.js is most of the page, and the page is one chunk.
    chunkSizeWarningLimit: 1000,
    rollupOptions,
  },
  // `strictPort`: the desktop app's `tauri dev` waits for exactly this address, so a busy port must
  // be an error here, not a quiet move to 5174 that leaves the app attached to some other server.
  server: { port: 5173, strictPort: true },
});
