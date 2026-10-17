import { describe, expect, it } from "vitest";
import { SURFACE_COLORS, WATER_COLOR, surfaceColor } from "../src/palette.js";
import {
  buildChunkGeometry,
  buildWaterGeometry,
  chunkCount,
  type TerrainData,
} from "../src/terrain-geometry.js";
import { CHUNK, HEIGHT_STEP, tileToWorld } from "../src/units.js";

/** A flat map where every corner sits at `level`. */
function flatTerrain(width: number, height: number, level: number): TerrainData {
  return {
    width,
    height,
    corners: new Int16Array((width + 1) * (height + 1)).fill(level),
    surface: new Uint8Array(width * height),
    water: new Uint8Array(width * height),
  };
}

function setCorner(t: TerrainData, cx: number, cy: number, h: number): void {
  t.corners[cy * (t.width + 1) + cx] = h;
}

type Vec = [number, number, number];

/** The three vertices of triangle `tri` (0-based over the whole geometry). */
function triangle(positions: Float32Array, tri: number): [Vec, Vec, Vec] {
  const at = (v: number): Vec => [
    positions[(tri * 3 + v) * 3] as number,
    positions[(tri * 3 + v) * 3 + 1] as number,
    positions[(tri * 3 + v) * 3 + 2] as number,
  ];
  return [at(0), at(1), at(2)];
}

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a: Vec, b: Vec): Vec {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

const key = (v: Vec) => v.map((n) => n.toFixed(4)).join(",");

describe("units", () => {
  it("maps tile coordinates to world space", () => {
    expect(HEIGHT_STEP).toBe(0.25);
    expect(CHUNK).toBe(16);
    expect(tileToWorld(3, 5, 8)).toEqual([3, 2, 5]);
  });
});

describe("palette", () => {
  it("applies the grass checker by tile parity and leaves other surfaces alone", () => {
    const [r, g, b] = SURFACE_COLORS[0];
    const even = surfaceColor(0, 0, 0);
    const odd = surfaceColor(0, 1, 0);
    expect(even[1]).toBeCloseTo(Math.min(1, g * 1.04), 6);
    expect(odd[1]).toBeCloseTo(g * 0.96, 6);
    expect(even[0]).toBeCloseTo(Math.min(1, r * 1.04), 6);
    expect(odd[2]).toBeCloseTo(b * 0.96, 6);
    expect(surfaceColor(0, 3, 5)).toEqual(even);
    expect(surfaceColor(0, 3, 4)).toEqual(odd);
    expect(surfaceColor(1, 0, 0)).toEqual(SURFACE_COLORS[1]);
    expect(surfaceColor(1, 1, 0)).toEqual(SURFACE_COLORS[1]);
  });

  it("clamps the checker so snow never exceeds 1", () => {
    for (const surface of [0, 1, 2, 3, 4] as const) {
      for (const channel of surfaceColor(surface, 0, 0)) {
        expect(channel).toBeLessThanOrEqual(1);
        expect(channel).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("chunkCount", () => {
  it("rounds up to whole chunks", () => {
    expect(chunkCount(flatTerrain(16, 16, 0))).toEqual({ cx: 1, cy: 1 });
    expect(chunkCount(flatTerrain(20, 33, 0))).toEqual({ cx: 2, cy: 3 });
    expect(chunkCount(flatTerrain(64, 64, 0))).toEqual({ cx: 4, cy: 4 });
  });
});

describe("buildChunkGeometry", () => {
  it("builds a flat 16x16 chunk of 512 upward-facing triangles at the right height", () => {
    const g = buildChunkGeometry(flatTerrain(16, 16, 8), 0, 0);
    expect(g.tileCount).toBe(256);
    expect(g.positions.length).toBe(512 * 3 * 3);
    expect(g.normals.length).toBe(g.positions.length);
    expect(g.colors.length).toBe(g.positions.length);
    expect(g.indices.length).toBe(512 * 3);
    for (let i = 0; i < g.positions.length; i += 3) {
      expect(g.positions[i + 1]).toBe(2.0);
      expect(g.normals[i]).toBe(0);
      expect(g.normals[i + 1]).toBe(1);
      expect(g.normals[i + 2]).toBe(0);
    }
    expect(Array.from(g.indices)).toEqual(Array.from({ length: g.indices.length }, (_, i) => i));
  });

  it("covers the chunk's tiles exactly and keeps each tile's triangles inside it", () => {
    const g = buildChunkGeometry(flatTerrain(16, 16, 8), 0, 0);
    let area = 0;
    for (let tri = 0; tri < 512; tri++) {
      const [a, b, c] = triangle(g.positions, tri);
      const n = cross(sub(b, a), sub(c, a));
      area += Math.hypot(...n) / 2;
      for (const v of [a, b, c]) {
        expect(v[0]).toBeGreaterThanOrEqual(0);
        expect(v[0]).toBeLessThanOrEqual(16);
        expect(v[2]).toBeGreaterThanOrEqual(0);
        expect(v[2]).toBeLessThanOrEqual(16);
      }
    }
    expect(area).toBeCloseTo(256, 6);
  });

  it("winds every triangle counter-clockwise seen from above and stores that normal", () => {
    const t = flatTerrain(16, 16, 8);
    setCorner(t, 3, 3, 14);
    setCorner(t, 9, 4, 2);
    const g = buildChunkGeometry(t, 0, 0);
    for (let tri = 0; tri < 512; tri++) {
      const [a, b, c] = triangle(g.positions, tri);
      const n = cross(sub(b, a), sub(c, a));
      const len = Math.hypot(...n);
      expect(n[1]).toBeGreaterThan(0);
      for (let v = 0; v < 3; v++) {
        const o = (tri * 3 + v) * 3;
        expect(g.normals[o]).toBeCloseTo(n[0] / len, 5);
        expect(g.normals[o + 1]).toBeCloseTo(n[1] / len, 5);
        expect(g.normals[o + 2]).toBeCloseTo(n[2] / len, 5);
      }
    }
  });

  it("makes the four tiles around a raised corner non-flat and leaves the rest flat", () => {
    const t = flatTerrain(16, 16, 8);
    setCorner(t, 1, 1, 12);
    const g = buildChunkGeometry(t, 0, 0);
    const tileNormals = (x: number, y: number) => {
      const first = (y * 16 + x) * 2;
      return [first, first + 1].map((tri) => g.normals[tri * 9 + 1] as number);
    };
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      expect(Math.min(...tileNormals(x, y))).toBeLessThan(1);
    }
    expect(tileNormals(2, 2)).toEqual([1, 1]);
    expect(tileNormals(8, 8)).toEqual([1, 1]);
  });

  it("splits a tile along the diagonal joining the corners with the smaller height difference", () => {
    // 1x1 map. Corner order in the array is NW, NE, SW, SE (row-major by corner row).
    const nesw = flatTerrain(1, 1, 8);
    setCorner(nesw, 1, 1, 12); // SE raised: |NW-SE| = 4 > |NE-SW| = 0, so the split is NE-SW
    const g1 = buildChunkGeometry(nesw, 0, 0);
    const NW: Vec = [0, 2, 0];
    const NE: Vec = [1, 2, 0];
    const SW: Vec = [0, 2, 1];
    const SE: Vec = [1, 3, 1];
    const sets1 = [0, 1].map((tri) => triangle(g1.positions, tri).map(key).sort());
    expect(sets1[0]).toEqual([NW, SW, NE].map(key).sort());
    expect(sets1[1]).toEqual([NE, SW, SE].map(key).sort());

    const nwse = flatTerrain(1, 1, 8);
    setCorner(nwse, 1, 0, 12); // NE raised: |NW-SE| = 0 <= |NE-SW| = 4, so the split is NW-SE
    const g2 = buildChunkGeometry(nwse, 0, 0);
    const NE2: Vec = [1, 3, 0];
    const SE2: Vec = [1, 2, 1];
    const sets2 = [0, 1].map((tri) => triangle(g2.positions, tri).map(key).sort());
    expect(sets2[0]).toEqual([NW, SW, SE2].map(key).sort());
    expect(sets2[1]).toEqual([NW, SE2, NE2].map(key).sort());
  });

  it("splits a tied tile along NW-SE", () => {
    const g = buildChunkGeometry(flatTerrain(1, 1, 8), 0, 0);
    const tri0 = triangle(g.positions, 0).map(key);
    expect(tri0).toContain(key([0, 2, 0]));
    expect(tri0).toContain(key([1, 2, 1]));
  });

  it("colors grass by parity, other surfaces flat, one color per triangle", () => {
    const t = flatTerrain(16, 16, 8);
    t.surface[2 * 16 + 2] = 1; // sand at (2, 2)
    t.surface[2 * 16 + 3] = 1; // sand at (3, 2)
    const g = buildChunkGeometry(t, 0, 0);
    const tileColor = (x: number, y: number, tri: 0 | 1, v: number) => {
      const o = ((y * 16 + x) * 6 + tri * 3 + v) * 3;
      return [g.colors[o], g.colors[o + 1], g.colors[o + 2]] as number[];
    };
    for (const [x, y] of [
      [0, 0],
      [5, 5],
      [1, 0],
      [4, 7],
    ] as const) {
      const expected = surfaceColor(0, x, y);
      for (const tri of [0, 1] as const) {
        for (let v = 0; v < 3; v++) {
          expect(tileColor(x, y, tri, v)).toEqual(expected.map(Math.fround));
        }
      }
    }
    expect(tileColor(0, 0, 0, 0)).not.toEqual(tileColor(1, 0, 0, 0));
    expect(tileColor(2, 2, 0, 0)).toEqual(SURFACE_COLORS[1].map(Math.fround));
    expect(tileColor(3, 2, 1, 2)).toEqual(SURFACE_COLORS[1].map(Math.fround));
  });

  it("offsets later chunks into world space", () => {
    const g = buildChunkGeometry(flatTerrain(64, 64, 8), 2, 1);
    let minX = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < g.positions.length; i += 3) {
      minX = Math.min(minX, g.positions[i] as number);
      maxZ = Math.max(maxZ, g.positions[i + 2] as number);
    }
    expect(minX).toBe(32);
    expect(maxZ).toBe(32);
  });

  it("builds only the tiles that exist in a chunk hanging off the map edge", () => {
    const t = flatTerrain(20, 20, 8);
    const corner = buildChunkGeometry(t, 1, 1);
    expect(corner.tileCount).toBe(16);
    expect(corner.positions.length).toBe(16 * 6 * 3);
    let maxX = -Infinity;
    for (let i = 0; i < corner.positions.length; i += 3) {
      maxX = Math.max(maxX, corner.positions[i] as number);
    }
    expect(maxX).toBe(20);
    expect(buildChunkGeometry(t, 1, 0).tileCount).toBe(64);
    expect(buildChunkGeometry(t, 0, 0).tileCount).toBe(256);
  });
});

describe("buildWaterGeometry", () => {
  it("returns null when the chunk has no water", () => {
    expect(buildWaterGeometry(flatTerrain(16, 16, 8), 0, 0)).toBeNull();
  });

  it("returns null for the dry chunk of a map that has water elsewhere", () => {
    const t = flatTerrain(32, 16, 8);
    t.water[3] = 12;
    expect(buildWaterGeometry(t, 1, 0)).toBeNull();
    expect(buildWaterGeometry(t, 0, 0)).not.toBeNull();
  });

  it("emits one lifted, upward-facing quad per water tile", () => {
    const t = flatTerrain(16, 16, 4);
    t.water[5 * 16 + 7] = 12;
    const g = buildWaterGeometry(t, 0, 0);
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.tileCount).toBe(1);
    expect(g.positions.length).toBe(6 * 3);
    expect(g.indices.length).toBe(6);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let v = 0; v < 6; v++) {
      expect(g.positions[v * 3 + 1]).toBeCloseTo(12 * HEIGHT_STEP + 0.01, 5);
      expect(g.normals[v * 3 + 1]).toBe(1);
      expect(Array.from(g.colors.slice(v * 3, v * 3 + 3))).toEqual(WATER_COLOR.map(Math.fround));
      xs.push(g.positions[v * 3] as number);
      zs.push(g.positions[v * 3 + 2] as number);
    }
    expect(Math.min(...xs)).toBe(7);
    expect(Math.max(...xs)).toBe(8);
    expect(Math.min(...zs)).toBe(5);
    expect(Math.max(...zs)).toBe(6);
    for (const tri of [0, 1]) {
      const [a, b, c] = triangle(g.positions, tri);
      expect(cross(sub(b, a), sub(c, a))[1]).toBeGreaterThan(0);
    }
  });

  it("counts several water tiles", () => {
    const t = flatTerrain(16, 16, 4);
    for (let x = 0; x < 3; x++) t.water[x] = 6;
    const g = buildWaterGeometry(t, 0, 0);
    expect(g?.tileCount).toBe(3);
    expect(g?.positions.length).toBe(3 * 6 * 3);
  });
});
