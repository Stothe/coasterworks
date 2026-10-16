import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Test the code as it is in `src`, not a `dist` that may be stale or not built yet. The tests
    // that spawn the built bin skip themselves when `dist` is missing.
    alias: {
      "@coasterworks/sim": source("../../packages/sim/src/index.ts"),
      "@coasterworks/mcp": source("../../packages/mcp/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
