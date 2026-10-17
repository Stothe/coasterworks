import type { CameraRig } from "./camera.js";
import { tileTriangles, type TerrainData } from "./terrain-geometry.js";
import type { V3 } from "./units.js";

export interface Ray {
  origin: V3;
  /** Need not be normalized, but must not be zero. */
  direction: V3;
}

export interface TileHit {
  /** Tile x and y of the tile the ray hit first. */
  x: number;
  y: number;
  /** The hit point in world space. */
  point: V3;
}

/** Slack on barycentric coordinates so a ray through a shared edge or the diagonal cannot slip between triangles. */
const BARY_EPS = 1e-9;
/** Below this the ray counts as parallel to a triangle's plane (the direction is unit length). */
const PARALLEL_EPS = 1e-12;

/**
 * Möller-Trumbore for the triangle at `tri[off..off + 9]`. Returns the ray parameter of the hit, or
 * -1 for no hit. Two-sided, and a hit behind the origin does not count.
 */
function intersectTriangle(o: V3, d: V3, tri: Float64Array, off: number): number {
  const ax = tri[off] as number;
  const ay = tri[off + 1] as number;
  const az = tri[off + 2] as number;
  const e1x = (tri[off + 3] as number) - ax;
  const e1y = (tri[off + 4] as number) - ay;
  const e1z = (tri[off + 5] as number) - az;
  const e2x = (tri[off + 6] as number) - ax;
  const e2y = (tri[off + 7] as number) - ay;
  const e2z = (tri[off + 8] as number) - az;

  const px = d.y * e2z - d.z * e2y;
  const py = d.z * e2x - d.x * e2z;
  const pz = d.x * e2y - d.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < PARALLEL_EPS) return -1;
  const inv = 1 / det;

  const tx = o.x - ax;
  const ty = o.y - ay;
  const tz = o.z - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -BARY_EPS || u > 1 + BARY_EPS) return -1;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
  if (v < -BARY_EPS || u + v > 1 + BARY_EPS) return -1;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : -1;
}

/**
 * Finds the first tile surface a ray hits. It walks the tiles under the ray's footprint on the ground
 * (a 2D DDA from where the ray enters the map's outline, or from its origin when that is inside) and
 * tests both triangles of each tile, split the same way the geometry is. The first tile with a hit
 * holds the nearest one, because the walk visits tiles in the order the ray crosses them. Returns
 * `null` when the ray misses the map.
 */
export function pickTile(ray: Ray, t: TerrainData): TileHit | null {
  const { width, height } = t;
  if (width <= 0 || height <= 0) return null;
  const len = Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z);
  if (!(len > 0)) return null;
  const o = ray.origin;
  const d: V3 = { x: ray.direction.x / len, y: ray.direction.y / len, z: ray.direction.z / len };
  const tri = new Float64Array(18);

  const testTile = (tx: number, tz: number): TileHit | null => {
    tileTriangles(t, tx, tz, tri);
    const t0 = intersectTriangle(o, d, tri, 0);
    const t1 = intersectTriangle(o, d, tri, 9);
    const hit = t0 < 0 ? t1 : t1 < 0 ? t0 : Math.min(t0, t1);
    if (hit < 0) return null;
    return { x: tx, y: tz, point: { x: o.x + d.x * hit, y: o.y + d.y * hit, z: o.z + d.z * hit } };
  };

  // A vertical ray covers one tile.
  if (Math.abs(d.x) < PARALLEL_EPS && Math.abs(d.z) < PARALLEL_EPS) {
    const tx = Math.floor(o.x);
    const tz = Math.floor(o.z);
    if (tx < 0 || tz < 0 || tx >= width || tz >= height) return null;
    return testTile(tx, tz);
  }

  // The part of the ray (parameter >= 0) that lies over the map's outline.
  let tNear = 0;
  let tFar = Infinity;
  for (const [origin, dir, size] of [
    [o.x, d.x, width],
    [o.z, d.z, height],
  ] as const) {
    if (Math.abs(dir) < PARALLEL_EPS) {
      if (origin < 0 || origin > size) return null;
      continue;
    }
    const a = (0 - origin) / dir;
    const b = (size - origin) / dir;
    tNear = Math.max(tNear, Math.min(a, b));
    tFar = Math.min(tFar, Math.max(a, b));
  }
  if (tNear > tFar) return null;

  let tx = Math.min(width - 1, Math.max(0, Math.floor(o.x + d.x * tNear)));
  let tz = Math.min(height - 1, Math.max(0, Math.floor(o.z + d.z * tNear)));
  const stepX = d.x > 0 ? 1 : d.x < 0 ? -1 : 0;
  const stepZ = d.z > 0 ? 1 : d.z < 0 ? -1 : 0;
  const deltaX = stepX === 0 ? Infinity : 1 / Math.abs(d.x);
  const deltaZ = stepZ === 0 ? Infinity : 1 / Math.abs(d.z);
  let nextX = stepX === 0 ? Infinity : ((stepX > 0 ? tx + 1 : tx) - o.x) / d.x;
  let nextZ = stepZ === 0 ? Infinity : ((stepZ > 0 ? tz + 1 : tz) - o.z) / d.z;

  while (tx >= 0 && tx < width && tz >= 0 && tz < height) {
    const hit = testTile(tx, tz);
    if (hit) return hit;
    if (nextX < nextZ) {
      tx += stepX;
      nextX += deltaX;
    } else {
      tz += stepZ;
      nextZ += deltaZ;
    }
  }
  return null;
}

/**
 * The world-space ray through a point on the screen, for a perspective camera at `rig.position()`
 * looking at `rig.target` with +Y up. `ndcX` and `ndcY` are in -1..1 with +Y up, `aspect` is
 * width over height, and `fovYRadians` is the vertical field of view.
 */
export function rayFromCamera(
  rig: CameraRig,
  ndcX: number,
  ndcY: number,
  aspect: number,
  fovYRadians: number,
): Ray {
  const origin = rig.position();
  const fx0 = rig.target.x - origin.x;
  const fy0 = rig.target.y - origin.y;
  const fz0 = rig.target.z - origin.z;
  const fl = Math.hypot(fx0, fy0, fz0);
  const f = { x: fx0 / fl, y: fy0 / fl, z: fz0 / fl };

  // right = forward x up, with up = +Y.
  let rx = -f.z;
  let rz = f.x;
  const rl = Math.hypot(rx, rz);
  if (rl > 0) {
    rx /= rl;
    rz /= rl;
  } else {
    // Looking straight down: fall back on the yaw.
    rx = Math.cos(rig.yaw);
    rz = -Math.sin(rig.yaw);
  }
  // camera up = right x forward.
  const ux = -rz * f.y;
  const uy = rz * f.x - rx * f.z;
  const uz = rx * f.y;

  const half = Math.tan(fovYRadians / 2);
  const sx = ndcX * half * aspect;
  const sy = ndcY * half;
  const dx = f.x + rx * sx + ux * sy;
  const dy = f.y + uy * sy;
  const dz = f.z + rz * sx + uz * sy;
  const dl = Math.hypot(dx, dy, dz);
  return { origin, direction: { x: dx / dl, y: dy / dl, z: dz / dl } };
}
