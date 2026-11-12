import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  BackSide,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  LinearToneMapping,
  Mesh,
  NeutralToneMapping,
  NoToneMapping,
  PMREMGenerator,
  ReinhardToneMapping,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
  type IUniform,
  type ToneMapping,
  type WebGLRenderTarget,
} from "three";
import { ATMOSPHERE_GLSL, CLOUD_SHADOW_STRENGTH } from "./atmosphere.glsl.js";
import {
  SHARED_UNIFORMS_GLSL,
  type FrameInfo,
  type Quality,
  type RenderContext,
  type SceneModule,
} from "./context.js";
import { NOISE_GLSL } from "./shaders/noise.glsl.js";
import {
  SUN_FULL_INTENSITY,
  luminance,
  sunFor,
  toneMap,
  type LinearRgb,
  type SunState,
  type ToneCurve,
} from "./sky.js";
import { SURROUNDINGS_REACH } from "./surroundings.js";

/**
 * The sky and the light: the sky dome with its sun, moon, stars and clouds, the one shadowed
 * directional light, the sky's own light on everything (an environment map made from the sky),
 * the haze toward the horizon, and the sun and sky uniforms every other shader reads.
 */
export type AtmosphereModule = SceneModule & {
  /** Sets the time of the visual day, 0..1 (0 the middle of the night, 0.5 noon). */
  setTimeOfDay(t: number): void;
};

/** What the atmosphere spends at each quality. */
interface Tier {
  /** Texels along each side of the sun's shadow map. */
  shadowMap: number;
  /** How far the shadow filter reaches, in texels: the softness of a shadow's edge. */
  shadowRadius: number;
  /** The most octaves of detail the clouds in the sky are drawn with. */
  cloudDetail: number;
  /** Octaves of detail in the cloud shadows on the land. */
  shadowDetail: number;
  /** Texels along a face of the sky's environment map. */
  environment: number;
}

const TIERS: Record<Quality, Tier> = {
  low: { shadowMap: 1024, shadowRadius: 1.3, cloudDetail: 3.5, shadowDetail: 1.5, environment: 64 },
  medium: {
    shadowMap: 2048,
    shadowRadius: 1.8,
    cloudDetail: 4.5,
    shadowDetail: 2,
    environment: 128,
  },
  high: { shadowMap: 4096, shadowRadius: 2.4, cloudDetail: 5.5, shadowDetail: 2, environment: 128 },
};

/** Half the side of the sky dome's box. The camera is always well inside it. */
const DOME_HALF = 1000;
/** The sky's environment map is made again once the time of day has moved this far (a day is 1). */
const ENVIRONMENT_STEP = 1 / 240;
/** And never more often than this, in milliseconds, however fast the day runs. */
const ENVIRONMENT_INTERVAL_MS = 400;

/** The same two, on a software renderer at low. */
const SOFTWARE_ENVIRONMENT_STEP = 1 / 24;
const SOFTWARE_ENVIRONMENT_INTERVAL_MS = 10_000;
/** The cloud octaves of the sky dome on a software renderer at low. */
const SOFTWARE_CLOUD_DETAIL = 1.5;

/** The visible ground is followed out to this many times the camera's distance, plus a little. */
const SHADOW_REACH_FACTOR = 3.2;
const SHADOW_REACH_MIN = 60;
const SHADOW_REACH_MAX = 280;
/** The shadow box's radius grows in steps of this factor, so it does not change with every zoom. */
const SHADOW_RADIUS_STEP = 2 ** 0.25;
/** The ground's height range under the shadow box is taken in steps of this, for the same reason. */
const SHADOW_HEIGHT_STEP = 4;
/** What stands on the ground (trees, the gate) is allowed this much height inside the box. */
const SHADOW_HEADROOM = 6;
/** Things up to this far above the visible ground still cast their shadow into it. */
const SHADOW_CASTER_HEIGHT = 16;
/** Samples per side of the grid that finds the ground's height range under the shadow box. */
const SHADOW_HEIGHT_SAMPLES = 5;

/** Where the haze begins, in tiles beyond the camera's target: this, plus this much per unit of distance. */
const HAZE_START = 26;
const HAZE_START_PER_DISTANCE = 0.42;
/** The haze is whole a little short of where the land beyond the park ends. */
const HAZE_END = SURROUNDINGS_REACH * 0.93;

/** A circle on the ground, in world X and Z. */
export interface GroundCircle {
  x: number;
  z: number;
  radius: number;
}

/**
 * The circle of ground a camera sees: where the given view rays (three numbers each, from `eye`)
 * meet the level plane at `planeY`, with any ray that misses the plane, or meets it farther than
 * `reach` from the eye, cut short at `reach`. The circle is centered on the middle of those
 * points and holds them all. Turning the camera about its target turns the points with it, so the
 * radius does not change with the view's heading.
 */
export function visibleGroundCircle(
  out: GroundCircle,
  eye: { x: number; y: number; z: number },
  rays: ArrayLike<number>,
  planeY: number,
  reach: number,
): GroundCircle {
  const count = Math.floor(rays.length / 3);
  let sumX = 0;
  let sumZ = 0;
  for (let pass = 0; pass < 2; pass++) {
    let farthest = 0;
    for (let i = 0; i < count; i++) {
      const dx = rays[i * 3]!;
      const dy = rays[i * 3 + 1]!;
      const dz = rays[i * 3 + 2]!;
      const flat = Math.hypot(dx, dz);
      // How far along the ground the ray lands; past the reach, or never, counts as the reach.
      const t = dy < -1e-6 ? (planeY - eye.y) / dy : Infinity;
      const run = t > 0 && t * flat <= reach ? t * flat : reach;
      const scale = flat > 1e-9 ? run / flat : 0;
      const x = eye.x + dx * scale;
      const z = eye.z + dz * scale;
      if (pass === 0) {
        sumX += x;
        sumZ += z;
      } else {
        farthest = Math.max(farthest, Math.hypot(x - out.x, z - out.z));
      }
    }
    if (pass === 0) {
      out.x = count > 0 ? sumX / count : eye.x;
      out.z = count > 0 ? sumZ / count : eye.z;
    } else {
      out.radius = farthest;
    }
  }
  return out;
}

/** `value` rounded up to the next whole power of `step` (a factor above 1). */
export function stepUp(value: number, step: number): number {
  return step ** Math.ceil(Math.log(value) / Math.log(step) - 1e-9);
}

/** The box a directional light's shadow camera covers, and where the light and its target go. */
export interface ShadowBox {
  /** The light's position. */
  px: number;
  py: number;
  pz: number;
  /** The light's target: straight down the light's direction from its position. */
  tx: number;
  ty: number;
  tz: number;
  /** Half the box's width (along the horizontal axis square to the light) and half its height. */
  halfWidth: number;
  halfHeight: number;
  near: number;
  far: number;
  /** The size of one shadow texel in world units, across and up the box. */
  texelWidth: number;
  texelHeight: number;
}

/**
 * Fits a directional light's shadow box to a circle of ground.
 *
 * `light` is the unit vector toward the light. The box holds every point over the circle between
 * heights `lowY` and `highY`, and reaches `casterReach` farther toward the light, so that things
 * outside the circle still cast into it. Seen from a low sun the circle is a thin ellipse, and
 * the box is that thin too: the texels are spent on the ground in view, not on empty air.
 *
 * The box's middle is moved to a whole number of texels along both of its axes, measured from
 * the world's origin. While the light, the circle's radius and the heights stay as they are, a
 * moving circle therefore shifts the shadow map by whole texels only, and the shadows' edges do
 * not crawl as the camera pans. `margin` is how many texels to leave clear around the circle for
 * that shift and for the soft filter.
 */
export function fitShadowBox(
  out: ShadowBox,
  light: ArrayLike<number>,
  circle: GroundCircle,
  lowY: number,
  highY: number,
  mapSize: number,
  margin: number,
  casterReach: number,
): ShadowBox {
  const lx = light[0]!;
  const ly = light[1]!;
  const lz = light[2]!;
  // The shadow camera's axes, as three.js's lookAt makes them from the light's direction and
  // world up: `a` across (level), `b` up the box, the light's direction toward the viewer.
  const flat = Math.hypot(lx, lz);
  const ax = flat > 1e-6 ? lz / flat : 1;
  const az = flat > 1e-6 ? -lx / flat : 0;
  const bx = ly * az;
  const by = lz * ax - lx * az;
  const bz = -ly * ax;

  // The circle's middle at height 0, in the box's axes.
  const u0 = circle.x * ax + circle.z * az;
  const v0 = circle.x * bx + circle.z * bz;
  const w0 = circle.x * lx + circle.z * lz;
  const r = circle.radius;
  // A level circle is foreshortened by the light's elevation along b and by its lowness along
  // the light's own direction; height moves a point along both by the other of the two.
  const vLow = v0 - r * Math.abs(ly) + Math.min(lowY * by, highY * by);
  const vHigh = v0 + r * Math.abs(ly) + Math.max(lowY * by, highY * by);
  const wLow = w0 - r * flat + Math.min(lowY * ly, highY * ly);
  const wHigh = w0 + r * flat + Math.max(lowY * ly, highY * ly);

  // Room for the margin on both sides and half a texel of snapping.
  const room = 1 - (2 * margin + 1) / mapSize;
  const halfWidth = r / room;
  const halfHeight = (vHigh - vLow) / 2 / room;
  const texelWidth = (2 * halfWidth) / mapSize;
  const texelHeight = (2 * halfHeight) / mapSize;
  const u = Math.round(u0 / texelWidth) * texelWidth;
  const v = Math.round((vLow + vHigh) / 2 / texelHeight) * texelHeight;

  const near = 1;
  const w = wHigh + casterReach + near;
  out.px = u * ax + v * bx + w * lx;
  out.py = v * by + w * ly;
  out.pz = u * az + v * bz + w * lz;
  out.tx = out.px - lx * 10;
  out.ty = out.py - ly * 10;
  out.tz = out.pz - lz * 10;
  out.halfWidth = halfWidth;
  out.halfHeight = halfHeight;
  out.near = near;
  out.far = w - wLow + 1;
  out.texelWidth = texelWidth;
  out.texelHeight = texelHeight;
  return out;
}

/**
 * Of a sky that runs from its zenith color overhead to its horizon color by `cwSkyHaze` (below),
 * the share of the horizon color in the light that reaches level ground: the haze weighted by the
 * cosine of the angle to the vertical, over the upper half. The same arithmetic as the shader.
 */
function horizonShareOfSkylight(): number {
  const steps = 256;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const up = (i + 0.5) / steps;
    const haze = (1 - Math.exp(-0.13 * (1 / (up + 0.035) - 0.9662))) * 1.0284;
    sum += 2 * up * haze;
  }
  return sum / steps;
}

const HORIZON_SHARE = horizonShareOfSkylight();

/**
 * How much of the horizon's color is stirred into the whole sky when it is used as a light, and
 * how much of that light's color is kept (the rest goes to grey of the same brightness). A clear
 * sky taken as it is lights everything a hard blue; real shadows are filled by the whole bright
 * world, not by the zenith alone.
 */
const SKYLIGHT_HORIZON = 0.3;
const SKYLIGHT_COLOR = 0.55;

/** What the sky lights level ground with, linear, before it is greyed: the mix of its two colors. */
function skylight(sun: SunState): LinearRgb {
  const k = HORIZON_SHARE * (1 - SKYLIGHT_HORIZON) + SKYLIGHT_HORIZON;
  return [
    sun.zenith[0] * (1 - k) + sun.horizon[0] * k,
    sun.zenith[1] * (1 - k) + sun.horizon[1] * k,
    sun.zenith[2] * (1 - k) + sun.horizon[2] * k,
  ];
}

/** The name of one of three.js's tone mapping constants, for `toneMap`. */
function toneCurve(mapping: ToneMapping): ToneCurve {
  switch (mapping) {
    case NoToneMapping:
      return "none";
    case LinearToneMapping:
      return "linear";
    case ReinhardToneMapping:
      return "reinhard";
    case ACESFilmicToneMapping:
      return "aces";
    case AgXToneMapping:
      return "agx";
    case NeutralToneMapping:
      return "neutral";
    default:
      // Cineon and custom curves: closest to hand.
      return "aces";
  }
}

const SKY_VERTEX = /* glsl */ `
varying vec3 cwSky_dir;

void main() {
  cwSky_dir = position;
  #ifdef CW_SKY_ENV
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #else
    // Only the camera's turn is applied, so the dome is centered on the eye wherever that is,
    // and it is drawn on the far plane: behind everything, and only where nothing else is.
    vec4 eye = viewMatrix * vec4(position, 0.0);
    gl_Position = projectionMatrix * vec4(eye.xyz, 1.0);
    gl_Position.z = gl_Position.w;
  #endif
}
`;

const SKY_FRAGMENT = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${NOISE_GLSL}
${ATMOSPHERE_GLSL}

// Toward the sun's disc and the moon's. (uSunDir is the light, which is held above the horizon.)
uniform vec3 cwSky_sunDir;
uniform vec3 cwSky_moonDir;
// The color of the sun's disc and glow, already dimmed by the air it crosses.
uniform vec3 cwSky_sunGlow;
// x: the angle one pixel spans, in radians. y: night, 0..1. z: dusk, 0..1.
// w: the most octaves of detail the clouds get.
uniform vec4 cwSky_view;
// What the land sends back up: the lower half of the environment map.
uniform vec3 cwSky_ground;

varying vec3 cwSky_dir;

const float CW_SKY_SUN_RADIUS = 0.021;
const float CW_SKY_MOON_RADIUS = 0.03;
// How deep the clouds are, as a share of their height above the land.
const float CW_SKY_CLOUD_DEPTH = 0.1;

// How much of the horizon's color a ray at this height picks up: the air it crosses grows from
// one atmosphere overhead to dozens along the ground, and what it scatters in grows with it.
float cwSkyHaze(float up) {
  float air = 1.0 / (up + 0.035);
  return (1.0 - exp(-0.13 * (air - 0.9662))) * 1.0284;
}

// Henyey-Greenstein: how much light a haze throws toward the eye at an angle from the sun.
float cwSkyForward(float cosAngle, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

// The clear sky: the gradient, the glow around the sun and the colors of dusk.
vec3 cwSkyAir(vec3 dir) {
  float up = max(dir.y, 0.0);
  float haze = cwSkyHaze(up);
  vec3 col = mix(uSkyZenith, uSkyHorizon, haze);

  // What depends on where the sun is fades out in the last sliver above the horizon, so that
  // the horizon itself is the fog's color all the way round and the far land meets it cleanly.
  float lift = smoothstep(0.0, 0.05, dir.y);
  float cosSun = dot(dir, cwSky_sunDir);

  // Air scatters most straight on and straight back, least at right angles to the sun.
  col *= 1.0 + lift * 0.16 * (cosSun * cosSun - 0.4);
  // Haze scatters forward: a tight glow round the sun, and at dusk a wide warm wash low down.
  float glow = cwSkyForward(cosSun, 0.76) * (0.05 + 0.22 * haze);
  float wash = cwSkyForward(cosSun, 0.5) * pow(haze, 1.5) * cwSky_view.z * 9.0;
  col += cwSky_sunGlow * lift * (glow + wash);

  // Opposite a setting sun: a pink band over the blue-grey shadow of the earth.
  float away = smoothstep(0.0, -0.85, cosSun) * cwSky_view.z * lift;
  float band = exp(-pow((up - 0.17) / 0.1, 2.0));
  col = mix(col, col * vec3(1.3, 0.86, 0.98) + vec3(0.05, 0.0, 0.025), away * band * 0.7);
  col *= 1.0 - away * 0.18 * exp(-pow(up / 0.07, 2.0));
  return col;
}

#ifndef CW_SKY_ENV

// The stars: one in most cells of a grid laid over the sky. The grid is a stereographic map of
// the upper half, which keeps shapes, so a star is round wherever it is.
vec3 cwSkyStars(vec3 dir) {
  float scale = 62.0 / (1.0 + dir.y);
  vec2 uv = dir.xz * scale;
  vec2 cell = floor(uv);
  vec2 rnd = cwHash22(cell);
  vec2 kind = cwHash22(cell + vec2(73.0, 19.0));
  // Radians from the star. It keeps clear of the cell's border, so no star is cut off.
  float dist = length(uv - cell - (0.2 + 0.6 * rnd)) / scale;
  // Never smaller than a pixel and a bit, or the stars would flicker as the camera turns.
  float size = max(cwSky_view.x * 1.15, 0.0008);
  float core = exp(-dist * dist / (size * size));
  // Few bright ones, many faint ones, and some cells empty.
  float bright = step(0.42, kind.y) * (0.06 + 2.4 * pow(kind.x, 8.0));
  float twinkle = 0.82 + 0.18 * sin(uTime * (1.3 + 2.6 * rnd.x) + 6.283 * rnd.y);
  vec3 tint = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.9, 0.74), rnd.y);
  vec3 stars = tint * (bright * core * twinkle);

  // A faint band of far stars across the sky.
  float across = dot(dir, vec3(0.37, 0.48, -0.795));
  float dust = cwFbm(uv * 0.11 + vec2(3.0, 11.0), 4);
  stars += vec3(0.05, 0.062, 0.1) * exp(-across * across / 0.045) * smoothstep(0.32, 0.72, dust);
  return stars;
}

// The moon: a lit ball a little past half, with seas. rgb is its light, a how much of the sky
// behind it the disc hides.
vec4 cwSkyMoon(vec3 dir) {
  vec3 m = cwSky_moonDir;
  float ang = sqrt(max(2.0 - 2.0 * dot(dir, m), 0.0));
  // The glow round it shows even where the disc does not.
  vec3 halo = vec3(0.5, 0.66, 1.0) * (0.3 * exp(-ang / 0.045) + 0.05 * exp(-ang / 0.2));
  if (ang > CW_SKY_MOON_RADIUS * 1.3) return vec4(halo, 0.0);

  vec3 across = normalize(cross(vec3(0.0, 1.0, 0.0), m));
  vec3 upward = cross(m, across);
  vec2 q = vec2(dot(dir, across), dot(dir, upward)) / CW_SKY_MOON_RADIUS;
  float r = length(q);
  float edge = max(cwSky_view.x / CW_SKY_MOON_RADIUS * 1.3, 0.03);
  float disc = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, r);
  vec3 normal = vec3(q, sqrt(max(1.0 - r * r, 0.0)));
  float lit = smoothstep(-0.12, 0.3, dot(normal, normalize(vec3(-0.5, 0.3, 0.62))));
  float seas = cwFbm(q * 1.9 + vec2(4.3, 8.1), 4);
  vec3 face = mix(vec3(0.5, 0.56, 0.68), vec3(1.0, 0.98, 0.92), smoothstep(0.38, 0.6, seas));
  vec3 moon = face * (0.035 + 2.6 * lit * (0.7 + 0.3 * normal.z));
  return vec4(halo + moon * disc, disc);
}

// The clouds in a direction: rgb their color, a how much of the sky they hide.
vec4 cwSkyClouds(vec3 dir) {
  float up = dir.y;
  vec2 base = cwAtmLayerPoint(cameraPosition.xz, dir);
  vec2 out_ = base - cameraPosition.xz;
  // How much of the layer one pixel covers decides how many octaves can be told apart: low in
  // the sky the layer is seen edge on and the fine ones would only shimmer.
  float spread = up + CW_ATM_CURVE;
  float footprint = cwAtm_cloud.w * cwSky_view.x / (spread * spread);
  float detail = clamp(log2(1.0 / (cwAtm_cloud.z * footprint * 3.0)) + 1.0, 1.5, cwSky_view.w);

  float low = cwAtmClouds(base, detail);
  // Well clear of any cloud: there is none higher up along this ray either.
  if (low < -0.14) return vec4(0.0);

  // The clouds have height. A ray climbing through them meets their higher parts farther out,
  // so the field is read again at a few steps along the ray's way over the ground, each a
  // level higher up the cloud, where a cloud is narrower. Nearest first: from below one sees a
  // cloud's flat grey base, and past its far edge the bright heap of its top.
  float run = min(CW_SKY_CLOUD_DEPTH * length(out_) * cwAtm_cloud.z, 0.3) / cwAtm_cloud.z;
  vec2 climb = out_ * (run / max(length(out_), 1e-4));
  int levels = cwSky_view.w > 5.0 ? 3 : 2;

  // At dusk the clouds catch the low sun's own color, redder than the light on the land, and
  // it is their bases it reaches.
  vec3 light = mix(uSunColor, cwSky_sunGlow * 1.7, cwSky_view.z);
  vec3 lit = light + uSkyHorizon * 0.22;
  vec3 dim = mix(uSkyZenith, uSkyHorizon, 0.45) * 0.62 + light * 0.1;
  // By day a cloud's base is in its own shade and its top in the sun. At dusk the low sun
  // reaches under it: the base glows, and the heap above is a dusty rose against the sky.
  vec3 rose = mix(uSkyZenith, uSkyHorizon, 0.62) * 0.92;
  vec3 baseColor = mix(dim, mix(rose, lit, 0.4), cwSky_view.z);
  vec3 topColor = mix(lit, rose, cwSky_view.z);

  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float thick = max(low, 0.0);
  for (int i = 0; i < 3; i++) {
    if (i >= levels) break;
    float f = float(i) / float(levels - 1);
    float density = (i == 0 ? low : cwAtmClouds(base + climb * f, detail - 0.5)) - f * 0.055;
    float a = smoothstep(0.0, 0.07, density);
    // Thin cloud lets the light through: every level is bright at its edge.
    vec3 c = mix(lit, mix(baseColor, topColor, f), smoothstep(0.0, 0.15, density));
    col += (1.0 - alpha) * a * c;
    alpha += (1.0 - alpha) * a;
    thick = max(thick, density);
  }
  if (alpha <= 0.0) return vec4(0.0);
  col /= alpha;

  // The silver lining: thin cloud near the sun glows with its light.
  float cosSun = max(dot(dir, cwSky_sunDir), 0.0);
  col += cwSky_sunGlow * (pow(cosSun, 20.0) * exp(-thick * 16.0) * 0.9);

  // Far clouds sink into the haze.
  col = mix(uSkyHorizon, col, 0.3 + 0.7 * smoothstep(0.0, 0.3, up));
  return vec4(col, alpha * smoothstep(0.0, 0.025, up));
}

#endif

void main() {
  vec3 dir = normalize(cwSky_dir);
  vec3 col;

  #ifdef CW_SKY_ENV

    // The sky as a light: the clear sky and its glow, no discs (the directional light is the
    // sun) and no clouds, and under the horizon the light the land sends back up.
    col = mix(cwSkyAir(dir), uSkyHorizon, CW_SKY_LIGHT_HORIZON);
    col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, CW_SKY_LIGHT_COLOR);
    col = mix(col, cwSky_ground, smoothstep(0.02, -0.28, dir.y));

  #else

    if (dir.y <= 0.0) {
      // Under the horizon the dome is the fog's color, as the far land is.
      col = uSkyHorizon;
    } else {
      col = cwSkyAir(dir);
      float rise = smoothstep(0.0, 0.006, dir.y);

      float night = cwSky_view.y;
      vec4 moon = vec4(0.0);
      if (night > 0.0) {
        moon = cwSkyMoon(dir);
        // Stars dim toward the horizon, where the air is thick.
        col += cwSkyStars(dir) * (night * (1.0 - moon.a) * smoothstep(0.03, 0.3, dir.y));
      }

      float cosSun = dot(dir, cwSky_sunDir);
      float ang = sqrt(max(2.0 - 2.0 * cosSun, 0.0));
      float soft = max(cwSky_view.x * 1.25, CW_SKY_SUN_RADIUS * 0.08);
      float disc = 1.0 - smoothstep(CW_SKY_SUN_RADIUS - soft, CW_SKY_SUN_RADIUS + soft, ang);
      float limb = sqrt(max(1.0 - ang * ang / (CW_SKY_SUN_RADIUS * CW_SKY_SUN_RADIUS), 0.0));
      vec3 sun = cwSky_sunGlow *
        (disc * (9.0 + 13.0 * limb) + 1.3 * exp(-ang / 0.028) + 0.26 * exp(-ang / 0.1));

      vec4 cloud = cwSkyClouds(dir);
      // A cloud hides most of whichever disc is behind it; a little of the glow comes through.
      col += (sun + moon.rgb * night) * (rise * (1.0 - 0.9 * cloud.a));
      col = mix(col, cloud.rgb, cloud.a);
    }

    // A grain finer than one step of the display, so the long gradients do not band.
    float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float level = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col += (grain - 0.5) * (0.004 * pow(max(level, 0.0), 0.6) + 0.0003);

  #endif

  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Creates the atmosphere module.
 *
 * - The sky is a dome drawn by one shader: a gradient from the zenith color to the horizon color
 *   by how much air the view ray crosses, the sun's glow and disc, at night the moon and stars,
 *   and a layer of drifting clouds. (three.js's own `Sky` addon was weighed against it: its
 *   Preetham model has no night, its horizon changes color round the compass so no single fog
 *   color can meet it, and its clouds cannot be shared with the land's shader. A shader written
 *   for this scene does all three and costs less.)
 * - The sky's light on the scene is an environment map made from that sky (`PMREMGenerator`),
 *   made again only when the time of day has moved by `ENVIRONMENT_STEP`.
 * - One directional light is the sun by day and the moon by night. Its shadow box is fitted each
 *   frame to the circle of ground in view and snapped to its own texels (`fitShadowBox`).
 * - The haze is three.js fog in the horizon's color, whole by the end of the land beyond the park.
 * - `cwCloudShadow` (in `atmosphere.glsl.ts`) is the same cloud field as the sky's, read toward
 *   the sun, so the shadows on the land are the clouds overhead.
 *
 * It writes `uSunDir`, `uSunColor`, `uSkyHorizon`, `uSkyZenith` and `uDaylight` every frame.
 */
export function createAtmosphere(ctx: RenderContext): AtmosphereModule {
  const { scene, renderer, camera, rig, uniforms, atmosphereUniforms } = ctx;
  const previousBackground = scene.background;
  const previousFog = scene.fog;
  const previousEnvironment = scene.environment;
  const previousEnvironmentIntensity = scene.environmentIntensity;
  const previousBeforeRender = scene.onBeforeRender;

  let tier = TIERS[ctx.quality];
  let sky: SunState = sunFor(0.4);

  // The sky dome, and the same sky as a light.
  const skyUniforms = {
    cwSky_sunDir: { value: new Vector3(0, 1, 0) },
    cwSky_moonDir: { value: new Vector3(0, 1, 0) },
    cwSky_sunGlow: { value: new Color(1, 1, 1) },
    cwSky_view: { value: new Vector4(0.0007, 0, 0, tier.cloudDetail) },
    cwSky_ground: { value: new Color(0.1, 0.14, 0.06) },
  } satisfies Record<string, IUniform>;
  const allUniforms: Record<string, IUniform> = {
    ...uniforms,
    ...atmosphereUniforms,
    ...skyUniforms,
  };
  const domeMaterial = new ShaderMaterial({
    name: "cwSky",
    uniforms: allUniforms,
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  const environmentMaterial = new ShaderMaterial({
    name: "cwSkyEnvironment",
    uniforms: allUniforms,
    defines: {
      CW_SKY_ENV: 1,
      CW_SKY_LIGHT_HORIZON: SKYLIGHT_HORIZON.toFixed(3),
      CW_SKY_LIGHT_COLOR: SKYLIGHT_COLOR.toFixed(3),
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  // A box as good as a ball here: the shader works from the direction alone. It is far larger
  // than the park, so a pass that draws the scene with another material sees only its back.
  const domeGeometry = new BoxGeometry(DOME_HALF * 2, DOME_HALF * 2, DOME_HALF * 2);
  const dome = new Mesh(domeGeometry, domeMaterial);
  dome.name = "cwSky";
  dome.frustumCulled = false;
  dome.matrixAutoUpdate = false;
  // After the rest of the opaque scene, so the sky's shader runs only where the sky shows.
  dome.renderOrder = 1000;
  scene.add(dome);
  scene.background = null;

  const environmentScene = new Scene();
  const environmentDome = new Mesh(domeGeometry, environmentMaterial);
  environmentDome.frustumCulled = false;
  environmentScene.add(environmentDome);
  const pmrem = new PMREMGenerator(renderer);
  let environment: WebGLRenderTarget | null = null;
  /** The time of day and the skylight the environment map was last made for, and when. */
  let environmentTime = Number.NaN;
  let environmentLight = 1;
  let environmentAtMs = -Infinity;
  let environmentStale = true;
  let timeOfDay = 0.4;

  // The sun, or the moon.
  const sun = new DirectionalLight(0xffffff, SUN_FULL_INTENSITY);
  sun.name = "cwSun";
  // A software renderer at low draws no shadows: the shadow pass and the filtered lookups in every
  // lit pixel were a large part of its frame.
  const castsShadow = (quality: Quality) => !(ctx.software === true && quality === "low");
  const cloudDetail = (quality: Quality) =>
    ctx.software === true && quality === "low" ? SOFTWARE_CLOUD_DETAIL : TIERS[quality].cloudDetail;
  skyUniforms.cwSky_view.value.w = cloudDetail(ctx.quality);
  sun.castShadow = castsShadow(ctx.quality);
  sun.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
  sun.shadow.radius = tier.shadowRadius;
  scene.add(sun, sun.target);

  // The haze. Its color is set as each frame is drawn (see below).
  const fog = new Fog(0xffffff, 100, 300);
  scene.fog = fog;
  /** The horizon color as it is, and as the tone curve in force leaves it (worked out on demand). */
  const horizon: LinearRgb = [1, 1, 1];
  let mapped: LinearRgb = [1, 1, 1];
  let mappedCurve: ToneCurve | null = null;
  let mappedExposure = Number.NaN;
  // three.js mixes fog into a standard material after tone mapping when it draws to the canvas,
  // and before it (the tone curve coming later, in an output pass) when it draws to a render
  // target. The sky dome is always tone-mapped. So for the canvas the fog gets the horizon color
  // as the tone curve leaves it, and for a render target the horizon color itself.
  scene.onBeforeRender = function (this: Scene, ...args: Parameters<Scene["onBeforeRender"]>) {
    previousBeforeRender.apply(this, args);
    if (renderer.getRenderTarget() !== null) {
      fog.color.setRGB(horizon[0], horizon[1], horizon[2]);
      return;
    }
    const curve = toneCurve(renderer.toneMapping);
    const exposure = renderer.toneMappingExposure;
    if (curve !== mappedCurve || exposure !== mappedExposure) {
      mapped = toneMap(horizon, curve, exposure);
      mappedCurve = curve;
      mappedExposure = exposure;
    }
    fog.color.setRGB(mapped[0], mapped[1], mapped[2]);
  };

  // Scratch for the frame's work, so that `update` allocates nothing.
  const rays = new Float64Array(15);
  const ray = new Vector3();
  const circle: GroundCircle = { x: 0, z: 0, radius: 1 };
  const box: ShadowBox = {
    px: 0,
    py: 0,
    pz: 0,
    tx: 0,
    ty: 0,
    tz: 0,
    halfWidth: 1,
    halfHeight: 1,
    near: 1,
    far: 2,
    texelWidth: 1,
    texelHeight: 1,
  };
  let shadowRadius = 0;
  /** The height of the drawing buffer in pixels. */
  let viewHeight = 900;
  /** The corners of the view and the middle of its top edge, as (x, y) on the screen in -1..1. */
  const VIEW_POINTS = [-1, -1, 1, -1, -1, 1, 1, 1, 0, 1] as const;

  /** Writes the sun and sky uniforms every shader in the scene reads. */
  function writeShared(): void {
    const light = sky.lightDirection;
    uniforms.uSunDir.value.set(light[0], light[1], light[2]);
    const share = sky.intensity / SUN_FULL_INTENSITY;
    uniforms.uSunColor.value.setRGB(
      sky.lightColor[0] * share,
      sky.lightColor[1] * share,
      sky.lightColor[2] * share,
    );
    uniforms.uSkyHorizon.value.setRGB(sky.horizon[0], sky.horizon[1], sky.horizon[2]);
    uniforms.uSkyZenith.value.setRGB(sky.zenith[0], sky.zenith[1], sky.zenith[2]);
    uniforms.uDaylight.value = sky.daylight;
  }

  /** Puts a new sky into the light, the dome's shader and the haze. */
  function applySky(): void {
    writeShared();
    const light = sky.lightDirection;
    sun.color.setRGB(sky.lightColor[0], sky.lightColor[1], sky.lightColor[2]);
    sun.intensity = sky.intensity;

    skyUniforms.cwSky_sunDir.value.set(
      sky.sunDirection[0],
      sky.sunDirection[1],
      sky.sunDirection[2],
    );
    skyUniforms.cwSky_moonDir.value.set(
      sky.moonDirection[0],
      sky.moonDirection[1],
      sky.moonDirection[2],
    );
    skyUniforms.cwSky_sunGlow.value.setRGB(sky.sunGlow[0], sky.sunGlow[1], sky.sunGlow[2]);
    skyUniforms.cwSky_view.value.y = sky.night;
    skyUniforms.cwSky_view.value.z = sky.dusk;

    // What grass sends back up under this light: a dim green, for the undersides of things.
    const level = sky.ambient + (sky.intensity * Math.max(0, light[1])) / Math.PI;
    skyUniforms.cwSky_ground.value.setRGB(0.1 * level, 0.13 * level, 0.055 * level);

    horizon[0] = sky.horizon[0];
    horizon[1] = sky.horizon[1];
    horizon[2] = sky.horizon[2];
    mappedCurve = null;

    // The sky's light follows the day at once; its colors wait for the map to be made again.
    scene.environmentIntensity = sky.ambient / environmentLight;
  }

  /** Makes the environment map from the sky as it is now. */
  function bakeEnvironment(nowMs: number): void {
    const made = pmrem.fromScene(environmentScene, 0, 1, DOME_HALF * 4, {
      size: tier.environment,
    });
    environment?.dispose();
    environment = made;
    scene.environment = made.texture;
    environmentLight = Math.max(1e-4, luminance(skylight(sky)));
    scene.environmentIntensity = sky.ambient / environmentLight;
    environmentTime = timeOfDay;
    environmentAtMs = nowMs;
    environmentStale = false;
  }

  /** Whether the sky has moved on enough since the environment map was made. */
  function environmentDue(nowMs: number): boolean {
    if (environment === null) return true;
    // A software renderer at low makes the map seldom: each one is a dozen passes on the CPU.
    const cheap = ctx.software === true && ctx.quality === "low";
    const interval = cheap ? SOFTWARE_ENVIRONMENT_INTERVAL_MS : ENVIRONMENT_INTERVAL_MS;
    if (nowMs - environmentAtMs < interval) return false;
    if (environmentStale) return true;
    const moved = Math.abs(timeOfDay - environmentTime);
    return Math.min(moved, 1 - moved) >= (cheap ? SOFTWARE_ENVIRONMENT_STEP : ENVIRONMENT_STEP);
  }

  /** Fits the sun's shadow box to the ground the camera sees. */
  function fitShadow(): void {
    // The view's corner rays, from the camera as the rig has just placed it.
    const tanY = Math.tan(rig.fovY / 2);
    const tanX = tanY * camera.aspect;
    for (let i = 0; i < 5; i++) {
      ray
        .set(VIEW_POINTS[i * 2]! * tanX, VIEW_POINTS[i * 2 + 1]! * tanY, -1)
        .applyQuaternion(camera.quaternion);
      rays[i * 3] = ray.x;
      rays[i * 3 + 1] = ray.y;
      rays[i * 3 + 2] = ray.z;
    }
    const reach = Math.min(
      SHADOW_REACH_MAX,
      Math.max(SHADOW_REACH_MIN, rig.distance * SHADOW_REACH_FACTOR + 20),
    );
    visibleGroundCircle(circle, camera.position, rays, rig.target.y, reach);

    // The radius moves in steps, and only when it must grow or can shrink by more than a step:
    // a size that changed every frame would make every shadow edge crawl.
    const needed = circle.radius * 1.04 + 1;
    if (needed > shadowRadius || needed < shadowRadius / (SHADOW_RADIUS_STEP * 1.12)) {
      shadowRadius = stepUp(needed, SHADOW_RADIUS_STEP);
    }
    circle.radius = shadowRadius;

    // The ground's height range under the circle, in coarse steps for the same reason.
    let low = Infinity;
    let high = -Infinity;
    const last = SHADOW_HEIGHT_SAMPLES - 1;
    for (let j = 0; j <= last; j++) {
      for (let i = 0; i <= last; i++) {
        const h = ctx.heightAt(
          circle.x + ((i / last) * 2 - 1) * shadowRadius,
          circle.z + ((j / last) * 2 - 1) * shadowRadius,
        );
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
    }
    low = Math.floor((low - 1) / SHADOW_HEIGHT_STEP) * SHADOW_HEIGHT_STEP;
    high = Math.ceil((high + SHADOW_HEADROOM) / SHADOW_HEIGHT_STEP) * SHADOW_HEIGHT_STEP;

    const light = sky.lightDirection;
    const casterReach = Math.min(200, SHADOW_CASTER_HEIGHT / Math.max(0.08, light[1]));
    const shadow = sun.shadow;
    fitShadowBox(
      box,
      light,
      circle,
      low,
      high,
      tier.shadowMap,
      Math.ceil(tier.shadowRadius) + 1,
      casterReach,
    );

    sun.position.set(box.px, box.py, box.pz);
    sun.target.position.set(box.tx, box.ty, box.tz);
    const lens = shadow.camera;
    if (
      lens.right !== box.halfWidth ||
      lens.top !== box.halfHeight ||
      lens.near !== box.near ||
      lens.far !== box.far
    ) {
      lens.left = -box.halfWidth;
      lens.right = box.halfWidth;
      lens.top = box.halfHeight;
      lens.bottom = -box.halfHeight;
      lens.near = box.near;
      lens.far = box.far;
      lens.updateProjectionMatrix();
    }
    // The offsets that hide a shadow map's stair steps grow with its texels. A texel is as long
    // on the ground as it is wide, whatever the sun's height: the box is squeezed to match.
    // Soft edges about a pixel and a half wide on the screen, and never wider than the tier's
    // filter: close up the texels are far smaller than a pixel, and a filter counted in texels
    // alone would either smear a guest's shadow away or leave the far view's edges hard.
    const pixel = (rig.distance * 2 * Math.tan(rig.fovY / 2)) / viewHeight;
    shadow.radius = Math.min(tier.shadowRadius, Math.max(1, (pixel * 1.5) / box.texelWidth));
    shadow.normalBias = box.texelWidth * 1.0;
    shadow.bias = (-box.texelWidth * 0.6) / (box.far - box.near);
  }

  applySky();

  return {
    setTimeOfDay(t: number): void {
      timeOfDay = t - Math.floor(t);
      sky = sunFor(t);
      applySky();
    },
    setQuality(quality: Quality): void {
      tier = TIERS[quality];
      sun.castShadow = castsShadow(quality);
      if (sun.shadow.mapSize.x !== tier.shadowMap) {
        // three.js keeps the map it made at the old size until it is thrown away.
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      sun.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
      sun.shadow.radius = tier.shadowRadius;
      skyUniforms.cwSky_view.value.w = cloudDetail(quality);
      atmosphereUniforms.cwAtm_wind.value.w = tier.shadowDetail;
      environmentStale = true;
    },
    contextRestored(): void {
      // The sky's light map was drawn into a render target, which the lost context took with it.
      environmentStale = true;
      environmentAtMs = -Infinity;
    },
    resize(_width: number, height: number, pixelRatio: number): void {
      viewHeight = Math.max(1, height * pixelRatio);
      skyUniforms.cwSky_view.value.x = rig.fovY / viewHeight;
    },
    update(frame: FrameInfo): void {
      // The shared uniforms are written every frame: every other module's shaders read them.
      writeShared();
      atmosphereUniforms.cwAtm_wind.value.w = tier.shadowDetail;
      // Moonlight is faint enough already: a cloud takes less of it away.
      atmosphereUniforms.cwAtm_cloud.value.y = CLOUD_SHADOW_STRENGTH * (0.6 + 0.4 * sky.daylight);
      if (environmentDue(frame.nowMs)) bakeEnvironment(frame.nowMs);
      fitShadow();

      // The haze starts beyond what the view is about and is whole where the land ends. Fog goes
      // by depth along the view, and a point s tiles beyond the target is at depth
      // distance + s * cos(pitch).
      const along = Math.cos(rig.pitch);
      const start = Math.min(HAZE_END * 0.72, HAZE_START + rig.distance * HAZE_START_PER_DISTANCE);
      fog.near = rig.distance + start * along;
      fog.far = rig.distance + HAZE_END * Math.max(along, 0.05);
    },
    dispose(): void {
      scene.remove(dome, sun, sun.target);
      scene.onBeforeRender = previousBeforeRender;
      scene.background = previousBackground;
      scene.fog = previousFog;
      scene.environment = previousEnvironment;
      scene.environmentIntensity = previousEnvironmentIntensity;
      environment?.dispose();
      pmrem.dispose();
      domeGeometry.dispose();
      domeMaterial.dispose();
      environmentMaterial.dispose();
      sun.shadow.dispose();
      sun.dispose();
    },
  };
}
