import type { TerrainData } from "./terrain-geometry.js";
import { HEIGHT_STEP } from "./units.js";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The ground height, in world units, at world (`x`, `z`): bilinear between the four corners of the
 * tile the point is in, times `HEIGHT_STEP`. A point off the map takes the height of the nearest
 * point on its edge. This is what the camera rig uses to stay out of the hills, so it is smooth
 * and cheap rather than exact: the drawn tile is two triangles, which can differ from the
 * bilinear value by a fraction of the tile's own height range.
 */
export function groundHeightAt(t: TerrainData, x: number, z: number): number {
  const px = clamp(x, 0, t.width);
  const pz = clamp(z, 0, t.height);
  const tx = Math.min(Math.floor(px), t.width - 1);
  const tz = Math.min(Math.floor(pz), t.height - 1);
  const fx = px - tx;
  const fz = pz - tz;
  const stride = t.width + 1;
  const at = (cx: number, cz: number) => t.corners[cz * stride + cx] as number;
  const north = at(tx, tz) * (1 - fx) + at(tx + 1, tz) * fx;
  const south = at(tx, tz + 1) * (1 - fx) + at(tx + 1, tz + 1) * fx;
  return (north * (1 - fz) + south * fz) * HEIGHT_STEP;
}
