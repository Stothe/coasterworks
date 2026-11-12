import { describe, expect, it } from "vitest";
import { PATH_TOO_STEEP } from "../src/commands/terrain.js";
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
      error: "Cannot flood a path or the park entrance",
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

  it("let a steep smooth through when no path is near", () => {
    const { sim } = setup();
    expect(sim.execute("terrain_raise", { x: 10, y: 2, w: 1, h: 1, steps: 8 }).ok).toBe(true);
    expect(sim.execute("terrain_smooth", { x: 9, y: 1, w: 3, h: 3 }).ok).toBe(true);
  });
});
