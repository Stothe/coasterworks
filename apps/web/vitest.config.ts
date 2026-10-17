import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Test the code as it is in `src`, not a `dist` that may be stale or not built yet.
    alias: {
      "@coasterworks/sim": source("../../packages/sim/src/index.ts"),
      "@coasterworks/protocol": source("../../packages/protocol/src/index.ts"),
      "@coasterworks/render": source("../../packages/render/src/index.ts"),
    },
  },
  esbuild: { jsx: "automatic" },
  test: {
    // Component and host tests need a DOM; the pure ones opt out with `@vitest-environment node`.
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
