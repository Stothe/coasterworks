import { describe, expect, it } from "vitest";
import { MAX_HEIGHT, createSamplePark, hashWorld } from "../src/index.js";

/** Corner height of a freshly created world; the hill must stand this many steps above it. */
const GROUND = 8;

function waterTiles(water: Uint8Array): number {
  let n = 0;
  for (const level of water) if (level > 0) n++;
  return n;
}

describe("createSamplePark", () => {
  const world = createSamplePark(7);

  it("is a 64 by 64 park called Leafy Lake with $10,000.00 in the bank", () => {
    expect(world.terrain.width).toBe(64);
    expect(world.terrain.height).toBe(64);
    expect(world.meta.name).toBe("Leafy Lake");
    expect(world.meta.seed).toBe(7);
    expect(world.finance.cash).toBe(10_000_00);
    expect(world.finance.monthStart.cash).toBe(10_000_00);
    expect(world.finance.loan).toBe(0);
    expect(world.tick).toBe(0);
  });

  it("has a hill at least 14 steps above the ground, near tile (18, 14)", () => {
    const { corners, width } = world.terrain;
    const peak = Math.max(...corners);
    expect(peak).toBeGreaterThanOrEqual(GROUND + 14);
    expect(peak).toBeLessThanOrEqual(MAX_HEIGHT);

    const at = corners.indexOf(peak);
    const px = at % (width + 1);
    const py = Math.floor(at / (width + 1));
    expect(Math.abs(px - 18)).toBeLessThanOrEqual(4);
    expect(Math.abs(py - 14)).toBeLessThanOrEqual(4);
  });

  it("has a pond of at least 24 water tiles, with sand around it and rock on the hill", () => {
    const { water, surface } = world.terrain;
    expect(waterTiles(water)).toBeGreaterThanOrEqual(24);
    expect(surface.includes(1)).toBe(true);
    expect(surface.includes(3)).toBe(true);
  });

  it("puts every water tile above the ground under it", () => {
    const { water, corners, width, height } = world.terrain;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const level = water[y * width + x] as number;
        if (level === 0) continue;
        const lowest = Math.min(
          corners[y * (width + 1) + x] as number,
          corners[y * (width + 1) + x + 1] as number,
          corners[(y + 1) * (width + 1) + x] as number,
          corners[(y + 1) * (width + 1) + x + 1] as number,
        );
        expect(level).toBeGreaterThan(lowest);
      }
    }
  });

  it("was shaped through commands as the system, so the log is not empty", () => {
    expect(world.log.length).toBeGreaterThan(0);
    for (const entry of world.log) {
      expect(entry.client).toBe("system");
      expect(entry.name.startsWith("terrain_")).toBe(true);
    }
  });

  it("cannot be undone away: the player starts with a clean slate", () => {
    expect(world.undoStack).toEqual([]);
    expect(world.redoStack).toEqual([]);
  });

  it("is the same park for the same seed, and a different one for another", () => {
    expect(hashWorld(createSamplePark(7))).toBe(hashWorld(world));
    expect(hashWorld(createSamplePark(8))).not.toBe(hashWorld(world));
  });

  it("works for any seed", () => {
    for (const seed of [0, 1, 99, 123456, 2 ** 31 - 1]) {
      const park = createSamplePark(seed);
      expect(Math.max(...park.terrain.corners)).toBeGreaterThanOrEqual(GROUND + 14);
      expect(waterTiles(park.terrain.water)).toBeGreaterThanOrEqual(24);
      expect(park.finance.cash).toBe(10_000_00);
    }
  });
});
