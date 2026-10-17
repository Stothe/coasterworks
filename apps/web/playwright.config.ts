import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;

/**
 * The browser smoke test. It drives the production build (`pnpm build` first), served by
 * `vite preview`, in headless Chromium.
 */
export default defineConfig({
  testDir: "e2e",
  // The first WebGL frame can be slow on a CI runner with no GPU.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One at a time: each test paints WebGL in software, and two at once on a small runner is slow
  // enough to trip the first-frame waits.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  outputDir: "test-results",
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        // A runner without a GPU still gets WebGL, from SwiftShader's software renderer.
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
      },
    },
  ],
});
