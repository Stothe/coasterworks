import { describe, expect, it } from "vitest";
import { groundHeightAt } from "../src/ground.js";
import type { TerrainData } from "../src/terrain-geometry.js";
import { HEIGHT_STEP } from "../src/units.js";

/** A width by height map whose corner (cx, cz) has the height `at(cx, cz)`. */
function terrain(width: number, height: number, at: (cx: number, cz: number) => number) {
  const corners = new Int16Array((width + 1) * (height + 1));
  for (let cz = 0; cz <= height; cz++) {
    for (let cx = 0; cx <= width; cx++) corners[cz * (width + 1) + cx] = at(cx, cz);
  }
  return {
    width,
    height,
    corners,
    surface: new Uint8Array(width * height),
    water: new Uint8Array(width * height),
  } satisfies TerrainData;
}

describe("groundHeightAt", () => {
  const sloped = terrain(4, 3, (cx, cz) => 10 + cx * 4 + cz * 2);

  it("is the corner height times HEIGHT_STEP at a corner", () => {
    expect(groundHeightAt(sloped, 0, 0)).toBe(10 * HEIGHT_STEP);
    expect(groundHeightAt(sloped, 2, 1)).toBe((10 + 8 + 2) * HEIGHT_STEP);
    expect(groundHeightAt(sloped, 4, 3)).toBe((10 + 16 + 6) * HEIGHT_STEP);
  });

  it("blends the four corners of the tile bilinearly", () => {
    // Tile (1, 1) has corners 16, 20, 18, 22 (NW, NE, SW, SE); its middle is their mean.
    expect(groundHeightAt(sloped, 1.5, 1.5)).toBeCloseTo(19 * HEIGHT_STEP, 12);
    expect(groundHeightAt(sloped, 1.25, 1)).toBeCloseTo(17 * HEIGHT_STEP, 12);
    expect(groundHeightAt(sloped, 1, 1.5)).toBeCloseTo(17 * HEIGHT_STEP, 12);
  });

  it("uses a saddle's average in its middle, whichever way the tile is split", () => {
    const saddle = terrain(1, 1, (cx, cz) => (cx === cz ? 20 : 0));
    expect(groundHeightAt(saddle, 0.5, 0.5)).toBeCloseTo(10 * HEIGHT_STEP, 12);
  });

  it("takes the nearest edge's height beyond the map", () => {
    expect(groundHeightAt(sloped, -5, 0)).toBe(groundHeightAt(sloped, 0, 0));
    expect(groundHeightAt(sloped, 99, 1.5)).toBe(groundHeightAt(sloped, 4, 1.5));
    expect(groundHeightAt(sloped, 2, -1)).toBe(groundHeightAt(sloped, 2, 0));
    expect(groundHeightAt(sloped, 2, 50)).toBe(groundHeightAt(sloped, 2, 3));
  });

  it("is continuous across a tile edge", () => {
    const bumpy = terrain(4, 4, (cx, cz) => (cx * 7 + cz * 13) % 11);
    const left = groundHeightAt(bumpy, 2 - 1e-9, 1.3);
    const right = groundHeightAt(bumpy, 2 + 1e-9, 1.3);
    expect(left).toBeCloseTo(right, 6);
  });
});
