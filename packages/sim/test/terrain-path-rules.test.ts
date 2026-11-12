import { describe, expect, it } from "vitest";
import { PATH_TOO_STEEP, RIDE_IN_THE_WAY } from "../src/commands/terrain.js";
import { Sim, createWorld } from "../src/index.js";

function setup() {
  const world = createWorld({ width: 16, height: 16, seed: 7, name: "T", cash: 1_000_000_00 });
  const sim = new Sim(world);
  const ok = (name: string, input: unknown) => {
    const result = sim.execute(name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`);
  };
  ok("park_set_entrance", { x: 0, y: 8 });
  ok("path_build", { x: 1, y: 8, w: 4, h: 1, kind: "foot" });
  return { world, sim };
}

// Terrain edits must not leave what path_build and park_set_entrance refuse to make.
describe("terrain commands keep paths and the entrance buildable", () => {
  it("refuse water over a path or the entrance, and allow it beside them", () => {
    const { sim } = setup();
    expect(sim.execute("terrain_set_water", { x: 2, y: 8, w: 1, h: 1, level: 20 })).toEqual({
      ok: false,
      error: "Cannot flood a path, a ride or the park entrance",
    });
    expect(sim.execute("terrain_set_water", { x: 0, y: 7, w: 1, h: 3, level: 20 }).ok).toBe(false);
    expect(sim.execute("terrain_set_water", { x: 2, y: 9, w: 3, h: 2, level: 20 }).ok).toBe(true);
    // Draining is always allowed.
    expect(sim.execute("terrain_set_water", { x: 2, y: 8, w: 1, h: 1, level: 0 }).ok).toBe(true);
  });

  it("refuse a raise, lower, level or smooth that leaves a path tile too steep", () => {
    const { world, sim } = setup();
    const before = world.terrain.corners.slice();
    for (const [name, input] of [
      ["terrain_raise", { x: 2, y: 8, w: 1, h: 1, steps: 3 }],
      ["terrain_lower", { x: 2, y: 9, w: 1, h: 1, steps: 3 }],
      ["terrain_level", { x: 3, y: 7, w: 1, h: 1, height: 30 }],
    ] as const) {
      expect(sim.execute(name, input)).toEqual({ ok: false, error: PATH_TOO_STEEP });
    }
    expect(world.terrain.corners).toEqual(before);
  });

  it("allow raising a path evenly, or a slope a path can still take", () => {
    const { world, sim } = setup();
    expect(sim.execute("terrain_raise", { x: 1, y: 8, w: 4, h: 1, steps: 4 }).ok).toBe(true);
    expect(sim.execute("terrain_raise", { x: 6, y: 8, w: 1, h: 1, steps: 8 }).ok).toBe(true);
    expect(world.terrain.path[8 * 16 + 2]).toBe(1);
  });

  it("refuse to reshape or flood the ground under a ride or stall", () => {
    const { world, sim } = setup();
    expect(sim.execute("stall_build", { type: "snack_stand", x: 10, y: 10, rot: 0 }).ok).toBe(true);
    const before = world.terrain.corners.slice();
    for (const [name, input] of [
      ["terrain_raise", { x: 10, y: 10, w: 1, h: 1 }],
      ["terrain_lower", { x: 9, y: 9, w: 1, h: 1 }],
      ["terrain_level", { x: 10, y: 10, w: 2, h: 1, height: 20 }],
    ] as const) {
      expect(sim.execute(name, input)).toEqual({ ok: false, error: RIDE_IN_THE_WAY });
    }
    expect(world.terrain.corners).toEqual(before);
    expect(sim.execute("terrain_set_water", { x: 10, y: 10, w: 1, h: 1, level: 20 })).toEqual({
      ok: false,
      error: "Cannot flood a path, a ride or the park entrance",
    });
  });

  it("let a steep smooth through when no path is near", () => {
    const { sim } = setup();
    expect(sim.execute("terrain_raise", { x: 10, y: 2, w: 1, h: 1, steps: 8 }).ok).toBe(true);
    expect(sim.execute("terrain_smooth", { x: 9, y: 1, w: 3, h: 3 }).ok).toBe(true);
  });
});

describe("ride access tiles", () => {
  it("cannot be shared by two rides or stalls", () => {
    const world = createWorld({ width: 32, height: 32, seed: 1, name: "T", cash: 1_000_000_00 });
    const sim = new Sim(world);
    // The carousel at (5, 5) has its entrance at (6, 8) and its exit at (8, 6).
    expect(sim.execute("ride_build", { type: "carousel", x: 5, y: 5, rot: 0 }).ok).toBe(true);
    expect(sim.execute("ride_build", { type: "swing_tower", x: 5, y: 9, rot: 0 })).toEqual({
      ok: false,
      error: "Something is already here",
    });
    expect(sim.execute("stall_build", { type: "snack_stand", x: 8, y: 5, rot: 0 })).toEqual({
      ok: false,
      error: "Something is already here",
    });
  });

  it("must be able to take a path, and stay so", () => {
    const world = createWorld({ width: 32, height: 32, seed: 1, name: "T", cash: 1_000_000_00 });
    const sim = new Sim(world);
    expect(sim.execute("terrain_lower", { x: 6, y: 9, w: 2, h: 1, steps: 6 }).ok).toBe(true);
    expect(sim.execute("ride_build", { type: "carousel", x: 5, y: 5, rot: 0 })).toEqual({
      ok: false,
      error: "The way in or out is too steep for a path",
    });
    expect(sim.undo().ok).toBe(true);
    expect(sim.execute("ride_build", { type: "carousel", x: 5, y: 5, rot: 0 }).ok).toBe(true);
    // Its exit (8, 6) may not be flooded or steepened afterwards.
    expect(sim.execute("terrain_set_water", { x: 8, y: 6, w: 1, h: 1, level: 20 }).ok).toBe(false);
    expect(sim.execute("terrain_raise", { x: 9, y: 6, w: 1, h: 1, steps: 6 })).toEqual({
      ok: false,
      error: PATH_TOO_STEEP,
    });
  });
});
