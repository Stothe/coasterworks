import type { Rgb } from "./palette.js";

export interface SunState {
  /** Radians above the horizon; negative while the sun is down. */
  elevation: number;
  /** Radians around the vertical axis, 0 toward +Z, increasing toward +X. */
  azimuth: number;
  /** Directional light intensity. */
  intensity: number;
  /** Directional light color as sRGB floats. */
  color: Rgb;
  /** Sky and fog color as sRGB floats. */
  skyColor: Rgb;
  /** Hemisphere light intensity; never below 0.25, so night is never black. */
  ambient: number;
}

const HORIZON_SUN: Rgb = [1.0, 0.72, 0.45];
const NOON_SUN: Rgb = [1.0, 0.95, 0.86];
const NIGHT_SKY: Rgb = [0.06, 0.08, 0.16];
const DUSK_SKY: Rgb = [0.95, 0.55, 0.35];
const DAY_SKY: Rgb = [0.62, 0.83, 0.95];

// This form is exact at k = 0 and k = 1.
const lerp = (a: number, b: number, k: number) => a * (1 - k) + b * k;
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [
  lerp(a[0], b[0], k),
  lerp(a[1], b[1], k),
  lerp(a[2], b[2], k),
];

/**
 * The sun and sky at time `t` of the visual day, where 0 is dawn, 0.5 is noon and 1 wraps back to
 * dawn (any real `t` is taken modulo 1). The sun is up for the whole day but low near both ends; the
 * sky holds its day color for the middle two thirds and turns through dusk to night at the ends.
 */
export function sunFor(t: number): SunState {
  const u = t - Math.floor(t);
  const s = Math.max(0, Math.sin(Math.PI * u));

  const skyColor =
    s < 0.2
      ? mix(NIGHT_SKY, DUSK_SKY, s / 0.2)
      : mix(DUSK_SKY, DAY_SKY, Math.min(1, (s - 0.2) / 0.3));

  return {
    elevation: -0.35 + 1.45 * s,
    azimuth: Math.PI / 4 + Math.PI * u,
    intensity: Math.min(2.2, Math.max(0.15, 0.15 + 2.2 * s)),
    color: mix(HORIZON_SUN, NOON_SUN, s),
    skyColor,
    ambient: Math.max(0.25, 0.75 * s),
  };
}
