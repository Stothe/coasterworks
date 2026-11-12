// Takes a picture of the look-dev page (lookdev.html) with Playwright's Chromium, on the real
// GPU, and prints one line of JSON about it. This is how the renderer's look is checked: run it,
// then look at the PNG.
//
// The dev server must already be running on the port given:
//
//   pnpm --filter @coasterworks/web exec vite --port 5273 --strictPort
//   node apps/web/scripts/lookdev-shot.mjs --port 5273 --preset overview --out /tmp/overview.png
//
// Options:
//
//   --port <n>        Port of the dev server. Required.
//   --out <file>      Where to write the PNG. Required. Its folder is created if need be.
//   --preset <name>   One of the views below. Default: overview.
//   --query <string>  URL parameters for the page ("tod=0.9&demo=1"), laid over the preset's.
//                     See src/lookdev/main.ts for what the page takes.
//   --size <WxH>      Viewport in CSS pixels. Default 1440x900.
//   --dpr <n>         Device pixel ratio. Default 1.
//   --frames <n>      Frames to let pass after the page is ready. Default 30.
//   --software        Use the software renderer (SwiftShader), as CI does, not the GPU.
//
// Prints: {"out":..., "url":..., "gl":..., "frameMs":..., "quality":..., "errors":[...]}
// `gl` is the WebGL renderer string: on a Mac it names Metal and the GPU; if it says SwiftShader
// the picture was painted in software. `frameMs` is the smoothed time between frames. `errors`
// holds the page's console errors and uncaught exceptions (a shader that failed to compile shows
// up here); when there are any, the exit code is 1 and the PNG is still written.

import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Cameras are cam=x,z,distance,yaw,pitch on the 64 by 64 sample park: the hill is around tile
// (19, 15), the pond around (37, 29), and the demo's plaza at (32, 39) with the gate at (32, 63).
const PRESETS = {
  // The whole park from a classic angle.
  overview: "tod=0.4&cam=32,32,90,0.785,0.7",
  // The pond and its beach, close enough to judge water and shoreline.
  lake: "tod=0.4&cam=37,29,22,0.6,0.6",
  // The hill, side-lit, to judge the smooth ground and its shading.
  hill: "tod=0.4&cam=19,15,36,0.9,0.55",
  // The demo's plaza, paths and crowd.
  paths: "tod=0.4&demo=1&cam=33,36,30,0.785,0.75",
  // Low across the south edge of the park to the horizon, with the gate in view.
  edge: "tod=0.4&demo=1&cam=32,58,34,3.6,0.27",
  // Just before sunset.
  dusk: "tod=0.93&demo=1&cam=32,32,70,2.4,0.5",
  // Night.
  night: "tod=0&demo=1&cam=32,34,60,0.785,0.65",
  // Right down among the guests on the plaza.
  closeup: "tod=0.4&demo=1&cam=32,39,8,0.785,0.5",
  // One of every ride and stall type, built by the sim on the sample park, the rides running.
  rides: "tod=0.4&rides=1&cam=34,45,24,0.785,0.6",
};

function fail(message) {
  console.error(`lookdev-shot: ${message}`);
  console.error(
    "usage: node apps/web/scripts/lookdev-shot.mjs --port <n> --out <file.png> " +
      `[--preset ${Object.keys(PRESETS).join("|")}] [--query "a=b&c=d"] [--size 1440x900] ` +
      "[--dpr 1] [--frames 30] [--software]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { preset: "overview", query: "", size: "1440x900", dpr: "1", frames: "30" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--software") {
      args.software = true;
      continue;
    }
    if (!flag.startsWith("--") || !(flag.slice(2) in { ...args, port: 1, out: 1 })) {
      fail(`unknown option ${flag}`);
    }
    const value = argv[++i];
    if (value === undefined) fail(`${flag} needs a value`);
    args[flag.slice(2)] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port);
if (!Number.isInteger(port) || port <= 0) fail("--port is required");
if (!args.out) fail("--out is required");
if (!(args.preset in PRESETS)) fail(`unknown preset ${args.preset}`);
const size = /^(\d+)x(\d+)$/.exec(args.size);
if (!size) fail("--size must look like 1440x900");
const frames = Number(args.frames);
const dpr = Number(args.dpr);
if (!Number.isInteger(frames) || frames < 0) fail("--frames must be a whole number");
if (!(dpr > 0)) fail("--dpr must be a positive number");

// The preset's parameters, with --query's laid over them.
const query = new URLSearchParams(PRESETS[args.preset]);
for (const [key, value] of new URLSearchParams(args.query.replace(/^\?/, ""))) {
  query.set(key, value);
}
// Commas are easier on the eye than %2C, and the page reads either.
const url = `http://localhost:${port}/lookdev.html?${query.toString().replaceAll("%2C", ",")}`;
const out = resolve(args.out);

// Headless Chromium paints WebGL in software unless told otherwise. `channel: "chromium"` is the
// full browser in its new headless mode (the default headless shell has no GPU process to speak
// of), and the flags put ANGLE on the machine's own graphics: Metal on a Mac.
const gpuArgs =
  process.platform === "darwin"
    ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
    : ["--use-angle=default", "--enable-gpu", "--ignore-gpu-blocklist"];
const softwareArgs = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: args.software ? softwareArgs : gpuArgs,
});
const errors = [];
let report = { gl: "", frameMs: 0, quality: "" };
try {
  const page = await browser.newPage({
    viewport: { width: Number(size[1]), height: Number(size[2]) },
    deviceScaleFactor: dpr,
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__lookdev?.ready === true, null, { timeout: 60_000 });
  // A fixed number of frames more, so every shot is taken at the same point.
  await page.evaluate(
    (count) =>
      new Promise((done) => {
        let left = count;
        const tick = () => (left-- <= 0 ? done() : requestAnimationFrame(tick));
        tick();
      }),
    frames,
  );
  await mkdir(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  report = await page.evaluate(() => ({
    gl: window.__lookdev.gl,
    frameMs: Math.round(window.__lookdev.frameMs * 100) / 100,
    quality: window.__lookdev.quality,
  }));
} catch (error) {
  errors.push(String(error));
} finally {
  await browser.close();
}

console.log(JSON.stringify({ out, url, ...report, errors }));
for (const error of errors) console.error(`lookdev-shot: page error: ${error}`);
if (errors.length > 0) process.exitCode = 1;
