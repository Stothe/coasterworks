import { describe, expect, it } from "vitest";
import {
  PATH_COST,
  PATH_FOOT,
  PATH_NONE,
  PATH_QUEUE,
  Sim,
  canBuildPath,
  createWorld,
  edgeSide,
  hashWorld,
  isEdgeTile,
  neighborsOnPath,
  pathAt,
  type World,
} from "../src/index.js";

const CASH = 1_000_000_00;

function setup(width = 16, height = 16) {
  const world = createWorld({ width, height, seed: 3, name: "Pathland", cash: CASH });
  return { world, sim: new Sim(world) };
}

/** Runs a command that must succeed. */
function run(sim: Sim, name: string, input: unknown): void {
  const result = sim.execute(name, input);
  if (!result.ok) throw new Error(`${name} failed: ${result.error}`);
}

/** A 16x16 world with a pond at (8..10, 8..9) and a one-tile plateau at (4, 4), 3 steps high. */
function pondAndPlateau() {
  const { world, sim } = setup();
  run(sim, "terrain_set_water", { x: 8, y: 8, w: 3, h: 2, level: 12 });
  run(sim, "terrain_raise", { x: 4, y: 4, w: 1, h: 1, steps: 3 });
  return { world, sim };
}

function pathOf(world: World, x: number, y: number): number {
  return pathAt(world.terrain, x, y);
}

/** What a path command can change. An undo logs an entry of its own, so the hash is no use here. */
function snapshot(world: World) {
  return {
    path: Array.from(world.terrain.path),
    park: structuredClone(world.park),
    cash: world.finance.cash,
  };
}

describe("path layer constants and helpers", () => {
  it("names the three path values", () => {
    expect([PATH_NONE, PATH_FOOT, PATH_QUEUE]).toEqual([0, 1, 2]);
    expect(PATH_COST).toBe(10_00);
  });

  it("pathAt reads the layer and answers none off the map", () => {
    const { world } = setup(4, 3);
    world.terrain.path[1 * 4 + 2] = PATH_QUEUE;
    expect(pathAt(world.terrain, 2, 1)).toBe(PATH_QUEUE);
    expect(pathAt(world.terrain, 0, 0)).toBe(PATH_NONE);
    expect(pathAt(world.terrain, -1, 0)).toBe(PATH_NONE);
    expect(pathAt(world.terrain, 4, 0)).toBe(PATH_NONE);
    expect(pathAt(world.terrain, 0, 3)).toBe(PATH_NONE);
    expect(pathAt(world.terrain, 1.5, 1)).toBe(PATH_NONE);
  });

  it("isEdgeTile is true on the outer ring of tiles and false inside or off the map", () => {
    const { world } = setup(5, 4);
    const t = world.terrain;
    for (const [x, y] of [
      [0, 0],
      [2, 0],
      [4, 0],
      [0, 2],
      [4, 2],
      [0, 3],
      [2, 3],
      [4, 3],
    ] as const) {
      expect(isEdgeTile(t, x, y), `(${x}, ${y})`).toBe(true);
    }
    for (const [x, y] of [
      [1, 1],
      [3, 2],
      [2, 1],
      [-1, 0],
      [5, 0],
      [0, 4],
      [2.5, 0],
    ] as const) {
      expect(isEdgeTile(t, x, y), `(${x}, ${y})`).toBe(false);
    }
  });

  it("edgeSide names the map edge: north 0, east 1, south 2, west 3, and -1 elsewhere", () => {
    const { world } = setup(5, 4);
    const t = world.terrain;
    expect(edgeSide(t, 2, 0)).toBe(0);
    expect(edgeSide(t, 4, 2)).toBe(1);
    expect(edgeSide(t, 2, 3)).toBe(2);
    expect(edgeSide(t, 0, 2)).toBe(3);
    expect(edgeSide(t, 2, 2)).toBe(-1);
    expect(edgeSide(t, -1, 0)).toBe(-1);
    expect(edgeSide(t, 5, 0)).toBe(-1);
  });

  it("edgeSide gives a corner the first side in the order north, east, south, west", () => {
    const { world } = setup(5, 4);
    const t = world.terrain;
    expect(edgeSide(t, 0, 0)).toBe(0); // north and west
    expect(edgeSide(t, 4, 0)).toBe(0); // north and east
    expect(edgeSide(t, 4, 3)).toBe(1); // east and south
    expect(edgeSide(t, 0, 3)).toBe(2); // south and west
  });

  it("edgeSide on a 1x1 map is north", () => {
    const { world } = setup(1, 1);
    expect(edgeSide(world.terrain, 0, 0)).toBe(0);
  });

  it("neighborsOnPath lists the path tiles around a tile in the order N, E, S, W", () => {
    const { world } = setup(5, 5);
    const t = world.terrain;
    expect(neighborsOnPath(t, 2, 2)).toEqual([]);
    t.path[2 * 5 + 1] = PATH_FOOT; // west
    t.path[3 * 5 + 2] = PATH_QUEUE; // south
    t.path[2 * 5 + 3] = PATH_FOOT; // east
    t.path[1 * 5 + 2] = PATH_FOOT; // north
    t.path[1 * 5 + 1] = PATH_FOOT; // a diagonal, which does not count
    expect(neighborsOnPath(t, 2, 2)).toEqual([
      [2, 1],
      [3, 2],
      [2, 3],
      [1, 2],
    ]);
  });

  it("neighborsOnPath skips neighbors off the map and does not count the tile itself", () => {
    const { world } = setup(3, 3);
    const t = world.terrain;
    t.path[0] = PATH_FOOT; // (0, 0)
    t.path[1] = PATH_FOOT; // (1, 0)
    expect(neighborsOnPath(t, 0, 0)).toEqual([[1, 0]]);
    expect(neighborsOnPath(t, 1, 0)).toEqual([[0, 0]]);
    expect(neighborsOnPath(t, 2, 2)).toEqual([]);
  });
});

describe("canBuildPath", () => {
  it("is null for an ordinary tile", () => {
    const { world } = pondAndPlateau();
    expect(canBuildPath(world, 1, 1)).toBeNull();
    // The plateau's own tile is flat: all four corners moved together.
    expect(canBuildPath(world, 4, 4)).toBeNull();
  });

  it("gives each reason its exact text", () => {
    const { world } = pondAndPlateau();
    expect(canBuildPath(world, -1, 0)).toBe("Area is outside the park");
    expect(canBuildPath(world, 16, 0)).toBe("Area is outside the park");
    expect(canBuildPath(world, 0, 16)).toBe("Area is outside the park");
    expect(canBuildPath(world, 9, 8)).toBe("Cannot build on water");
    expect(canBuildPath(world, 3, 4)).toBe("Tile is too steep");
    world.park.entrance = { x: 7, y: 0, side: 0 };
    expect(canBuildPath(world, 7, 0)).toBe("Tile is the park entrance");
  });

  it("allows a drop of 2 steps and refuses 3", () => {
    const { world, sim } = setup();
    run(sim, "terrain_raise", { x: 4, y: 4, w: 1, h: 1, steps: 2 });
    expect(canBuildPath(world, 3, 4)).toBeNull();
    run(sim, "terrain_raise", { x: 8, y: 8, w: 1, h: 1, steps: 3 });
    expect(canBuildPath(world, 7, 8)).toBe("Tile is too steep");
  });

  it("checks in the order outside, water, steep, entrance", () => {
    const { world, sim } = setup();
    // Water on a steep tile: raise a plateau, then flood the tile beside it above its low corners.
    run(sim, "terrain_raise", { x: 4, y: 4, w: 1, h: 1, steps: 5 });
    run(sim, "terrain_set_water", { x: 3, y: 4, w: 1, h: 1, level: 12 });
    expect(canBuildPath(world, 3, 4)).toBe("Cannot build on water");
    world.terrain.water[4 * 16 + 3] = 0;
    // Steep and the entrance: steep is reported first.
    world.park.entrance = { x: 3, y: 4, side: 3 };
    expect(canBuildPath(world, 3, 4)).toBe("Tile is too steep");
  });
});

describe("path_build", () => {
  it("builds a 2x2 foot path for $40 and sets four tiles", () => {
    const { world, sim } = setup();
    const result = sim.execute("path_build", { x: 2, y: 3, w: 2, h: 2, kind: "foot" });
    expect(result).toMatchObject({ ok: true, cost: 40_00 });
    expect(world.finance.cash).toBe(CASH - 40_00);
    for (const [x, y] of [
      [2, 3],
      [3, 3],
      [2, 4],
      [3, 4],
    ] as const) {
      expect(pathOf(world, x, y)).toBe(PATH_FOOT);
    }
    expect([...world.terrain.path].filter((v) => v !== PATH_NONE)).toHaveLength(4);
  });

  it("builds a queue", () => {
    const { world, sim } = setup();
    expect(sim.execute("path_build", { x: 1, y: 1, w: 3, h: 1, kind: "queue" })).toMatchObject({
      ok: true,
      cost: 30_00,
    });
    expect([pathOf(world, 1, 1), pathOf(world, 2, 1), pathOf(world, 3, 1)]).toEqual([
      PATH_QUEUE,
      PATH_QUEUE,
      PATH_QUEUE,
    ]);
  });

  it("rejects a kind other than foot or queue", () => {
    const { sim } = setup();
    expect(sim.execute("path_build", { x: 1, y: 1, w: 1, h: 1, kind: "road" }).ok).toBe(false);
    expect(sim.execute("path_build", { x: 1, y: 1, w: 1, h: 1 }).ok).toBe(false);
  });

  it("rejects building over the pond", () => {
    const { world, sim } = pondAndPlateau();
    const result = sim.execute("path_build", { x: 9, y: 8, w: 1, h: 1, kind: "foot" });
    expect(result).toEqual({ ok: false, error: "Cannot build on water" });
    expect(pathOf(world, 9, 8)).toBe(PATH_NONE);
  });

  it("rejects building over a steep slope", () => {
    const { sim } = pondAndPlateau();
    expect(sim.execute("path_build", { x: 3, y: 4, w: 1, h: 1, kind: "foot" })).toEqual({
      ok: false,
      error: "Tile is too steep",
    });
  });

  it("rejects building over the entrance", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entrance", { x: 7, y: 0 });
    expect(sim.execute("path_build", { x: 6, y: 0, w: 3, h: 1, kind: "foot" })).toEqual({
      ok: false,
      error: "Tile is the park entrance",
    });
    expect(pathOf(world, 6, 0)).toBe(PATH_NONE);
  });

  it("rejects a rectangle that is off the map or runs past its edge", () => {
    const { sim } = setup();
    const outside = { ok: false, error: "Area is outside the park" };
    expect(sim.execute("path_build", { x: 16, y: 0, w: 1, h: 1, kind: "foot" })).toEqual(outside);
    expect(sim.execute("path_build", { x: 0, y: 99, w: 1, h: 1, kind: "foot" })).toEqual(outside);
    expect(sim.execute("path_build", { x: 14, y: 0, w: 3, h: 1, kind: "foot" })).toEqual(outside);
    expect(sim.execute("path_build", { x: -1, y: 0, w: 1, h: 1, kind: "foot" }).ok).toBe(false);
  });

  it("rejects the whole command when any tile fails, charging nothing and logging nothing", () => {
    const { world, sim } = pondAndPlateau();
    const before = hashWorld(world);
    const cash = world.finance.cash;
    const logLength = world.log.length;
    // Row 8 crosses the pond at x = 8..10.
    const result = sim.execute("path_build", { x: 6, y: 8, w: 6, h: 1, kind: "foot" });
    expect(result).toEqual({ ok: false, error: "Cannot build on water" });
    expect(hashWorld(world)).toBe(before);
    expect(world.finance.cash).toBe(cash);
    expect(world.log).toHaveLength(logLength);
    expect([...world.terrain.path].every((v) => v === PATH_NONE)).toBe(true);
  });

  it("counts only the tiles that change: the other kind is charged, the same kind is free", () => {
    const { world, sim } = setup();
    run(sim, "path_build", { x: 2, y: 2, w: 4, h: 1, kind: "foot" });
    const cash = world.finance.cash;

    // Same kind over all four tiles, plus two new ones: only the two new ones are charged.
    expect(sim.execute("path_build", { x: 2, y: 2, w: 6, h: 1, kind: "foot" })).toMatchObject({
      ok: true,
      cost: 20_00,
    });
    expect(world.finance.cash).toBe(cash - 20_00);

    // The other kind over existing foot tiles changes them, and is charged for each.
    expect(sim.execute("path_build", { x: 2, y: 2, w: 2, h: 1, kind: "queue" })).toMatchObject({
      ok: true,
      cost: 20_00,
    });
    expect([pathOf(world, 2, 2), pathOf(world, 3, 2), pathOf(world, 4, 2)]).toEqual([
      PATH_QUEUE,
      PATH_QUEUE,
      PATH_FOOT,
    ]);

    // Nothing to change: free.
    expect(sim.execute("path_build", { x: 2, y: 2, w: 2, h: 1, kind: "queue" })).toMatchObject({
      ok: true,
      cost: 0,
    });
  });

  it("refuses when the park cannot pay", () => {
    const world = createWorld({ width: 8, height: 8, seed: 1, name: "Poor", cash: 25_00 });
    const sim = new Sim(world);
    const result = sim.execute("path_build", { x: 0, y: 0, w: 3, h: 1, kind: "foot" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^Not enough cash/);
    expect([...world.terrain.path].every((v) => v === PATH_NONE)).toBe(true);
  });

  it("saves plain JSON undo data: the changed tiles and what each held before", () => {
    const { world, sim } = setup();
    run(sim, "path_build", { x: 1, y: 1, w: 2, h: 1, kind: "foot" });
    run(sim, "path_build", { x: 2, y: 1, w: 2, h: 1, kind: "queue" });
    const entry = world.log.at(-1);
    // (2, 1) was foot, (3, 1) was nothing.
    expect(entry?.undo).toEqual({
      tiles: [
        [1 * 16 + 2, PATH_FOOT],
        [1 * 16 + 3, PATH_NONE],
      ],
    });
    expect(JSON.parse(JSON.stringify(entry?.undo))).toEqual(entry?.undo);
  });

  it("undo restores the previous kinds and the cash, and redo builds again", () => {
    const { world, sim } = setup();
    run(sim, "path_build", { x: 1, y: 1, w: 3, h: 1, kind: "foot" });
    const before = snapshot(world);
    const cash = world.finance.cash;

    // Over a mix: one foot tile becomes a queue, the new ones are queue too.
    run(sim, "path_build", { x: 3, y: 1, w: 3, h: 1, kind: "queue" });
    expect(snapshot(world)).not.toEqual(before);
    expect(world.finance.cash).toBe(cash - 30_00);

    expect(sim.undo().ok).toBe(true);
    expect(snapshot(world)).toEqual(before);
    expect(world.finance.cash).toBe(cash);
    expect([1, 2, 3, 4, 5].map((x) => pathOf(world, x, 1))).toEqual([
      PATH_FOOT,
      PATH_FOOT,
      PATH_FOOT,
      PATH_NONE,
      PATH_NONE,
    ]);

    expect(sim.redo().ok).toBe(true);
    expect(world.finance.cash).toBe(cash - 30_00);
    expect([1, 2, 3, 4, 5].map((x) => pathOf(world, x, 1))).toEqual([
      PATH_FOOT,
      PATH_FOOT,
      PATH_QUEUE,
      PATH_QUEUE,
      PATH_QUEUE,
    ]);
  });

  it("bumps pathVersion on apply and on revert, and not on a rejection", () => {
    const { world, sim } = pondAndPlateau();
    expect(world.pathVersion).toBe(0);
    run(sim, "path_build", { x: 1, y: 1, w: 2, h: 1, kind: "foot" });
    expect(world.pathVersion).toBe(1);
    expect(sim.execute("path_build", { x: 9, y: 8, w: 1, h: 1, kind: "foot" }).ok).toBe(false);
    expect(world.pathVersion).toBe(1);
    sim.undo();
    expect(world.pathVersion).toBe(2);
    sim.redo();
    expect(world.pathVersion).toBe(3);
  });

  it("does not put pathVersion in the hash", () => {
    const { world } = setup();
    const before = hashWorld(world);
    world.pathVersion += 5;
    expect(hashWorld(world)).toBe(before);
  });
});

describe("path_remove", () => {
  it("restores tiles to none for nothing, and undo restores the previous kinds", () => {
    const { world, sim } = setup();
    run(sim, "path_build", { x: 1, y: 1, w: 2, h: 1, kind: "foot" });
    run(sim, "path_build", { x: 3, y: 1, w: 2, h: 1, kind: "queue" });
    const built = snapshot(world);
    const cash = world.finance.cash;

    expect(sim.execute("path_remove", { x: 1, y: 1, w: 4, h: 1 })).toMatchObject({
      ok: true,
      cost: 0,
    });
    expect(world.finance.cash).toBe(cash);
    expect([1, 2, 3, 4].map((x) => pathOf(world, x, 1))).toEqual([0, 0, 0, 0]);

    expect(sim.undo().ok).toBe(true);
    expect(snapshot(world)).toEqual(built);
    expect([1, 2, 3, 4].map((x) => pathOf(world, x, 1))).toEqual([
      PATH_FOOT,
      PATH_FOOT,
      PATH_QUEUE,
      PATH_QUEUE,
    ]);
    expect(world.finance.cash).toBe(cash);
  });

  it("does not count tiles that have no path", () => {
    const { world, sim } = setup();
    run(sim, "path_build", { x: 2, y: 2, w: 1, h: 1, kind: "foot" });
    const result = sim.execute("path_remove", { x: 1, y: 1, w: 3, h: 3 });
    expect(result).toMatchObject({ ok: true, cost: 0 });
    const entry = world.log.at(-1);
    expect(entry?.undo).toEqual({ tiles: [[2 * 16 + 2, PATH_FOOT]] });
  });

  it("is free and leaves nothing to restore on a bare rectangle", () => {
    const { world, sim } = setup();
    expect(sim.execute("path_remove", { x: 0, y: 0, w: 4, h: 4 })).toMatchObject({
      ok: true,
      cost: 0,
    });
    expect(world.log.at(-1)?.undo).toEqual({ tiles: [] });
    expect(sim.undo().ok).toBe(true);
    expect(world.terrain.path.every((v) => v === 0)).toBe(true);
  });

  it("rejects a rectangle off the map", () => {
    const { sim } = setup();
    expect(sim.execute("path_remove", { x: 15, y: 15, w: 2, h: 1 })).toEqual({
      ok: false,
      error: "Area is outside the park",
    });
  });

  it("bumps pathVersion on apply and on revert", () => {
    const { world, sim } = setup();
    run(sim, "path_build", { x: 1, y: 1, w: 1, h: 1, kind: "foot" });
    const start = world.pathVersion;
    run(sim, "path_remove", { x: 1, y: 1, w: 1, h: 1 });
    expect(world.pathVersion).toBe(start + 1);
    sim.undo();
    expect(world.pathVersion).toBe(start + 2);
  });
});
