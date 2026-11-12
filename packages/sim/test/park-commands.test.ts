import { describe, expect, it } from "vitest";
import {
  ENTRANCE_COST,
  PATH_FOOT,
  PATH_NONE,
  Sim,
  createWorld,
  hashWorld,
  pathAt,
  type World,
} from "../src/index.js";

const CASH = 1_000_000_00;

function setup(width = 16, height = 12) {
  const world = createWorld({ width, height, seed: 5, name: "Parkland", cash: CASH });
  return { world, sim: new Sim(world) };
}

function run(sim: Sim, name: string, input: unknown): void {
  const result = sim.execute(name, input);
  if (!result.ok) throw new Error(`${name} failed: ${result.error}`);
}

function pathOf(world: World, x: number, y: number): number {
  return pathAt(world.terrain, x, y);
}

/** What the park commands can change. An undo logs an entry of its own, so the hash is no use. */
function snapshot(world: World) {
  return {
    path: Array.from(world.terrain.path),
    park: structuredClone(world.park),
    cash: world.finance.cash,
  };
}

describe("park state on a new world", () => {
  it("starts closed, with the default fee, rating, and no entrance or takings", () => {
    const { world } = setup();
    expect(world.park).toEqual({
      name: "Parkland",
      open: false,
      entryFee: 10_00,
      entrance: null,
      rating: 500,
      guestsInPark: 0,
      totalAdmissions: 0,
      income: { entry: 0, rides: 0, shops: 0 },
      expenses: { running: 0, wages: 0 },
      monthly: { entry: 0, rides: 0, shops: 0, running: 0, wages: 0 },
      history: [],
    });
    expect(world.pathVersion).toBe(0);
    expect(world.terrain.path).toBeInstanceOf(Uint8Array);
    expect(world.terrain.path).toHaveLength(16 * 12);
    expect(world.terrain.path.every((v) => v === 0)).toBe(true);
  });
});

describe("park_set_entrance", () => {
  it("costs $500 and sets the entrance with the side of the edge it is on", () => {
    const { world, sim } = setup();
    expect(ENTRANCE_COST).toBe(500_00);
    expect(sim.execute("park_set_entrance", { x: 5, y: 11 })).toMatchObject({
      ok: true,
      cost: 500_00,
    });
    expect(world.park.entrance).toEqual({ x: 5, y: 11, side: 2 });
    expect(world.finance.cash).toBe(CASH - 500_00);
  });

  it("sets side 0 on the north edge, 1 on the east, 2 on the south, 3 on the west", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entrance", { x: 4, y: 0 });
    expect(world.park.entrance).toEqual({ x: 4, y: 0, side: 0 });
    run(sim, "park_set_entrance", { x: 15, y: 4 });
    expect(world.park.entrance).toEqual({ x: 15, y: 4, side: 1 });
    run(sim, "park_set_entrance", { x: 4, y: 11 });
    expect(world.park.entrance).toEqual({ x: 4, y: 11, side: 2 });
    run(sim, "park_set_entrance", { x: 0, y: 4 });
    expect(world.park.entrance).toEqual({ x: 0, y: 4, side: 3 });
  });

  it("gives a corner the first side in the order north, east, south, west", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entrance", { x: 0, y: 0 });
    expect(world.park.entrance?.side).toBe(0);
    run(sim, "park_set_entrance", { x: 15, y: 11 });
    expect(world.park.entrance?.side).toBe(1);
    run(sim, "park_set_entrance", { x: 0, y: 11 });
    expect(world.park.entrance?.side).toBe(2);
  });

  it("must be on the park edge", () => {
    const { world, sim } = setup();
    for (const [x, y] of [
      [5, 5],
      [1, 1],
      [14, 10],
      [1, 6],
    ]) {
      expect(sim.execute("park_set_entrance", { x, y }), `(${x}, ${y})`).toEqual({
        ok: false,
        error: "The entrance must be on the park edge",
      });
    }
    expect(world.park.entrance).toBeNull();
    expect(world.finance.cash).toBe(CASH);
  });

  it("must be on the map", () => {
    const { sim } = setup();
    expect(sim.execute("park_set_entrance", { x: 16, y: 3 })).toEqual({
      ok: false,
      error: "Area is outside the park",
    });
    expect(sim.execute("park_set_entrance", { x: 3, y: 12 })).toEqual({
      ok: false,
      error: "Area is outside the park",
    });
    expect(sim.execute("park_set_entrance", { x: -1, y: 3 }).ok).toBe(false);
  });

  it("cannot be on water", () => {
    const { world, sim } = setup();
    run(sim, "terrain_set_water", { x: 6, y: 0, w: 2, h: 1, level: 12 });
    expect(sim.execute("park_set_entrance", { x: 6, y: 0 })).toEqual({
      ok: false,
      error: "Cannot build on water",
    });
    expect(world.park.entrance).toBeNull();
  });

  it("moving it refunds nothing and charges again", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entrance", { x: 4, y: 0 });
    expect(sim.execute("park_set_entrance", { x: 9, y: 0 })).toMatchObject({
      ok: true,
      cost: 500_00,
    });
    expect(world.park.entrance).toEqual({ x: 9, y: 0, side: 0 });
    expect(world.finance.cash).toBe(CASH - 1000_00);
  });

  it("refuses when the park cannot pay", () => {
    const world = createWorld({ width: 8, height: 8, seed: 1, name: "Poor", cash: 499_99 });
    const sim = new Sim(world);
    const result = sim.execute("park_set_entrance", { x: 0, y: 3 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^Not enough cash/);
    expect(world.park.entrance).toBeNull();
  });

  it("replaces a path on the tile, and undo brings back the path and the old entrance", () => {
    const { world, sim } = setup();
    run(sim, "path_build", { x: 3, y: 0, w: 4, h: 1, kind: "foot" });
    run(sim, "park_set_entrance", { x: 1, y: 0 });
    const before = snapshot(world);
    const cash = world.finance.cash;

    run(sim, "park_set_entrance", { x: 5, y: 0 });
    expect(world.park.entrance).toEqual({ x: 5, y: 0, side: 0 });
    expect(pathOf(world, 5, 0)).toBe(PATH_NONE);
    expect(pathOf(world, 4, 0)).toBe(PATH_FOOT);
    expect(pathOf(world, 6, 0)).toBe(PATH_FOOT);

    expect(sim.undo().ok).toBe(true);
    expect(world.park.entrance).toEqual({ x: 1, y: 0, side: 0 });
    expect(pathOf(world, 5, 0)).toBe(PATH_FOOT);
    expect(world.finance.cash).toBe(cash);
    expect(snapshot(world)).toEqual(before);

    expect(sim.redo().ok).toBe(true);
    expect(world.park.entrance).toEqual({ x: 5, y: 0, side: 0 });
    expect(pathOf(world, 5, 0)).toBe(PATH_NONE);
    expect(world.finance.cash).toBe(cash - 500_00);
  });

  it("undoing the first placement leaves no entrance", () => {
    const { world, sim } = setup();
    const before = snapshot(world);
    run(sim, "park_set_entrance", { x: 0, y: 5 });
    expect(world.park.entrance).not.toBeNull();
    expect(sim.undo().ok).toBe(true);
    expect(snapshot(world)).toEqual(before);
    expect(world.park.entrance).toBeNull();
    expect(world.redoStack).toHaveLength(1);
  });

  it("saves plain JSON undo data that does not point into the world", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entrance", { x: 2, y: 0 });
    run(sim, "path_build", { x: 8, y: 0, w: 1, h: 1, kind: "queue" });
    run(sim, "park_set_entrance", { x: 8, y: 0 });
    const entry = world.log.at(-1);
    expect(JSON.parse(JSON.stringify(entry?.undo))).toEqual(entry?.undo);
    expect(entry?.undo).toEqual({
      entrance: { x: 2, y: 0, side: 0 },
      tile: [8, 2],
    });
    // The saved entrance is its own object, not the one in the world.
    expect((entry?.undo as { entrance: object }).entrance).not.toBe(world.park.entrance);
  });

  it("bumps pathVersion on apply and on revert", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entrance", { x: 2, y: 0 });
    expect(world.pathVersion).toBe(1);
    sim.undo();
    expect(world.pathVersion).toBe(2);
    sim.redo();
    expect(world.pathVersion).toBe(3);
    expect(sim.execute("park_set_entrance", { x: 5, y: 5 }).ok).toBe(false);
    expect(world.pathVersion).toBe(3);
  });
});

describe("park_set_entry_fee", () => {
  it("sets the fee in cents, for nothing", () => {
    const { world, sim } = setup();
    expect(sim.execute("park_set_entry_fee", { cents: 5_00 })).toMatchObject({ ok: true, cost: 0 });
    expect(world.park.entryFee).toBe(5_00);
    expect(world.finance.cash).toBe(CASH);
  });

  it("accepts 0 and $100, and nothing outside that or fractional", () => {
    const { world, sim } = setup();
    expect(sim.execute("park_set_entry_fee", { cents: 0 }).ok).toBe(true);
    expect(world.park.entryFee).toBe(0);
    expect(sim.execute("park_set_entry_fee", { cents: 100_00 }).ok).toBe(true);
    expect(world.park.entryFee).toBe(100_00);
    for (const cents of [100_01, -1, 1.5, "5", null]) {
      expect(sim.execute("park_set_entry_fee", { cents }).ok, String(cents)).toBe(false);
    }
    expect(sim.execute("park_set_entry_fee", {}).ok).toBe(false);
    expect(world.park.entryFee).toBe(100_00);
  });

  it("undo restores the previous fee, and redo sets it again", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entry_fee", { cents: 7_50 });
    expect(sim.undo().ok).toBe(true);
    expect(world.park.entryFee).toBe(10_00);
    expect(world.undoStack).toEqual([]);
    expect(sim.redo().ok).toBe(true);
    expect(world.park.entryFee).toBe(7_50);
  });
});

describe("park_open and park_close", () => {
  it("opening needs an entrance", () => {
    const { world, sim } = setup();
    expect(sim.execute("park_open", {})).toEqual({
      ok: false,
      error: "Place the park entrance first",
    });
    expect(world.park.open).toBe(false);
  });

  it("toggle the open flag for nothing", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entrance", { x: 0, y: 5 });
    const cash = world.finance.cash;
    expect(sim.execute("park_open", {})).toMatchObject({ ok: true, cost: 0 });
    expect(world.park.open).toBe(true);
    expect(sim.execute("park_close", {})).toMatchObject({ ok: true, cost: 0 });
    expect(world.park.open).toBe(false);
    expect(world.finance.cash).toBe(cash);
  });

  it("closing needs no entrance", () => {
    const { world, sim } = setup();
    expect(sim.execute("park_close", {}).ok).toBe(true);
    expect(world.park.open).toBe(false);
  });

  it("undo puts the flag back where it was", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entrance", { x: 0, y: 5 });
    run(sim, "park_open", {});
    run(sim, "park_close", {});
    expect(world.park.open).toBe(false);
    expect(sim.undo().ok).toBe(true);
    expect(world.park.open).toBe(true);
    expect(sim.undo().ok).toBe(true);
    expect(world.park.open).toBe(false);
    expect(sim.redo().ok).toBe(true);
    expect(world.park.open).toBe(true);
  });

  it("opening an open park or closing a closed one changes nothing and undoes cleanly", () => {
    const { world, sim } = setup();
    run(sim, "park_set_entrance", { x: 0, y: 5 });
    run(sim, "park_open", {});
    run(sim, "park_open", {});
    expect(world.park.open).toBe(true);
    expect(sim.undo().ok).toBe(true);
    expect(world.park.open).toBe(true);
  });
});

describe("park_rename", () => {
  it("renames the park, and undo brings the old name back", () => {
    const { world, sim } = setup();
    expect(sim.execute("park_rename", { name: "Wobbly Hills" })).toMatchObject({
      ok: true,
      cost: 0,
    });
    expect(world.park.name).toBe("Wobbly Hills");
    expect(world.meta.name).toBe("Parkland");
    expect(sim.undo().ok).toBe(true);
    expect(world.park.name).toBe("Parkland");
    expect(sim.redo().ok).toBe(true);
    expect(world.park.name).toBe("Wobbly Hills");
  });

  it("takes 1 to 40 characters", () => {
    const { world, sim } = setup();
    expect(sim.execute("park_rename", { name: "x" }).ok).toBe(true);
    expect(sim.execute("park_rename", { name: "y".repeat(40) }).ok).toBe(true);
    expect(sim.execute("park_rename", { name: "" }).ok).toBe(false);
    expect(sim.execute("park_rename", { name: "z".repeat(41) }).ok).toBe(false);
    expect(sim.execute("park_rename", { name: 7 }).ok).toBe(false);
    expect(world.park.name).toBe("y".repeat(40));
  });
});

describe("park commands and the hash", () => {
  it("every park command moves the hash, so a replay that drops one is caught", () => {
    const { world, sim } = setup();
    const seen = new Set<string>([hashWorld(world)]);
    const steps: Array<[string, unknown]> = [
      ["park_set_entrance", { x: 3, y: 0 }],
      ["park_set_entry_fee", { cents: 12_00 }],
      ["park_open", {}],
      ["park_rename", { name: "Hashville" }],
      ["path_build", { x: 3, y: 1, w: 1, h: 3, kind: "queue" }],
    ];
    for (const [name, input] of steps) {
      run(sim, name, input);
      const hash = hashWorld(world);
      expect(seen.has(hash), name).toBe(false);
      seen.add(hash);
    }
  });
});

describe("undoing park_open", () => {
  it("closes the park the way park_close does: the guests inside go home", () => {
    const { world, sim } = setup(16, 16);
    run(sim, "park_set_entrance", { x: 0, y: 8 });
    run(sim, "path_build", { x: 1, y: 8, w: 10, h: 1, kind: "foot" });
    world.park.entryFee = 0;
    world.park.rating = 999;
    run(sim, "park_open", {});
    sim.step(3000);
    expect(world.park.guestsInPark).toBeGreaterThan(0);

    expect(sim.undo().ok).toBe(true);
    expect(world.park.open).toBe(false);
    sim.step(3000);
    expect(world.park.guestsInPark).toBe(0);
  });
});
