import { describe, expect, it } from "vitest";
import { buildGateGeometry, GATE } from "../src/entrance.js";

// The entrance module's own data helper: the gate as plain arrays. No other module's tests live
// in this file.

describe("buildGateGeometry", () => {
  const gate = buildGateGeometry();
  const vertexCount = gate.positions.length / 3;
  const at = (array: Float32Array, i: number, size = 3): number[] =>
    Array.from(array.subarray(i * size, i * size + size));

  it("has one entry per vertex in every array, and indices that fit", () => {
    expect(vertexCount).toBeGreaterThan(1000);
    expect(vertexCount).toBeLessThan(65536);
    expect(gate.normals.length).toBe(vertexCount * 3);
    expect(gate.colors.length).toBe(vertexCount * 3);
    expect(gate.fx.length).toBe(vertexCount * 4);
    expect(gate.indices.length).toBe(gate.triangleCount * 3);
    let highest = 0;
    for (const index of gate.indices) highest = Math.max(highest, index);
    expect(highest).toBe(vertexCount - 1);
    // A gate, not a city: a few thousand triangles.
    expect(gate.triangleCount).toBeLessThan(8000);
  });

  it("stands on the ground, reaches below it, and is the same on both sides", () => {
    let low = Infinity;
    let high = -Infinity;
    let left = Infinity;
    let right = -Infinity;
    let front = -Infinity;
    let back = Infinity;
    for (let v = 0; v < vertexCount; v++) {
      const [x, y, z] = at(gate.positions, v) as [number, number, number];
      low = Math.min(low, y);
      high = Math.max(high, y);
      // Flags fly one way; leave them out of the comparison of the two sides.
      if ((gate.fx[v * 4 + 1] as number) < 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      front = Math.max(front, z);
      back = Math.min(back, z);
    }
    expect(low).toBeCloseTo(-GATE.footing, 6);
    expect(high).toBeGreaterThan(GATE.poleTop);
    expect(high).toBeLessThan(GATE.poleTop + 0.1);
    expect(left).toBeCloseTo(-right, 5);
    expect(front).toBeCloseTo(-back, 5);
    // The towers leave the 0.8 wide path between them clear.
    expect(right).toBeGreaterThan(GATE.towerX);
    expect(right).toBeLessThan(1);
  });

  it("leaves the way through clear for the height of two guests", () => {
    for (let v = 0; v < vertexCount; v++) {
      const [x, y] = at(gate.positions, v) as [number, number, number];
      if (Math.abs(x) < 0.45 && y > 0) expect(y).toBeGreaterThan(0.9);
    }
  });

  it("has unit normals and plausible colors", () => {
    let shortest = Infinity;
    let longest = 0;
    let brightest = 0;
    let darkest = Infinity;
    for (let v = 0; v < vertexCount; v++) {
      const [nx, ny, nz] = at(gate.normals, v) as [number, number, number];
      const length = Math.hypot(nx, ny, nz);
      shortest = Math.min(shortest, length);
      longest = Math.max(longest, length);
      for (const channel of at(gate.colors, v)) {
        brightest = Math.max(brightest, channel);
        darkest = Math.min(darkest, channel);
      }
    }
    expect(shortest).toBeCloseTo(1, 5);
    expect(longest).toBeCloseTo(1, 5);
    // Nothing brighter than white paint.
    expect(brightest).toBeLessThanOrEqual(0.8);
    expect(darkest).toBeGreaterThanOrEqual(0);
  });

  it("winds every triangle to face the way its normals point, and has none without area", () => {
    for (let t = 0; t < gate.indices.length; t += 3) {
      const a = gate.indices[t] as number;
      const b = gate.indices[t + 1] as number;
      const c = gate.indices[t + 2] as number;
      const pa = at(gate.positions, a) as [number, number, number];
      const pb = at(gate.positions, b) as [number, number, number];
      const pc = at(gate.positions, c) as [number, number, number];
      const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]] as const;
      const w = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]] as const;
      const face = [
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
      ] as const;
      const area = Math.hypot(face[0], face[1], face[2]);
      let agree = 0;
      for (const i of [a, b, c]) {
        const n = at(gate.normals, i) as [number, number, number];
        agree += face[0] * n[0] + face[1] * n[1] + face[2] * n[2];
      }
      if (!(area > 0) || !(agree >= 0)) {
        expect.fail(`triangle ${t / 3} has area ${area} and agreement ${agree}`);
      }
    }
  });

  it("marks flags, bulbs and the sign's faces for the shader, and nothing else", () => {
    let flags = 0;
    let signs = 0;
    const bulbs = new Set<number>();
    for (let v = 0; v < vertexCount; v++) {
      const [along, kind, s, t] = at(gate.fx, v, 4) as [number, number, number, number];
      const [x, y, z] = at(gate.positions, v) as [number, number, number];
      if (kind < 0) {
        // A flag: flat in the plane of the gate, above the roofs, 0 at the pole to 1 at the tip.
        flags++;
        expect(along).toBeGreaterThanOrEqual(0);
        expect(along).toBeLessThanOrEqual(1);
        expect(Math.abs(t)).toBeLessThanOrEqual(1);
        expect(z).toBe(0);
        expect(y).toBeGreaterThan(GATE.roofTop);
        expect(s).toBe(-100);
      } else {
        expect(along).toBe(0);
        if (kind > 0) bulbs.add(kind);
        if (s > -50) {
          // On the sign: within its length and height, on one of its two faces.
          signs++;
          expect(Math.abs(s)).toBeLessThanOrEqual(GATE.signLength / 2 + 1e-6);
          expect(t).toBeGreaterThanOrEqual(-1e-6);
          expect(t).toBeLessThanOrEqual(GATE.signHeight + 1e-6);
          expect(Math.abs(z)).toBeCloseTo(GATE.signDepth / 2, 6);
          expect(Math.abs(x)).toBeLessThan(GATE.towerX);
        }
      }
    }
    expect(flags).toBeGreaterThan(50);
    expect(signs).toBeGreaterThan(100);
    // The bulbs are numbered 1 to n round the sign, an even number of them.
    expect(bulbs.size).toBeGreaterThanOrEqual(16);
    expect(bulbs.size % 2).toBe(0);
    expect(Math.min(...bulbs)).toBe(1);
    expect(Math.max(...bulbs)).toBe(bulbs.size);
  });

  it("gives the same gate every time", () => {
    const again = buildGateGeometry();
    expect(Array.from(again.positions)).toEqual(Array.from(gate.positions));
    expect(Array.from(again.indices)).toEqual(Array.from(gate.indices));
  });
});
