// @vitest-environment node
import type { TerrainData } from "@coasterworks/render";
import { describe, expect, it } from "vitest";
import {
  brushRect,
  lowestCorner,
  planCommand,
  planPlacement,
  timeOfDay,
} from "../src/viewport/brush";

const none = { shift: false, alt: false };

function flat(width: number, height: number, level = 8): TerrainData {
  return {
    width,
    height,
    corners: new Int16Array((width + 1) * (height + 1)).fill(level),
    surface: new Uint8Array(width * height),
    water: new Uint8Array(width * height),
  };
}

describe("brushRect", () => {
  it("covers just the tile for size 1, and centers sizes 2 and 3 on it", () => {
    expect(brushRect(10, 20, 1, 64, 64)).toEqual({ x: 10, y: 20, w: 1, h: 1 });
    // An even brush leans toward the lower side: x - floor((2 - 1) / 2) = x.
    expect(brushRect(10, 20, 2, 64, 64)).toEqual({ x: 10, y: 20, w: 2, h: 2 });
    expect(brushRect(10, 20, 3, 64, 64)).toEqual({ x: 9, y: 19, w: 3, h: 3 });
  });

  it("shrinks at the west and north edges instead of going off the map", () => {
    expect(brushRect(0, 0, 3, 64, 64)).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(brushRect(0, 5, 3, 64, 64)).toEqual({ x: 0, y: 4, w: 2, h: 3 });
    expect(brushRect(5, 0, 3, 64, 64)).toEqual({ x: 4, y: 0, w: 3, h: 2 });
  });

  it("shrinks at the east and south edges", () => {
    expect(brushRect(63, 63, 3, 64, 64)).toEqual({ x: 62, y: 62, w: 2, h: 2 });
    expect(brushRect(63, 63, 2, 64, 64)).toEqual({ x: 63, y: 63, w: 1, h: 1 });
    expect(brushRect(63, 10, 3, 64, 64)).toEqual({ x: 62, y: 9, w: 2, h: 3 });
    expect(brushRect(10, 63, 3, 64, 64)).toEqual({ x: 9, y: 62, w: 3, h: 2 });
  });

  it("works on maps that are not square", () => {
    expect(brushRect(31, 7, 3, 32, 8)).toEqual({ x: 30, y: 6, w: 2, h: 2 });
  });

  it("is null when no part of the brush is on the map", () => {
    expect(brushRect(-3, 0, 3, 64, 64)).toBeNull();
    expect(brushRect(0, 70, 1, 64, 64)).toBeNull();
    expect(brushRect(64, 0, 1, 64, 64)).toBeNull();
  });

  it("never returns a rectangle that is not wholly on the map", () => {
    for (let size = 1; size <= 3; size++) {
      for (let y = -2; y < 10; y++) {
        for (let x = -2; x < 10; x++) {
          const r = brushRect(x, y, size, 8, 6);
          if (!r) continue;
          expect(r.w).toBeGreaterThanOrEqual(1);
          expect(r.h).toBeGreaterThanOrEqual(1);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(8);
          expect(r.y + r.h).toBeLessThanOrEqual(6);
        }
      }
    }
  });
});

describe("lowestCorner", () => {
  it("is the lowest of the tile's four corners", () => {
    const t = flat(4, 4);
    // Tile (1, 2) has corners (1,2) (2,2) (1,3) (2,3), row stride 5.
    t.corners[2 * 5 + 2] = 5;
    t.corners[3 * 5 + 1] = 11;
    expect(lowestCorner(t, 1, 2)).toBe(5);
    expect(lowestCorner(t, 0, 0)).toBe(8);
    expect(lowestCorner(t, 3, 3)).toBe(8);
  });
});

describe("planCommand", () => {
  const terrain = flat(8, 8);

  it("raises and lowers the brush rectangle", () => {
    expect(planCommand("raise", none, 3, 3, 2, terrain)).toEqual({
      name: "terrain_raise",
      input: { x: 3, y: 3, w: 2, h: 2 },
    });
    expect(planCommand("lower", none, 3, 3, 3, terrain)).toEqual({
      name: "terrain_lower",
      input: { x: 2, y: 2, w: 3, h: 3 },
    });
  });

  it("flips raise and lower with shift", () => {
    expect(planCommand("raise", { shift: true, alt: false }, 1, 1, 1, terrain)?.name).toBe(
      "terrain_lower",
    );
    expect(planCommand("lower", { shift: true, alt: false }, 1, 1, 1, terrain)?.name).toBe(
      "terrain_raise",
    );
  });

  it("levels to the clicked tile's lowest corner", () => {
    const t = flat(8, 8);
    t.corners[3 * 9 + 3] = 5;
    expect(planCommand("level", none, 3, 3, 1, t)).toEqual({
      name: "terrain_level",
      input: { x: 3, y: 3, w: 1, h: 1, height: 5 },
    });
  });

  it("fills water two steps above the clicked tile's lowest corner, and drains with alt", () => {
    expect(planCommand("water", none, 2, 2, 2, terrain)).toEqual({
      name: "terrain_set_water",
      input: { x: 2, y: 2, w: 2, h: 2, level: 10 },
    });
    expect(planCommand("water", { shift: false, alt: true }, 2, 2, 2, terrain)).toEqual({
      name: "terrain_set_water",
      input: { x: 2, y: 2, w: 2, h: 2, level: 0 },
    });
  });

  it("holds the water level to the highest height the sim accepts", () => {
    const high = flat(4, 4, 62);
    expect(planCommand("water", none, 1, 1, 1, high)?.input.level).toBe(63);
  });

  it("clamps a brush at the edge, and sends nothing when the click is off the map", () => {
    expect(planCommand("raise", none, 7, 7, 3, terrain)?.input).toEqual({
      x: 6,
      y: 6,
      w: 2,
      h: 2,
    });
    expect(planCommand("raise", none, 8, 3, 1, terrain)).toBeNull();
    expect(planCommand("water", none, -1, -1, 1, terrain)).toBeNull();
  });
});

describe("timeOfDay", () => {
  const cycle = 400 * 31;

  it("opens a fresh park mid-morning rather than at night", () => {
    expect(timeOfDay(0)).toBeCloseTo(0.3, 10);
  });

  it("runs once around per month of ticks, 0 to 1, and starts again", () => {
    expect(timeOfDay(cycle / 2)).toBeCloseTo(0.8, 10);
    // 0.7 of the way in, the offset day has gone all the way round.
    expect(timeOfDay((cycle * 7) / 10)).toBeCloseTo(0, 10);
    expect(timeOfDay((cycle * 7) / 10 + cycle / 4)).toBeCloseTo(0.25, 10);
    expect(timeOfDay(cycle)).toBeCloseTo(timeOfDay(0), 10);
    expect(timeOfDay(cycle * 5 + 123)).toBeCloseTo(timeOfDay(123), 10);
  });

  it("stays from 0 up to but not including 1", () => {
    for (const tick of [0, 1, 1234, (cycle * 7) / 10 - 1, (cycle * 7) / 10, cycle - 1, cycle]) {
      const t = timeOfDay(tick);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
    }
  });
});

describe("planPlacement", () => {
  const terrain = flat(16, 16, 4);

  it("clicks a raise placement into terrain_raise over the brush, with its defaults", () => {
    const plan = planPlacement(
      { command: "terrain_raise", defaults: { steps: 2 }, size: 2 },
      none,
      5,
      6,
      terrain,
    );
    expect(plan).toEqual({ name: "terrain_raise", input: { x: 5, y: 6, w: 2, h: 2, steps: 2 } });
  });

  it("fills in the height of a level placement and the level of a water one from the tile", () => {
    expect(
      planPlacement({ command: "terrain_level", defaults: {}, size: 1 }, none, 3, 3, terrain),
    ).toEqual({ name: "terrain_level", input: { x: 3, y: 3, w: 1, h: 1, height: 4 } });
    expect(
      planPlacement({ command: "terrain_set_water", defaults: {}, size: 1 }, none, 3, 3, terrain),
    ).toEqual({ name: "terrain_set_water", input: { x: 3, y: 3, w: 1, h: 1, level: 6 } });
  });

  it("prefers what the placement gives to what it would work out", () => {
    const plan = planPlacement(
      { command: "terrain_level", defaults: { height: 9 }, size: 1 },
      none,
      3,
      3,
      terrain,
    );
    expect(plan?.input["height"]).toBe(9);
  });

  it("never lets the defaults move the area the player clicked", () => {
    const plan = planPlacement(
      { command: "terrain_raise", defaults: { x: 0, y: 0, w: 9, h: 9 }, size: 1 },
      none,
      5,
      6,
      terrain,
    );
    expect(plan?.input).toMatchObject({ x: 5, y: 6, w: 1, h: 1 });
  });

  it("honors Shift and Alt as the terrain bar does", () => {
    const shift = { shift: true, alt: false };
    expect(
      planPlacement({ command: "terrain_raise", defaults: {}, size: 1 }, shift, 3, 3, terrain)
        ?.name,
    ).toBe("terrain_lower");
    const alt = { shift: false, alt: true };
    expect(
      planPlacement({ command: "terrain_set_water", defaults: {}, size: 1 }, alt, 3, 3, terrain)
        ?.input["level"],
    ).toBe(0);
  });

  it("places any other command over the brush with its defaults, and nothing else of its own", () => {
    expect(
      planPlacement(
        { command: "terrain_set_surface", defaults: { surface: 2 }, size: 3 },
        none,
        5,
        5,
        terrain,
      ),
    ).toEqual({ name: "terrain_set_surface", input: { x: 4, y: 4, w: 3, h: 3, surface: 2 } });
    expect(
      planPlacement(
        { command: "ride_build", defaults: { kind: "carousel" }, size: 1 },
        none,
        0,
        0,
        terrain,
      ),
    ).toEqual({ name: "ride_build", input: { x: 0, y: 0, w: 1, h: 1, kind: "carousel" } });
  });

  it("is null when the brush is off the map", () => {
    expect(
      planPlacement({ command: "terrain_raise", defaults: {}, size: 1 }, none, 40, 40, terrain),
    ).toBeNull();
    expect(
      planPlacement({ command: "ride_build", defaults: {}, size: 1 }, none, 40, 40, terrain),
    ).toBeNull();
  });
});
