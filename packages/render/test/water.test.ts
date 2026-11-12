import { describe, expect, it } from "vitest";
import type { TerrainData } from "../src/terrain/geometry.js";
import { HEIGHT_STEP, WATER_LIFT } from "../src/units.js";
import { buildWaterGeometry } from "../src/water.js";

// The water module's own data helper. These tests describe the placeholder; whoever
// replaces it rewrites them along with it. No other module's tests live in this file.

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

  it("covers the water tiles and the tiles around them, level, a hair above the water", () => {
    const t = flatTerrain(8, 8, 8);
    t.water[3 * 8 + 3] = 7;
    t.water[3 * 8 + 4] = 7;
    const g = buildWaterGeometry(t);
    expect(g).not.toBeNull();
    if (!g) return;
    // Two water tiles and the ring around them: 4 by 3.
    expect(g.tileCount).toBe(12);
    expect(g.positions.length).toBe(12 * 4 * 3);
    expect(g.indices.length).toBe(12 * 6);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < g.positions.length / 3; i++) {
      const [x, y] = vertex(g.positions, i);
      expect(y).toBeCloseTo(7 * HEIGHT_STEP + WATER_LIFT, 6);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    expect([minX, maxX]).toEqual([2, 6]);
  });

  it("faces up", () => {
    const t = flatTerrain(4, 4, 8);
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

  it("stops at the edge of the map, and gives a dry tile between two pools the higher level", () => {
    const t = flatTerrain(5, 1, 8);
    t.water[0] = 5;
    t.water[2] = 9;
    const g = buildWaterGeometry(t);
    if (!g) throw new Error("expected water");
    // Tiles 0 to 3: the two pools, the tile between them and the one past the second.
    expect(g.tileCount).toBe(4);
    const levelOfTile = (tile: number) => (g.positions[tile * 12 + 1] as number) - WATER_LIFT;
    expect(levelOfTile(0)).toBeCloseTo(5 * HEIGHT_STEP, 6);
    expect(levelOfTile(1)).toBeCloseTo(9 * HEIGHT_STEP, 6);
    expect(levelOfTile(2)).toBeCloseTo(9 * HEIGHT_STEP, 6);
  });
});
