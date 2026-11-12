import { describe, expect, it } from "vitest";
import { groundHeightAt, groundNormalAt } from "../src/heightfield.js";
import { SURFACE_COLORS, WATER_COLOR, srgbToLinear } from "../src/palette.js";
import {
  buildTerrainChunk,
  chunkCount,
  tileTriangles,
  type TerrainData,
} from "../src/terrain/geometry.js";
import { CHUNK, HEIGHT_STEP, SUBDIV, tileToWorld } from "../src/units.js";

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

/** Rolling land with a few sharp features, the same for a given size. */
function hillyTerrain(width: number, height: number): TerrainData {
  const t = flatTerrain(width, height, 8);
  for (let cy = 0; cy <= height; cy++) {
    for (let cx = 0; cx <= width; cx++) {
      const rolling = 8 + 6 * Math.sin(cx * 0.4) * Math.cos(cy * 0.33) + 2 * Math.sin(cy * 0.9);
      const sharp = (cx * 7 + cy * 13) % 17 === 0 ? 5 : 0;
      t.corners[cy * (width + 1) + cx] = Math.round(rolling + sharp);
    }
  }
  return t;
}

function setCorner(t: TerrainData, cx: number, cy: number, h: number): void {
  t.corners[cy * (t.width + 1) + cx] = h;
}

type Vec = [number, number, number];

function vertex(a: Float32Array, i: number): Vec {
  return [a[i * 3] as number, a[i * 3 + 1] as number, a[i * 3 + 2] as number];
}

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a: Vec, b: Vec): Vec {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

describe("units", () => {
  it("maps tile coordinates to world space", () => {
    expect(HEIGHT_STEP).toBe(0.25);
    expect(CHUNK).toBe(16);
    expect(SUBDIV).toBe(4);
    expect(tileToWorld(3, 5, 8)).toEqual([3, 2, 5]);
  });
});

describe("palette", () => {
  it("has a color in range for every surface, and for water", () => {
    for (const surface of [0, 1, 2, 3, 4] as const) {
      for (const channel of SURFACE_COLORS[surface]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    expect(WATER_COLOR[2]).toBeGreaterThan(WATER_COLOR[0]);
  });

  it("converts sRGB to linear light", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 3);
  });
});

describe("chunkCount", () => {
  it("rounds up to whole chunks", () => {
    expect(chunkCount(flatTerrain(16, 16, 0))).toEqual({ cx: 1, cy: 1 });
    expect(chunkCount(flatTerrain(20, 33, 0))).toEqual({ cx: 2, cy: 3 });
    expect(chunkCount(flatTerrain(64, 64, 0))).toEqual({ cx: 4, cy: 4 });
  });
});

describe("tileTriangles", () => {
  it("gives two upward-facing triangles through the tile's four corners", () => {
    const t = flatTerrain(2, 2, 8);
    setCorner(t, 1, 1, 12);
    const out = new Float64Array(18);
    tileTriangles(t, 0, 0, out);
    const points = Array.from({ length: 6 }, (_, i) => [
      out[i * 3],
      out[i * 3 + 1],
      out[i * 3 + 2],
    ]);
    expect(points).toContainEqual([1, 3, 1]);
    expect(points).toContainEqual([0, 2, 0]);
    for (const first of [0, 3]) {
      const [a, b, c] = [0, 1, 2].map((k) => points[first + k] as Vec) as [Vec, Vec, Vec];
      expect(cross(sub(b, a), sub(c, a))[1]).toBeGreaterThan(0);
    }
  });
});

describe("buildTerrainChunk", () => {
  it("builds a shared-vertex grid of SUBDIV cells per tile edge", () => {
    const g = buildTerrainChunk(flatTerrain(16, 16, 8), 0, 0);
    const side = CHUNK * SUBDIV + 1;
    expect(g.tileCount).toBe(256);
    expect(g.positions.length).toBe(side * side * 3);
    expect(g.normals.length).toBe(g.positions.length);
    expect(g.indices.length).toBe(CHUNK * SUBDIV * CHUNK * SUBDIV * 6);
    for (let i = 0; i < g.positions.length; i += 3) {
      expect(g.positions[i + 1]).toBe(2.0);
      expect(g.normals[i]).toBe(0);
      expect(g.normals[i + 1]).toBe(1);
      expect(g.normals[i + 2]).toBe(0);
    }
  });

  it("clips a chunk at the edge of the map, and is empty beyond it", () => {
    const t = flatTerrain(20, 18, 8);
    const corner = buildTerrainChunk(t, 1, 1);
    expect(corner.tileCount).toBe(4 * 2);
    expect(corner.positions.length).toBe((4 * SUBDIV + 1) * (2 * SUBDIV + 1) * 3);
    expect(corner.indices.length).toBe(4 * SUBDIV * 2 * SUBDIV * 6);
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let minX = Infinity;
    let minZ = Infinity;
    for (let i = 0; i < corner.positions.length; i += 3) {
      minX = Math.min(minX, corner.positions[i] as number);
      maxX = Math.max(maxX, corner.positions[i] as number);
      minZ = Math.min(minZ, corner.positions[i + 2] as number);
      maxZ = Math.max(maxZ, corner.positions[i + 2] as number);
    }
    expect([minX, maxX, minZ, maxZ]).toEqual([16, 20, 16, 18]);

    const beyond = buildTerrainChunk(t, 2, 0);
    expect(beyond.tileCount).toBe(0);
    expect(beyond.positions.length).toBe(0);
    expect(beyond.indices.length).toBe(0);
  });

  it("uses every vertex, and no index is out of range", () => {
    const g = buildTerrainChunk(hillyTerrain(16, 16), 0, 0);
    const vertices = g.positions.length / 3;
    const used = new Uint8Array(vertices);
    for (const index of g.indices) {
      expect(index).toBeLessThan(vertices);
      used[index] = 1;
    }
    expect(used.every((u) => u === 1)).toBe(true);
  });

  it("winds every triangle counter-clockwise seen from above, and covers the chunk exactly", () => {
    const g = buildTerrainChunk(hillyTerrain(16, 16), 0, 0);
    let area = 0;
    for (let i = 0; i < g.indices.length; i += 3) {
      const a = vertex(g.positions, g.indices[i] as number);
      const b = vertex(g.positions, g.indices[i + 1] as number);
      const c = vertex(g.positions, g.indices[i + 2] as number);
      const n = cross(sub(b, a), sub(c, a));
      expect(n[1]).toBeGreaterThan(0);
      // The area of its footprint on the ground.
      area += n[1] / 2;
    }
    expect(area).toBeCloseTo(256, 6);
  });

  it("puts every vertex on the smooth ground, with the ground's own normal", () => {
    const t = hillyTerrain(16, 16);
    const g = buildTerrainChunk(t, 0, 0);
    for (let i = 0; i < g.positions.length / 3; i++) {
      const [x, y, z] = vertex(g.positions, i);
      expect(y).toBe(Math.fround(groundHeightAt(t, x, z)));
      const n = groundNormalAt(t, x, z);
      expect(vertex(g.normals, i)).toEqual(n.map(Math.fround));
    }
  });

  it("has unit normals that point up", () => {
    const g = buildTerrainChunk(hillyTerrain(16, 16), 0, 0);
    for (let i = 0; i < g.normals.length / 3; i++) {
      const n = vertex(g.normals, i);
      expect(Math.hypot(...n)).toBeCloseTo(1, 6);
      expect(n[1]).toBeGreaterThan(0);
    }
  });

  it("passes through the sim's corners", () => {
    const t = hillyTerrain(16, 16);
    const g = buildTerrainChunk(t, 0, 0);
    const side = CHUNK * SUBDIV + 1;
    for (let cy = 0; cy <= 16; cy++) {
      for (let cx = 0; cx <= 16; cx++) {
        const v = cy * SUBDIV * side + cx * SUBDIV;
        expect(vertex(g.positions, v)).toEqual([
          cx,
          (t.corners[cy * 17 + cx] as number) * HEIGHT_STEP,
          cy,
        ]);
      }
    }
  });

  it("gives neighboring chunks identical vertices and normals along their shared border", () => {
    const t = hillyTerrain(40, 36);
    const byPlace = (g: ReturnType<typeof buildTerrainChunk>) => {
      const map = new Map<string, { y: number; n: Vec }>();
      for (let i = 0; i < g.positions.length / 3; i++) {
        const [x, y, z] = vertex(g.positions, i);
        map.set(`${x},${z}`, { y, n: vertex(g.normals, i) });
      }
      return map;
    };
    const pairs: [[number, number], [number, number]][] = [
      [
        [0, 0],
        [1, 0],
      ],
      [
        [0, 0],
        [0, 1],
      ],
      [
        [1, 1],
        [2, 1],
      ],
      [
        [1, 1],
        [1, 2],
      ],
      [
        [0, 0],
        [1, 1],
      ],
    ];
    for (const [a, b] of pairs) {
      const first = byPlace(buildTerrainChunk(t, a[0], a[1]));
      const second = byPlace(buildTerrainChunk(t, b[0], b[1]));
      let shared = 0;
      for (const [place, mine] of first) {
        const theirs = second.get(place);
        if (!theirs) continue;
        shared++;
        // Exactly equal, not merely close: a crack is a single differing bit.
        expect(theirs.y).toBe(mine.y);
        expect(theirs.n).toEqual(mine.n);
      }
      // A whole edge of vertices for side neighbors, the one corner for diagonal ones.
      expect(shared).toBeGreaterThanOrEqual(1);
      if (a[0] === b[0] || a[1] === b[1]) expect(shared).toBeGreaterThan(SUBDIV * 4);
    }
  });

  it("stores normals that agree with the mesh around each vertex", () => {
    const t = flatTerrain(16, 16, 8);
    for (let cy = 0; cy <= 16; cy++) {
      for (let cx = 0; cx <= 16; cx++) {
        setCorner(t, cx, cy, Math.round(10 + 5 * Math.sin(cx * 0.4) * Math.cos(cy * 0.35)));
      }
    }
    const g = buildTerrainChunk(t, 0, 0);
    // The area-weighted sum of the face normals around each vertex.
    const around = new Float64Array(g.positions.length);
    for (let i = 0; i < g.indices.length; i += 3) {
      const corners = [g.indices[i], g.indices[i + 1], g.indices[i + 2]] as number[];
      const [a, b, c] = corners.map((v) => vertex(g.positions, v)) as [Vec, Vec, Vec];
      const face = cross(sub(b, a), sub(c, a));
      for (const v of corners) {
        for (let k = 0; k < 3; k++) around[v * 3 + k] = (around[v * 3 + k] as number) + face[k]!;
      }
    }
    for (let v = 0; v < g.positions.length / 3; v++) {
      const sum: Vec = [around[v * 3]!, around[v * 3 + 1]!, around[v * 3 + 2]!];
      const n = vertex(g.normals, v);
      const cosine = (sum[0] * n[0] + sum[1] * n[1] + sum[2] * n[2]) / Math.hypot(...sum);
      // Within 20 degrees: the smooth ground's normal, sampled at the vertex, and the coarser
      // mesh's own. A normal that pointed anywhere else would light the hill wrong.
      expect(cosine).toBeGreaterThan(Math.cos((20 * Math.PI) / 180));
    }
  });

  it("leaves level tiles level next to a raised corner", () => {
    const t = flatTerrain(16, 16, 8);
    setCorner(t, 4, 4, 12);
    const g = buildTerrainChunk(t, 0, 0);
    for (let i = 0; i < g.positions.length / 3; i++) {
      const [x, y, z] = vertex(g.positions, i);
      const near = x > 3 && x < 5 && z > 3 && z < 5;
      if (!near) expect(y).toBe(2);
      else expect(y).toBeGreaterThanOrEqual(2);
    }
  });
});
