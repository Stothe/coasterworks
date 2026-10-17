import type { Surface } from "@coasterworks/sim";

/** An sRGB color as three floats in 0..1. */
export type Rgb = [number, number, number];

function hex(value: number): Rgb {
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** Base terrain colors by `Surface` (grass, sand, dirt, rock, snow), as sRGB floats. */
export const SURFACE_COLORS: Record<Surface, Rgb> = {
  0: hex(0x6fbf4a),
  1: hex(0xe3d28a),
  2: hex(0x8a6a3e),
  3: hex(0x8d8d8d),
  4: hex(0xf2f6fa),
};

/** Water color as sRGB floats. */
export const WATER_COLOR: Rgb = hex(0x3aa0e0);

/**
 * The color of tile (`x`, `y`) with surface `surface`. Grass gets a subtle checker: 4% lighter on
 * tiles where `(x + y)` is even and 4% darker where it is odd. Other surfaces are flat.
 */
export function surfaceColor(surface: Surface, x: number, y: number): Rgb {
  const [r, g, b] = SURFACE_COLORS[surface];
  if (surface !== 0) return [r, g, b];
  const k = (x + y) % 2 === 0 ? 1.04 : 0.96;
  return [Math.min(1, r * k), Math.min(1, g * k), Math.min(1, b * k)];
}

/** Converts one sRGB channel (0..1) to linear light, which is what three.js expects in vertex colors. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
