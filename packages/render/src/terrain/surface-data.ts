import { HEIGHT_STEP } from "../units.js";
import type { TerrainData } from "./geometry.js";

/**
 * The data the ground's shader (`surface.glsl.ts`) reads, built on the CPU:
 *
 * - the surface weights: how much sand, dirt, rock and snow there is at a point, as a smooth field
 *   the shader can sample with linear filtering and bend with noise, so that a painted square of
 *   sand comes out as a patch with a natural edge;
 * - the ground field: how near water is and at what level it stands, and how far the ground rises
 *   above or dips below the land around it;
 * - the detail noise: one tileable noise texture, with mipmaps, that gives the shader its
 *   mottling and bump for the price of a texture read;
 * - the grain: a second tileable texture of drawn marks (grass blades, specks, cracks), which is
 *   what the ground is made of when seen from close by.
 *
 * The first two cover the map plus `SURFACE_MARGIN` tiles on every side. Texel (i, j) of a texture
 * with `n` texels per tile holds the value at tile coordinates `((i + 0.5) / n - SURFACE_MARGIN,
 * (j + 0.5) / n - SURFACE_MARGIN)`, which is world (x, z). Everything fades to nothing inside the
 * margin, so the outermost texels are zero and a clamped read beyond them finds plain ground.
 */

/** Tiles of margin the weights and the ground field cover around the map. */
export const SURFACE_MARGIN = 6;
/** Texels per tile edge of the weights texture. */
export const WEIGHT_TEXELS = 4;
/** Texels per tile edge of the ground field texture. */
export const FIELD_TEXELS = 2;
/** Tiles from water at which the water proximity reaches zero. */
export const WATER_REACH = 3;
/** Corners on each side that the local mean height of the relief is taken over. */
export const RELIEF_RADIUS = 4;
/** World units of rise above (or dip below) the local mean that the relief byte saturates at. */
export const RELIEF_RANGE = 1.5;
/** Edge length in texels of the detail noise texture. */
export const DETAIL_SIZE = 256;
/** Edge length in texels of the grain texture. */
export const GRAIN_SIZE = 512;
/** Texels from a crack's middle at which the grain's crack channel reaches 255. */
export const CRACK_SPAN = 8;

/** How far, in tiles, a tile's surface reaches into the weights around it. */
const WEIGHT_REACH = 1;
/** How far, in tiles, a tile's water or a corner's height reaches into the ground field. */
const FIELD_REACH = Math.max(WATER_REACH + 1, RELIEF_RADIUS + 1);

/** Four bytes per texel, row by row from the north-west texel. */
export interface SurfaceTexture {
  data: Uint8Array;
  width: number;
  height: number;
}

/** A rectangle of tiles (or of corners): `x0 <= x < x1`, `y0 <= y < y1`. */
export interface GridRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Hermite step from 0 at `d <= -0.5` to 1 at `d >= 0.5`. */
function ramp(d: number): number {
  const u = clamp(d + 0.5, 0, 1);
  return u * u * (3 - 2 * u);
}

function emptyTexture(t: TerrainData, texels: number): SurfaceTexture {
  const width = (t.width + 2 * SURFACE_MARGIN) * texels;
  const height = (t.height + 2 * SURFACE_MARGIN) * texels;
  return { data: new Uint8Array(width * height * 4), width, height };
}

/** The texels that hold tiles `rect` grown by `reach` tiles, held to the texture. */
function texelRect(out: SurfaceTexture, texels: number, rect: GridRect, reach: number): GridRect {
  return {
    x0: clamp((rect.x0 - reach + SURFACE_MARGIN) * texels, 0, out.width),
    y0: clamp((rect.y0 - reach + SURFACE_MARGIN) * texels, 0, out.height),
    x1: clamp((rect.x1 + reach + SURFACE_MARGIN) * texels, 0, out.width),
    y1: clamp((rect.y1 + reach + SURFACE_MARGIN) * texels, 0, out.height),
  };
}

/**
 * The smallest rectangle that holds every cell where two grids of `cols` by `rows` cells differ,
 * or null when they are the same.
 */
export function changedRect(
  before: ArrayLike<number>,
  after: ArrayLike<number>,
  cols: number,
  rows: number,
): GridRect | null {
  let x0 = cols;
  let y0 = rows;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < rows; y++) {
    const row = y * cols;
    for (let x = 0; x < cols; x++) {
      if (before[row + x] === after[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** The smallest rectangle that holds both, or whichever is not null. */
export function unionRect(a: GridRect | null, b: GridRect | null): GridRect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** The tiles that touch the corners of `corners` (a rectangle of corner indices). */
export function tilesAroundCorners(corners: GridRect): GridRect {
  return { x0: corners.x0 - 1, y0: corners.y0 - 1, x1: corners.x1, y1: corners.y1 };
}

/**
 * Bakes the surface weights into `out`: for the whole map, or with `tiles` only for the texels
 * those tiles can reach (what a repaint of those tiles changes).
 *
 * R, G, B and A are how much sand, dirt, rock and snow there is; grass is what is left of 255, so
 * plain grass is all zeros and the four never add up to more than 255. Each tile spreads its
 * surface over itself and half a tile beyond, with a smooth falloff: a texel in the middle of a
 * tile holds that tile's surface alone, the weight is one half on the border between two
 * surfaces, and the fields of neighboring tiles always add up to one. Tiles beyond the map count
 * as grass. A surface the renderer does not know is grass.
 */
export function bakeSurfaceWeights(t: TerrainData, out: SurfaceTexture, tiles?: GridRect): void {
  const whole = { x0: 0, y0: 0, x1: t.width, y1: t.height };
  const region = texelRect(out, WEIGHT_TEXELS, tiles ?? whole, tiles ? WEIGHT_REACH : 1e6);
  const sums = [0, 0, 0, 0];
  for (let j = region.y0; j < region.y1; j++) {
    const py = (j + 0.5) / WEIGHT_TEXELS - SURFACE_MARGIN;
    const ty = Math.floor(py);
    for (let i = region.x0; i < region.x1; i++) {
      const px = (i + 0.5) / WEIGHT_TEXELS - SURFACE_MARGIN;
      const tx = Math.floor(px);
      sums[0] = sums[1] = sums[2] = sums[3] = 0;
      for (let y = ty - 1; y <= ty + 1; y++) {
        if (y < 0 || y >= t.height) continue;
        // How much of the falloff, centered on this texel, lies over row y.
        const wy = ramp(py - y) - ramp(py - y - 1);
        if (wy <= 0) continue;
        for (let x = tx - 1; x <= tx + 1; x++) {
          if (x < 0 || x >= t.width) continue;
          const surface = t.surface[y * t.width + x] as number;
          // Surfaces 1 to 4 are sand, dirt, rock and snow, in the order of the channels.
          if (surface < 1 || surface > 4) continue;
          sums[surface - 1]! += wy * (ramp(px - x) - ramp(px - x - 1));
        }
      }
      const at = (j * out.width + i) * 4;
      let total = 0;
      let largest = 0;
      for (let c = 0; c < 4; c++) {
        const byte = Math.round((sums[c] as number) * 255);
        out.data[at + c] = byte;
        total += byte;
        if (byte > (out.data[at + largest] as number)) largest = c;
      }
      // Rounding four parts of a whole can come to a little over it.
      if (total > 255) out.data[at + largest]! -= total - 255;
    }
  }
}

/** The surface weights of a whole terrain: `WEIGHT_TEXELS` texels per tile, map plus margin. */
export function buildSurfaceWeights(t: TerrainData): SurfaceTexture {
  const out = emptyTexture(t, WEIGHT_TEXELS);
  bakeSurfaceWeights(t, out);
  return out;
}

/** The height in sim steps of corner (x, y), with the grid carried on level beyond its edge. */
function cornerAt(t: TerrainData, x: number, y: number): number {
  const cx = clamp(x, 0, t.width);
  const cy = clamp(y, 0, t.height);
  return t.corners[cy * (t.width + 1) + cx] as number;
}

/** Corner heights joined bilinearly, in sim steps, at tile coordinates (px, py). */
function heightAt(t: TerrainData, px: number, py: number): number {
  const x = Math.floor(px);
  const y = Math.floor(py);
  const fx = px - x;
  const fy = py - y;
  const north = cornerAt(t, x, y) * (1 - fx) + cornerAt(t, x + 1, y) * fx;
  const south = cornerAt(t, x, y + 1) * (1 - fx) + cornerAt(t, x + 1, y + 1) * fx;
  return north * (1 - fy) + south * fy;
}

/**
 * How far the ground at (px, py) stands above the land around it, in sim steps: its height less
 * the mean of the corners within `RELIEF_RADIUS + 1`, weighted down to nothing at that distance so
 * the value moves smoothly with the point. Positive on a rise, negative in a hollow, zero on a
 * plain and on an even slope.
 */
function reliefAt(t: TerrainData, px: number, py: number): number {
  const reach = RELIEF_RADIUS + 1;
  let sum = 0;
  let total = 0;
  for (let y = Math.ceil(py - reach); y <= Math.floor(py + reach); y++) {
    const wy = 1 - Math.abs(y - py) / reach;
    if (wy <= 0) continue;
    for (let x = Math.ceil(px - reach); x <= Math.floor(px + reach); x++) {
      const w = wy * (1 - Math.abs(x - px) / reach);
      if (w <= 0) continue;
      sum += w * cornerAt(t, x, y);
      total += w;
    }
  }
  return heightAt(t, px, py) - sum / total;
}

/**
 * Bakes the ground field into `out`: for the whole map, or with `tiles` only for the texels that
 * a change to those tiles' water or corners can reach.
 *
 * - R: water proximity. 255 over a water tile, falling smoothly to 0 at `WATER_REACH` tiles from
 *   the nearest one (measured to the tile's square, so the field has no steps or corners in it).
 * - G: the water level, in sim steps, of the nearest water tile within `WATER_REACH + 1` tiles;
 *   0 where there is none. It reaches a tile further than the proximity does, so wherever the
 *   proximity is above zero the level beside it is a real one, also under linear filtering.
 * - B: relief. 128 where the ground is level with the land around it, more on a rise and less in
 *   a hollow, reaching 255 or 1 at `RELIEF_RANGE` world units.
 * - A: 255.
 */
export function bakeGroundField(t: TerrainData, out: SurfaceTexture, tiles?: GridRect): void {
  const whole = { x0: 0, y0: 0, x1: t.width, y1: t.height };
  const region = texelRect(out, FIELD_TEXELS, tiles ?? whole, tiles ? FIELD_REACH : 1e6);
  const levelReach = WATER_REACH + 1;
  for (let j = region.y0; j < region.y1; j++) {
    const py = (j + 0.5) / FIELD_TEXELS - SURFACE_MARGIN;
    const yLo = Math.max(0, Math.floor(py - levelReach));
    const yHi = Math.min(t.height - 1, Math.floor(py + levelReach));
    for (let i = region.x0; i < region.x1; i++) {
      const px = (i + 0.5) / FIELD_TEXELS - SURFACE_MARGIN;
      const xLo = Math.max(0, Math.floor(px - levelReach));
      const xHi = Math.min(t.width - 1, Math.floor(px + levelReach));

      let nearest = levelReach * levelReach;
      let level = 0;
      for (let y = yLo; y <= yHi; y++) {
        const dy = Math.max(y - py, 0, py - y - 1);
        for (let x = xLo; x <= xHi; x++) {
          const tileLevel = t.water[y * t.width + x] as number;
          if (tileLevel === 0) continue;
          const dx = Math.max(x - px, 0, px - x - 1);
          const d = dx * dx + dy * dy;
          if (d < nearest) {
            nearest = d;
            level = tileLevel;
          }
        }
      }
      const near = 1 - clamp(Math.sqrt(nearest) / WATER_REACH, 0, 1);
      const relief = (reliefAt(t, px, py) * HEIGHT_STEP) / RELIEF_RANGE;

      const at = (j * out.width + i) * 4;
      out.data[at] = Math.round(near * near * (3 - 2 * near) * 255);
      out.data[at + 1] = level;
      out.data[at + 2] = 128 + Math.round(clamp(relief, -1, 1) * 127);
      out.data[at + 3] = 255;
    }
  }
}

/** The ground field of a whole terrain: `FIELD_TEXELS` texels per tile, map plus margin. */
export function buildGroundField(t: TerrainData): SurfaceTexture {
  const out = emptyTexture(t, FIELD_TEXELS);
  bakeGroundField(t, out);
  return out;
}

/** A well mixed 32-bit number for a lattice point. */
function latticeHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(seed, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * Gradient noise that repeats every `period` lattice cells on both axes, about -0.7..0.7. The
 * gradients are unit vectors at an angle taken from the hash, so the noise has no preferred
 * direction.
 */
function periodicNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const dot = (ix: number, iy: number, dx: number, dy: number) => {
    const wrapX = ((ix % period) + period) % period;
    const wrapY = ((iy % period) + period) % period;
    const angle = (latticeHash(wrapX, wrapY, seed) / 4294967296) * Math.PI * 2;
    return Math.cos(angle) * dx + Math.sin(angle) * dy;
  };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = dot(xi, yi, fx, fy);
  const b = dot(xi + 1, yi, fx - 1, fy);
  const c = dot(xi, yi + 1, fx, fy - 1);
  const d = dot(xi + 1, yi + 1, fx - 1, fy - 1);
  return a + u * (b - a) + v * (c - a) + u * v * (a - b - c + d);
}

/**
 * A tileable fractal field of `size` by `size` values with a mean of 0 and a standard deviation
 * of 1: `octaves` layers of periodic noise from `cycles` features across the texture, each layer
 * twice as fine as the last and `gain` times as strong.
 */
function tileableFbm(
  size: number,
  cycles: number,
  octaves: number,
  gain: number,
  seed: number,
): Float32Array {
  const field = new Float32Array(size * size);
  let amplitude = 1;
  let frequency = cycles;
  for (let o = 0; o < octaves; o++) {
    const scale = frequency / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        field[y * size + x]! += amplitude * periodicNoise(x * scale, y * scale, frequency, seed + o);
      }
    }
    amplitude *= gain;
    frequency *= 2;
  }
  let mean = 0;
  for (let k = 0; k < field.length; k++) mean += field[k] as number;
  mean /= field.length;
  let variance = 0;
  for (let k = 0; k < field.length; k++) variance += ((field[k] as number) - mean) ** 2;
  const deviation = Math.sqrt(variance / field.length) || 1;
  for (let k = 0; k < field.length; k++) field[k] = ((field[k] as number) - mean) / deviation;
  return field;
}

/** Standard deviations of a detail field that span half of the byte range (0.5 is the mean). */
const DETAIL_SPREAD = 2.6;

/**
 * The detail noise texture, `size` texels square (a power of two), four bytes per texel. It
 * repeats seamlessly on both axes, and every channel has a mean of one half, so its mipmaps fade
 * each one evenly to "nothing" with distance: the shader's fine detail goes away by itself instead
 * of shimmering.
 *
 * - R: a rough height, from broad lumps down to grain two texels wide.
 * - G: a second, softer field with nothing in common with the first.
 * - B, A: the slope of R along x and along y (0.5 is level), for bump shading. One unit of the
 *   byte range is the same slope in both.
 */
export function buildDetailNoise(size: number = DETAIL_SIZE): Uint8Array {
  const height = tileableFbm(size, 4, 5, 0.62, 101);
  const soft = tileableFbm(size, 3, 5, 0.5, 211);
  const wrap = (v: number) => (v + size) % size;

  const slopeX = new Float32Array(size * size);
  const slopeY = new Float32Array(size * size);
  let variance = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      const dx = ((height[y * size + wrap(x + 1)] as number) - (height[y * size + wrap(x - 1)] as number)) / 2;
      const dy = ((height[wrap(y + 1) * size + x] as number) - (height[wrap(y - 1) * size + x] as number)) / 2;
      slopeX[k] = dx;
      slopeY[k] = dy;
      variance += dx * dx + dy * dy;
    }
  }
  const slopeDeviation = Math.sqrt(variance / (2 * size * size)) || 1;

  const data = new Uint8Array(size * size * 4);
  const byte = (v: number) => Math.round(clamp(0.5 + v / (2 * DETAIL_SPREAD), 0, 1) * 255);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = byte(height[k] as number);
    data[k * 4 + 1] = byte(soft[k] as number);
    data[k * 4 + 2] = byte((slopeX[k] as number) / slopeDeviation);
    data[k * 4 + 3] = byte((slopeY[k] as number) / slopeDeviation);
  }
  return data;
}

/** A repeatable stream of numbers in 0..1 (mulberry32). */
function randomStream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let v = Math.imul(a ^ (a >>> 15), a | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws grass seen from above into a `size` by `size` field that repeats on both axes: thousands
 * of short, slightly bent strokes, each dark at its foot and light at its tip, the taller ones
 * over the shorter. Values 0 (bare) to 1 (the tip of the tallest blade). `size` is a power of two.
 */
function drawBlades(size: number, seed: number): Float32Array {
  const field = new Float32Array(size * size);
  const random = randomStream(seed);
  // Strokes are sized against a 512 texture, so a smaller one holds the same picture, coarser.
  const unit = size / 512;
  const count = Math.round((size * size) / (8 * unit * unit));
  const mask = size - 1;
  for (let n = 0; n < count; n++) {
    let x = random() * size;
    let y = random() * size;
    // Mostly one way, as wind and light comb grass, with a wide spread.
    let angle = (random() + random() + random() - 1.5) * 1.5;
    const bend = ((random() - 0.5) * 0.14) / unit;
    const length = (9 + random() * 15) * unit;
    const tall = 0.45 + random() * 0.55;
    const width = (0.9 + random() * 0.9) * unit;
    // One dab every three quarters of a texel along the blade.
    const steps = Math.ceil(length / 0.75);
    for (let k = 0; k <= steps; k++) {
      const along = k / steps;
      // Narrowing to the tip, and lighter there.
      const radius = Math.max(0.55, width * (1 - 0.65 * along));
      const value = tall * (0.3 + 0.7 * along);
      const reach = Math.ceil(radius);
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      for (let j = cy - reach; j <= cy + reach; j++) {
        const dy = j + 0.5 - y;
        const row = (j & mask) * size;
        for (let i = cx - reach; i <= cx + reach; i++) {
          const dx = i + 0.5 - x;
          const cover = radius + 0.5 - Math.sqrt(dx * dx + dy * dy);
          if (cover <= 0) continue;
          const at = row + (i & mask);
          const v = cover < 1 ? value * cover : value;
          if (v > (field[at] as number)) field[at] = v;
        }
      }
      x += Math.sin(angle) * 0.75;
      y -= Math.cos(angle) * 0.75;
      angle += bend;
    }
  }
  return field;
}

/**
 * Scatters specks (pebbles, grains, flower heads) over a `size` by `size` field that repeats on
 * both axes: one in most cells of a `cells` by `cells` grid, placed and sized so that it stays
 * inside its cell. `cover` is 1 on a speck and 0 off it, with an edge one texel soft; `id` is a
 * number in 0..1 that names the speck, held over the whole of its cell so that filtering across a
 * speck's edge does not change it.
 */
function drawSpecks(
  size: number,
  cells: number,
  seed: number,
): { cover: Float32Array; id: Float32Array } {
  const cover = new Float32Array(size * size);
  const id = new Float32Array(size * size);
  const cell = size / cells;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const random = randomStream(latticeHash(cx, cy, seed));
      const name = random();
      const present = random() < 0.7;
      // Most specks are small, a few are large.
      const radius = cell * (0.07 + 0.2 * random() ** 2.2);
      const room = cell / 2 - radius - 0.5;
      const x = (cx + 0.5) * cell + (random() * 2 - 1) * room;
      const y = (cy + 0.5) * cell + (random() * 2 - 1) * room;
      for (let j = Math.floor(cy * cell); j < Math.floor((cy + 1) * cell); j++) {
        for (let i = Math.floor(cx * cell); i < Math.floor((cx + 1) * cell); i++) {
          const at = j * size + i;
          id[at] = name;
          if (present) cover[at] = clamp(radius - Math.hypot(i + 0.5 - x, j + 0.5 - y) + 0.5, 0, 1);
        }
      }
    }
  }
  return { cover, id };
}

/**
 * The cracks between the stones of a broken surface, as a `size` by `size` field that repeats on
 * both axes: the distance in texels from each texel to the nearest border between two cells of a
 * scattering of `cells` by `cells` points (0 on a crack, growing into the stone).
 */
function drawCracks(size: number, cells: number, seed: number): Float32Array {
  const field = new Float32Array(size * size);
  const cell = size / cells;
  const points = new Float32Array(cells * cells * 2);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const random = randomStream(latticeHash(cx, cy, seed));
      points[(cy * cells + cx) * 2] = (cx + 0.1 + 0.8 * random()) * cell;
      points[(cy * cells + cx) * 2 + 1] = (cy + 0.1 + 0.8 * random()) * cell;
    }
  }
  for (let j = 0; j < size; j++) {
    const y = j + 0.5;
    const cy = Math.floor(y / cell);
    for (let i = 0; i < size; i++) {
      const x = i + 0.5;
      const cx = Math.floor(x / cell);
      // The nearest point, then the nearest border between its cell and any other.
      let nearest = Infinity;
      let nx = 0;
      let ny = 0;
      for (let v = cy - 1; v <= cy + 1; v++) {
        for (let u = cx - 1; u <= cx + 1; u++) {
          const k = ((((v % cells) + cells) % cells) * cells + (((u % cells) + cells) % cells)) * 2;
          // A point reached around the texture's edge lies a whole texture away.
          const dx = (points[k] as number) + Math.floor(u / cells) * size - x;
          const dy = (points[k + 1] as number) + Math.floor(v / cells) * size - y;
          const d = dx * dx + dy * dy;
          if (d < nearest) {
            nearest = d;
            nx = dx;
            ny = dy;
          }
        }
      }
      let border = Infinity;
      for (let v = cy - 2; v <= cy + 2; v++) {
        for (let u = cx - 2; u <= cx + 2; u++) {
          const k = ((((v % cells) + cells) % cells) * cells + (((u % cells) + cells) % cells)) * 2;
          const dx = (points[k] as number) + Math.floor(u / cells) * size - x;
          const dy = (points[k + 1] as number) + Math.floor(v / cells) * size - y;
          const ex = dx - nx;
          const ey = dy - ny;
          const apart = ex * ex + ey * ey;
          if (apart < 1e-9) continue;
          // How far along the line to the other point its half-way border lies.
          const d = ((nx + dx) * 0.5 * ex + (ny + dy) * 0.5 * ey) / Math.sqrt(apart);
          if (d < border) border = d;
        }
      }
      field[j * size + i] = border;
    }
  }
  return field;
}

/**
 * The grain texture, `size` texels square (a power of two), four bytes per texel, repeating
 * seamlessly on both axes. Where the detail noise is shapeless, this one is drawn: it is what
 * makes grass look like blades and rock like stone from close by. Its mipmaps bring every channel
 * to its mean with distance, so the marks go away by themselves instead of shimmering.
 *
 * - R: grass blades, dark feet to light tips, with a mean of one half and the spread of the
 *   detail noise.
 * - G: specks (pebbles, grains, flower heads): 255 on a speck, 0 off it.
 * - B: a number that names the speck of this spot, the same over the whole of its cell.
 * - A: cracks. 0 in the middle of a crack, rising to 255 at `CRACK_SPAN` texels from it.
 */
export function buildGrainTexture(size: number = GRAIN_SIZE): Uint8Array {
  const blades = drawBlades(size, 733);
  const specks = drawSpecks(size, Math.round(size / 13), 389);
  const cracks = drawCracks(size, 7, 151);

  let mean = 0;
  for (let k = 0; k < blades.length; k++) mean += blades[k] as number;
  mean /= blades.length;
  let variance = 0;
  for (let k = 0; k < blades.length; k++) variance += ((blades[k] as number) - mean) ** 2;
  // Spread about the mean as the detail noise is, so the two weigh the same in the shader.
  const gain = 1 / (2 * DETAIL_SPREAD * (Math.sqrt(variance / blades.length) || 1));

  const span = (CRACK_SPAN * size) / 512;
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = Math.round(clamp(0.5 + ((blades[k] as number) - mean) * gain, 0, 1) * 255);
    data[k * 4 + 1] = Math.round((specks.cover[k] as number) * 255);
    data[k * 4 + 2] = Math.round((specks.id[k] as number) * 255);
    data[k * 4 + 3] = Math.round(clamp((cracks[k] as number) / span, 0, 1) * 255);
  }
  return data;
}
