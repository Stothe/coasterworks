import type { Quality } from "./context.js";

/**
 * Choosing the quality when the player leaves it on "auto": a first guess from the name of the
 * graphics hardware, then a governor that watches the frame time and steps down when the machine
 * cannot keep up. Pure logic: the post module feeds it and acts on what it says.
 */

const ORDER: readonly Quality[] = ["low", "medium", "high"];

/** The quality one step below `q`, or `q` itself at the bottom. */
export function lowerQuality(q: Quality): Quality {
  return ORDER[Math.max(0, ORDER.indexOf(q) - 1)] as Quality;
}

/** The quality one step above `q`, or `q` itself at the top. */
export function higherQuality(q: Quality): Quality {
  return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(q) + 1)] as Quality;
}

/**
 * The quality to start "auto" from, given the renderer string WebGL reports (the unmasked one
 * from `WEBGL_debug_renderer_info` when there is one). A software renderer (SwiftShader,
 * llvmpipe, anything that says "software") gets `low`: it paints every pixel on the CPU. So does
 * an empty string, since a browser that hides its hardware cannot be assumed to be fast. Real
 * hardware starts at `high` and the governor takes it from there.
 */
export function detectQuality(glRenderer: string): Quality {
  const name = glRenderer.toLowerCase();
  if (name.trim() === "") return "low";
  if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(name)) return "low";
  return "high";
}

/** A frame slower than this, in milliseconds, is a slow frame: under about 45 a second. */
export const SLOW_FRAME_MS = 22;
/** Slow frames must go on this long, in milliseconds, before the governor steps down. */
export const SLOW_HOLD_MS = 2000;
/** After any change the governor waits this long before it steps down again. */
export const SETTLE_MS = 3000;
/** The governor steps up at most this often, and only after frames stayed fast this long. */
export const STEP_UP_MS = 60_000;

/** What the governor remembers between frames. Treat it as opaque and immutable. */
export interface GovernorState {
  /** The quality in force. */
  quality: Quality;
  /** The best quality it will ever go back up to. */
  ceiling: Quality;
  /** When the current run of slow frames began, or null while frames are fast. */
  slowSince: number | null;
  /** When the current run of fast frames began, or null while frames are slow. */
  fastSince: number | null;
  /** When the quality last changed (or when the governor started). */
  changedAt: number;
  /** Whether the last change was a step up: if that proves too much, it is not tried again. */
  steppedUp: boolean;
}

/** A governor that starts at `quality` at time `nowMs` and never goes above it. */
export function createGovernor(quality: Quality, nowMs: number): GovernorState {
  return {
    quality,
    ceiling: quality,
    slowSince: null,
    fastSince: null,
    changedAt: nowMs,
    steppedUp: false,
  };
}

/**
 * Takes one frame's time and returns the state after it. `frameMs` is a smoothed frame time (an
 * average over a few frames, so one hitch is not a slow spell) and `nowMs` is the clock.
 * `pausedMs` is how long drawing had stopped before this frame (`FrameMeter.pausedMs`: a hidden
 * tab), or 0 when the frame followed the last one as usual.
 *
 * - It steps down one level when frames have been slower than `SLOW_FRAME_MS` for `SLOW_HOLD_MS`
 *   without a break, and at least `SETTLE_MS` has passed since the last change.
 * - It steps back up one level, never above where it started, only after frames have been fast
 *   for `STEP_UP_MS` without a break and at least that long has passed since the last change. So
 *   it goes up at most once a minute.
 * - A step up that has to be taken back is the last one: the level it failed at becomes out of
 *   reach for good. That is what keeps it from going back and forth all session.
 * - Time with nothing drawn is not time spent slow or fast. A pause ends whatever run was going,
 *   so the first frame back starts a new one, and it is left out of both waits: a tab hidden for
 *   a minute right after one long frame comes back at the quality it left with.
 */
export function stepGovernor(
  state: GovernorState,
  frameMs: number,
  nowMs: number,
  pausedMs = 0,
): GovernorState {
  if (pausedMs > 0) {
    // The runs start over at this frame, and the clock of the last change skips the pause.
    state = {
      ...state,
      slowSince: null,
      fastSince: null,
      changedAt: Math.min(nowMs, state.changedAt + pausedMs),
    };
  }
  const slow = frameMs > SLOW_FRAME_MS;
  const slowSince = slow ? (state.slowSince ?? nowMs) : null;
  const fastSince = slow ? null : (state.fastSince ?? nowMs);
  const sinceChange = nowMs - state.changedAt;

  if (
    slowSince !== null &&
    nowMs - slowSince >= SLOW_HOLD_MS &&
    sinceChange >= SETTLE_MS &&
    state.quality !== "low"
  ) {
    const quality = lowerQuality(state.quality);
    return {
      quality,
      // Having just come up and found it too much, this is as high as it goes from now on.
      ceiling: state.steppedUp ? quality : state.ceiling,
      slowSince: null,
      fastSince: null,
      changedAt: nowMs,
      steppedUp: false,
    };
  }

  if (
    fastSince !== null &&
    nowMs - fastSince >= STEP_UP_MS &&
    sinceChange >= STEP_UP_MS &&
    state.quality !== state.ceiling
  ) {
    return {
      quality: higherQuality(state.quality),
      ceiling: state.ceiling,
      slowSince: null,
      fastSince: null,
      changedAt: nowMs,
      steppedUp: true,
    };
  }

  if (slowSince === state.slowSince && fastSince === state.fastSince) return state;
  return { ...state, slowSince, fastSince };
}

/** How much one new frame moves the smoothed frame time. */
const METER_BLEND = 0.1;
/** A gap this long between frames, in milliseconds, is a pause (a hidden tab), not a frame. */
const METER_PAUSE_MS = 250;

/** A running average of the time between frames. */
export interface FrameMeter {
  /** Call once per frame with the clock. Returns the smoothed frame time in milliseconds. */
  sample(nowMs: number): number;
  /** The smoothed frame time in milliseconds; 0 until two frames have been seen. */
  readonly frameMs: number;
  /**
   * How long drawing had stopped before the frame last sampled, in milliseconds, when that gap
   * was a pause and was left out of the average; 0 when the frame followed the last one as usual.
   * Hand it to `stepGovernor` with the same frame.
   */
  readonly pausedMs: number;
}

/**
 * Measures the time between frames as an exponential moving average. A pause (no frame for a
 * quarter of a second) is skipped, so coming back to a hidden tab is not counted as a slow frame;
 * `pausedMs` says how long it was.
 */
export function createFrameMeter(): FrameMeter {
  let last: number | null = null;
  let average = 0;
  let paused = 0;
  return {
    sample(nowMs: number): number {
      paused = 0;
      if (last !== null) {
        const gap = nowMs - last;
        if (gap >= METER_PAUSE_MS) {
          paused = gap;
        } else if (gap > 0) {
          average = average === 0 ? gap : average + (gap - average) * METER_BLEND;
        }
      }
      last = nowMs;
      return average;
    },
    get frameMs(): number {
      return average;
    },
    get pausedMs(): number {
      return paused;
    },
  };
}

/** How edges are smoothed after the picture is toned. */
export type PostAntialias = "smaa" | "fxaa";

/**
 * What the post pipeline is made of at one quality and pixel ratio. Everything in it decides what
 * gets built, so a change of plan means building the pipeline again; nothing in it changes from
 * frame to frame.
 */
export interface PostPlan {
  /** Samples of the multisampled target the scene is drawn into. */
  samples: number;
  /** The resolution ambient occlusion is worked out at, as a share of the drawing buffer. */
  aoScale: number;
  /** Horizon samples ambient occlusion takes at each pixel. */
  aoSamples: number;
  /** Whether the finish pass blurs toward the top and bottom of the frame. */
  tiltShift: boolean;
  /** The edge smoothing that follows the finish pass. */
  antialias: PostAntialias;
}

/** A drawing buffer this dense, in device pixels per CSS pixel, has pixels to spare. */
const DENSE_PIXEL_RATIO = 1.5;

/**
 * The post pipeline for a quality, or null at `low`, which draws straight to the canvas with no
 * pipeline at all.
 *
 * - `medium`: ambient occlusion at half resolution with fewer samples, no tilt-shift, the cheap
 *   edge smoothing.
 * - `high`: everything, ambient occlusion at full resolution.
 *
 * On a dense drawing buffer (a pixel ratio of 1.5 or more) there are two or more device pixels to
 * every CSS pixel in each direction, so `high` works its occlusion out at half the buffer, which
 * is still every CSS pixel, and both tiers take two samples a pixel where they would take four:
 * the picture is no softer for it and the frame costs about what it does at a ratio of 1.
 */
export function postPlan(quality: Quality, pixelRatio: number): PostPlan | null {
  if (quality === "low") return null;
  const dense = pixelRatio >= DENSE_PIXEL_RATIO;
  const high = quality === "high";
  return {
    samples: dense ? 2 : 4,
    aoScale: high && !dense ? 1 : 0.5,
    aoSamples: high ? 12 : 8,
    tiltShift: high,
    antialias: high ? "smaa" : "fxaa",
  };
}

/** Whether two plans build the same pipeline. */
export function samePostPlan(a: PostPlan | null, b: PostPlan | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.samples === b.samples &&
    a.aoScale === b.aoScale &&
    a.aoSamples === b.aoSamples &&
    a.tiltShift === b.tiltShift &&
    a.antialias === b.antialias
  );
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Hermite ramp from 0 at `from` to 1 at `to`, as GLSL's `smoothstep`. */
function smoothstep(from: number, to: number, value: number): number {
  const t = clamp01((value - from) / (to - from));
  return t * t * (3 - 2 * t);
}

/**
 * The reach of ambient occlusion in world units (one tile is one unit), for a camera `distance`
 * from what it looks at. It grows with the distance, so that the shading in a crease covers about
 * the same share of the screen at every zoom: up close it is the contact of a guest's feet and a
 * post with the ground, from far off the foot of a hill and the gaps between trees. It stops
 * growing where wider shading would stop reading as contact and start reading as dirt.
 */
export function aoRadiusFor(distance: number): number {
  return Math.min(3.2, Math.max(0.45, distance * 0.055));
}

/** How far from the eye, in world units, ambient occlusion starts to fade into the haze. */
export function aoFadeStartFor(distance: number): number {
  return distance * 1.6 + 24;
}

/** How far from the eye, in world units, ambient occlusion is gone; nothing beyond is worked out. */
export function aoFadeEndFor(distance: number): number {
  return distance * 3 + 70;
}

/**
 * How strong the tilt-shift blur is, 0..1, for a camera `distance` from what it looks at, raised
 * `pitch` radians above the ground. A close view has the shallow focus of a photograph of a
 * model, and a far one is left almost sharp, because the whole park has to stay readable there.
 * Looking straight down, everything in view is about as far away as everything else, so there is
 * little out of focus; looking low across the land, the top of the frame is far off and the
 * bottom is under the lens.
 */
export function tiltShiftFor(distance: number, pitch: number): number {
  const zoom = 1 - 0.75 * smoothstep(6, 60, distance);
  const slant = 1 - 0.6 * smoothstep(0.85, 1.4, pitch);
  return clamp01(zoom * slant);
}

/** The line three's tone mapping chunk ends with: the custom operator, which does nothing. */
const CUSTOM_TONE_MAPPING_STUB = "vec3 CustomToneMapping( vec3 color ) { return color; }";

/**
 * three's `tonemapping_pars_fragment` chunk with its do-nothing `CustomToneMapping` replaced by
 * `glsl`, which must define `vec3 CustomToneMapping( vec3 color )` and may call the operators the
 * chunk defines before it. Throws when the chunk has no such line, which means three changed and
 * the look would silently be lost.
 */
export function withCustomToneMapping(chunk: string, glsl: string): string {
  if (!chunk.includes(CUSTOM_TONE_MAPPING_STUB)) {
    throw new Error("three's tone mapping chunk has no CustomToneMapping to replace.");
  }
  return chunk.replace(CUSTOM_TONE_MAPPING_STUB, () => glsl);
}
