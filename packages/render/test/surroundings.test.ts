import { describe, expect, it } from "vitest";
import { groundHeightAt, groundNormalAt } from "../src/heightfield.js";
import {
  EDGE_REACH,
  FAR_REACH,
  LAND_LEVEL,
  LAND_REACH,
  buildSurroundingsGeometry,
  createOuterLand,
  distanceOutside,
  loopAt,
  meanEdgeHeight,
  ringLoops,
} from "../src/scenery/land.js";
import { detailFor } from "../src/surroundings.js";
import { buildTerrainChunk, type TerrainData } from "../src/terrain/geometry.js";
import { SUBDIV } from "../src/units.js";

// The land beyond the park: its shape (`createOuterLand`) and its mesh
// (`buildSurroundingsGeometry`). What stands on it is tested in `scenery.test.ts`.

function flatTerrain(width: number, height: number, level: number): TerrainData {
  return {
    width,
    height,
    corners: new Int16Array((width + 1) * (height + 1)).fill(level),
    surface: new Uint8Array(width * height),
    water: new Uint8Array(width * height),
  };
}

/** Uneven land, so the border has heights and slopes worth matching. */
function uneven(width: number, height: number): TerrainData {
  const t = flatTerrain(width, height, 8);
  for (let cy = 0; cy <= height; cy++) {
    for (let cx = 0; cx <= width; cx++) {
      t.corners[cy * (width + 1) + cx] = Math.round(8 + 3 * Math.sin(cx * 0.7 + cy * 0.4));
    }
  }
  return t;
}

type Vec = [number, number, number];
const vertex = (a: Float32Array, i: number): Vec => [
  a[i * 3] as number,
  a[i * 3 + 1] as number,
  a[i * 3 + 2] as number,
];

describe("distanceOutside", () => {
  it("is zero over the park and the straight-line distance to it beyond", () => {
    expect(distanceOutside(20, 18, 10, 9)).toBe(0);
    expect(distanceOutside(20, 18, 20, 18)).toBe(0);
    expect(distanceOutside(20, 18, -3, 9)).toBe(3);
    expect(distanceOutside(20, 18, 10, 25)).toBe(7);
    expect(distanceOutside(20, 18, 23, 22)).toBe(5);
    expect(distanceOutside(20, 18, -6, -8)).toBe(10);
  });
});

describe("createOuterLand", () => {
  it("is the park's own smooth ground on the edge and for the level stretch beyond it", () => {
    const t = uneven(20, 18);
    const land = createOuterLand(t);
    const out: Vec = [0, 0, 0];
    for (const [x, z] of [
      [0, 5.25],
      [20, 11.5],
      [7.75, 0],
      [13, 18],
      [-LAND_LEVEL, 9],
      [10, 18 + LAND_LEVEL * 0.5],
      [-2, -2],
    ] as const) {
      expect(land.heightAt(x, z)).toBe(groundHeightAt(t, x, z));
      expect(land.normalAt(x, z, out)).toEqual(groundNormalAt(t, x, z));
    }
  });

  it("runs level straight out from the edge for the first few tiles", () => {
    const t = uneven(20, 18);
    const land = createOuterLand(t);
    for (let z = 0; z <= 18; z += 0.5) {
      const edge = land.heightAt(20, z);
      for (let d = 0.5; d <= LAND_LEVEL; d += 0.5) expect(land.heightAt(20 + d, z)).toBe(edge);
    }
  });

  it("has no step and no sudden slope anywhere, the end of the level stretch included", () => {
    const t = uneven(20, 18);
    const land = createOuterLand(t);
    const step = 0.05;
    for (const z of [-40, 3.3, 9, 30]) {
      let last = land.heightAt(20, z);
      let lastRise = 0;
      for (let x = 20 + step; x < 20 + FAR_REACH; x += step) {
        const h = land.heightAt(x, z);
        const rise = h - last;
        // Hills, not cliffs: never steeper than about 27 degrees.
        expect(Math.abs(rise)).toBeLessThan(step * 0.5);
        // And the slope itself changes a little at a time.
        expect(Math.abs(rise - lastRise)).toBeLessThan(step * 0.03);
        last = h;
        lastRise = rise;
      }
    }
  });

  it("rises into hills that stand above the park's edge by the horizon", () => {
    const t = flatTerrain(32, 32, 8);
    const land = createOuterLand(t);
    expect(land.base).toBe(2);
    let highest = -Infinity;
    let lowest = Infinity;
    for (let a = 0; a < 64; a++) {
      const x = 16 + Math.cos(a) * (16 + 110);
      const z = 16 + Math.sin(a) * (16 + 110);
      highest = Math.max(highest, land.heightAt(x, z));
      lowest = Math.min(lowest, land.heightAt(x, z));
    }
    expect(highest).toBeGreaterThan(land.base + 8);
    // Valleys too: the land rolls, it is not a wall around the park.
    expect(lowest).toBeLessThan(land.base + 6);
    expect(lowest).toBeGreaterThan(land.base - 3);
  });

  it("gives unit normals that agree with the heights", () => {
    const t = uneven(20, 18);
    const land = createOuterLand(t);
    const out: Vec = [0, 0, 0];
    for (const [x, z] of [
      [60, 9],
      [-45, -30],
      [10, 150],
      [140, 140],
    ] as const) {
      const n = land.normalAt(x, z, out);
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 10);
      const e = 0.5;
      const dx = (land.heightAt(x + e, z) - land.heightAt(x - e, z)) / (2 * e);
      const dz = (land.heightAt(x, z + e) - land.heightAt(x, z - e)) / (2 * e);
      expect(-n[0] / n[1]).toBeCloseTo(dx, 6);
      expect(-n[2] / n[1]).toBeCloseTo(dz, 6);
    }
  });

  it("keeps a given base, so that an edit at the edge leaves the far hills alone", () => {
    const before = uneven(20, 18);
    const after = uneven(20, 18);
    // Dig a hole at the middle of the east edge.
    for (let cy = 7; cy <= 11; cy++) after.corners[cy * 21 + 20] = 2;
    expect(meanEdgeHeight(after)).not.toBe(meanEdgeHeight(before));

    const base = meanEdgeHeight(before);
    const a = createOuterLand(before, base);
    const b = createOuterLand(after, base);
    expect(b.base).toBe(base);
    expect(b.heightAt(21, 9)).not.toBe(a.heightAt(21, 9));
    for (const [x, z] of [
      [20 + EDGE_REACH, 9],
      [20 + EDGE_REACH + 25, 4],
      [-80, 60],
    ] as const) {
      expect(b.heightAt(x, z)).toBe(a.heightAt(x, z));
    }
  });
});

describe("ringLoops", () => {
  it("starts on the park's edge at the park mesh's own cell size and coarsens outward", () => {
    const loops = ringLoops();
    expect(loops[0]).toEqual({ distance: 0, cell: 1 / SUBDIV });
    expect(loops[loops.length - 1]?.distance).toBe(FAR_REACH);
    for (let i = 1; i < loops.length; i++) {
      const loop = loops[i];
      const inner = loops[i - 1];
      if (!loop || !inner) throw new Error("missing loop");
      expect(loop.distance).toBeGreaterThan(inner.distance);
      expect(loop.distance - inner.distance).toBeCloseTo(inner.cell, 10);
    }
    // Loops lie exactly where the land's parts meet.
    expect(loopAt(loops, EDGE_REACH)).toBeGreaterThan(0);
    expect(loopAt(loops, LAND_REACH)).toBeGreaterThan(loopAt(loops, EDGE_REACH));
  });
});

describe("buildSurroundingsGeometry", () => {
  it("covers everything out to the far reach but the park itself, every triangle facing up", () => {
    const t = uneven(20, 18);
    const g = buildSurroundingsGeometry(t, createOuterLand(t));
    let farthest = 0;
    for (let i = 0; i < g.positions.length / 3; i++) {
      const [x, , z] = vertex(g.positions, i);
      // No vertex strictly inside the park.
      expect(x > 0 && x < 20 && z > 0 && z < 18).toBe(false);
      farthest = Math.max(farthest, distanceOutside(20, 18, x, z));
    }
    expect(farthest).toBeCloseTo(FAR_REACH, 3);

    let area = 0;
    for (let i = 0; i < g.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => vertex(g.positions, g.indices[i + k] as number)) as [
        Vec,
        Vec,
        Vec,
      ];
      const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      expect(ny).toBeGreaterThan(0);
      area += ny / 2;
    }
    // A rectangle grown by the reach with rounded corners, less the park; the corners are drawn
    // as many-sided arcs, which come out a little under a true circle.
    const full = 2 * (20 + 18) * FAR_REACH + Math.PI * FAR_REACH * FAR_REACH;
    expect(area).toBeLessThanOrEqual(full + 1e-3);
    expect(area).toBeGreaterThan(full * 0.99);
  });

  it("shares the park mesh's border vertices exactly: same places, heights and normals", () => {
    const t = uneven(20, 18);
    const ring = buildSurroundingsGeometry(t, createOuterLand(t));
    const ringAt = new Map<string, { y: number; n: Vec }>();
    for (let i = 0; i < ring.positions.length / 3; i++) {
      const [x, y, z] = vertex(ring.positions, i);
      ringAt.set(`${x},${z}`, { y, n: vertex(ring.normals, i) });
    }
    let border = 0;
    for (const [cx, cy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const chunk = buildTerrainChunk(t, cx, cy);
      for (let i = 0; i < chunk.positions.length / 3; i++) {
        const [x, y, z] = vertex(chunk.positions, i);
        if (x !== 0 && x !== 20 && z !== 0 && z !== 18) continue;
        border++;
        const twin = ringAt.get(`${x},${z}`);
        expect(twin).toBeDefined();
        expect(twin?.y).toBe(y);
        expect(twin?.n).toEqual(vertex(chunk.normals, i));
      }
    }
    // Every border vertex of the park, counting the ones two chunks share twice.
    expect(border).toBeGreaterThanOrEqual((20 + 18) * 2 * SUBDIV);
  });

  it("puts every vertex on the land, with the land's normal", () => {
    const t = uneven(12, 12);
    const land = createOuterLand(t);
    const g = buildSurroundingsGeometry(t, land);
    for (let i = 0; i < g.positions.length / 3; i++) {
      const [x, y, z] = vertex(g.positions, i);
      // The mesh keeps single-precision places, so the land is asked a hair away from them.
      expect(y).toBeCloseTo(land.heightAt(x, z), 4);
      const n = vertex(g.normals, i);
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
      expect(n[1]).toBeGreaterThan(0.8);
    }
  });

  it("builds in two parts that meet on the very same vertices", () => {
    const t = uneven(12, 10);
    const land = createOuterLand(t);
    const loops = ringLoops();
    const split = loopAt(loops, EDGE_REACH);
    const near = buildSurroundingsGeometry(t, land, loops, 0, split);
    const far = buildSurroundingsGeometry(t, land, loops, split, loops.length - 1);
    const whole = buildSurroundingsGeometry(t, land, loops);
    expect(near.indices.length + far.indices.length).toBe(whole.indices.length);

    const seam = (g: typeof near) => {
      const found: string[] = [];
      for (let i = 0; i < g.positions.length / 3; i++) {
        const [x, y, z] = vertex(g.positions, i);
        if (Math.abs(distanceOutside(12, 10, x, z) - EDGE_REACH) < 1e-4) {
          found.push([x, y, z, ...vertex(g.normals, i)].join(","));
        }
      }
      return found.sort();
    };
    const nearSeam = seam(near);
    expect(nearSeam.length).toBeGreaterThan(20);
    expect(seam(far)).toEqual(nearSeam);
  });

  it("stays a modest mesh", () => {
    const t = flatTerrain(64, 64, 8);
    const g = buildSurroundingsGeometry(t, createOuterLand(t));
    expect(g.indices.length / 3).toBeLessThan(160_000);
  });
});

describe("detailFor", () => {
  const range = [16, 100, 190] as const;

  it("uses a finer model the nearer the camera", () => {
    expect(detailFor(1, range, -1, 0)).toBe(0);
    expect(detailFor(16, range, -1, 0)).toBe(1);
    expect(detailFor(100, range, -1, 0)).toBe(2);
    expect(detailFor(200, range, -1, 0)).toBe(3);
  });

  it("never goes finer than the band allows", () => {
    expect(detailFor(1, range, -1, 1)).toBe(1);
  });

  it("holds the coarser level until the camera is well inside the finer range", () => {
    // Showing level 2 at 99 tiles: 99 is inside level 1's range but not by the slack.
    expect(detailFor(99, range, 2, 0)).toBe(2);
    expect(detailFor(80, range, 2, 0)).toBe(1);
  });
});
