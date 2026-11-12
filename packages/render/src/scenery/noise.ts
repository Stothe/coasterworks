/**
 * The noise the land beyond the park and everything scattered on it are made from, computed on the
 * CPU. All of it comes from integer hashes of lattice points, so the same coordinates give the
 * same numbers on every machine and in every run: the hills, the forests and each tree's shape
 * never change between sessions.
 */

/** A well-mixed 32-bit number for a lattice point and a seed. */
export function hash2(ix: number, iy: number, seed: number): number {
  let h =
    Math.imul(ix | 0, 0x9e3779b1) ^ Math.imul(iy | 0, 0x85ebca77) ^ Math.imul(seed | 0, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** A number in 0..1 (1 excluded) for a lattice point and a seed. */
export function hash01(ix: number, iy: number, seed: number): number {
  return hash2(ix, iy, seed) / 4294967296;
}

/**
 * A repeatable stream of numbers in 0..1 (1 excluded), for building one thing (a tree, a rock)
 * whose every random choice must come out the same each time.
 */
export function randomStream(seed: number): () => number {
  let state = seed | 0;
  return () => {
    // mulberry32
    state = (state + 0x6d2b79f5) | 0;
    let r = Math.imul(state ^ (state >>> 15), 1 | state);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (f: number) => f * f * f * (f * (f * 6 - 15) + 10);

/** The dot product of the lattice point's gradient with the offset (`fx`, `fy`) from it. */
function corner(ix: number, iy: number, seed: number, fx: number, fy: number): number {
  const h = hash2(ix, iy, seed);
  // Two independent numbers in -1..1 out of the one hash.
  const gx = (h & 0xffff) / 32767.5 - 1;
  const gy = (h >>> 16) / 32767.5 - 1;
  return gx * fx + gy * fy;
}

/**
 * Smooth gradient noise with one feature per unit, in about -1..1 (it keeps within -0.75..0.75
 * nearly everywhere) and exactly 0 at every lattice point.
 */
export function noise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fade(fx);
  const v = fade(fy);
  const a = corner(ix, iy, seed, fx, fy);
  const b = corner(ix + 1, iy, seed, fx - 1, fy);
  const c = corner(ix, iy + 1, seed, fx, fy - 1);
  const d = corner(ix + 1, iy + 1, seed, fx - 1, fy - 1);
  return (a + (b - a) * u + (c - a + (a - b - c + d) * u) * v) * 1.4;
}

/**
 * A fractal sum of `octaves` layers of `noise2`, each twice as fine and half as strong as the one
 * before and turned so the lattices do not line up. In about -1..1.
 */
export function fbm2(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0;
  let weight = 0.5;
  let total = 0;
  let px = x;
  let py = y;
  for (let k = 0; k < octaves; k++) {
    sum += weight * noise2(px, py, seed + k * 101);
    total += weight;
    weight *= 0.5;
    // Turn by about 37 degrees and double the frequency.
    const nx = 1.6 * px - 1.2 * py + 17.3;
    py = 1.2 * px + 1.6 * py + 9.1;
    px = nx;
  }
  return sum / total;
}

/**
 * Smooth noise over three dimensions, in about -1..1: three planes of `noise2` through the point,
 * which is plenty for giving a lump to a shape and far cheaper than a true 3D lattice.
 */
export function noise3(x: number, y: number, z: number, seed: number): number {
  return (
    (noise2(x + z * 0.37, y - z * 0.61, seed) +
      noise2(y + x * 0.43, z - x * 0.29, seed + 31) +
      noise2(z + y * 0.53, x - y * 0.47, seed + 67)) /
    3
  );
}

/** 0 below `a`, 1 above `b`, and a smooth S between. */
export function smoothstep(a: number, b: number, x: number): number {
  const k = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return k * k * (3 - 2 * k);
}
