import {
  createScene,
  type ModuleName,
  type Quality,
  type SceneOptions,
  type TerrainData,
} from "@coasterworks/render";
import { createSamplePark } from "@coasterworks/sim";
import { createDemo } from "./demo";
import { placeEveryRide } from "./rides";

/**
 * The look-dev page: the render scene alone, with no interface around it, on the sample park
 * built right here in the page (no worker, no sim running). It is how the look of the renderer is
 * judged, by eye and by `scripts/lookdev-shot.mjs`, which takes a picture of it.
 *
 * Everything is set from the URL:
 *
 * - `tod=0.4`: time of the visual day, 0..1 (0 dawn, 0.5 noon). Default 0.4.
 * - `cam=x,z,distance,yaw,pitch`: the camera: the tile it looks at, how far away, and the two
 *   angles in radians. Parts left out keep their defaults.
 * - `quality=low|medium|high|auto`. Default auto.
 * - `still=<seconds>`: stops the animation clock at this many seconds, and the demo crowd where
 *   that long a walk has taken it, so that every frame is the same picture.
 * - `modules=a,b,c`: only these modules are created. With a minus, `modules=-post,-water`, all
 *   but these are. Names: surface, paths, overlay, water, atmosphere, post, guests, entrance,
 *   surroundings.
 * - `demo=1`: a made-up path network, an entrance on the south edge and about 150 walking guests.
 * - `grid=1`: the build grid.
 * - `hl=x,y,w,h`: a highlighted tile rectangle.
 * - `seed=7`: the sample park's seed. Default 7, the park the app opens.
 * - `rides=1`: one of every ride and stall type, built on the sample park by the sim, the rides
 *   running.
 * - `ghost=type,x,y,rot,ok`: a placement ghost of that type (`ok` 1 green, 0 red).
 *
 * `window.__lookdev` reports `ready` (true once a few frames of the finished scene are drawn),
 * the WebGL renderer string, the smoothed frame time and the quality in force.
 */

/** What the page tells whoever is driving it. */
interface LookdevReport {
  ready: boolean;
  /** The graphics hardware, as WebGL names it. */
  gl: string;
  /** Smoothed milliseconds between frames. */
  frameMs: number;
  quality: Quality;
  /** Frames drawn so far. */
  frames: number;
}

declare global {
  interface Window {
    __lookdev: LookdevReport;
  }
}

const MODULES: readonly ModuleName[] = [
  "surface",
  "paths",
  "overlay",
  "water",
  "atmosphere",
  "post",
  "guests",
  "entrance",
  "rides",
  "surroundings",
];
/** Frames drawn before the page calls itself ready: shaders are compiled and shadows are in. */
const READY_FRAMES = 3;
/** How often the demo crowd moves, in milliseconds: the pace of the sim's snapshots. */
const DEMO_STEP_MS = 50;

const params = new URLSearchParams(location.search);

/** The numbers of a comma-separated parameter; a part that is missing or not a number is null. */
function numbers(name: string): (number | null)[] {
  const raw = params.get(name);
  if (raw === null) return [];
  return raw.split(",").map((part) => {
    const value = Number(part);
    return part.trim() === "" || !Number.isFinite(value) ? null : value;
  });
}

function number(name: string): number | null {
  return numbers(name)[0] ?? null;
}

function moduleSwitches(): Partial<Record<ModuleName, boolean>> {
  const raw = params.get("modules");
  if (raw === null) return {};
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const off = names.filter((name) => name.startsWith("-")).map((name) => name.slice(1));
  const on = names.filter((name) => !name.startsWith("-"));
  const switches: Partial<Record<ModuleName, boolean>> = {};
  for (const name of MODULES) {
    // Named without a minus: only those are on. Otherwise all are, but the ones with a minus.
    switches[name] = on.length > 0 ? on.includes(name) : !off.includes(name);
  }
  return switches;
}

function qualityParam(): Quality | "auto" {
  const raw = params.get("quality");
  return raw === "low" || raw === "medium" || raw === "high" ? raw : "auto";
}

const canvas = document.getElementById("view") as HTMLCanvasElement;
const still = number("still");
const options: SceneOptions = { quality: qualityParam(), modules: moduleSwitches() };
if (still !== null) options.frozenTime = still;
const scene = createScene(canvas, options);

const world = createSamplePark(number("seed") ?? 7);
// Built before the terrain goes to the scene: the sim may only refuse a spot, never change land.
const rides = params.get("rides") === "1" ? placeEveryRide(world) : null;
// The sim's terrain has the arrays the renderer wants, under the same names.
const terrain: TerrainData = world.terrain;
scene.setTerrain(terrain);
scene.setTimeOfDay(number("tod") ?? 0.4);
scene.setPaths(world.terrain.path);
scene.setEntrance(world.park.entrance);

const demo = params.get("demo") === "1" ? createDemo(terrain.width, terrain.height) : null;
if (demo) {
  scene.setPaths(demo.paths);
  scene.setEntrance(demo.entrance);
  // A crowd that has been walking for a while is spread out the way a real one is.
  demo.advance(20 + (still ?? 0));
  scene.setGuests(demo.guests);
}

if (rides) {
  scene.setRides(rides.rides);
  scene.setRideStatus(rides.status);
}
const ghost = params.get("ghost")?.split(",");
if (ghost && ghost.length >= 4) {
  const [type = "", gx, gy, rot] = ghost;
  scene.setPlacementGhost({
    type,
    x: Number(gx),
    y: Number(gy),
    rot: (Number(rot) & 3) as 0 | 1 | 2 | 3,
    ok: ghost[4] !== "0",
  });
}

scene.setGridVisible(params.get("grid") === "1");
const [hx, hy, hw, hh] = numbers("hl");
if (hx != null && hy != null) scene.highlightTile(hx, hy, hw ?? 1, hh ?? 1);

// The camera: by default the whole park from a classic angle.
const { rig } = scene;
const [camX, camZ, camDistance, camYaw, camPitch] = numbers("cam");
rig.target.x = camX ?? terrain.width / 2;
rig.target.z = camZ ?? terrain.height / 2;
// Straight onto the ground there: the rig would otherwise ease to it over many frames.
rig.target.y = rig.heightAt?.(rig.target.x, rig.target.z) ?? 0;
rig.distance = camDistance ?? 90;
rig.yaw = camYaw ?? Math.PI / 4;
rig.pitch = rig.userPitch = camPitch ?? 0.7;

const report: LookdevReport = { ready: false, gl: "", frameMs: 0, quality: "low", frames: 0 };
window.__lookdev = report;

window.addEventListener("resize", () => scene.resize());

let lastDemoStep = performance.now();
function frame(now: number): void {
  if (demo && still === null && now - lastDemoStep >= DEMO_STEP_MS) {
    // Whole steps only, as snapshots come; a stall is not caught up on.
    demo.advance(DEMO_STEP_MS / 1000);
    lastDemoStep = now;
    scene.setGuests(demo.guests, now);
  }
  scene.render(now);
  const { gl, frameMs, quality } = scene.info;
  report.frames++;
  report.gl = gl;
  report.frameMs = frameMs;
  report.quality = quality;
  report.ready = report.frames >= READY_FRAMES;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
