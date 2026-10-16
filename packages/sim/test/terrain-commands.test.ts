import { describe, expect, it } from "vitest";
import {
  MAX_HEIGHT,
  createDefaultRegistry,
  createWorld,
  executeCommand,
  getCorner,
  hashWorld,
  redoLast,
  setCorner,
  tileIndex,
  undoLast,
} from "../src/index.js";

const RAISE_COST_PER_CORNER = 50_00;
const SURFACE_COST_PER_TILE = 10_00;
const WATER_COST_PER_TILE = 20_00;

function setup() {
  return {
    world: createWorld({ width: 8, height: 8, seed: 1, name: "t" }),
    registry: createDefaultRegistry(),
  };
}

describe("createDefaultRegistry", () => {
  it("registers the six terrain commands as undoable terrain commands", () => {
    const entries = createDefaultRegistry()
      .catalog()
      .filter((e) => e.kind === "command");
    expect(entries.map((e) => e.name)).toEqual([
      "terrain_raise",
      "terrain_lower",
      "terrain_level",
      "terrain_smooth",
      "terrain_set_surface",
      "terrain_set_water",
    ]);
    for (const e of entries) {
      expect(e.category).toBe("terrain");
      expect(e.undoable).toBe(true);
    }
  });

  it("returns a fresh registry each call", () => {
    expect(createDefaultRegistry()).not.toBe(createDefaultRegistry());
  });
});

describe("terrain_raise", () => {
  it("raises the 9 corners of a 2x2 rect by 1 and charges 50.00 for each", () => {
    const { world, registry } = setup();
    const result = executeCommand(
      world,
      registry,
      "terrain_raise",
      { x: 2, y: 3, w: 2, h: 2 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 9 * RAISE_COST_PER_CORNER });
    expect(result).toMatchObject({ cost: 45_000 });
    expect(world.finance.cash).toBe(1_000_000 - 45_000);
    let raised = 0;
    for (let cy = 0; cy <= 8; cy++) {
      for (let cx = 0; cx <= 8; cx++) {
        const inRect = cx >= 2 && cx <= 4 && cy >= 3 && cy <= 5;
        expect(getCorner(world.terrain, cx, cy)).toBe(inRect ? 9 : 8);
        if (inRect) raised++;
      }
    }
    expect(raised).toBe(9);
  });

  it("raises by the given number of steps", () => {
    const { world, registry } = setup();
    executeCommand(
      world,
      registry,
      "terrain_raise",
      { x: 0, y: 0, w: 1, h: 1, steps: 5 },
      "player",
    );
    expect(getCorner(world.terrain, 0, 0)).toBe(13);
    expect(getCorner(world.terrain, 1, 1)).toBe(13);
  });

  it("rejects a rect that runs off the map and leaves the world untouched", () => {
    const { world, registry } = setup();
    const before = hashWorld(world);
    const result = executeCommand(
      world,
      registry,
      "terrain_raise",
      { x: 7, y: 0, w: 2, h: 1 },
      "player",
    );
    expect(result).toEqual({ ok: false, error: "Area is outside the park" });
    expect(hashWorld(world)).toBe(before);
  });

  it("rejects steps outside 1..8", () => {
    const { world, registry } = setup();
    const before = hashWorld(world);
    for (const steps of [0, 9, -1, 1.5]) {
      const result = executeCommand(
        world,
        registry,
        "terrain_raise",
        { x: 0, y: 0, w: 1, h: 1, steps },
        "player",
      );
      expect(result.ok).toBe(false);
    }
    expect(hashWorld(world)).toBe(before);
  });

  it("neither changes nor charges corners already at the maximum height", () => {
    const { world, registry } = setup();
    executeCommand(
      world,
      registry,
      "terrain_level",
      { x: 0, y: 0, w: 2, h: 2, height: MAX_HEIGHT },
      "player",
    );
    const cash = world.finance.cash;
    const result = executeCommand(
      world,
      registry,
      "terrain_raise",
      { x: 0, y: 0, w: 2, h: 2 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 0 });
    expect(world.finance.cash).toBe(cash);
    expect(getCorner(world.terrain, 1, 1)).toBe(MAX_HEIGHT);
  });

  it("counts only the corners that change when part of the rect is clamped", () => {
    const { world, registry } = setup();
    setCorner(world.terrain, 0, 0, MAX_HEIGHT);
    const result = executeCommand(
      world,
      registry,
      "terrain_raise",
      { x: 0, y: 0, w: 1, h: 1, steps: 2 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 3 * RAISE_COST_PER_CORNER });
    expect(getCorner(world.terrain, 0, 0)).toBe(MAX_HEIGHT);
    expect(getCorner(world.terrain, 1, 0)).toBe(10);
  });
});

describe("terrain_lower", () => {
  it("lowers the rect's corners and charges per corner changed", () => {
    const { world, registry } = setup();
    const result = executeCommand(
      world,
      registry,
      "terrain_lower",
      { x: 1, y: 1, w: 3, h: 1, steps: 2 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 8 * RAISE_COST_PER_CORNER });
    expect(getCorner(world.terrain, 1, 1)).toBe(6);
    expect(getCorner(world.terrain, 4, 2)).toBe(6);
    expect(getCorner(world.terrain, 0, 1)).toBe(8);
    expect(getCorner(world.terrain, 1, 3)).toBe(8);
  });

  it("clamps at zero without charging corners that are already there", () => {
    const { world, registry } = setup();
    executeCommand(
      world,
      registry,
      "terrain_level",
      { x: 0, y: 0, w: 1, h: 1, height: 0 },
      "player",
    );
    const result = executeCommand(
      world,
      registry,
      "terrain_lower",
      { x: 0, y: 0, w: 1, h: 1 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 0 });
    expect(getCorner(world.terrain, 0, 0)).toBe(0);
  });

  it("rejects a rect that runs off the map", () => {
    const { world, registry } = setup();
    const result = executeCommand(
      world,
      registry,
      "terrain_lower",
      { x: 0, y: 8, w: 1, h: 1 },
      "player",
    );
    expect(result).toEqual({ ok: false, error: "Area is outside the park" });
  });
});

describe("terrain_level", () => {
  it("sets every corner of the rect and charges only for corners that change", () => {
    const { world, registry } = setup();
    setCorner(world.terrain, 1, 1, 12);
    const result = executeCommand(
      world,
      registry,
      "terrain_level",
      { x: 0, y: 0, w: 2, h: 2, height: 8 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 1 * RAISE_COST_PER_CORNER });
    expect(getCorner(world.terrain, 1, 1)).toBe(8);
  });

  it("levels to a new height", () => {
    const { world, registry } = setup();
    const result = executeCommand(
      world,
      registry,
      "terrain_level",
      { x: 2, y: 2, w: 2, h: 2, height: 20 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 9 * RAISE_COST_PER_CORNER });
    expect(getCorner(world.terrain, 3, 3)).toBe(20);
    expect(getCorner(world.terrain, 1, 1)).toBe(8);
  });

  it("rejects a height outside 0..63 and a rect off the map", () => {
    const { world, registry } = setup();
    const tooHigh = executeCommand(
      world,
      registry,
      "terrain_level",
      { x: 0, y: 0, w: 1, h: 1, height: 64 },
      "player",
    );
    expect(tooHigh.ok).toBe(false);
    const negative = executeCommand(
      world,
      registry,
      "terrain_level",
      { x: 0, y: 0, w: 1, h: 1, height: -1 },
      "player",
    );
    expect(negative.ok).toBe(false);
    const off = executeCommand(
      world,
      registry,
      "terrain_level",
      { x: 0, y: 0, w: 9, h: 1, height: 5 },
      "player",
    );
    expect(off).toEqual({ ok: false, error: "Area is outside the park" });
  });
});

describe("terrain_smooth", () => {
  it("lowers a lone spike toward its neighbors, computing every corner from the heights before the pass", () => {
    const { world, registry } = setup();
    setCorner(world.terrain, 4, 4, 20);
    const result = executeCommand(
      world,
      registry,
      "terrain_smooth",
      { x: 0, y: 0, w: 8, h: 8 },
      "player",
    );
    // The spike and its 8 neighbors all become round((20 + 8 * 8) / 9) = 9. Nothing else moves.
    expect(result).toMatchObject({ ok: true, cost: 9 * RAISE_COST_PER_CORNER });
    expect(getCorner(world.terrain, 4, 4)).toBe(9);
    for (let cy = 0; cy <= 8; cy++) {
      for (let cx = 0; cx <= 8; cx++) {
        const near = Math.abs(cx - 4) <= 1 && Math.abs(cy - 4) <= 1;
        expect(getCorner(world.terrain, cx, cy)).toBe(near ? 9 : 8);
      }
    }
  });

  it("ignores neighbors that are off the map", () => {
    const { world, registry } = setup();
    setCorner(world.terrain, 0, 0, 14);
    executeCommand(world, registry, "terrain_smooth", { x: 0, y: 0, w: 1, h: 1 }, "player");
    // Corner (0,0) has 3 neighbors: round((14 + 3 * 8) / 4) = round(9.5) = 10.
    expect(getCorner(world.terrain, 0, 0)).toBe(10);
  });

  it("changes nothing and costs nothing on flat ground", () => {
    const { world, registry } = setup();
    const result = executeCommand(
      world,
      registry,
      "terrain_smooth",
      { x: 0, y: 0, w: 8, h: 8 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 0 });
  });

  it("rejects a rect off the map", () => {
    const { world, registry } = setup();
    const result = executeCommand(
      world,
      registry,
      "terrain_smooth",
      { x: 5, y: 5, w: 4, h: 1 },
      "player",
    );
    expect(result).toEqual({ ok: false, error: "Area is outside the park" });
  });
});

describe("terrain_set_surface", () => {
  it("sets the surface of each tile in the rect and charges per tile changed", () => {
    const { world, registry } = setup();
    const result = executeCommand(
      world,
      registry,
      "terrain_set_surface",
      { x: 1, y: 1, w: 2, h: 3, surface: 2 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 6 * SURFACE_COST_PER_TILE });
    expect(world.terrain.surface[tileIndex(world.terrain, 1, 1)]).toBe(2);
    expect(world.terrain.surface[tileIndex(world.terrain, 2, 3)]).toBe(2);
    expect(world.terrain.surface[tileIndex(world.terrain, 3, 1)]).toBe(0);
    expect(world.terrain.surface[tileIndex(world.terrain, 1, 4)]).toBe(0);
  });

  it("does not charge for tiles that already have the surface", () => {
    const { world, registry } = setup();
    executeCommand(
      world,
      registry,
      "terrain_set_surface",
      { x: 0, y: 0, w: 1, h: 1, surface: 3 },
      "player",
    );
    const result = executeCommand(
      world,
      registry,
      "terrain_set_surface",
      { x: 0, y: 0, w: 2, h: 1, surface: 3 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 1 * SURFACE_COST_PER_TILE });
  });

  it("rejects a surface outside 0..4 and a rect off the map", () => {
    const { world, registry } = setup();
    expect(
      executeCommand(
        world,
        registry,
        "terrain_set_surface",
        { x: 0, y: 0, w: 1, h: 1, surface: 5 },
        "player",
      ).ok,
    ).toBe(false);
    expect(
      executeCommand(
        world,
        registry,
        "terrain_set_surface",
        { x: 7, y: 7, w: 2, h: 2, surface: 1 },
        "player",
      ),
    ).toEqual({
      ok: false,
      error: "Area is outside the park",
    });
  });
});

describe("terrain_set_water", () => {
  it("fills tiles with water above their lowest corner and charges per tile changed", () => {
    const { world, registry } = setup();
    const result = executeCommand(
      world,
      registry,
      "terrain_set_water",
      { x: 2, y: 2, w: 3, h: 2, level: 10 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 6 * WATER_COST_PER_TILE });
    expect(world.terrain.water[tileIndex(world.terrain, 2, 2)]).toBe(10);
    expect(world.terrain.water[tileIndex(world.terrain, 4, 3)]).toBe(10);
    expect(world.terrain.water[tileIndex(world.terrain, 5, 2)]).toBe(0);
  });

  it("rejects water at or below the ground, naming the rule", () => {
    const { world, registry } = setup();
    const before = hashWorld(world);
    for (const level of [5, 8]) {
      const result = executeCommand(
        world,
        registry,
        "terrain_set_water",
        { x: 0, y: 0, w: 1, h: 1, level },
        "player",
      );
      expect(result).toEqual({ ok: false, error: "Water must be above the ground" });
    }
    expect(hashWorld(world)).toBe(before);
  });

  it("rejects the whole rect when any one tile is not below the water, and changes nothing", () => {
    const { world, registry } = setup();
    // A hill under tile (3, 0): its four corners are 12, so its base is 12. Tiles (2, 0) and (4, 0)
    // each touch the hill with only two corners, so their base is still 8.
    executeCommand(
      world,
      registry,
      "terrain_level",
      { x: 3, y: 0, w: 1, h: 1, height: 12 },
      "player",
    );
    const before = hashWorld(world);
    const blocked = executeCommand(
      world,
      registry,
      "terrain_set_water",
      { x: 2, y: 0, w: 3, h: 1, level: 10 },
      "player",
    );
    expect(blocked).toEqual({ ok: false, error: "Water must be above the ground" });
    expect(hashWorld(world)).toBe(before);
    const clear = executeCommand(
      world,
      registry,
      "terrain_set_water",
      { x: 2, y: 0, w: 3, h: 1, level: 13 },
      "player",
    );
    expect(clear).toMatchObject({ ok: true, cost: 3 * WATER_COST_PER_TILE });
  });

  it("clears water with level 0, even though 0 is not above the ground, and charges for tiles that had water", () => {
    const { world, registry } = setup();
    executeCommand(
      world,
      registry,
      "terrain_set_water",
      { x: 0, y: 0, w: 2, h: 1, level: 9 },
      "player",
    );
    const result = executeCommand(
      world,
      registry,
      "terrain_set_water",
      { x: 0, y: 0, w: 3, h: 1, level: 0 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 2 * WATER_COST_PER_TILE });
    expect(world.terrain.water[0]).toBe(0);
    expect(world.terrain.water[1]).toBe(0);
  });

  it("does not charge for tiles that already have the level", () => {
    const { world, registry } = setup();
    executeCommand(
      world,
      registry,
      "terrain_set_water",
      { x: 0, y: 0, w: 1, h: 1, level: 9 },
      "player",
    );
    const result = executeCommand(
      world,
      registry,
      "terrain_set_water",
      { x: 0, y: 0, w: 2, h: 1, level: 9 },
      "player",
    );
    expect(result).toMatchObject({ ok: true, cost: 1 * WATER_COST_PER_TILE });
  });

  it("rejects a level above 63 and a rect off the map", () => {
    const { world, registry } = setup();
    expect(
      executeCommand(
        world,
        registry,
        "terrain_set_water",
        { x: 0, y: 0, w: 1, h: 1, level: 64 },
        "player",
      ).ok,
    ).toBe(false);
    expect(
      executeCommand(
        world,
        registry,
        "terrain_set_water",
        { x: 0, y: 7, w: 1, h: 2, level: 10 },
        "player",
      ),
    ).toEqual({
      ok: false,
      error: "Area is outside the park",
    });
  });
});

describe("undo", () => {
  const cases: Array<[string, Record<string, number>]> = [
    ["terrain_raise", { x: 1, y: 1, w: 3, h: 2, steps: 3 }],
    ["terrain_lower", { x: 0, y: 2, w: 2, h: 2, steps: 2 }],
    ["terrain_level", { x: 2, y: 2, w: 4, h: 3, height: 17 }],
    ["terrain_smooth", { x: 0, y: 0, w: 8, h: 8 }],
    ["terrain_set_surface", { x: 3, y: 1, w: 2, h: 4, surface: 4 }],
    ["terrain_set_water", { x: 1, y: 5, w: 4, h: 2, level: 12 }],
  ];

  for (const [name, input] of cases) {
    it(`${name}: the hash after apply then revert equals the hash before`, () => {
      const { world, registry } = setup();
      // Uneven ground so smooth has work to do.
      setCorner(world.terrain, 4, 4, 20);
      setCorner(world.terrain, 2, 6, 3);
      const def = registry.command(name);
      if (!def) throw new Error(`${name} is not registered`);
      const parsed = def.input.parse(input);
      const before = hashWorld(world);
      expect(def.validate(world, parsed)).toBeNull();
      const undo = def.apply(world, parsed);
      expect(hashWorld(world)).not.toBe(before);
      // The undo data must survive a trip through JSON, as it does in a saved log.
      def.revert(world, parsed, JSON.parse(JSON.stringify(undo)));
      expect(hashWorld(world)).toBe(before);
    });
  }

  it("undoLast refunds the cost and restores the terrain; redoLast charges and applies it again", () => {
    const { world, registry } = setup();
    const cash = world.finance.cash;
    const corners = Int16Array.from(world.terrain.corners);
    executeCommand(world, registry, "terrain_raise", { x: 0, y: 0, w: 2, h: 2 }, "player");
    const raised = Int16Array.from(world.terrain.corners);
    expect(world.finance.cash).toBe(cash - 45_000);

    expect(undoLast(world, registry, "player")).toMatchObject({ ok: true, cost: -45_000 });
    expect(world.finance.cash).toBe(cash);
    expect(world.terrain.corners).toEqual(corners);

    expect(redoLast(world, registry, "player")).toMatchObject({ ok: true, cost: 45_000 });
    expect(world.finance.cash).toBe(cash - 45_000);
    expect(world.terrain.corners).toEqual(raised);
  });

  it("stores undo data as plain arrays of [index, previous] pairs", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "terrain_raise", { x: 0, y: 0, w: 1, h: 1 }, "player");
    executeCommand(
      world,
      registry,
      "terrain_set_surface",
      { x: 0, y: 0, w: 1, h: 1, surface: 1 },
      "player",
    );
    expect(world.log[0]?.undo).toEqual({
      corners: [
        [0, 8],
        [1, 8],
        [9, 8],
        [10, 8],
      ],
    });
    expect(world.log[1]?.undo).toEqual({ tiles: [[0, 0]] });
  });
});
