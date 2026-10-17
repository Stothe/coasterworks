/**
 * World space for the renderer: world X is the tile's x, world Z is the tile's y, and world Y is the
 * corner height times `HEIGHT_STEP`. Tile (x, y) spans world X in [x, x + 1] and Z in [y, y + 1].
 * The camera's "north" is -Z.
 */

/** World units per sim height step. */
export const HEIGHT_STEP = 0.25;

/** Tiles per chunk edge. Each chunk is one mesh (plus one for its water). */
export const CHUNK = 16;

/** How far the water surface sits above its nominal level, so it never fights the terrain. */
export const WATER_LIFT = 0.01;

/** A point or direction in world space. */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** The world position `[x, y, z]` of tile corner (`x`, `y`) at sim height `h`. */
export function tileToWorld(x: number, y: number, h: number): [number, number, number] {
  return [x, h * HEIGHT_STEP, y];
}
