import { describe, expect, it } from "vitest";
import type { EntrancePlace } from "../src/context.js";
import {
  END_LENGTH,
  GATE_MARGIN,
  HEDGE_HALF_WIDTH,
  HEDGE_HEIGHT,
  HEDGE_OFFSET,
  buildHedge,
  hedgeRuns,
} from "../src/scenery/boundary.js";
import { LAND_REACH, distanceOutside } from "../src/scenery/land.js";
import { fbm2, hash01, noise2, noise3, randomStream } from "../src/scenery/noise.js";
import {
  LANE_HALF_WIDTH,
  LANE_LENGTH,
  SMALL_MARGIN,
  SMALL_REACH,
  TREE_MARGIN,
  onLane,
  scatterScenery,
  woodedAt,
} from "../src/scenery/scatter.js";
import {
  BIRCH,
  BUSH,
  KIND_COUNT,
  LOD_COUNT,
  OAK,
  ROCK,
  SHAPE_HEIGHT,
  SPRUCE,
  VARIANTS,
  buildSceneryShape,
  geodesicSphere,
  type SceneryKind,
  type SceneryLod,
  type SceneryShape,
} from "../src/scenery/shapes.js";

// What stands on the land beyond the park: the noise it is all made from, the models, where they
// are scattered, and the hedge along the park's edge.

describe("scenery noise", () => {
  it("is the same every time and stays in range", () => {
    expect(hash01(3, -7, 11)).toBe(hash01(3, -7, 11));
    expect(hash01(3, -7, 11)).not.toBe(hash01(4, -7, 11));
    const stream = randomStream(42);
    const again = randomStream(42);
    for (let i = 0; i < 50; i++) {
      const value = stream();
      expect(value).toBe(again());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    for (let i = 0; i < 400; i++) {
      const x = i * 0.37 - 60;
      const z = i * 0.91 + 13;
      expect(Math.abs(noise2(x, z, 5))).toBeLessThanOrEqual(1.05);
      expect(Math.abs(fbm2(x, z, 3, 5))).toBeLessThanOrEqual(1.05);
      expect(Math.abs(noise3(x, z * 0.3, z, 5))).toBeLessThanOrEqual(1.05);
    }
  });

  it("is smooth: a small step changes it a little", () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.613 - 40;
      const z = i * 0.271 + 7;
      expect(Math.abs(noise2(x + 0.01, z, 9) - noise2(x, z, 9))).toBeLessThan(0.06);
    }
  });
});

function eachShape(visit: (shape: SceneryShape, kind: SceneryKind, lod: SceneryLod) => void) {
  for (let kind = 0; kind < KIND_COUNT; kind++) {
    for (let lod = 0; lod < LOD_COUNT; lod++) {
      const variants = (VARIANTS[kind] as readonly number[])[lod] as number;
      for (let variant = 0; variant < variants; variant++) {
        visit(
          buildSceneryShape(kind as SceneryKind, variant, lod as SceneryLod),
          kind as SceneryKind,
          lod as SceneryLod,
        );
      }
    }
  }
}

describe("geodesicSphere", () => {
  it("is a closed ball of unit directions with 20 times the frequency squared triangles", () => {
    for (const frequency of [1, 2, 5]) {
      const sphere = geodesicSphere(frequency);
      const count = sphere.directions.length / 3;
      expect(sphere.indices.length / 3).toBe(20 * frequency * frequency);
      // Euler: a closed ball has two more vertices than half its triangles.
      expect(count).toBe(10 * frequency * frequency + 2);
      for (let v = 0; v < count; v++) {
        expect(
          Math.hypot(
            sphere.directions[v * 3] as number,
            sphere.directions[v * 3 + 1] as number,
            sphere.directions[v * 3 + 2] as number,
          ),
        ).toBeCloseTo(1, 10);
      }
      // Every triangle faces outward.
      for (let i = 0; i < sphere.indices.length; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => {
          const v = (sphere.indices[i + k] as number) * 3;
          return [sphere.directions[v], sphere.directions[v + 1], sphere.directions[v + 2]] as [
            number,
            number,
            number,
          ];
        }) as [[number, number, number], [number, number, number], [number, number, number]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
        const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        expect(
          (n[0] as number) * a[0] + (n[1] as number) * a[1] + (n[2] as number) * a[2],
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("buildSceneryShape", () => {
  it("gives every model whole, finite vertex data and unit normals", () => {
    eachShape((shape) => {
      const count = shape.positions.length / 3;
      expect(count).toBeGreaterThan(3);
      expect(shape.normals.length).toBe(count * 3);
      expect(shape.colors.length).toBe(count * 3);
      expect(shape.aux.length).toBe(count * 3);
      expect(shape.indices.length % 3).toBe(0);
      for (const index of shape.indices) expect(index).toBeLessThan(count);
      for (const value of shape.positions) expect(Number.isFinite(value)).toBe(true);
      for (let v = 0; v < count; v++) {
        expect(
          Math.hypot(
            shape.normals[v * 3] as number,
            shape.normals[v * 3 + 1] as number,
            shape.normals[v * 3 + 2] as number,
          ),
        ).toBeCloseTo(1, 4);
      }
    });
  });

  it("keeps colors in a plausible range for leaves, bark and stone, and aux in 0..1", () => {
    eachShape((shape) => {
      for (const value of shape.colors) {
        expect(value).toBeGreaterThanOrEqual(0);
        // Nothing out here is brighter than pale birch bark.
        expect(value).toBeLessThanOrEqual(0.6);
      }
      for (const value of shape.aux) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });
  });

  it("stands each model on the origin, about as tall as it says, and rooted below ground", () => {
    eachShape((shape, kind, lod) => {
      let low = Infinity;
      let high = -Infinity;
      let reach = 0;
      for (let v = 0; v < shape.positions.length; v += 3) {
        low = Math.min(low, shape.positions[v + 1] as number);
        high = Math.max(high, shape.positions[v + 1] as number);
        reach = Math.max(
          reach,
          Math.hypot(shape.positions[v] as number, shape.positions[v + 2] as number),
        );
      }
      const tall = SHAPE_HEIGHT[kind] as number;
      expect(high).toBeGreaterThan(tall * 0.75);
      expect(high).toBeLessThan(tall * 1.2);
      expect(low).toBeLessThan(0.3);
      // A tree with a trunk has its foot in the ground.
      if (kind <= SPRUCE && lod <= 2) expect(low).toBeLessThan(-0.1);
      // No canopy is wider than the room trees are given by the park's edge.
      expect(reach).toBeLessThan(TREE_MARGIN * 0.7);
    });
  });

  it("does not sway at the foot and sways most at the top", () => {
    for (const kind of [OAK, BIRCH, SPRUCE] as const) {
      const shape = buildSceneryShape(kind, 0, 0);
      let top = 0;
      let topSway = 0;
      for (let v = 0; v < shape.positions.length / 3; v++) {
        const y = shape.positions[v * 3 + 1] as number;
        const sway = shape.aux[v * 3] as number;
        if (y <= 0) expect(sway).toBe(0);
        if (y > top) {
          top = y;
          topSway = sway;
        }
      }
      expect(topSway).toBeGreaterThan(0.85);
    }
    const rock = buildSceneryShape(ROCK, 0, 0);
    for (let v = 0; v < rock.aux.length; v += 3) expect(rock.aux[v]).toBe(0);
  });

  it("is the same model every time, and spends fewer triangles the further away it is meant for", () => {
    expect(buildSceneryShape(OAK, 1, 0).positions).toEqual(buildSceneryShape(OAK, 1, 0).positions);
    for (const kind of [OAK, BIRCH, SPRUCE] as const) {
      const triangles = [0, 1, 2, 3].map(
        (lod) => buildSceneryShape(kind, 0, lod as SceneryLod).indices.length / 3,
      );
      expect(triangles[0]).toBeLessThan(2400);
      expect(triangles[1]).toBeLessThan(650);
      expect(triangles[2]).toBeLessThan(200);
      expect(triangles[3]).toBeLessThanOrEqual(30);
      for (let lod = 1; lod < 4; lod++) {
        expect(triangles[lod]).toBeLessThan(triangles[lod - 1] as number);
      }
    }
    expect(buildSceneryShape(BUSH, 0, 0).indices.length / 3).toBeLessThanOrEqual(600);
    expect(buildSceneryShape(ROCK, 0, 0).indices.length / 3).toBeLessThanOrEqual(320);
  });
});

describe("scatterScenery", () => {
  const scatter = scatterScenery(64, 64);

  it("is the same scatter every time", () => {
    const again = scatterScenery(64, 64);
    expect(again.count).toBe(scatter.count);
    expect(again.x).toEqual(scatter.x);
    expect(again.z).toEqual(scatter.z);
    expect(again.kind).toEqual(scatter.kind);
    expect(again.tint).toEqual(scatter.tint);
  });

  it("puts nothing in the park, nothing too near its edge and nothing beyond the reach", () => {
    for (let i = 0; i < scatter.count; i++) {
      const x = scatter.x[i] as number;
      const z = scatter.z[i] as number;
      const d = distanceOutside(64, 64, x, z);
      expect(d).toBeCloseTo(scatter.distance[i] as number, 4);
      const small = scatter.kind[i] === BUSH || scatter.kind[i] === ROCK;
      expect(d).toBeGreaterThanOrEqual(small ? SMALL_MARGIN : TREE_MARGIN);
      expect(d).toBeLessThanOrEqual(small ? SMALL_REACH : LAND_REACH);
    }
  });

  it("stays within its budget", () => {
    // Trees within 30 tiles of the park are the near band (drawn finest); the rest is forest.
    let near = 0;
    let far = 0;
    for (let i = 0; i < scatter.count; i++) {
      if ((scatter.distance[i] as number) < 30) near++;
      else far++;
    }
    expect(near).toBeLessThan(3500);
    expect(far).toBeLessThan(25000);
    // And there is a forest out there.
    expect(far).toBeGreaterThan(3000);
  });

  it("is sparse near the park and dense far out", () => {
    const trees = (from: number, to: number) => {
      let count = 0;
      for (let i = 0; i < scatter.count; i++) {
        const d = scatter.distance[i] as number;
        if ((scatter.kind[i] as number) <= SPRUCE && d >= from && d < to) count++;
      }
      const area = 2 * (64 + 64) * (to - from) + Math.PI * (to * to - from * from);
      return count / area;
    };
    const nearDensity = trees(TREE_MARGIN, 14);
    const midDensity = trees(30, 60);
    expect(nearDensity).toBeGreaterThan(0.004);
    expect(midDensity).toBeGreaterThan(nearDensity * 2);
    expect(woodedAt(300, 300, 10)).toBeGreaterThanOrEqual(0);
    expect(woodedAt(300, 300, 10)).toBeLessThanOrEqual(1);
  });

  it("stands trees in clumps with clearings between, not evenly", () => {
    // Count trees in 12-tile squares across a band of the mid distance: some squares are full
    // and some nearly empty.
    const cells = new Map<string, number>();
    for (let i = 0; i < scatter.count; i++) {
      const d = scatter.distance[i] as number;
      if ((scatter.kind[i] as number) > SPRUCE || d < 20 || d > 60) continue;
      const key = `${Math.floor((scatter.x[i] as number) / 12)},${Math.floor((scatter.z[i] as number) / 12)}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    const counts = [...cells.values()].sort((a, b) => a - b);
    const low = counts[Math.floor(counts.length * 0.15)] as number;
    const high = counts[Math.floor(counts.length * 0.85)] as number;
    expect(high).toBeGreaterThan(low * 3);
  });

  it("has all three kinds of tree, bushes and rocks, with tints near one", () => {
    const perKind = new Array<number>(KIND_COUNT).fill(0);
    for (let i = 0; i < scatter.count; i++) perKind[scatter.kind[i] as number]!++;
    for (const count of perKind) expect(count).toBeGreaterThan(20);
    for (const value of scatter.tint) {
      expect(value).toBeGreaterThan(0.5);
      expect(value).toBeLessThan(1.5);
    }
    for (const value of scatter.rank) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("onLane", () => {
  const south: EntrancePlace = { x: 31, y: 63, side: 2 };

  it("covers the way out from the entrance and nothing else", () => {
    expect(onLane(64, 64, south, 31.5, 66)).toBe(true);
    expect(onLane(64, 64, south, 31.5 + LANE_HALF_WIDTH - 0.1, 65)).toBe(true);
    expect(onLane(64, 64, south, 31.5 + LANE_HALF_WIDTH + 0.1, 65)).toBe(false);
    expect(onLane(64, 64, south, 31.5, 64 + LANE_LENGTH + 1)).toBe(false);
    // Not on the other sides of the park.
    expect(onLane(64, 64, south, 31.5, -3)).toBe(false);
    expect(onLane(64, 64, south, 66, 31.5)).toBe(false);
    expect(onLane(64, 64, null, 31.5, 66)).toBe(false);
  });

  it("follows the entrance to whichever side it is on", () => {
    expect(onLane(64, 64, { x: 10, y: 0, side: 0 }, 10.5, -5)).toBe(true);
    expect(onLane(64, 64, { x: 63, y: 20, side: 1 }, 70, 20.5)).toBe(true);
    expect(onLane(64, 64, { x: 0, y: 40, side: 3 }, -4, 40.5)).toBe(true);
    expect(onLane(64, 64, { x: 0, y: 40, side: 3 }, -4, 20)).toBe(false);
  });

  it("narrows further out", () => {
    const wide = LANE_HALF_WIDTH - 0.2;
    expect(onLane(64, 64, south, 31.5 + wide, 64 + 2)).toBe(true);
    expect(onLane(64, 64, south, 31.5 + wide, 64 + LANE_LENGTH - 1)).toBe(false);
  });
});

describe("buildHedge", () => {
  const level = () => 2;
  const south: EntrancePlace = { x: 5, y: 9, side: 2 };

  it("runs once round the park, just outside it", () => {
    const runs = hedgeRuns(12, 10, null);
    expect(runs.length).toBe(1);
    expect(runs[0]?.closed).toBe(true);
    for (const station of runs[0]?.stations ?? []) {
      expect(distanceOutside(12, 10, station.x, station.z)).toBeCloseTo(HEDGE_OFFSET, 10);
      expect(Math.hypot(station.tx, station.tz)).toBeCloseTo(1, 10);
    }
  });

  it("keeps every vertex outside the park and no higher than a hedge", () => {
    const hedge = buildHedge(12, 10, level, south);
    if (!hedge) throw new Error("no hedge");
    for (let v = 0; v < hedge.positions.length; v += 3) {
      const x = hedge.positions[v] as number;
      const y = hedge.positions[v + 1] as number;
      const z = hedge.positions[v + 2] as number;
      const d = distanceOutside(12, 10, x, z);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(HEDGE_OFFSET + HEDGE_HALF_WIDTH * 1.3);
      expect(y).toBeLessThan(2 + HEDGE_HEIGHT * 1.3);
      expect(y).toBeGreaterThan(2 - HEDGE_HEIGHT);
    }
  });

  it("leaves the entrance open and is whole everywhere else", () => {
    const runs = hedgeRuns(12, 10, south);
    expect(runs.length).toBe(1);
    expect(runs[0]?.closed).toBe(false);
    const stations = runs[0]?.stations ?? [];
    // The run starts on the west side of the gap and ends on the east side of it, having gone
    // round the park the long way.
    const first = stations[0];
    const last = stations[stations.length - 1];
    expect(first?.z).toBeCloseTo(10 + HEDGE_OFFSET, 10);
    expect(first?.x).toBeCloseTo(5 - GATE_MARGIN - END_LENGTH, 10);
    expect(last?.x).toBeCloseTo(6 + GATE_MARGIN + END_LENGTH, 10);
    expect(stations.length).toBeGreaterThan((12 + 10) * 2 * 4 - 8);

    const hedge = buildHedge(12, 10, level, south);
    if (!hedge) throw new Error("no hedge");
    for (let v = 0; v < hedge.positions.length; v += 3) {
      const x = hedge.positions[v] as number;
      const z = hedge.positions[v + 2] as number;
      // Nothing of it stands across the entrance tile's width on the south side.
      if (z > 10) expect(x <= 5 || x >= 6).toBe(true);
    }
  });

  it("opens on any side, and copes with a gate on a corner tile", () => {
    for (const entrance of [
      { x: 3, y: 0, side: 0 },
      { x: 11, y: 4, side: 1 },
      { x: 0, y: 7, side: 3 },
      { x: 0, y: 9, side: 2 },
      { x: 11, y: 9, side: 2 },
    ] as EntrancePlace[]) {
      const runs = hedgeRuns(12, 10, entrance);
      expect(runs.length).toBe(1);
      expect(runs[0]?.closed).toBe(false);
      const hedge = buildHedge(12, 10, level, entrance);
      expect(hedge?.indices.length).toBeGreaterThan(0);
      for (const value of hedge?.normals ?? []) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("follows the ground it stands on", () => {
    const sloping = (x: number, z: number) => 2 + 0.1 * x + 0.05 * z;
    const hedge = buildHedge(12, 10, sloping, null);
    if (!hedge) throw new Error("no hedge");
    for (let v = 0; v < hedge.positions.length; v += 3) {
      const x = hedge.positions[v] as number;
      const y = hedge.positions[v + 1] as number;
      const z = hedge.positions[v + 2] as number;
      const ground = sloping(x, z);
      expect(y).toBeGreaterThan(ground - HEDGE_HEIGHT * 0.5);
      expect(y).toBeLessThan(ground + HEDGE_HEIGHT * 1.35);
    }
  });

  it("has outward-facing sides", () => {
    const hedge = buildHedge(12, 10, level, null);
    if (!hedge) throw new Error("no hedge");
    let outward = 0;
    let total = 0;
    for (let v = 0; v < hedge.positions.length; v += 3) {
      const x = hedge.positions[v] as number;
      const z = hedge.positions[v + 2] as number;
      // Vertices on the north run, outer face: their normals point north (-Z).
      if (z < -HEDGE_OFFSET - HEDGE_HALF_WIDTH * 0.9 && x > 1 && x < 11) {
        total++;
        if ((hedge.normals[v + 2] as number) < 0) outward++;
      }
    }
    expect(total).toBeGreaterThan(10);
    expect(outward).toBe(total);
  });
});
