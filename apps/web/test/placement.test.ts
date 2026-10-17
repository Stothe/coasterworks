// @vitest-environment node
import type { TerrainData } from "@coasterworks/render";
import { describe, expect, it } from "vitest";
import { planPlacement } from "../src/viewport/brush";
import {
  DEFAULT_TERRAIN_OPTIONS,
  SURFACES,
  TERRAIN_VERBS,
  optionsOfDefaults,
  terrainPlacement,
  verbOfCommand,
  type TerrainVerb,
} from "../src/viewport/terrainTools";

const none = { shift: false, alt: false };
const shift = { shift: true, alt: false };
const alt = { shift: false, alt: true };

function flat(width: number, height: number, level = 8): TerrainData {
  return {
    width,
    height,
    corners: new Int16Array((width + 1) * (height + 1)).fill(level),
    surface: new Uint8Array(width * height),
    water: new Uint8Array(width * height),
  };
}

const place = (command: string, defaults: Record<string, unknown>, size = 1) => ({
  command,
  defaults,
  size,
});

describe("planPlacement: the brush", () => {
  const terrain = flat(16, 16, 4);

  it("clicks a raise placement into terrain_raise over the brush, with its defaults", () => {
    expect(planPlacement(place("terrain_raise", { steps: 2 }, 2), none, 5, 6, terrain)).toEqual({
      name: "terrain_raise",
      input: { x: 5, y: 6, w: 2, h: 2, steps: 2 },
    });
  });

  it("centers a brush of 3 on the clicked tile and a brush of 2 toward the north-west", () => {
    expect(planPlacement(place("terrain_lower", {}, 3), none, 5, 5, terrain)?.input).toEqual({
      x: 4,
      y: 4,
      w: 3,
      h: 3,
    });
    expect(planPlacement(place("terrain_lower", {}, 2), none, 5, 5, terrain)?.input).toEqual({
      x: 5,
      y: 5,
      w: 2,
      h: 2,
    });
  });

  it("flips raise and lower with Shift", () => {
    expect(planPlacement(place("terrain_raise", {}), shift, 1, 1, terrain)?.name).toBe(
      "terrain_lower",
    );
    expect(planPlacement(place("terrain_lower", {}), shift, 1, 1, terrain)?.name).toBe(
      "terrain_raise",
    );
  });

  it("clamps a brush at the edge, and sends nothing when the click is off the map", () => {
    expect(planPlacement(place("terrain_raise", {}, 3), none, 15, 15, terrain)?.input).toEqual({
      x: 14,
      y: 14,
      w: 2,
      h: 2,
    });
    expect(planPlacement(place("terrain_raise", {}), none, 16, 3, terrain)).toBeNull();
    expect(planPlacement(place("terrain_set_water", {}), none, -1, -1, terrain)).toBeNull();
    expect(planPlacement(place("ride_build", {}), none, 40, 40, terrain)).toBeNull();
  });

  it("never lets the defaults move the area the player clicked", () => {
    const plan = planPlacement(
      place("terrain_raise", { x: 0, y: 0, w: 9, h: 9 }),
      none,
      5,
      6,
      terrain,
    );
    expect(plan?.input).toMatchObject({ x: 5, y: 6, w: 1, h: 1 });
  });

  it("smooths the brush and sends nothing but the area", () => {
    expect(planPlacement(place("terrain_smooth", {}, 2), none, 3, 3, terrain)).toEqual({
      name: "terrain_smooth",
      input: { x: 3, y: 3, w: 2, h: 2 },
    });
  });

  it("places any other command over the brush with its defaults, and nothing else of its own", () => {
    expect(planPlacement(place("ride_build", { kind: "carousel" }), none, 0, 0, terrain)).toEqual({
      name: "ride_build",
      input: { x: 0, y: 0, w: 1, h: 1, kind: "carousel" },
    });
  });
});

describe("planPlacement: level", () => {
  const terrain = flat(8, 8);
  terrain.corners[3 * 9 + 3] = 5;

  it("goes to the clicked tile's lowest corner in tile mode, whatever height it remembers", () => {
    expect(
      planPlacement(
        place("terrain_level", { heightMode: "tile", height: 12 }),
        none,
        3,
        3,
        terrain,
      ),
    ).toEqual({ name: "terrain_level", input: { x: 3, y: 3, w: 1, h: 1, height: 5 } });
  });

  it("goes to the height it was given in height mode", () => {
    expect(
      planPlacement(
        place("terrain_level", { heightMode: "height", height: 12 }),
        none,
        3,
        3,
        terrain,
      ),
    ).toEqual({ name: "terrain_level", input: { x: 3, y: 3, w: 1, h: 1, height: 12 } });
  });

  it("takes a plain height as given, and the tile when it has none", () => {
    expect(
      planPlacement(place("terrain_level", { height: 9 }), none, 3, 3, terrain)?.input,
    ).toMatchObject({ height: 9 });
    expect(planPlacement(place("terrain_level", {}), none, 3, 3, terrain)?.input).toMatchObject({
      height: 5,
    });
  });

  it("keeps its helper keys from the sim", () => {
    const input = planPlacement(
      place("terrain_level", { heightMode: "tile", height: 12 }),
      none,
      3,
      3,
      terrain,
    )?.input;
    expect(Object.keys(input ?? {}).sort()).toEqual(["h", "height", "w", "x", "y"]);
  });

  it("levels the whole brush to the one height", () => {
    expect(
      planPlacement(place("terrain_level", { heightMode: "tile" }, 3), none, 3, 3, terrain)?.input,
    ).toEqual({ x: 2, y: 2, w: 3, h: 3, height: 5 });
  });
});

describe("planPlacement: water", () => {
  const terrain = flat(8, 8);

  it("fills to the number of steps above the clicked tile's lowest corner", () => {
    expect(
      planPlacement(place("terrain_set_water", { levelAbove: 2 }, 2), none, 2, 2, terrain),
    ).toEqual({ name: "terrain_set_water", input: { x: 2, y: 2, w: 2, h: 2, level: 10 } });
    expect(
      planPlacement(place("terrain_set_water", { levelAbove: 5 }), none, 2, 2, terrain)?.input,
    ).toMatchObject({ level: 13 });
  });

  it("is two above when it is not told, which is what the tray starts at", () => {
    expect(planPlacement(place("terrain_set_water", {}), none, 2, 2, terrain)?.input).toMatchObject(
      { level: 10 },
    );
  });

  it("drains with Alt, however far above it would have filled", () => {
    expect(
      planPlacement(place("terrain_set_water", { levelAbove: 6 }, 2), alt, 2, 2, terrain),
    ).toEqual({ name: "terrain_set_water", input: { x: 2, y: 2, w: 2, h: 2, level: 0 } });
  });

  it("holds the level to the highest height the sim accepts", () => {
    const high = flat(4, 4, 62);
    expect(
      planPlacement(place("terrain_set_water", { levelAbove: 8 }), none, 1, 1, high)?.input,
    ).toMatchObject({ level: 63 });
  });

  it("reads the level from the lowest corner of the tile it was clicked on", () => {
    const sloped = flat(8, 8);
    sloped.corners[2 * 9 + 2] = 3;
    expect(
      planPlacement(place("terrain_set_water", { levelAbove: 2 }), none, 2, 2, sloped)?.input,
    ).toMatchObject({ level: 5 });
  });

  it("takes a level it was given outright, and keeps its helper key from the sim", () => {
    const given = planPlacement(place("terrain_set_water", { level: 9 }), none, 2, 2, terrain);
    expect(given?.input).toEqual({ x: 2, y: 2, w: 1, h: 1, level: 9 });
    const relative = planPlacement(
      place("terrain_set_water", { levelAbove: 2 }),
      none,
      2,
      2,
      terrain,
    );
    expect(Object.keys(relative?.input ?? {}).sort()).toEqual(["h", "level", "w", "x", "y"]);
  });
});

describe("planPlacement: surface", () => {
  const terrain = flat(8, 8);

  it("sets the surface the placement names over the brush", () => {
    expect(
      planPlacement(place("terrain_set_surface", { surface: 1 }, 3), none, 5, 5, terrain),
    ).toEqual({ name: "terrain_set_surface", input: { x: 4, y: 4, w: 3, h: 3, surface: 1 } });
  });

  it("is grass when it is not told", () => {
    expect(
      planPlacement(place("terrain_set_surface", {}), none, 5, 5, terrain)?.input,
    ).toMatchObject({ surface: 0 });
  });
});

describe("the terrain tools", () => {
  it("lists the six verbs of the tray in order, each with a command and a key", () => {
    expect(TERRAIN_VERBS.map((v) => [v.verb, v.command, v.label, v.key])).toEqual([
      ["raise", "terrain_raise", "Raise", "R"],
      ["lower", "terrain_lower", "Lower", "L"],
      ["level", "terrain_level", "Level", "V"],
      ["smooth", "terrain_smooth", "Smooth", "M"],
      ["water", "terrain_set_water", "Water", "W"],
      ["surface", "terrain_set_surface", "Surface", "U"],
    ]);
  });

  it("names the five surfaces in the order of the sim's numbers", () => {
    expect(SURFACES.map((s) => [s.id, s.label])).toEqual([
      [0, "Grass"],
      [1, "Sand"],
      [2, "Dirt"],
      [3, "Rock"],
      [4, "Snow"],
    ]);
  });

  it("finds the verb of a command, and none for any other", () => {
    expect(verbOfCommand("terrain_set_water")).toBe("water");
    expect(verbOfCommand("terrain_smooth")).toBe("smooth");
    expect(verbOfCommand("ride_build")).toBeUndefined();
    expect(verbOfCommand(undefined)).toBeUndefined();
  });

  it("starts each verb with the options it uses and no others", () => {
    const options = { waterAbove: 4, surface: 3, heightMode: "height", height: 12 } as const;
    expect(terrainPlacement("raise", options)).toEqual({ command: "terrain_raise", defaults: {} });
    expect(terrainPlacement("lower", options)).toEqual({ command: "terrain_lower", defaults: {} });
    expect(terrainPlacement("smooth", options)).toEqual({
      command: "terrain_smooth",
      defaults: {},
    });
    expect(terrainPlacement("level", options)).toEqual({
      command: "terrain_level",
      defaults: { heightMode: "height", height: 12 },
    });
    expect(terrainPlacement("water", options)).toEqual({
      command: "terrain_set_water",
      defaults: { levelAbove: 4 },
    });
    expect(terrainPlacement("surface", options)).toEqual({
      command: "terrain_set_surface",
      defaults: { surface: 3 },
    });
  });

  it("starts from the defaults: two above for water, grass, and level to the tile", () => {
    expect(DEFAULT_TERRAIN_OPTIONS).toEqual({
      waterAbove: 2,
      surface: 0,
      heightMode: "tile",
      height: 8,
    });
    expect(terrainPlacement("water").defaults).toEqual({ levelAbove: 2 });
    expect(terrainPlacement("surface").defaults).toEqual({ surface: 0 });
    expect(terrainPlacement("level").defaults).toEqual({ heightMode: "tile", height: 8 });
  });

  it("reads the options back from a placement's defaults, with the defaults for what is missing", () => {
    expect(optionsOfDefaults({})).toEqual(DEFAULT_TERRAIN_OPTIONS);
    expect(optionsOfDefaults({ levelAbove: 5, surface: 2 })).toMatchObject({
      waterAbove: 5,
      surface: 2,
    });
    // A level placement that was given a height and no mode is in height mode, as the click reads it.
    expect(optionsOfDefaults({ height: 9 })).toMatchObject({ heightMode: "height", height: 9 });
    expect(optionsOfDefaults({ heightMode: "tile", height: 9 })).toMatchObject({
      heightMode: "tile",
      height: 9,
    });
    // Something that is not a number is not an option.
    expect(optionsOfDefaults({ levelAbove: "high", surface: null })).toEqual(
      DEFAULT_TERRAIN_OPTIONS,
    );
  });

  it("round-trips every verb's options through a click into the command the sim takes", () => {
    const terrain = flat(8, 8);
    const options = { waterAbove: 3, surface: 4, heightMode: "height", height: 20 } as const;
    const expected: Record<TerrainVerb, unknown> = {
      raise: { name: "terrain_raise", input: { x: 3, y: 3, w: 1, h: 1 } },
      lower: { name: "terrain_lower", input: { x: 3, y: 3, w: 1, h: 1 } },
      smooth: { name: "terrain_smooth", input: { x: 3, y: 3, w: 1, h: 1 } },
      level: { name: "terrain_level", input: { x: 3, y: 3, w: 1, h: 1, height: 20 } },
      water: { name: "terrain_set_water", input: { x: 3, y: 3, w: 1, h: 1, level: 11 } },
      surface: { name: "terrain_set_surface", input: { x: 3, y: 3, w: 1, h: 1, surface: 4 } },
    };
    for (const { verb } of TERRAIN_VERBS) {
      const { command, defaults } = terrainPlacement(verb, options);
      expect(planPlacement({ command, defaults, size: 1 }, none, 3, 3, terrain), verb).toEqual(
        expected[verb],
      );
    }
  });
});
