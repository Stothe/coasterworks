import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Test the code as it is in `src`, not a `dist` that may be stale or not built yet.
    alias: {
      "@coasterworks/sim": source("../sim/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
