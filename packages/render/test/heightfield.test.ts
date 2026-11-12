import { describe, expect, it } from "vitest";
import { groundHeightAt, groundNormalAt, sceneGroundAt } from "../src/heightfield.js";
import type { TerrainData } from "../src/terrain/geometry.js";
import { HEIGHT_STEP } from "../src/units.js";

/** A width by height map whose corner (cx, cz) has the height `at(cx, cz)`. */
function terrain(
  width: number,
  height: number,
  at: (cx: number, cz: number) => number,
): TerrainData {
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
  };
}

const corner = (t: TerrainData, cx: number, cz: number) =>
  t.corners[cz * (t.width + 1) + cx] as number;

/** A repeatable generator of numbers in 0..1 (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), a | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rough land: every corner at a random height from 0 to 15. The hardest case for the spline. */
function rough(width: number, height: number, seed: number): TerrainData {
  const next = random(seed);
  return terrain(width, height, () => Math.floor(next() * 16));
}

/** Rolling land: a couple of rounded hills, as the sim's smoothing leaves them. */
const rolling = terrain(12, 10, (cx, cz) =>
  Math.round(8 + 6 * Math.sin(cx * 0.55) * Math.cos(cz * 0.45) + 3 * Math.sin(cz * 0.8 + 1)),
);

describe("groundHeightAt", () => {
  it("passes exactly through every corner", () => {
    for (const t of [rough(9, 7, 1), rough(5, 12, 2), rolling]) {
      for (let cz = 0; cz <= t.height; cz++) {
        for (let cx = 0; cx <= t.width; cx++) {
          expect(groundHeightAt(t, cx, cz)).toBe(corner(t, cx, cz) * HEIGHT_STEP);
        }
      }
    }
  });

  it("keeps a level tile exactly level all over, whatever its neighbors do", () => {
    const t = rough(8, 8, 3);
    // Level the four corners of tile (3, 4), in the middle of rough land.
    for (const [cx, cz] of [
      [3, 4],
      [4, 4],
      [3, 5],
      [4, 5],
    ] as const) {
      t.corners[cz * 9 + cx] = 11;
    }
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        expect(groundHeightAt(t, 3 + i / 20, 4 + j / 20)).toBe(11 * HEIGHT_STEP);
      }
    }
  });

  it("is exactly level over level ground", () => {
    const t = terrain(6, 6, () => 8);
    const next = random(4);
    for (let i = 0; i < 200; i++) {
      expect(groundHeightAt(t, next() * 6, next() * 6)).toBe(2);
    }
  });

  it("never rises above or dips below the corners of the tile a point is in", () => {
    for (const t of [rough(10, 10, 5), rough(10, 10, 6), rolling]) {
      const next = random(7);
      for (let i = 0; i < 4000; i++) {
        const x = next() * t.width;
        const z = next() * t.height;
        const tx = Math.min(t.width - 1, Math.floor(x));
        const tz = Math.min(t.height - 1, Math.floor(z));
        const around = [
          corner(t, tx, tz),
          corner(t, tx + 1, tz),
          corner(t, tx, tz + 1),
          corner(t, tx + 1, tz + 1),
        ];
        const h = groundHeightAt(t, x, z) / HEIGHT_STEP;
        expect(h).toBeGreaterThanOrEqual(Math.min(...around) - 1e-9);
        expect(h).toBeLessThanOrEqual(Math.max(...around) + 1e-9);
      }
    }
  });

  it("is a straight ramp where the corners rise evenly", () => {
    const ramp = terrain(6, 4, (cx) => 4 + cx * 2);
    // Away from the ends, where the land levels off toward the edge of the map.
    expect(groundHeightAt(ramp, 2.5, 1.3)).toBeCloseTo((4 + 5) * HEIGHT_STEP, 12);
    expect(groundHeightAt(ramp, 3.25, 2.9)).toBeCloseTo((4 + 6.5) * HEIGHT_STEP, 12);
  });

  it("is continuous across tile borders", () => {
    for (const t of [rough(8, 8, 8), rolling]) {
      const next = random(9);
      for (let i = 0; i < 300; i++) {
        const border = 1 + Math.floor(next() * (t.width - 2));
        const along = next() * t.height;
        const eps = 1e-7;
        expect(groundHeightAt(t, border - eps, along)).toBeCloseTo(
          groundHeightAt(t, border + eps, along),
          5,
        );
        const borderZ = 1 + Math.floor(next() * (t.height - 2));
        const alongX = next() * t.width;
        expect(groundHeightAt(t, alongX, borderZ - eps)).toBeCloseTo(
          groundHeightAt(t, alongX, borderZ + eps),
          5,
        );
      }
    }
  });

  it("has no crease across tile borders: the slope is the same on both sides, on both axes", () => {
    const eps = 1e-5;
    const slopeX = (t: TerrainData, x: number, z: number) =>
      (groundHeightAt(t, x + eps, z) - groundHeightAt(t, x, z)) / eps;
    const slopeZ = (t: TerrainData, x: number, z: number) =>
      (groundHeightAt(t, x, z + eps) - groundHeightAt(t, x, z)) / eps;
    // Even over the roughest land.
    for (const t of [rough(8, 8, 10), rough(8, 8, 18), rolling]) {
      const next = random(11);
      for (let i = 0; i < 500; i++) {
        const border = 1 + Math.floor(next() * (t.width - 2));
        const along = next() * t.height;
        // The slope across the border, just before it and just after it.
        expect(slopeX(t, border - eps, along)).toBeCloseTo(slopeX(t, border, along), 2);
        // And the slope along the border, a hair to either side of it.
        expect(slopeZ(t, border - eps, along)).toBeCloseTo(slopeZ(t, border + eps, along), 2);

        const borderZ = 1 + Math.floor(next() * (t.height - 2));
        const alongX = next() * t.width;
        expect(slopeZ(t, alongX, borderZ - eps)).toBeCloseTo(slopeZ(t, alongX, borderZ), 2);
        expect(slopeX(t, alongX, borderZ - eps)).toBeCloseTo(slopeX(t, alongX, borderZ + eps), 2);
      }
    }
  });

  it("treats X and Z alike: a map turned over its diagonal gives the same ground", () => {
    const t = rough(7, 7, 19);
    const turned = terrain(7, 7, (cx, cz) => corner(t, cz, cx));
    const next = random(20);
    for (let i = 0; i < 300; i++) {
      const x = next() * 9 - 1;
      const z = next() * 9 - 1;
      expect(groundHeightAt(turned, z, x)).toBeCloseTo(groundHeightAt(t, x, z), 12);
    }
  });

  it("stays within the corners over a sharp saddle", () => {
    // Two high corners on one diagonal and two low on the other, with the land outside rising
    // steeply the way each edge leans: the hardest tile to stay inside.
    const t = terrain(3, 3, (cx, cz) => {
      if ((cx === 1 || cx === 2) && (cz === 1 || cz === 2)) return cx === cz ? 20 : 4;
      return cx + cz <= 2 || cx + cz >= 4 ? 40 : 0;
    });
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        const h = groundHeightAt(t, 1 + i / 40, 1 + j / 40) / HEIGHT_STEP;
        expect(h).toBeGreaterThanOrEqual(4);
        expect(h).toBeLessThanOrEqual(20);
      }
    }
  });

  it("carries the edge's height on beyond the map", () => {
    const t = rough(6, 5, 12);
    expect(groundHeightAt(t, -5, 0)).toBe(groundHeightAt(t, 0, 0));
    expect(groundHeightAt(t, 99, 1.5)).toBe(groundHeightAt(t, 6, 1.5));
    expect(groundHeightAt(t, 2.25, -1)).toBe(groundHeightAt(t, 2.25, 0));
    expect(groundHeightAt(t, 2.25, 50)).toBe(groundHeightAt(t, 2.25, 5));
    expect(groundHeightAt(t, -3, -3)).toBe(corner(t, 0, 0) * HEIGHT_STEP);
    expect(groundHeightAt(t, 1e6, 1e6)).toBe(corner(t, 6, 5) * HEIGHT_STEP);
  });

  it("meets the edge of the map level, so the land beyond joins without a crease", () => {
    const t = rough(6, 6, 13);
    const eps = 1e-4;
    for (let i = 0; i <= 24; i++) {
      const along = i / 4;
      const west = (groundHeightAt(t, eps, along) - groundHeightAt(t, 0, along)) / eps;
      const south = (groundHeightAt(t, along, 6) - groundHeightAt(t, along, 6 - eps)) / eps;
      expect(Math.abs(west)).toBeLessThan(1e-2);
      expect(Math.abs(south)).toBeLessThan(1e-2);
    }
  });

  it("turns a single raised corner into a smooth mound", () => {
    const t = terrain(8, 8, (cx, cz) => (cx === 4 && cz === 4 ? 12 : 8));
    const peak = 12 * HEIGHT_STEP;
    const base = 8 * HEIGHT_STEP;
    expect(groundHeightAt(t, 4, 4)).toBe(peak);

    // Downhill all the way from the peak to the level ground, in every direction.
    for (let k = 0; k < 16; k++) {
      const angle = (k / 16) * Math.PI * 2;
      let last = peak;
      for (let step = 1; step <= 40; step++) {
        const r = (step / 40) * 1.5;
        const h = groundHeightAt(t, 4 + Math.cos(angle) * r, 4 + Math.sin(angle) * r);
        expect(h).toBeLessThanOrEqual(last + 1e-12);
        expect(h).toBeGreaterThanOrEqual(base);
        last = h;
      }
      expect(last).toBe(base);
    }

    // Rounded on top and at the foot: level at the peak and where it meets the ground.
    const eps = 1e-3;
    expect(peak - groundHeightAt(t, 4 + eps, 4)).toBeLessThan(1e-4);
    expect(peak - groundHeightAt(t, 4, 4 - eps)).toBeLessThan(1e-4);
    expect(groundHeightAt(t, 5 - eps, 4) - base).toBeLessThan(1e-4);
    // Halfway down, the slope is well short of a pyramid's cliff but clearly a hill.
    expect(groundHeightAt(t, 4.5, 4)).toBeCloseTo((peak + base) / 2, 9);

    // The mound is the four tiles around the corner and nothing more.
    expect(groundHeightAt(t, 5.5, 4.5)).toBe(base);
    expect(groundHeightAt(t, 2.5, 3.5)).toBe(base);
    expect(groundHeightAt(t, 4.5, 5.5)).toBe(base);
  });
});

describe("sceneGroundAt", () => {
  const t = rough(6, 5, 24);
  const hills = (x: number, z: number) => 100 + x + z;

  it("is zero while there is no terrain", () => {
    expect(sceneGroundAt(null, null, 3, 3)).toBe(0);
    expect(sceneGroundAt(null, hills, -3, 3)).toBe(0);
  });

  it("is the smooth ground everywhere when nothing lies beyond the park", () => {
    for (const [x, z] of [
      [2.3, 1.7],
      [0, 0],
      [-4, 2],
      [9, 9],
    ] as const) {
      expect(sceneGroundAt(t, null, x, z)).toBe(groundHeightAt(t, x, z));
    }
  });

  it("is the park's ground over the map, edge included, and the outer ground beyond it", () => {
    for (const [x, z] of [
      [2.3, 1.7],
      [0, 0],
      [6, 5],
      [0, 2.5],
      [3, 5],
    ] as const) {
      expect(sceneGroundAt(t, hills, x, z)).toBe(groundHeightAt(t, x, z));
    }
    for (const [x, z] of [
      [-0.01, 2],
      [6.01, 2],
      [3, -0.01],
      [3, 5.01],
      [-40, 70],
    ] as const) {
      expect(sceneGroundAt(t, hills, x, z)).toBe(100 + x + z);
    }
  });
});

describe("groundNormalAt", () => {
  it("points straight up over level ground", () => {
    const t = terrain(4, 4, () => 8);
    expect(groundNormalAt(t, 1.3, 2.7)).toEqual([0, 1, 0]);
    expect(groundNormalAt(t, -3, 9)).toEqual([0, 1, 0]);
  });

  it("is unit length and leans away from rising ground", () => {
    const ramp = terrain(8, 4, (cx) => cx * 2);
    const [nx, ny, nz] = groundNormalAt(ramp, 4.5, 2);
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 12);
    // The ground rises toward +X by two steps (0.5 world units) a tile.
    expect(nx / ny).toBeCloseTo(-0.5, 6);
    expect(nz).toBeCloseTo(0, 9);

    const next = random(14);
    const t = rough(8, 8, 15);
    for (let i = 0; i < 200; i++) {
      const n = groundNormalAt(t, next() * 10 - 1, next() * 10 - 1);
      expect(Math.hypot(...n)).toBeCloseTo(1, 12);
      expect(n[1]).toBeGreaterThan(0);
    }
  });

  it("is the same on both sides of a tile border", () => {
    const next = random(16);
    for (let i = 0; i < 300; i++) {
      const border = 1 + Math.floor(next() * (rolling.width - 2));
      const along = next() * rolling.height;
      const a = groundNormalAt(rolling, border - 1e-6, along);
      const b = groundNormalAt(rolling, border + 1e-6, along);
      const c = groundNormalAt(rolling, along, border - 1e-6);
      const d = groundNormalAt(rolling, along, border + 1e-6);
      for (let k = 0; k < 3; k++) {
        expect(a[k]).toBeCloseTo(b[k] as number, 4);
        expect(c[k]).toBeCloseTo(d[k] as number, 4);
      }
    }
  });

  it("is exactly the normal of a plane, whichever way the plane leans", () => {
    const plane = terrain(12, 12, (cx, cz) => 2 * cx + cz);
    // The ground rises half a world unit a tile toward +X and a quarter toward +Z.
    const inv = 1 / Math.hypot(0.5, 1, 0.25);
    const next = random(21);
    for (let i = 0; i < 100; i++) {
      const [nx, ny, nz] = groundNormalAt(plane, 2 + next() * 8, 2 + next() * 8);
      expect(nx).toBeCloseTo(-0.5 * inv, 12);
      expect(ny).toBeCloseTo(inv, 12);
      expect(nz).toBeCloseTo(-0.25 * inv, 12);
    }
  });

  /** How far each part of the normal moves along a line of `direction` from `from`, 6 tiles long. */
  function swing(
    t: TerrainData,
    from: readonly [number, number],
    direction: readonly [number, number],
  ): number {
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let s = 0; s <= 6; s += 1 / 32) {
      const n = groundNormalAt(t, from[0] + direction[0] * s, from[1] + direction[1] * s);
      for (let k = 0; k < 3; k++) {
        low[k] = Math.min(low[k] as number, n[k] as number);
        high[k] = Math.max(high[k] as number, n[k] as number);
      }
    }
    return Math.max(...high.map((h, k) => h - (low[k] as number)));
  }

  it("lights a diagonal ridge or valley evenly along its length: no band once a tile", () => {
    // Two faces meeting on the grid's diagonal, as the land tools leave the corners of every
    // hill and every pit. Along any line beside the fold the land is the same all the way, so
    // its normal should be too. The exact slope of the ground swings by 0.36 here, about 20
    // degrees, once a tile.
    const folds: [string, TerrainData, number][] = [
      ["hip", terrain(24, 24, (cx, cz) => 2 * Math.min(cx, cz)), 0.02],
      ["steep hip", terrain(24, 24, (cx, cz) => 4 * Math.min(cx, cz)), 0.03],
      ["valley", terrain(24, 24, (cx, cz) => 2 * Math.max(cx, cz)), 0.02],
      // A roof whose ridge climbs: neither face is level along either axis.
      ["roof", terrain(24, 24, (cx, cz) => 30 + cx + cz - 3 * Math.abs(cx - cz)), 0.06],
    ];
    for (const [name, t, most] of folds) {
      for (const offset of [0, 0.25, 0.5, 1, 1.5]) {
        expect(swing(t, [8 + offset, 8], [1, 1]), `${name}, ${offset} off the fold`).toBeLessThan(
          most,
        );
      }
    }
  });

  it("turns from one face to the other across a ridge, without a level spot on top", () => {
    const hip = terrain(24, 24, (cx, cz) => 2 * Math.min(cx, cz));
    // Well onto each face it is that face's own normal.
    const inv = 1 / Math.hypot(0.5, 1);
    const [ax, , az] = groundNormalAt(hip, 9, 13);
    expect(ax).toBeCloseTo(-0.5 * inv, 9);
    expect(az).toBeCloseTo(0, 9);
    const [bx, , bz] = groundNormalAt(hip, 13, 9);
    expect(bx).toBeCloseTo(0, 9);
    expect(bz).toBeCloseTo(-0.5 * inv, 9);
    // On the ridge it leans equally both ways, at a corner and between corners alike.
    for (const at of [10, 10.5, 11]) {
      const [nx, ny, nz] = groundNormalAt(hip, at, at);
      expect(nx).toBeCloseTo(nz, 12);
      expect(nx).toBeLessThan(-0.2);
      expect(ny).toBeLessThan(0.95);
    }
  });

  it("is exactly upright wherever the corners around the point are level", () => {
    // A plateau with a slope four tiles away on one side.
    const t = terrain(16, 16, (cx) => (cx < 10 ? 8 : 8 + (cx - 10) * 3));
    for (const x of [1, 3.3, 6.5, 7.99]) expect(groundNormalAt(t, x, 5.2)).toEqual([0, 1, 0]);
    // The last level tile before the slope leans toward it, though its ground is flat.
    expect(groundHeightAt(t, 9.5, 5.2)).toBe(8 * HEIGHT_STEP);
    const [nx, , nz] = groundNormalAt(t, 9.5, 5.2);
    expect(nx).toBeLessThan(0);
    expect(nx).toBeGreaterThan(-0.2);
    expect(nz).toBe(0);
  });

  it("stays near the exact slope of the ground on rolling land: a few degrees, more at a fold", () => {
    const eps = 1e-4;
    let total = 0;
    let count = 0;
    for (let z = 1; z <= 9; z += 0.25) {
      for (let x = 1; x <= 11; x += 0.25) {
        const dx = (groundHeightAt(rolling, x + eps, z) - groundHeightAt(rolling, x - eps, z)) / 2;
        const dz = (groundHeightAt(rolling, x, z + eps) - groundHeightAt(rolling, x, z - eps)) / 2;
        const inv = 1 / Math.hypot(dx / eps, 1, dz / eps);
        const [nx, ny, nz] = groundNormalAt(rolling, x, z);
        const cos = (-dx / eps) * inv * nx + inv * ny + (-dz / eps) * inv * nz;
        const angle = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
        expect(angle).toBeLessThan(35);
        total += angle;
        count++;
      }
    }
    expect(total / count).toBeLessThan(8);
  });

  it("treats X and Z alike", () => {
    const t = rough(7, 7, 22);
    const turned = terrain(7, 7, (cx, cz) => corner(t, cz, cx));
    const next = random(23);
    for (let i = 0; i < 200; i++) {
      const x = next() * 9 - 1;
      const z = next() * 9 - 1;
      const [nx, ny, nz] = groundNormalAt(t, x, z);
      const [mx, my, mz] = groundNormalAt(turned, z, x);
      expect(mx).toBeCloseTo(nz, 12);
      expect(my).toBeCloseTo(ny, 12);
      expect(mz).toBeCloseTo(nx, 12);
    }
  });

  it("points straight up at the top of a mound", () => {
    const t = terrain(8, 8, (cx, cz) => (cx === 4 && cz === 4 ? 12 : 8));
    const [nx, ny, nz] = groundNormalAt(t, 4, 4);
    expect(nx).toBeCloseTo(0, 9);
    expect(nz).toBeCloseTo(0, 9);
    expect(ny).toBeCloseTo(1, 9);
  });
});
