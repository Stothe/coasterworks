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

/** Converts one sRGB channel (0..1) to linear light, which is what shaders and uniforms work in. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
