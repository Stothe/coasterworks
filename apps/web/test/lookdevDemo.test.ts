// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDemo } from "../src/lookdev/demo";

describe("the look-dev demo", () => {
  const demo = createDemo(64, 64);
  const kind = (x: number, y: number) => demo.paths[y * 64 + x];

  it("lays a connected network with a plaza and queues, from an entrance on the south edge", () => {
    expect(demo.entrance).toEqual({ x: 32, y: 63, side: 2 });
    expect(kind(32, 63)).toBe(1);
    // The 3 by 3 plaza.
    for (let y = 38; y <= 40; y++) for (let x = 31; x <= 33; x++) expect(kind(x, y)).toBe(1);
    expect(Array.from(demo.paths).filter((k) => k === 2).length).toBeGreaterThan(4);

    // Every path tile can be walked to from the entrance.
    const seen = new Set<number>([63 * 64 + 32]);
    const queue = [63 * 64 + 32];
    while (queue.length > 0) {
      const tile = queue.pop() as number;
      const x = tile % 64;
      const y = (tile - x) / 64;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= 64 || ny >= 64) continue;
        const next = ny * 64 + nx;
        if (!demo.paths[next] || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    expect(seen.size).toBe(Array.from(demo.paths).filter((k) => k !== 0).length);
  });

  it("keeps about 150 guests on the paths as they walk", () => {
    expect(demo.guests.count).toBe(150);
    expect(new Set(demo.guests.id).size).toBe(150);
    for (let step = 0; step < 200; step++) {
      demo.advance(0.05);
      for (let i = 0; i < demo.guests.count; i++) {
        // The tile a guest is on, as the sim reads a position: 32 units to a tile.
        const x = (demo.guests.x[i] as number) >> 5;
        const y = (demo.guests.y[i] as number) >> 5;
        expect(kind(x, y)).toBeGreaterThan(0);
        expect(demo.guests.color[i]).toBeLessThan(9);
      }
    }
  });

  it("moves guests at walking pace", () => {
    const before = Array.from(demo.guests.x, (x, i) => [x, demo.guests.y[i] as number] as const);
    demo.advance(0.05);
    let moved = 0;
    for (let i = 0; i < demo.guests.count; i++) {
      const [x, y] = before[i] as readonly [number, number];
      const d = Math.hypot((demo.guests.x[i] as number) - x, (demo.guests.y[i] as number) - y);
      // Four units in a twentieth of a second, give or take rounding and turning a corner.
      expect(d).toBeLessThanOrEqual(6);
      if (d > 0) moved++;
    }
    expect(moved).toBeGreaterThan(140);
  });

  it("publishes each step as a new section and leaves the last one as it was", () => {
    const walking = createDemo(64, 64);
    const before = walking.guests;
    const x = Array.from(before.x);
    const y = Array.from(before.y);
    walking.advance(0.05);
    const after = walking.guests;
    expect(after).not.toBe(before);
    expect(after.x).not.toBe(before.x);
    expect(after.y).not.toBe(before.y);
    // The section already handed out still says where the guests were.
    expect(Array.from(before.x)).toEqual(x);
    expect(Array.from(before.y)).toEqual(y);
    // The same guests, in the same order, somewhere new.
    expect(Array.from(after.id)).toEqual(Array.from(before.id));
    expect(Array.from(after.x)).not.toEqual(x);
  });

  it("is the same every time", () => {
    const a = createDemo(64, 64);
    const b = createDemo(64, 64);
    a.advance(3);
    b.advance(3);
    expect(Array.from(a.guests.x)).toEqual(Array.from(b.guests.x));
    expect(Array.from(a.paths)).toEqual(Array.from(b.paths));
  });

  it("has no guests on a map too small to hold any of the paths", () => {
    expect(createDemo(4, 4).guests.count).toBe(0);
  });
});
