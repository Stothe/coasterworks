import { describe, expect, it } from "vitest";
import type { TerrainData } from "../src/terrain/geometry.js";
import {
  CRACK_SPAN,
  DETAIL_SIZE,
  FIELD_TEXELS,
  RELIEF_RADIUS,
  SURFACE_MARGIN,
  WATER_REACH,
  WEIGHT_TEXELS,
  bakeGroundField,
  bakeSurfaceWeights,
  buildDetailNoise,
  buildGrainTexture,
  buildGroundField,
  buildSurfaceWeights,
  changedRect,
  tilesAroundCorners,
  unionRect,
  type SurfaceTexture,
} from "../src/terrain/surface-data.js";

// The surface module's own data: the weights and ground field the ground's shader reads, and its
// two tileable textures. No other module's tests live in this file.

const SAND = 1;
const DIRT = 2;
const ROCK = 3;
const SNOW = 4;

function flatTerrain(width: number, height: number, level: number): TerrainData {
  return {
    width,
    height,
    corners: new Int16Array((width + 1) * (height + 1)).fill(level),
    surface: new Uint8Array(width * height),
    water: new Uint8Array(width * height),
  };
}

/** The four bytes of the texel that holds tile coordinates (x, y), which may be fractional. */
function texelAt(texture: SurfaceTexture, texels: number, x: number, y: number): number[] {
  const i = Math.floor((x + SURFACE_MARGIN) * texels);
  const j = Math.floor((y + SURFACE_MARGIN) * texels);
  const at = (j * texture.width + i) * 4;
  return Array.from(texture.data.subarray(at, at + 4));
}

/** What a shader's linear filter reads at tile coordinates (x, y): four texels, blended. */
function sampleLinear(texture: SurfaceTexture, texels: number, x: number, y: number): number[] {
  const u = (x + SURFACE_MARGIN) * texels - 0.5;
  const v = (y + SURFACE_MARGIN) * texels - 0.5;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const out = [0, 0, 0, 0];
  for (const [di, dj, weight] of [
    [0, 0, (1 - fu) * (1 - fv)],
    [1, 0, fu * (1 - fv)],
    [0, 1, (1 - fu) * fv],
    [1, 1, fu * fv],
  ] as const) {
    const at = ((j + dj) * texture.width + i + di) * 4;
    for (let c = 0; c < 4; c++) out[c]! += weight * (texture.data[at + c] as number);
  }
  return out;
}

/** The largest step in channel `c` between any two texels side by side or one above the other. */
function largestStep(texture: SurfaceTexture, c: number): number {
  let largest = 0;
  for (let j = 0; j < texture.height; j++) {
    for (let i = 0; i < texture.width; i++) {
      const here = texture.data[(j * texture.width + i) * 4 + c] as number;
      if (i + 1 < texture.width) {
        const right = texture.data[(j * texture.width + i + 1) * 4 + c] as number;
        largest = Math.max(largest, Math.abs(right - here));
      }
      if (j + 1 < texture.height) {
        const below = texture.data[((j + 1) * texture.width + i) * 4 + c] as number;
        largest = Math.max(largest, Math.abs(below - here));
      }
    }
  }
  return largest;
}

/** A terrain with every surface on it, in blocks and in single tiles, some of them touching. */
function paintedTerrain(): TerrainData {
  const t = flatTerrain(12, 10, 8);
  const paint = (x0: number, y0: number, w: number, h: number, surface: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) t.surface[y * t.width + x] = surface;
    }
  };
  paint(0, 0, 4, 3, SAND);
  paint(4, 0, 3, 3, DIRT);
  paint(4, 3, 2, 2, ROCK);
  paint(6, 3, 2, 2, SNOW);
  paint(10, 8, 2, 2, ROCK);
  paint(9, 5, 1, 1, SAND);
  return t;
}

describe("buildSurfaceWeights", () => {
  it("covers the map and a margin, at WEIGHT_TEXELS texels a tile", () => {
    const weights = buildSurfaceWeights(flatTerrain(5, 3, 8));
    expect(weights.width).toBe((5 + 2 * SURFACE_MARGIN) * WEIGHT_TEXELS);
    expect(weights.height).toBe((3 + 2 * SURFACE_MARGIN) * WEIGHT_TEXELS);
    expect(weights.data.length).toBe(weights.width * weights.height * 4);
  });

  it("is all zeros on plain grass", () => {
    const weights = buildSurfaceWeights(flatTerrain(6, 6, 8));
    expect(weights.data.every((byte) => byte === 0)).toBe(true);
  });

  it("puts sand, dirt, rock and snow in R, G, B and A, whole in the middle of a painted block", () => {
    const t = flatTerrain(12, 3, 8);
    for (let surface = SAND; surface <= SNOW; surface++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) t.surface[y * t.width + (surface - 1) * 3 + x] = surface;
      }
    }
    const weights = buildSurfaceWeights(t);
    expect(sampleLinear(weights, WEIGHT_TEXELS, 1.5, 1.5)).toEqual([255, 0, 0, 0]);
    expect(sampleLinear(weights, WEIGHT_TEXELS, 4.5, 1.5)).toEqual([0, 255, 0, 0]);
    expect(sampleLinear(weights, WEIGHT_TEXELS, 7.5, 1.5)).toEqual([0, 0, 255, 0]);
    expect(sampleLinear(weights, WEIGHT_TEXELS, 10.5, 1.5)).toEqual([0, 0, 0, 255]);
  });

  it("treats a surface it does not know as grass", () => {
    const t = flatTerrain(3, 3, 8);
    t.surface.fill(9);
    expect(buildSurfaceWeights(t).data.every((byte) => byte === 0)).toBe(true);
  });

  it("never adds up to more than the whole, and to the whole where no grass is near", () => {
    const t = paintedTerrain();
    const weights = buildSurfaceWeights(t);
    for (let k = 0; k < weights.data.length; k += 4) {
      const total =
        (weights.data[k] as number) +
        (weights.data[k + 1] as number) +
        (weights.data[k + 2] as number) +
        (weights.data[k + 3] as number);
      expect(total).toBeLessThanOrEqual(255);
    }
    // On the border between the sand block and the dirt block, well away from any grass.
    const [sand, dirt, rock, snow] = sampleLinear(weights, WEIGHT_TEXELS, 4, 1.5) as [
      number,
      number,
      number,
      number,
    ];
    expect(sand + dirt + rock + snow).toBeGreaterThan(253);
    expect(Math.abs(sand - dirt)).toBeLessThan(2);
  });

  it("is one half on the straight border between a surface and grass", () => {
    const t = flatTerrain(8, 8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) t.surface[y * 8 + x] = SAND;
    const weights = buildSurfaceWeights(t);
    expect(sampleLinear(weights, WEIGHT_TEXELS, 4, 4)[0]).toBeCloseTo(127.5, 0);
    // And falls steadily across the half tile on either side of it.
    let before = 256;
    for (let x = 3.625; x <= 4.375; x += 0.125) {
      const here = sampleLinear(weights, WEIGHT_TEXELS, x, 4)[0] as number;
      expect(here).toBeLessThan(before);
      before = here;
    }
  });

  it("is smooth enough to read with a linear filter: no step between texels is a tile's edge", () => {
    const weights = buildSurfaceWeights(paintedTerrain());
    // A hard tile edge would be a step of 255. The falloff spreads it over a whole tile, so the
    // steepest texel-to-texel step is the Hermite's peak slope: 1.5 / WEIGHT_TEXELS of the range.
    const limit = Math.ceil((255 * 1.5) / WEIGHT_TEXELS) + 1;
    for (let c = 0; c < 4; c++) expect(largestStep(weights, c)).toBeLessThanOrEqual(limit);
  });

  it("reaches half a tile past a painted tile and no further", () => {
    const t = flatTerrain(9, 9, 8);
    t.surface[4 * 9 + 4] = ROCK;
    const weights = buildSurfaceWeights(t);
    expect(texelAt(weights, WEIGHT_TEXELS, 4.5, 4.5)[2]).toBeGreaterThan(225);
    expect(texelAt(weights, WEIGHT_TEXELS, 3.7, 4.5)[2]).toBeGreaterThan(0);
    expect(texelAt(weights, WEIGHT_TEXELS, 3.4, 4.5)[2]).toBe(0);
    expect(texelAt(weights, WEIGHT_TEXELS, 5.6, 5.6)[2]).toBe(0);
  });

  it("fades to nothing inside the margin, so a clamped read beyond the texture finds grass", () => {
    const t = flatTerrain(4, 4, 8);
    t.surface.fill(SAND);
    const weights = buildSurfaceWeights(t);
    const { width, height, data } = weights;
    for (let i = 0; i < width; i++) {
      expect(data[i * 4]).toBe(0);
      expect(data[((height - 1) * width + i) * 4]).toBe(0);
    }
    for (let j = 0; j < height; j++) {
      expect(data[j * width * 4]).toBe(0);
      expect(data[(j * width + width - 1) * 4]).toBe(0);
    }
    // The map's own edge is a border with the grass beyond it.
    expect(sampleLinear(weights, WEIGHT_TEXELS, 0, 2)[0]).toBeCloseTo(127.5, 0);
  });
});

describe("bakeSurfaceWeights on part of the map", () => {
  it("gives what a whole rebuild gives when told which tiles were repainted", () => {
    const t = paintedTerrain();
    const weights = buildSurfaceWeights(t);
    const before = t.surface.slice();
    t.surface[5 * t.width + 2] = SNOW;
    t.surface[6 * t.width + 3] = DIRT;
    t.surface[0] = 0;
    const painted = changedRect(before, t.surface, t.width, t.height);
    expect(painted).toEqual({ x0: 0, y0: 0, x1: 4, y1: 7 });
    bakeSurfaceWeights(t, weights, painted!);
    expect(Array.from(weights.data)).toEqual(Array.from(buildSurfaceWeights(t).data));
  });

  it("leaves texels out of reach of the repainted tiles alone", () => {
    const t = flatTerrain(10, 10, 8);
    const weights = buildSurfaceWeights(t);
    weights.data.fill(77);
    t.surface[5 * 10 + 5] = SAND;
    bakeSurfaceWeights(t, weights, { x0: 5, y0: 5, x1: 6, y1: 6 });
    expect(texelAt(weights, WEIGHT_TEXELS, 5.5, 5.5)[0]).toBeGreaterThan(225);
    expect(texelAt(weights, WEIGHT_TEXELS, 3.9, 5.5)).toEqual([77, 77, 77, 77]);
    expect(texelAt(weights, WEIGHT_TEXELS, 5.5, 7.1)).toEqual([77, 77, 77, 77]);
  });
});

describe("buildGroundField: water", () => {
  /** A 20 by 20 plain with a 2 by 2 pond at tiles 9..10, whose water stands at `level`. */
  function pondTerrain(level: number): TerrainData {
    const t = flatTerrain(20, 20, 8);
    for (const y of [9, 10]) for (const x of [9, 10]) t.water[y * 20 + x] = level;
    return t;
  }

  it("covers the map and a margin, at FIELD_TEXELS texels a tile, with A at 255", () => {
    const field = buildGroundField(flatTerrain(5, 3, 8));
    expect(field.width).toBe((5 + 2 * SURFACE_MARGIN) * FIELD_TEXELS);
    expect(field.height).toBe((3 + 2 * SURFACE_MARGIN) * FIELD_TEXELS);
    for (let k = 3; k < field.data.length; k += 4) expect(field.data[k]).toBe(255);
  });

  it("has no water proximity and no level on dry land", () => {
    const field = buildGroundField(flatTerrain(6, 6, 8));
    for (let k = 0; k < field.data.length; k += 4) {
      expect(field.data[k]).toBe(0);
      expect(field.data[k + 1]).toBe(0);
    }
  });

  it("is full over water and falls steadily to nothing at WATER_REACH tiles from it", () => {
    const field = buildGroundField(pondTerrain(7));
    expect(texelAt(field, FIELD_TEXELS, 9.75, 10.25)[0]).toBe(255);
    let before = 255;
    for (let x = 11.25; x < 11 + WATER_REACH; x += 0.5) {
      const here = texelAt(field, FIELD_TEXELS, x, 10.25)[0] as number;
      expect(here).toBeLessThan(before);
      expect(here).toBeGreaterThan(0);
      before = here;
    }
    expect(texelAt(field, FIELD_TEXELS, 11 + WATER_REACH + 0.25, 10.25)[0]).toBe(0);
    expect(texelAt(field, FIELD_TEXELS, 2.25, 2.25)[0]).toBe(0);
  });

  it("is blurred: the proximity has no step in it, around a corner of the pond either", () => {
    const field = buildGroundField(pondTerrain(7));
    // The Hermite falloff over WATER_REACH tiles is at its steepest 1.5 / WATER_REACH a tile.
    const limit = Math.ceil((255 * 1.5) / (WATER_REACH * FIELD_TEXELS)) + 1;
    expect(largestStep(field, 0)).toBeLessThanOrEqual(limit);
    // Measured to the pond's square: the same distance out along a side and from a corner.
    const side = texelAt(field, FIELD_TEXELS, 12.25, 10.25)[0] as number;
    const diagonal = 1.25 / Math.SQRT2;
    const corner = sampleLinear(field, FIELD_TEXELS, 11 + diagonal, 11 + diagonal)[0] as number;
    expect(Math.abs(corner - side)).toBeLessThan(12);
  });

  it("carries the water's level wherever the proximity is above zero", () => {
    const field = buildGroundField(pondTerrain(7));
    for (let k = 0; k < field.data.length; k += 4) {
      if ((field.data[k] as number) > 0) expect(field.data[k + 1]).toBe(7);
    }
    // And one tile further than the proximity reaches, so a filtered read at its rim is whole.
    expect(texelAt(field, FIELD_TEXELS, 11 + WATER_REACH + 0.25, 10.25)[1]).toBe(7);
  });

  it("takes the level of the nearer of two waters", () => {
    const t = flatTerrain(20, 8, 8);
    t.water[4 * 20 + 5] = 3;
    t.water[4 * 20 + 9] = 6;
    const field = buildGroundField(t);
    expect(texelAt(field, FIELD_TEXELS, 6.25, 4.25)[1]).toBe(3);
    expect(texelAt(field, FIELD_TEXELS, 8.75, 4.25)[1]).toBe(6);
  });
});

describe("buildGroundField: relief", () => {
  it("is 128 on a plain and on an even slope", () => {
    const plain = buildGroundField(flatTerrain(12, 12, 8));
    for (let k = 2; k < plain.data.length; k += 4) expect(plain.data[k]).toBe(128);

    const slope = flatTerrain(30, 30, 0);
    for (let y = 0; y <= 30; y++) for (let x = 0; x <= 30; x++) slope.corners[y * 31 + x] = x;
    // Well inside the map: at its edge the land beyond is level, which is a change of slope.
    expect(texelAt(buildGroundField(slope), FIELD_TEXELS, 15.25, 15.25)[2]).toBe(128);
  });

  it("is above 128 on a rise, below it in a hollow, and back to 128 away from both", () => {
    const t = flatTerrain(40, 20, 8);
    const raise = (cx: number, cy: number, by: number) => {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (let x = cx - 1; x <= cx + 1; x++) t.corners[y * 41 + x]! += by;
      }
    };
    raise(10, 10, 6);
    raise(30, 10, -6);
    const field = buildGroundField(t);
    expect(texelAt(field, FIELD_TEXELS, 10, 10)[2]).toBeGreaterThan(190);
    expect(texelAt(field, FIELD_TEXELS, 30, 10)[2]).toBeLessThan(66);
    expect(texelAt(field, FIELD_TEXELS, 20.25, 10.25)[2]).toBe(128);
    // The land around a rise is, by a little, a hollow: it lies below the mean that the rise lifts.
    expect(texelAt(field, FIELD_TEXELS, 10.25, 10.25 + RELIEF_RADIUS)[2]).toBeLessThan(128);
  });
});

describe("bakeGroundField on part of the map", () => {
  it("gives what a whole rebuild gives after water and corners change", () => {
    const t = flatTerrain(24, 24, 8);
    t.water[5 * 24 + 5] = 7;
    const field = buildGroundField(t);
    const water = t.water.slice();
    const corners = t.corners.slice();

    t.water[5 * 24 + 5] = 0;
    t.water[12 * 24 + 14] = 6;
    t.water[12 * 24 + 15] = 6;
    for (const corner of [16 * 25 + 8, 16 * 25 + 9, 17 * 25 + 8]) t.corners[corner]! += 5;

    const flooded = changedRect(water, t.water, 24, 24);
    const raised = changedRect(corners, t.corners, 25, 25);
    expect(raised).toEqual({ x0: 8, y0: 16, x1: 10, y1: 18 });
    const shaped = unionRect(flooded, tilesAroundCorners(raised!));
    expect(shaped).toEqual({ x0: 5, y0: 5, x1: 16, y1: 18 });
    bakeGroundField(t, field, shaped!);
    expect(Array.from(field.data)).toEqual(Array.from(buildGroundField(t).data));
  });
});

describe("changedRect, unionRect, tilesAroundCorners", () => {
  it("finds no rectangle when nothing changed", () => {
    expect(changedRect([1, 2, 3, 4], [1, 2, 3, 4], 2, 2)).toBeNull();
  });

  it("finds the smallest rectangle that holds every changed cell", () => {
    const before = new Uint8Array(5 * 4);
    const after = before.slice();
    after[1 * 5 + 3] = 1;
    after[3 * 5 + 1] = 1;
    expect(changedRect(before, after, 5, 4)).toEqual({ x0: 1, y0: 1, x1: 4, y1: 4 });
  });

  it("joins two rectangles, and passes on the one that is not null", () => {
    const a = { x0: 1, y0: 2, x1: 3, y1: 4 };
    const b = { x0: 2, y0: 0, x1: 6, y1: 3 };
    expect(unionRect(a, b)).toEqual({ x0: 1, y0: 0, x1: 6, y1: 4 });
    expect(unionRect(a, null)).toBe(a);
    expect(unionRect(null, b)).toBe(b);
    expect(unionRect(null, null)).toBeNull();
  });

  it("takes corners to the tiles that touch them", () => {
    // Corner (3, 5) alone is touched by tiles 2..3 by 4..5.
    expect(tilesAroundCorners({ x0: 3, y0: 5, x1: 4, y1: 6 })).toEqual({
      x0: 2,
      y0: 4,
      x1: 4,
      y1: 6,
    });
  });
});

/** The mean of channel `c` of a square RGBA texture. */
function channelMean(data: Uint8Array, c: number): number {
  let sum = 0;
  for (let k = c; k < data.length; k += 4) sum += data[k] as number;
  return sum / (data.length / 4);
}

/**
 * The mean step in channel `c` from each texel of row or column `at` to the one after it, around
 * the texture's edge if `at` is the last.
 */
function meanStep(data: Uint8Array, size: number, c: number, at: number, along: "x" | "y"): number {
  let sum = 0;
  const next = (at + 1) % size;
  for (let k = 0; k < size; k++) {
    const a = along === "x" ? (k * size + at) * 4 + c : (at * size + k) * 4 + c;
    const b = along === "x" ? (k * size + next) * 4 + c : (next * size + k) * 4 + c;
    sum += Math.abs((data[a] as number) - (data[b] as number));
  }
  return sum / size;
}

describe("buildDetailNoise", () => {
  const size = 64;
  const noise = buildDetailNoise(size);

  it("is four bytes a texel and the same every time", () => {
    expect(noise.length).toBe(size * size * 4);
    expect(Array.from(buildDetailNoise(size))).toEqual(Array.from(noise));
    expect(DETAIL_SIZE & (DETAIL_SIZE - 1)).toBe(0);
  });

  it("has a mean of one half in every channel, so its mipmaps fade to an even tone", () => {
    for (let c = 0; c < 4; c++) expect(Math.abs(channelMean(noise, c) - 127.5)).toBeLessThan(2.5);
  });

  it("uses a good part of the byte range without piling up at its ends", () => {
    for (let c = 0; c < 4; c++) {
      let low = 255;
      let high = 0;
      let clipped = 0;
      for (let k = c; k < noise.length; k += 4) {
        const byte = noise[k] as number;
        low = Math.min(low, byte);
        high = Math.max(high, byte);
        if (byte === 0 || byte === 255) clipped++;
      }
      expect(high - low).toBeGreaterThan(150);
      expect(clipped / (size * size)).toBeLessThan(0.02);
    }
  });

  it("repeats without a seam: the step around the edge is like any other", () => {
    for (let c = 0; c < 4; c++) {
      for (const along of ["x", "y"] as const) {
        const inner = meanStep(noise, size, c, size / 2, along);
        const wrap = meanStep(noise, size, c, size - 1, along);
        expect(wrap).toBeLessThan(inner * 2 + 2);
      }
    }
  });

  it("holds in B and A the slope of R along x and y", () => {
    let alongX = 0;
    let alongY = 0;
    let crossed = 0;
    const wrap = (v: number) => (v + size) % size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = (i: number, j: number) => noise[(wrap(j) * size + wrap(i)) * 4] as number;
        const dx = r(x + 1, y) - r(x - 1, y);
        const dy = r(x, y + 1) - r(x, y - 1);
        const b = (noise[(y * size + x) * 4 + 2] as number) - 127.5;
        const a = (noise[(y * size + x) * 4 + 3] as number) - 127.5;
        alongX += dx * b;
        alongY += dy * a;
        crossed += dx * a;
      }
    }
    expect(alongX).toBeGreaterThan(0);
    expect(alongY).toBeGreaterThan(0);
    // The slope along x says next to nothing about the slope along y.
    expect(Math.abs(crossed)).toBeLessThan(alongX * 0.2);
  });
});

describe("buildGrainTexture", () => {
  const size = 128;
  const grain = buildGrainTexture(size);

  it("is four bytes a texel and the same every time", () => {
    expect(grain.length).toBe(size * size * 4);
    expect(Array.from(buildGrainTexture(size))).toEqual(Array.from(grain));
  });

  it("draws blades around a mean of one half, from dark feet to light tips", () => {
    expect(Math.abs(channelMean(grain, 0) - 127.5)).toBeLessThan(2.5);
    let dark = 0;
    let light = 0;
    for (let k = 0; k < grain.length; k += 4) {
      if ((grain[k] as number) < 64) dark++;
      if ((grain[k] as number) > 192) light++;
    }
    expect(dark / (size * size)).toBeGreaterThan(0.03);
    expect(light / (size * size)).toBeGreaterThan(0.03);
  });

  it("scatters specks thinly: mostly bare, some covered, each with a number of its own", () => {
    let covered = 0;
    const names = new Set<number>();
    for (let k = 0; k < grain.length; k += 4) {
      if ((grain[k + 1] as number) === 255) {
        covered++;
        names.add(grain[k + 2] as number);
      }
    }
    const share = covered / (size * size);
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.2);
    expect(names.size).toBeGreaterThan(20);
  });

  it("names a speck by one number over the whole of it", () => {
    // Texels side by side that are both fully on a speck are on the same speck.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x + 1 < size; x++) {
        const here = (y * size + x) * 4;
        if (grain[here + 1] === 255 && grain[here + 5] === 255) {
          expect(grain[here + 6]).toBe(grain[here + 2]);
        }
      }
    }
  });

  it("draws cracks as thin lines in a field that is mostly whole stone", () => {
    let onCrack = 0;
    let whole = 0;
    for (let k = 3; k < grain.length; k += 4) {
      if ((grain[k] as number) < 32) onCrack++;
      if ((grain[k] as number) === 255) whole++;
    }
    expect(onCrack / (size * size)).toBeGreaterThan(0.005);
    expect(onCrack / (size * size)).toBeLessThan(0.1);
    expect(whole / (size * size)).toBeGreaterThan(0.5);
    // The distance to a crack changes by no more than one texel from a texel to the next.
    const span = (CRACK_SPAN * size) / 512;
    const limit = Math.ceil(255 / span) + 1;
    for (const along of ["x", "y"] as const) {
      for (let at = 0; at < size; at++) {
        for (let k = 0; k < size; k++) {
          const a = along === "x" ? k * size + at : at * size + k;
          const b = along === "x" ? k * size + ((at + 1) % size) : ((at + 1) % size) * size + k;
          const step = Math.abs((grain[a * 4 + 3] as number) - (grain[b * 4 + 3] as number));
          expect(step).toBeLessThanOrEqual(limit);
        }
      }
    }
  });

  it("repeats without a seam in the blades", () => {
    for (const along of ["x", "y"] as const) {
      const inner = meanStep(grain, size, 0, size / 2, along);
      const wrap = meanStep(grain, size, 0, size - 1, along);
      expect(wrap).toBeLessThan(inner * 1.5 + 2);
    }
  });
});
