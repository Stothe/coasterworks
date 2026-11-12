import { describe, expect, it } from "vitest";
import type { TerrainData } from "../src/terrain/geometry.js";
import { HEIGHT_STEP, SUBDIV } from "../src/units.js";
import { WATER_DROP, buildWaterGeometry, waterSurfaceY } from "../src/water.js";

// The water module's own data helper: one sheet per water level over its tiles and the dry tiles
// around them, on the ground mesh's sub-grid. No other module's tests live in this file.

function flatTerrain(width: number, height: number, level: number): TerrainData {
  return {
    width,
    height,
    corners: new Int16Array((width + 1) * (height + 1)).fill(level),
    surface: new Uint8Array(width * height),
    water: new Uint8Array(width * height),
  };
}

type Vec = [number, number, number];
const vertex = (a: Float32Array, i: number): Vec => [
  a[i * 3] as number,
  a[i * 3 + 1] as number,
  a[i * 3 + 2] as number,
];

describe("buildWaterGeometry", () => {
  it("is null for a map with no water", () => {
    expect(buildWaterGeometry(flatTerrain(4, 4, 8))).toBeNull();
  });

  it("is null when the ground stands above the water everywhere", () => {
    const t = flatTerrain(4, 4, 8);
    t.water[5] = 6;
    expect(buildWaterGeometry(t)).toBeNull();
  });

  it("covers the water tiles and the tiles around them, level, just under the brim", () => {
    const t = flatTerrain(8, 8, 6);
    t.water[3 * 8 + 3] = 7;
    t.water[3 * 8 + 4] = 7;
    const g = buildWaterGeometry(t);
    expect(g).not.toBeNull();
    if (!g) return;
    // Two water tiles and the ring around them: 4 by 3, each SUBDIV by SUBDIV cells of two triangles.
    expect(g.tileCount).toBe(12);
    // (A corner cell of the ring can have a triangle whose three corners are all on the dry outer
    // border; the ground covers it and it is left out.)
    expect(g.indices.length).toBeLessThanOrEqual(12 * SUBDIV * SUBDIV * 6);
    expect(g.indices.length).toBeGreaterThanOrEqual((12 * SUBDIV * SUBDIV - 4) * 6);
    // Shared vertices: at most one per sub-grid point (a dropped corner leaves its own out).
    expect(g.positions.length).toBeLessThanOrEqual((4 * SUBDIV + 1) * (3 * SUBDIV + 1) * 3);
    expect(g.positions.length).toBeGreaterThanOrEqual(
      ((4 * SUBDIV + 1) * (3 * SUBDIV + 1) - 4) * 3,
    );
    expect(g.depths.length).toBe(g.positions.length / 3);
    expect(g.banks.length).toBe(g.positions.length / 3);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < g.positions.length / 3; i++) {
      const [x, y, z] = vertex(g.positions, i);
      expect(y).toBeCloseTo(waterSurfaceY(7), 6);
      expect(y).toBeLessThan(7 * HEIGHT_STEP);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      // The outer border holds no water; inside, the depth is the surface over the ground.
      const border = x === 2 || x === 6 || z === 2 || z === 5;
      if (border) expect(g.depths[i]).toBeLessThanOrEqual(0);
      else expect(g.depths[i]).toBeCloseTo(waterSurfaceY(7) - 6 * HEIGHT_STEP, 6);
      // Flat ground: no bank.
      expect(g.banks[i]).toBeCloseTo(0, 6);
    }
    expect([minX, maxX]).toEqual([2, 6]);
  });

  it("faces up", () => {
    const t = flatTerrain(4, 4, 4);
    t.water[5] = 6;
    const g = buildWaterGeometry(t);
    if (!g) throw new Error("expected water");
    for (let i = 0; i < g.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => vertex(g.positions, g.indices[i + k] as number)) as [
        Vec,
        Vec,
        Vec,
      ];
      const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      expect(ny).toBeGreaterThan(0);
    }
  });

  it("stops at the edge of the map, and gives each pool its own sheet over the dry tile between", () => {
    const t = flatTerrain(5, 1, 4);
    t.water[0] = 5;
    t.water[2] = 9;
    const g = buildWaterGeometry(t);
    if (!g) throw new Error("expected water");
    // Level 5: tile 0 and the dry tile 1. Level 9: tile 2 and the dry tiles 1 and 3.
    expect(g.tileCount).toBe(5);
    const levels = new Set<number>();
    for (let i = 0; i < g.positions.length / 3; i++) {
      const [x, y, z] = vertex(g.positions, i);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(4);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(1);
      const level = Math.round((y + WATER_DROP) / HEIGHT_STEP);
      levels.add(level);
      if (level === 5) expect(x).toBeLessThanOrEqual(2);
      else expect(x).toBeGreaterThanOrEqual(1);
    }
    expect([...levels].sort((a, b) => a - b)).toEqual([5, 9]);
  });
});
