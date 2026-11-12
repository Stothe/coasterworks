// Takes the README's picture of the app on the real GPU, with the same scene the smoke test sets:
// the sample park running for a few seconds so guests are about, then paused, the inspector open
// on the park's Finances, Terrain in hand and the brush in the middle of the view.
//
// The smoke test (`UPDATE_SCREENSHOT=1 pnpm e2e`) can also write the picture, but the e2e browser
// paints in software (SwiftShader, as on CI), at the cheapest quality. This script is for the
// picture people see; nothing checks it.
//
// Serve the built app first, then run it:
//
//   pnpm build
//   pnpm --filter @coasterworks/web exec vite preview --port 4174 --strictPort
//   node apps/web/scripts/readme-shot.mjs --port 4174
//
// Options:
//
//   --port <n>      Port the app is served on. Required.
//   --out <file>    Where to write the PNG. Default: apps/web/e2e/__screenshots__/park.png.
//   --walk <ms>     How long the park runs at 8x before it is paused. Default 9000.
//
// Prints {"out":..., "gl":..., "errors":[...]}. Exits 1, writing nothing, if the page painted in
// software (no GPU) or logged an error.

import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(`readme-shot: ${message}`);
  console.error(
    "usage: node apps/web/scripts/readme-shot.mjs --port <n> [--out <file.png>] [--walk <ms>]",
  );
  process.exit(2);
}

const args = {
  out: fileURLToPath(new URL("../e2e/__screenshots__/park.png", import.meta.url)),
  walk: "9000",
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  if (!["--port", "--out", "--walk"].includes(flag)) fail(`unknown option ${flag}`);
  const value = argv[++i];
  if (value === undefined) fail(`${flag} needs a value`);
  args[flag.slice(2)] = value;
}
const port = Number(args.port);
if (!Number.isInteger(port) || port <= 0) fail("--port is required");
const walk = Number(args.walk);
if (!(walk >= 0)) fail("--walk must be a number of milliseconds");
const out = resolve(args.out);

// As in lookdev-shot.mjs: the full browser in new headless mode, with ANGLE on the machine's own
// graphics (Metal on a Mac).
const gpuArgs =
  process.platform === "darwin"
    ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
    : ["--use-angle=default", "--enable-gpu", "--ignore-gpu-blocklist"];

const browser = await chromium.launch({ channel: "chromium", headless: true, args: gpuArgs });
const errors = [];
let gl = "";
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__coasterworks?.ready === true, null, {
    timeout: 60_000,
  });
  gl = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[aria-label="Park view"]');
    const context = canvas?.getContext("webgl2");
    const info = context?.getExtension("WEBGL_debug_renderer_info");
    return info ? String(context.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  });

  // Let the guests come in at 8x and spread out along the paths, then hold the park still.
  await page.getByRole("button", { name: "8x" }).click();
  await page.waitForTimeout(walk);
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: /^Open finances/ }).click();
  await page.keyboard.press("1");
  const box = await page.getByLabel("Park view").boundingBox();
  if (!box) throw new Error("The park view has no size");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("region", { name: "Terrain tray" }).waitFor();
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
  // A second of frames for the light and the quality to settle.
  await page.waitForTimeout(1000);
  const picture = await page.screenshot();

  if (/swiftshader|llvmpipe|software/i.test(gl) || gl === "") {
    errors.push(`painted without a GPU (${gl || "renderer unknown"}); not written`);
  } else if (errors.length === 0) {
    await writeFile(out, picture);
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ out, gl, errors }));
process.exit(errors.length === 0 ? 0 : 1);
