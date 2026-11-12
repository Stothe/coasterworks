import { SIN_TABLE } from "./sin-table.js";

// Fixed-point units for track geometry and coaster physics. Integer math only: no `Math.sin`,
// `Math.atan2` or other engine-dependent functions, so every engine computes the same numbers.
//
// One length unit is 1/1024 of a tile, horizontally and vertically alike. A height step is a
// quarter of a tile, so it is 256 units: vertical positions are in 1/256 height step and
// horizontal ones in 1/1024 tile, and the two share one physical unit, which keeps slopes and
// curvature free of scale factors. A 256-tile map is 262,144 units across and height 63 steps
// is 16,128 units, far inside the safe-integer range even when squared.
//
// Angles are in 1/4096 of a turn, measured clockwise from north for headings (0 north, 1024
// east, 2048 south, 3072 west), upward for pitch, and right-side-down for roll.
// Sine and cosine come back scaled by 2^14 (TRIG_ONE).

/** Length units in one tile. */
export const TILE = 1024;
/** Length units in one height step (a quarter tile). */
export const STEP = 256;
/** Angle units in a full turn. */
export const TURN = 4096;
/** Angle units in a quarter turn. */
export const QUARTER_TURN = 1024;
/** The value of sine 1 and cosine 0: results of `isin`/`icos` are scaled by this. */
export const TRIG_ONE = 16384;

/** `a mod n` in 0..n-1, also for negative `a`. */
export function mod(a: number, n: number): number {
  const r = a % n;
  return r < 0 ? r + n : r + 0; // + 0 turns -0 into 0
}

/** `a / b` rounded to the nearest integer, halves toward +infinity. `b` must be positive. */
export function divRound(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/** Integer square root: the largest `r` with `r * r <= n`. `n` must be a non-negative integer. */
export function isqrt(n: number): number {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/** Sine of `angle` (in 1/4096 turn, any integer), scaled by 2^14. Exact table lookup. */
export function isin(angle: number): number {
  const a = mod(angle, TURN);
  if (a <= QUARTER_TURN) return SIN_TABLE[a]!;
  if (a <= 2 * QUARTER_TURN) return SIN_TABLE[2 * QUARTER_TURN - a]!;
  if (a <= 3 * QUARTER_TURN) return -SIN_TABLE[a - 2 * QUARTER_TURN]!;
  return -SIN_TABLE[TURN - a]!;
}

/** Cosine of `angle` (in 1/4096 turn, any integer), scaled by 2^14. */
export function icos(angle: number): number {
  return isin(angle + QUARTER_TURN);
}

/** Largest magnitude `iatan2` accepts without losing exactness in its products. */
const ATAN_LIMIT = 68_719_476_736; // 2^36

/**
 * The angle of the vector (x, y), in 1/4096 turn counter-clockwise from +x, in -2047..2048:
 * `iatan2(1, 1)` is 512, `iatan2(1, 0)` is 1024. Use it as `iatan2(rise, run)` for a pitch.
 * The result is the table angle nearest the true angle. `iatan2(0, 0)` is 0.
 */
export function iatan2(y: number, x: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new RangeError(`iatan2 takes integers, got ${y}, ${x}`);
  }
  if (Math.abs(x) > ATAN_LIMIT || Math.abs(y) > ATAN_LIMIT) {
    throw new RangeError(`iatan2 arguments must be within 2^36, got ${y}, ${x}`);
  }
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  // First quadrant: the smallest angle t in 0..1024 where sin(t) * ax >= cos(t) * ay, which is
  // monotonic in t, then whichever of t - 1 and t is closer to the true angle.
  let lo = 0;
  let hi = QUARTER_TURN;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (isin(mid) * ax >= icos(mid) * ay) hi = mid;
    else lo = mid + 1;
  }
  let t = lo;
  if (t > 0) {
    const over = isin(t) * ax - icos(t) * ay; // >= 0
    const under = icos(t - 1) * ay - isin(t - 1) * ax; // > 0
    if (under < over) t -= 1;
  }
  if (x >= 0 && y >= 0) return t;
  if (x < 0 && y >= 0) return 2 * QUARTER_TURN - t;
  if (x < 0) return t === 0 ? 2 * QUARTER_TURN : t - 2 * QUARTER_TURN;
  return -t;
}
