import type { Rgb } from "./palette.js";

/**
 * The sun, the moon and the colors of the sky over the visual day, as plain numbers. Nothing here
 * knows about three.js: the atmosphere module turns this into lights, a sky dome and uniforms, and
 * everything is a pure function of the time of day, so it can be tested as it stands.
 */

/** A linear-light color as three floats; channels may pass 1 (light is not held to a screen's range). */
export type LinearRgb = [number, number, number];

/** A unit vector in world space: X east, Y up, Z south. */
export type Direction = [number, number, number];

export interface SunState {
  /** Radians above the horizon; negative while the sun is down. */
  elevation: number;
  /** Radians around the vertical axis, 0 toward +Z, increasing toward +X. */
  azimuth: number;
  /** Intensity of the one directional light: the sun by day, the moon by night. */
  intensity: number;
  /** Color of that light as sRGB floats. */
  color: Rgb;
  /** Color of the sky at the horizon, which is also the fog color, as sRGB floats. */
  skyColor: Rgb;
  /**
   * How brightly the sky alone lights level ground, as linear luminance: what is left in a shadow.
   * It never falls below `AMBIENT_FLOOR`, so night is never black.
   */
  ambient: number;

  /** Toward the sun's disc. It points below the horizon while the sun is down. */
  sunDirection: Direction;
  /** Toward the moon's disc. The moon is up for the whole night. */
  moonDirection: Direction;
  /** True while the moon is the light, false while the sun is. */
  moonlit: boolean;
  /**
   * Toward whichever of the two lights the land. It is held a little above the horizon, so light
   * never rakes the ground flat or comes from below it; the disc in the sky is where
   * `sunDirection` says.
   */
  lightDirection: Direction;
  /** Linear color of that light, its strongest channel at 1; `intensity` carries the strength. */
  lightColor: LinearRgb;
  /** Linear color of the sun's disc and the glow around it, dimmed and reddened by the air it crosses. */
  sunGlow: LinearRgb;
  /** Linear color of the sky straight overhead. */
  zenith: LinearRgb;
  /** Linear color of the sky at the horizon: the haze the far land fades into. */
  horizon: LinearRgb;
  /** 0 at night to 1 in full day. */
  daylight: number;
  /** 0 by day to 1 in full night: how much of the stars and the moon show. */
  night: number;
  /** 0 to 1, peaking as the sun crosses the horizon: how much of the sunset colors show. */
  dusk: number;
}

/** The sun's light at its strongest: a clear noon. */
export const SUN_FULL_INTENSITY = 3;
/** The moon's light at its strongest. Far brighter than a real moon, so the park reads at night. */
export const MOON_FULL_INTENSITY = 1.7;
/** The least the sky lights the ground (see `SunState.ambient`). */
export const AMBIENT_FLOOR = 0.2;
/** The most the sky lights the ground: about a third of what the noon sun adds on level ground. */
export const AMBIENT_NOON = 0.44;

/** The sun's elevation at the start of the day and how far it climbs by noon, in radians. */
const ELEVATION_AT_DAWN = -0.35;
const ELEVATION_CLIMB = 1.45;
/** Below this sun elevation the moon is the light; above it, the sun. Both are dark at the change. */
const HANDOVER = -0.17;
/** The light is never lower than about this (see `lightDirection`). */
const LIGHT_FLOOR = 0.42;
/** How high the moon stands, and how far round from the point opposite the sun. */
const MOON_ELEVATION = 0.8;
const MOON_TURN = 0.55;

/** The sun at noon: white with a little warmth. Linear. */
const SUN_WHITE: LinearRgb = [1.0, 0.94, 0.84];
/** How strongly a unit of air dims red, green and blue: blue goes first, so a low sun is golden. */
const EXTINCTION: LinearRgb = [0.011, 0.03, 0.074];
/** The moon's light: pale blue. Linear. */
const MOON_LIGHT: LinearRgb = [0.46, 0.66, 1.0];

/**
 * The sky's colors against the sun's elevation, low to high: overhead, at the horizon, and how
 * brightly the sky lights the ground. All linear. Between two rows the values ease from one to
 * the next. The sky's light is kept in step with the sun's on level ground (which falls as the
 * sun sinks), so a shadow stays about as dark against the lit ground beside it all day.
 */
const SKY_KEYS: readonly {
  elevation: number;
  zenith: LinearRgb;
  horizon: LinearRgb;
  ambient: number;
}[] = [
  // Night: deep blue overhead, a paler band low down. Brighter than a real night, to be read by.
  { elevation: -0.3, zenith: [0.016, 0.036, 0.105], horizon: [0.05, 0.088, 0.19], ambient: 0.22 },
  // Late twilight: the last warmth leaves the horizon.
  { elevation: -0.17, zenith: [0.028, 0.05, 0.15], horizon: [0.2, 0.15, 0.24], ambient: 0.2 },
  // Sunset.
  { elevation: -0.04, zenith: [0.07, 0.095, 0.31], horizon: [0.84, 0.43, 0.23], ambient: 0.25 },
  // Golden hour.
  { elevation: 0.1, zenith: [0.085, 0.185, 0.5], horizon: [0.8, 0.6, 0.4], ambient: 0.27 },
  // Morning and afternoon.
  { elevation: 0.32, zenith: [0.088, 0.235, 0.63], horizon: [0.6, 0.72, 0.86], ambient: 0.3 },
  { elevation: 0.65, zenith: [0.082, 0.24, 0.68], horizon: [0.52, 0.7, 0.93], ambient: 0.38 },
  // Midday.
  { elevation: 1.0, zenith: [0.08, 0.24, 0.69], horizon: [0.5, 0.69, 0.94], ambient: AMBIENT_NOON },
];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
// This form is exact at k = 0 and k = 1.
const lerp = (a: number, b: number, k: number) => a * (1 - k) + b * k;

/** 0 at `edge0`, 1 at `edge1`, eased in between. The edges may run either way. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const k = clamp01((x - edge0) / (edge1 - edge0));
  return k * k * (3 - 2 * k);
}

/** One linear channel (0..1) to sRGB. */
export function linearToSrgb(c: number): number {
  const v = clamp01(c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Linear luminance of a linear color. */
export function luminance(c: LinearRgb): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** A unit vector from an elevation above the horizon and an azimuth (0 toward +Z, turning toward +X). */
export function directionFrom(elevation: number, azimuth: number): Direction {
  const flat = Math.cos(elevation);
  return [flat * Math.sin(azimuth), Math.sin(elevation), flat * Math.cos(azimuth)];
}

/**
 * How much air a ray crosses on its way out of the atmosphere, in units of the air straight
 * overhead: 1 at the zenith, about 38 at the horizon (Kasten and Young's fit). Below the horizon
 * it is held at the horizon's value.
 */
export function airMass(elevation: number): number {
  const e = Math.max(0, elevation);
  const degrees = (e * 180) / Math.PI;
  return 1 / (Math.sin(e) + 0.50572 * (degrees + 6.07995) ** -1.6364);
}

/**
 * The linear color of sunlight that has crossed the air at `elevation`, relative to noon: each
 * channel dimmed by its own extinction, so the light turns from white through gold to orange as
 * the sun goes down. Not normalized: it gets darker as well as redder.
 */
export function sunlightThrough(elevation: number): LinearRgb {
  const extra = airMass(elevation) - 1;
  return [
    SUN_WHITE[0] * Math.exp(-EXTINCTION[0] * extra),
    SUN_WHITE[1] * Math.exp(-EXTINCTION[1] * extra),
    SUN_WHITE[2] * Math.exp(-EXTINCTION[2] * extra),
  ];
}

/** The sky's keyed values at a sun elevation. */
function skyAt(elevation: number): { zenith: LinearRgb; horizon: LinearRgb; ambient: number } {
  const first = SKY_KEYS[0]!;
  const last = SKY_KEYS[SKY_KEYS.length - 1]!;
  if (elevation <= first.elevation) {
    return { zenith: [...first.zenith], horizon: [...first.horizon], ambient: first.ambient };
  }
  for (let i = 1; i < SKY_KEYS.length; i++) {
    const a = SKY_KEYS[i - 1]!;
    const b = SKY_KEYS[i]!;
    if (elevation > b.elevation) continue;
    const k = smoothstep(a.elevation, b.elevation, elevation);
    return {
      zenith: [0, 1, 2].map((c) => lerp(a.zenith[c]!, b.zenith[c]!, k)) as LinearRgb,
      horizon: [0, 1, 2].map((c) => lerp(a.horizon[c]!, b.horizon[c]!, k)) as LinearRgb,
      ambient: lerp(a.ambient, b.ambient, k),
    };
  }
  return { zenith: [...last.zenith], horizon: [...last.horizon], ambient: last.ambient };
}

/**
 * The sun, the moon and the sky at time `t` of the visual day, where 0 is the middle of the night,
 * 0.5 is noon and 1 wraps back to 0 (any real `t` is taken modulo 1). The sun rises at about 0.08
 * and sets at about 0.92; it is low and golden for a while at both ends, and the moon lights the
 * short night in between.
 */
export function sunFor(t: number): SunState {
  const u = t - Math.floor(t);
  const s = Math.max(0, Math.sin(Math.PI * u));
  const elevation = ELEVATION_AT_DAWN + ELEVATION_CLIMB * s;
  const azimuth = Math.PI / 4 + Math.PI * u;

  const sunDirection = directionFrom(elevation, azimuth);
  const moonAzimuth = azimuth + Math.PI + MOON_TURN;
  const moonDirection = directionFrom(MOON_ELEVATION, moonAzimuth);

  // The sun's light holds through sunset and is gone by the handover; the moon's comes up after.
  const moonlit = elevation < HANDOVER;
  const sunShare = smoothstep(HANDOVER, HANDOVER + 0.1, elevation);
  const moonShare = smoothstep(HANDOVER, HANDOVER - 0.11, elevation);

  // The light's color follows the air it crosses, held to what a sun just clear of the horizon
  // gives: golden, not the deep red of the last sliver.
  const through = sunlightThrough(Math.max(elevation, 0.045));
  const peak = Math.max(through[0], through[1], through[2]);
  const sunColor: LinearRgb = [through[0] / peak, through[1] / peak, through[2] / peak];
  const sunIntensity =
    SUN_FULL_INTENSITY * (0.88 + 0.12 * smoothstep(-0.05, 0.55, elevation)) * sunShare;
  const moonIntensity = MOON_FULL_INTENSITY * moonShare;

  // A smooth "no lower than the floor": equal to the elevation when the sun is well up.
  const lifted = 0.5 * (elevation + LIGHT_FLOOR + Math.sqrt((elevation - LIGHT_FLOOR) ** 2 + 0.02));
  const lightDirection = moonlit ? moonDirection : directionFrom(lifted, azimuth);
  const lightColor: LinearRgb = moonlit ? [...MOON_LIGHT] : sunColor;
  const intensity = moonlit ? moonIntensity : sunIntensity;

  // The disc and its glow: the true color through the air, fading out as the disc goes under.
  const discShare = smoothstep(-0.09, 0.0, elevation);
  const disc = sunlightThrough(Math.max(elevation, 0.012));
  const sunGlow: LinearRgb = [disc[0] * discShare, disc[1] * discShare, disc[2] * discShare];

  const sky = skyAt(elevation);

  return {
    elevation,
    azimuth,
    intensity,
    color: [linearToSrgb(lightColor[0]), linearToSrgb(lightColor[1]), linearToSrgb(lightColor[2])],
    skyColor: [
      linearToSrgb(sky.horizon[0]),
      linearToSrgb(sky.horizon[1]),
      linearToSrgb(sky.horizon[2]),
    ],
    ambient: Math.max(AMBIENT_FLOOR, sky.ambient),
    sunDirection,
    moonDirection,
    moonlit,
    lightDirection,
    lightColor,
    sunGlow,
    zenith: sky.zenith,
    horizon: sky.horizon,
    daylight: smoothstep(HANDOVER, 0.32, elevation),
    night: smoothstep(-0.03, -0.26, elevation),
    dusk: smoothstep(-0.2, -0.02, elevation) * smoothstep(0.3, 0.02, elevation),
  };
}

/** The tone curves three.js can draw with, by the names of its constants. */
export type ToneCurve = "none" | "linear" | "reinhard" | "aces" | "agx" | "neutral";

type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

/** A row-major 3 by 3 matrix times a color. */
function transform(m: Matrix3, c: LinearRgb): LinearRgb {
  return [
    m[0] * c[0] + m[1] * c[1] + m[2] * c[2],
    m[3] * c[0] + m[4] * c[1] + m[5] * c[2],
    m[6] * c[0] + m[7] * c[1] + m[8] * c[2],
  ];
}

// The matrices of three.js r186's tone mapping shader chunk (tonemapping_pars_fragment), written
// row-major here; the chunk lists them column by column.
const ACES_IN: Matrix3 = [
  0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777,
];
const ACES_OUT: Matrix3 = [
  1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602,
];
const SRGB_TO_REC2020: Matrix3 = [
  0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0113, 0.0164, 0.088, 0.8956,
];
const REC2020_TO_SRGB: Matrix3 = [
  1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187,
];
const AGX_INSET: Matrix3 = [
  0.856627153315983, 0.0951212405381588, 0.0482516061458583, 0.137318972929847, 0.761241990602591,
  0.101439036467562, 0.11189821299995, 0.0767994186031903, 0.811302368396859,
];
const AGX_OUTSET: Matrix3 = [
  1.1271005818144368, -0.11060664309660323, -0.016493938717834573, -0.1413297634984383,
  1.157823702216272, -0.016493938717834257, -0.14132976349843826, -0.11060664309660294,
  1.2519364065950405,
];
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

function agxContrast(x: number): number {
  const x2 = x * x;
  const x4 = x2 * x2;
  return (
    15.5 * x4 * x2 -
    40.14 * x4 * x +
    31.96 * x4 -
    6.868 * x2 * x +
    0.4298 * x2 +
    0.1191 * x -
    0.00232
  );
}

/**
 * What three.js r186's tone mapping makes of a linear color at the given exposure: the same
 * arithmetic as its shader, so that a color worked out here lands on the screen exactly where a
 * color drawn through the shader does. The result is linear, 0..1, ready for the display's
 * transfer curve.
 *
 * The atmosphere needs it for the fog. When the frame is drawn straight to the canvas, three.js
 * tone-maps a standard material's lit color and only then mixes the fog color in untouched, while
 * the sky dome's horizon goes through the tone curve: the two would differ at the far edge of the
 * land. Handing the fog the tone-mapped horizon makes them meet.
 */
export function toneMap(color: LinearRgb, curve: ToneCurve, exposure: number): LinearRgb {
  const c: LinearRgb = [color[0] * exposure, color[1] * exposure, color[2] * exposure];
  switch (curve) {
    case "none":
      return [color[0], color[1], color[2]];
    case "linear":
      return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
    case "reinhard":
      return [clamp01(c[0] / (1 + c[0])), clamp01(c[1] / (1 + c[1])), clamp01(c[2] / (1 + c[2]))];
    case "aces": {
      const fit = (v: number) =>
        (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
      const a = transform(ACES_IN, [c[0] / 0.6, c[1] / 0.6, c[2] / 0.6]);
      const b = transform(ACES_OUT, [fit(a[0]), fit(a[1]), fit(a[2])]);
      return [clamp01(b[0]), clamp01(b[1]), clamp01(b[2])];
    }
    case "agx": {
      const inset = transform(AGX_INSET, transform(SRGB_TO_REC2020, c));
      const curved = inset.map((v) => {
        const ev = (Math.log2(Math.max(v, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
        return agxContrast(clamp01(ev));
      }) as LinearRgb;
      const outset = transform(AGX_OUTSET, curved).map((v) => Math.max(0, v) ** 2.2) as LinearRgb;
      const out = transform(REC2020_TO_SRGB, outset);
      return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])];
    }
    case "neutral": {
      const start = 0.8 - 0.04;
      const least = Math.min(c[0], c[1], c[2]);
      const offset = least < 0.08 ? least - 6.25 * least * least : 0.04;
      const shifted: LinearRgb = [c[0] - offset, c[1] - offset, c[2] - offset];
      const peak = Math.max(shifted[0], shifted[1], shifted[2]);
      if (peak < start) return shifted;
      const d = 1 - start;
      const newPeak = 1 - (d * d) / (peak + d - start);
      const scale = newPeak / peak;
      const g = 1 - 1 / (0.15 * (peak - newPeak) + 1);
      return [
        lerp(shifted[0] * scale, newPeak, g),
        lerp(shifted[1] * scale, newPeak, g),
        lerp(shifted[2] * scale, newPeak, g),
      ];
    }
  }
}
