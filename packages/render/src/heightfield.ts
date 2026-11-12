import type { TerrainData } from "./terrain/geometry.js";
import { HEIGHT_STEP } from "./units.js";

/**
 * The smooth ground. The sim's terrain is a grid of integer corner heights; the drawn ground is a
 * smooth surface through those corners: one bicubic Hermite patch per tile, built from the heights
 * of the tile's four corners and the slope of the land at each of them along X and along Z.
 *
 * The slope at a corner along an axis comes from the corner and its two neighbors on that axis, by
 * the monotone rule (Fritsch-Carlson): zero where the three do not rise or fall together,
 * otherwise their central slope, held to three times the gentler of the two steps. A corner beside
 * a level stretch therefore has no slope toward it, which is what keeps level tiles level. Two
 * tiles that share an edge share its two corners, heights and slopes alike, so they agree along
 * the whole edge in height and in slope.
 *
 * What follows from that, and what the rest of the renderer relies on:
 *
 * - the surface passes exactly through every corner;
 * - a tile whose four corners are level is exactly flat all over, so paths and rides sit level;
 * - the surface never rises above the highest or dips below the lowest corner of the tile a point
 *   is in, so a single raised corner is a soft mound and not a spike;
 * - it is continuous everywhere and so is its slope, along both axes, across every tile border:
 *   there is no crease for the light to catch;
 * - it treats X and Z alike;
 * - off the map the corner grid carries on at the height of the nearest edge corner, so the land
 *   runs out level from the edge and the surface is defined for any (x, z).
 *
 * What it costs: a corner where the land along a row or a column stops rising (a level step on
 * one side, or a step back down) has no slope along that axis. Along a ridge or a valley that
 * runs diagonally across the grid, where two faces meet, that is every corner on the ridge on
 * both axes, so the ridge is a chain of small level spots, one a tile, with the land a fraction
 * of a height step lower or higher between them. Anything that keeps level tiles level, stays
 * within the corners and has no crease must do this. The shape is close to right, but its exact
 * slope, used to light it, would show those spots as a band once a tile along every ridge.
 *
 * So the ground is lit with a second, smoother slope (`groundNormalAt`): that of the cubic
 * B-spline surface the same corners define. That surface does not pass through the corners or
 * keep level tiles level, which is why nothing stands on it, but its slope turns evenly through a
 * ridge whichever way the ridge runs, is exact wherever the land is a plane, and is continuous
 * everywhere along with its own rate of change. The two agree on planes and differ by a few
 * degrees on average over hilly land, by up to about 25 right at a sharp fold or a peak, which
 * is the fold being lit as the rounded thing it is meant to be.
 */

/**
 * The slope at `p1` of the curve through `p0`, `p1`, `p2`, which are one apart: zero at a peak,
 * a dip or a level stretch, otherwise the central slope, held to three times the gentler of the
 * two steps. That limit is what keeps a curve along a row of corners between its corners.
 */
function tangent(p0: number, p1: number, p2: number): number {
  const before = p1 - p0;
  const after = p2 - p1;
  if (before * after <= 0) return 0;
  const limit = 3 * Math.min(Math.abs(before), Math.abs(after));
  const slope = (p2 - p0) / 2;
  return slope > limit ? limit : slope < -limit ? -limit : slope;
}

/** The smooth ground height at (`x`, `z`) in sim height steps (not yet world units). */
function heightSteps(t: TerrainData, x: number, z: number): number {
  const stride = t.width + 1;
  const { corners, width, height } = t;
  // Far off the map everything is level, and clamping here keeps the indices small.
  const px = x < -2 ? -2 : x > width + 2 ? width + 2 : x;
  const pz = z < -2 ? -2 : z > height + 2 ? height + 2 : z;
  const tx = Math.floor(px);
  const tz = Math.floor(pz);
  const u = px - tx;
  const v = pz - tz;

  // The four corner columns and rows around the point, each held to the map.
  const c0 = tx - 1 < 0 ? 0 : tx - 1 > width ? width : tx - 1;
  const c1 = tx < 0 ? 0 : tx > width ? width : tx;
  const c2 = tx + 1 < 0 ? 0 : tx + 1 > width ? width : tx + 1;
  const c3 = tx + 2 < 0 ? 0 : tx + 2 > width ? width : tx + 2;
  const r0 = (tz - 1 < 0 ? 0 : tz - 1 > height ? height : tz - 1) * stride;
  const r1 = (tz < 0 ? 0 : tz > height ? height : tz) * stride;
  const r2 = (tz + 1 < 0 ? 0 : tz + 1 > height ? height : tz + 1) * stride;
  const r3 = (tz + 2 < 0 ? 0 : tz + 2 > height ? height : tz + 2) * stride;

  // The tile's own corners: north-west, north-east, south-west, south-east.
  const nw = corners[r1 + c1] as number;
  const ne = corners[r1 + c2] as number;
  const sw = corners[r2 + c1] as number;
  const se = corners[r2 + c2] as number;

  // The slope along X at each of the four corners, from the corners beside it in its row.
  const nwX = tangent(corners[r1 + c0] as number, nw, ne);
  const neX = tangent(nw, ne, corners[r1 + c3] as number);
  const swX = tangent(corners[r2 + c0] as number, sw, se);
  const seX = tangent(sw, se, corners[r2 + c3] as number);
  // And along Z, from the corners above and below it in its column.
  const nwZ = tangent(corners[r0 + c1] as number, nw, sw);
  const neZ = tangent(corners[r0 + c2] as number, ne, se);
  const swZ = tangent(nw, sw, corners[r3 + c1] as number);
  const seZ = tangent(ne, se, corners[r3 + c2] as number);

  // Hermite weights. Everything is written around the first value, so that level corners give
  // exactly that value back.
  const u2 = u * u;
  const u3 = u2 * u;
  const blendU = 3 * u2 - 2 * u3;
  const startU = u3 - 2 * u2 + u;
  const endU = u3 - u2;

  // The curve along the tile's north edge and along its south edge, at this x.
  const north = nw + (ne - nw) * blendU + nwX * startU + neX * endU;
  const south = sw + (se - sw) * blendU + swX * startU + seX * endU;
  // The slope along Z on those two edges at this x: the corners' slopes, blended along the edge.
  const northZ = nwZ + (neZ - nwZ) * blendU;
  const southZ = swZ + (seZ - swZ) * blendU;

  const v2 = v * v;
  const v3 = v2 * v;
  const h =
    north + (south - north) * (3 * v2 - 2 * v3) + northZ * (v3 - 2 * v2 + v) + southZ * (v3 - v2);

  // The edges of the patch cannot leave the range of their corners, but its middle can, a little,
  // over a sharp saddle. Holding it to the corners' range costs a small level spot there.
  const low = Math.min(nw, ne, sw, se);
  const high = Math.max(nw, ne, sw, se);
  return h < low ? low : h > high ? high : h;
}

/**
 * The height of the smooth ground, in world units, at world (`x`, `z`). Defined everywhere: off
 * the map it is the height of the nearest point on the map's edge.
 */
export function groundHeightAt(t: TerrainData, x: number, z: number): number {
  return heightSteps(t, x, z) * HEIGHT_STEP;
}

/**
 * The height of the ground a scene stands things on and keeps its camera above, in world units at
 * world (`x`, `z`): the park's smooth ground over the map, its edge included, and beyond the edge
 * the land out there, `outer`, when there is one (the surroundings' hills). Without `outer` it is
 * the smooth ground everywhere, which runs out level from the edge. Zero while there is no
 * terrain.
 */
export function sceneGroundAt(
  t: TerrainData | null,
  outer: ((x: number, z: number) => number) | null,
  x: number,
  z: number,
): number {
  if (!t) return 0;
  if (outer && (x < 0 || z < 0 || x > t.width || z > t.height)) return outer(x, z);
  return groundHeightAt(t, x, z);
}

/** The 4 by 4 corner heights around a point, row by row; `groundNormalAt` fills and reads it. */
const around = new Float64Array(16);

/**
 * The three steps between four of those heights, `stride` apart from `first`, weighted. A row is
 * a stride of 1 and a column a stride of 4.
 */
function steps(first: number, stride: number, w0: number, w1: number, w2: number): number {
  const p0 = around[first] as number;
  const p1 = around[first + stride] as number;
  const p2 = around[first + stride * 2] as number;
  const p3 = around[first + stride * 3] as number;
  return w0 * (p1 - p0) + w1 * (p2 - p1) + w2 * (p3 - p2);
}

/**
 * The unit normal `[x, y, z]` the smooth ground is lit with at world (`x`, `z`): the normal of
 * the cubic B-spline surface through the sixteen corners around the point (see the top of this
 * file for why it is not the exact normal of `groundHeightAt`). Over a plane it is the plane's
 * normal exactly; where those sixteen corners are level it is exactly `[0, 1, 0]`; beside a
 * slope, a level tile's normal leans a little toward it, fading out within the tile. It depends
 * only on the terrain and the point, so two meshes that share a vertex position get the very same
 * normal there. Off the map the corner grid carries on as it does for the height.
 */
export function groundNormalAt(t: TerrainData, x: number, z: number): [number, number, number] {
  const stride = t.width + 1;
  const { corners, width, height } = t;
  const px = x < -2 ? -2 : x > width + 2 ? width + 2 : x;
  const pz = z < -2 ? -2 : z > height + 2 ? height + 2 : z;
  const tx = Math.floor(px);
  const tz = Math.floor(pz);
  const u = px - tx;
  const v = pz - tz;

  for (let j = 0; j < 4; j++) {
    const cz = tz - 1 + j;
    const row = (cz < 0 ? 0 : cz > height ? height : cz) * stride;
    for (let i = 0; i < 4; i++) {
      const cx = tx - 1 + i;
      around[j * 4 + i] = corners[row + (cx < 0 ? 0 : cx > width ? width : cx)] as number;
    }
  }

  // The slope of a cubic B-spline is the quadratic B-spline of the steps between its points.
  // Working from the steps means that land with no step along an axis has exactly no slope along
  // it, whatever the weights round to.
  const u2 = u * u;
  const v2 = v * v;
  const stepU0 = (1 - u) * (1 - u) * 0.5;
  const stepU1 = -u2 + u + 0.5;
  const stepU2 = u2 * 0.5;
  const stepV0 = (1 - v) * (1 - v) * 0.5;
  const stepV1 = -v2 + v + 0.5;
  const stepV2 = v2 * 0.5;
  // And across the other axis, the cubic B-spline's own weights.
  const sixth = 1 / 6;
  const baseU0 = (1 - u) * (1 - u) * (1 - u) * sixth;
  const baseU1 = (3 * u2 * u - 6 * u2 + 4) * sixth;
  const baseU2 = (-3 * u2 * u + 3 * u2 + 3 * u + 1) * sixth;
  const baseU3 = u2 * u * sixth;
  const baseV0 = (1 - v) * (1 - v) * (1 - v) * sixth;
  const baseV1 = (3 * v2 * v - 6 * v2 + 4) * sixth;
  const baseV2 = (-3 * v2 * v + 3 * v2 + 3 * v + 1) * sixth;
  const baseV3 = v2 * v * sixth;

  // The slope along X in each of the four rows, blended across them; and the same turned round.
  const dx =
    (baseV0 * steps(0, 1, stepU0, stepU1, stepU2) +
      baseV1 * steps(4, 1, stepU0, stepU1, stepU2) +
      baseV2 * steps(8, 1, stepU0, stepU1, stepU2) +
      baseV3 * steps(12, 1, stepU0, stepU1, stepU2)) *
    HEIGHT_STEP;
  const dz =
    (baseU0 * steps(0, 4, stepV0, stepV1, stepV2) +
      baseU1 * steps(1, 4, stepV0, stepV1, stepV2) +
      baseU2 * steps(2, 4, stepV0, stepV1, stepV2) +
      baseU3 * steps(3, 4, stepV0, stepV1, stepV2)) *
    HEIGHT_STEP;

  const inv = 1 / Math.hypot(dx, 1, dz);
  // Adding zero turns a negative zero into a plain one, so level ground is exactly [0, 1, 0].
  return [-dx * inv + 0, inv, -dz * inv + 0];
}
