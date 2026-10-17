import { describe, expect, it } from "vitest";
import { CameraRig } from "../src/camera.js";
import { pickTile, rayFromCamera } from "../src/picker.js";
import { tileTriangles, type TerrainData } from "../src/terrain-geometry.js";

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

const down = { x: 0, y: -1, z: 0 };

describe("pickTile", () => {
  it("hits the tile under a straight-down ray over flat terrain", () => {
    const hit = pickTile(
      { origin: { x: 5.5, y: 100, z: 7.5 }, direction: down },
      flatTerrain(16, 16, 8),
    );
    expect(hit).not.toBeNull();
    expect(hit?.x).toBe(5);
    expect(hit?.y).toBe(7);
    expect(hit?.point.x).toBeCloseTo(5.5, 9);
    expect(hit?.point.y).toBeCloseTo(2.0, 9);
    expect(hit?.point.z).toBeCloseTo(7.5, 9);
  });

  it("hits tile centers, which lie exactly on the tile diagonal", () => {
    const t = flatTerrain(16, 16, 8);
    for (let ty = 0; ty < 16; ty++) {
      for (let tx = 0; tx < 16; tx++) {
        const hit = pickTile({ origin: { x: tx + 0.5, y: 50, z: ty + 0.5 }, direction: down }, t);
        expect(hit && [hit.x, hit.y]).toEqual([tx, ty]);
      }
    }
  });

  it("misses a straight-down ray beside the map", () => {
    const t = flatTerrain(16, 16, 8);
    expect(pickTile({ origin: { x: -1, y: 100, z: 3 }, direction: down }, t)).toBeNull();
    expect(pickTile({ origin: { x: 3, y: 100, z: 16.5 }, direction: down }, t)).toBeNull();
    expect(pickTile({ origin: { x: 20, y: 100, z: 3 }, direction: down }, t)).toBeNull();
  });

  it("misses a ray pointing away from the map", () => {
    const t = flatTerrain(16, 16, 8);
    expect(
      pickTile({ origin: { x: -5, y: 10, z: 3.5 }, direction: { x: -1, y: -0.5, z: 0 } }, t),
    ).toBeNull();
    expect(
      pickTile({ origin: { x: 8, y: 10, z: 8 }, direction: { x: 0, y: 1, z: 0 } }, t),
    ).toBeNull();
  });

  it("misses a ray that passes under the terrain", () => {
    const t = flatTerrain(64, 64, 8);
    expect(
      pickTile({ origin: { x: -20, y: 10, z: 8.5 }, direction: { x: 1, y: -0.5, z: 0 } }, t),
    ).toBeNull();
  });

  it("finds the entry tile for an oblique ray that starts outside the map", () => {
    const t = flatTerrain(64, 64, 8);
    const hit = pickTile(
      { origin: { x: -10, y: 5.05, z: 3.5 }, direction: { x: 1, y: -0.1, z: 0 } },
      t,
    );
    expect(hit && [hit.x, hit.y]).toEqual([20, 3]);
    expect(hit?.point.x).toBeCloseTo(20.5, 6);
    expect(hit?.point.y).toBeCloseTo(2.0, 6);
  });

  it("walks diagonally across tiles", () => {
    const t = flatTerrain(64, 64, 8);
    // From (2, 10, 2) heading (+1, -0.25, +1): reaches y = 2 after 32 units along each of x and z.
    const hit = pickTile(
      { origin: { x: 2.2, y: 10, z: 2.7 }, direction: { x: 1, y: -0.25, z: 1 } },
      t,
    );
    expect(hit && [hit.x, hit.y]).toEqual([34, 34]);
    expect(hit?.point.x).toBeCloseTo(34.2, 6);
    expect(hit?.point.z).toBeCloseTo(34.7, 6);
  });

  it("returns the correct tile and a point on the raised surface", () => {
    const t = flatTerrain(16, 16, 8);
    for (const [cx, cy] of [
      [3, 2],
      [4, 2],
      [3, 3],
      [4, 3],
    ] as const) {
      setCorner(t, cx, cy, 20);
    }
    const top = pickTile({ origin: { x: 3.5, y: 100, z: 2.5 }, direction: down }, t);
    expect(top && [top.x, top.y]).toEqual([3, 2]);
    expect(top?.point.y).toBeCloseTo(5.0, 9);

    // On the ramp tile east of the plateau the height falls from 5.0 at x = 4 to 2.0 at x = 5.
    const ramp = pickTile({ origin: { x: 4.25, y: 100, z: 2.5 }, direction: down }, t);
    expect(ramp && [ramp.x, ramp.y]).toEqual([4, 2]);
    expect(ramp?.point.y).toBeCloseTo(5 - 3 * 0.25, 9);
  });

  it("stops at the first surface along an oblique ray, not the one behind it", () => {
    const t = flatTerrain(16, 16, 8);
    for (const [cx, cy] of [
      [3, 2],
      [4, 2],
      [3, 3],
      [4, 3],
    ] as const) {
      setCorner(t, cx, cy, 20);
    }
    // Descends from the east toward (3.5, 3, 2.5): the ramp tile (4, 2) is struck first.
    const hit = pickTile(
      { origin: { x: 10.5, y: 30, z: 2.5 }, direction: { x: -7, y: -27, z: 0 } },
      t,
    );
    expect(hit && [hit.x, hit.y]).toEqual([4, 2]);
    expect(hit?.point.y).toBeCloseTo(5 - 3 * (hit!.point.x - 4), 6);
    // The ray was heading for tile (3, 2) but cannot reach it past the ramp.
  });

  it("uses the tile's own diagonal when the tile is skewed", () => {
    // NW=8, NE=8, SE=12, SW=8: split NE-SW, so the SE half is a plane through NE, SW and SE.
    const t = flatTerrain(1, 1, 8);
    setCorner(t, 1, 1, 12);
    const inSE = pickTile({ origin: { x: 0.75, y: 50, z: 0.75 }, direction: down }, t);
    // Plane through NE (1,2,0), SW (0,2,1), SE (1,3,1): height = 2 + (x + z - 1) * 1.
    expect(inSE?.point.y).toBeCloseTo(2.5, 9);
    const inNW = pickTile({ origin: { x: 0.25, y: 50, z: 0.25 }, direction: down }, t);
    expect(inNW?.point.y).toBeCloseTo(2.0, 9);
  });

  it("tests only the tile under the origin for a vertical ray", () => {
    const t = flatTerrain(16, 16, 8);
    expect(pickTile({ origin: { x: 1.5, y: 1.0, z: 1.5 }, direction: down }, t)).toBeNull();
    expect(
      pickTile({ origin: { x: 1.5, y: 9.0, z: 1.5 }, direction: { x: 0, y: -2, z: 0 } }, t)?.point
        .y,
    ).toBeCloseTo(2, 9);
  });

  it("picks from an origin inside the map's footprint", () => {
    const t = flatTerrain(16, 16, 8);
    const hit = pickTile({ origin: { x: 8.5, y: 6, z: 8.5 }, direction: { x: 1, y: -1, z: 0 } }, t);
    expect(hit && [hit.x, hit.y]).toEqual([12, 8]);
    expect(hit?.point.x).toBeCloseTo(12.5, 6);
  });
});

describe("rayFromCamera", () => {
  const fov = (40 * Math.PI) / 180;

  it("sends the center ray through the camera target", () => {
    const rig = new CameraRig();
    rig.target = { x: 10.5, y: 2, z: 12.5 };
    const ray = rayFromCamera(rig, 0, 0, 16 / 9, fov);
    const p = rig.position();
    expect(ray.origin).toEqual(p);
    expect(Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z)).toBeCloseTo(1, 9);
    const hit = pickTile(ray, flatTerrain(32, 32, 8));
    expect(hit && [hit.x, hit.y]).toEqual([10, 12]);
    expect(hit?.point.x).toBeCloseTo(10.5, 6);
    expect(hit?.point.z).toBeCloseTo(12.5, 6);
  });

  it("tilts toward the screen edges", () => {
    const rig = new CameraRig();
    rig.yaw = 0;
    rig.pitch = 0.8;
    rig.target = { x: 20, y: 2, z: 20 };
    const center = rayFromCamera(rig, 0, 0, 1, fov);
    const right = rayFromCamera(rig, 1, 0, 1, fov);
    const up = rayFromCamera(rig, 0, 1, 1, fov);
    // Yaw 0: the camera looks along -Z with +X to the right.
    expect(right.direction.x).toBeGreaterThan(center.direction.x);
    expect(right.direction.x).toBeCloseTo(Math.tan(fov / 2) / Math.hypot(1, Math.tan(fov / 2)), 6);
    expect(up.direction.y).toBeGreaterThan(center.direction.y);
    // A wider aspect widens the horizontal spread only.
    const wide = rayFromCamera(rig, 1, 0, 2, fov);
    expect(wide.direction.x).toBeGreaterThan(right.direction.x);
  });

  it("picks the tiles a click lands on, left of center and right of center", () => {
    const rig = new CameraRig();
    rig.yaw = 0;
    rig.pitch = 1.0;
    rig.target = { x: 20.5, y: 2, z: 20.5 };
    const t = flatTerrain(40, 40, 8);
    const left = pickTile(rayFromCamera(rig, -0.5, 0, 1.5, fov), t);
    const right = pickTile(rayFromCamera(rig, 0.5, 0, 1.5, fov), t);
    expect(left && right && left.x < 20 && right.x > 20).toBe(true);
    expect(left?.y).toBe(right?.y);
  });
});

/** Deterministic pseudo-random numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The nearest hit found by testing every triangle of the map, by plane intersection and edge tests. */
function bruteForce(
  o: { x: number; y: number; z: number },
  d: { x: number; y: number; z: number },
  t: TerrainData,
): { x: number; y: number; at: number } | null {
  const tri = new Float64Array(18);
  let best: { x: number; y: number; at: number } | null = null;
  for (let ty = 0; ty < t.height; ty++) {
    for (let tx = 0; tx < t.width; tx++) {
      tileTriangles(t, tx, ty, tri);
      for (const off of [0, 9]) {
        const v = (i: number) =>
          [tri[off + i * 3], tri[off + i * 3 + 1], tri[off + i * 3 + 2]] as [
            number,
            number,
            number,
          ];
        const [a, b, c] = [v(0), v(1), v(2)];
        const sub = (p: number[], q: number[]) =>
          [p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!] as [number, number, number];
        const crs = (p: number[], q: number[]) =>
          [
            p[1]! * q[2]! - p[2]! * q[1]!,
            p[2]! * q[0]! - p[0]! * q[2]!,
            p[0]! * q[1]! - p[1]! * q[0]!,
          ] as [number, number, number];
        const dot = (p: number[], q: number[]) => p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!;
        const n = crs(sub(b, a), sub(c, a));
        const denom = dot(n, [d.x, d.y, d.z]);
        if (Math.abs(denom) < 1e-12) continue;
        const at = dot(n, sub(a, [o.x, o.y, o.z])) / denom;
        if (at < 0) continue;
        const p: [number, number, number] = [o.x + d.x * at, o.y + d.y * at, o.z + d.z * at];
        const inside = [
          [a, b],
          [b, c],
          [c, a],
        ].every(([s, e]) => dot(crs(sub(e!, s!), sub(p, s!)), n) >= -1e-9);
        if (inside && (!best || at < best.at)) best = { x: tx, y: ty, at };
      }
    }
  }
  return best;
}

describe("pickTile against a brute-force search", () => {
  it("agrees on the nearest hit for random rays over random terrain", () => {
    const rand = mulberry32(12345);
    const t = flatTerrain(23, 19, 0);
    for (let i = 0; i < t.corners.length; i++) t.corners[i] = Math.floor(rand() * 24);

    let hits = 0;
    for (let n = 0; n < 600; n++) {
      const origin = { x: rand() * 33 - 5, y: 6 + rand() * 24, z: rand() * 29 - 5 };
      const direction = { x: rand() * 2 - 1, y: -(0.3 + rand()), z: rand() * 2 - 1 };
      const len = Math.hypot(direction.x, direction.y, direction.z);
      const dir = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
      const expected = bruteForce(origin, dir, t);
      const actual = pickTile({ origin, direction: dir }, t);
      if (!expected) {
        expect(actual).toBeNull();
        continue;
      }
      hits++;
      expect(actual).not.toBeNull();
      if (!actual) continue;
      const along = Math.hypot(
        actual.point.x - origin.x,
        actual.point.y - origin.y,
        actual.point.z - origin.z,
      );
      expect(along).toBeCloseTo(expected.at, 6);
      // On a tile boundary two tiles share the hit point, so only check the tile off the boundary.
      const edge = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;
      if (!edge(actual.point.x) && !edge(actual.point.z)) {
        expect([actual.x, actual.y]).toEqual([expected.x, expected.y]);
      }
    }
    expect(hits).toBeGreaterThan(100);
  });
});
