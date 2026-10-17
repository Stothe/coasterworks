import { describe, expect, it } from "vitest";
import {
  type CatalogEntry,
  MAX_HEIGHT,
  Sim,
  createDefaultRegistry,
  createWorld,
  getCorner,
  setCorner,
  tileIndex,
} from "../src/index.js";

function setup(opts: { width?: number; height?: number } = {}) {
  const world = createWorld({
    width: opts.width ?? 16,
    height: opts.height ?? 16,
    seed: 7,
    name: "Queryland",
    cash: 1_000_000,
  });
  return { world, sim: new Sim(world) };
}

describe("default registry", () => {
  it("registers the six queries, after the commands, with their categories", () => {
    const queries = createDefaultRegistry()
      .catalog()
      .filter((e) => e.kind === "query");
    expect(queries.map((e) => [e.name, e.category, e.undoable])).toEqual([
      ["park_status", "park", false],
      ["park_bounds", "park", false],
      ["terrain_get", "terrain", false],
      ["log_recent", "sim", false],
      ["undo_state", "sim", false],
      ["catalog_list", "sim", false],
    ]);
  });
});

describe("catalog_list", () => {
  /** Runs `catalog_list` and returns its entries. */
  function list(): CatalogEntry[] {
    const { sim } = setup();
    const out = sim.query("catalog_list", {});
    if (!out.ok) throw new Error(out.error);
    return out.result as CatalogEntry[];
  }

  it("returns the registry's catalog: every command and query, itself included", () => {
    const { sim } = setup();
    const entries = list();
    expect(entries).toEqual(sim.registry.catalog());

    const kinds = (kind: CatalogEntry["kind"]) =>
      entries.filter((e) => e.kind === kind).map((e) => e.name);
    expect(kinds("command")).toEqual(sim.registry.commands().map((def) => def.name));
    expect(kinds("query")).toEqual(sim.registry.queries().map((def) => def.name));
    expect(kinds("query")).toContain("catalog_list");
  });

  it("gives every entry its kind, undo flag, and a JSON Schema for its input", () => {
    for (const entry of list()) {
      expect(["command", "query"], entry.name).toContain(entry.kind);
      expect(typeof entry.description, entry.name).toBe("string");
      expect(typeof entry.undoable, entry.name).toBe("boolean");
      expect(entry.inputSchema["type"], entry.name).toBe("object");
    }
    const raise = list().find((e) => e.name === "terrain_raise");
    expect(raise).toMatchObject({ category: "terrain", kind: "command", undoable: true });
    expect(Object.keys(raise?.inputSchema["properties"] as object)).toEqual([
      "x",
      "y",
      "w",
      "h",
      "steps",
    ]);
  });

  it("is plain JSON, so it crosses the worker and the wire unchanged", () => {
    const entries = list();
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
  });

  it("takes no input: stray keys are ignored and a non-object is refused", () => {
    const { sim } = setup();
    expect(sim.query("catalog_list", { extra: 1 }).ok).toBe(true);
    expect(sim.query("catalog_list", null).ok).toBe(false);
  });
});

describe("park_status", () => {
  it("describes a fresh park", () => {
    const { sim } = setup();
    expect(sim.query("park_status", {})).toEqual({
      ok: true,
      result: {
        name: "Queryland",
        tick: 0,
        date: "March 1, Year 1",
        year: 1,
        month: 0,
        day: 1,
        cash: 1_000_000,
        monthStartCash: 1_000_000,
        loan: 0,
        guests: 0,
        rating: 0,
        width: 16,
        height: 16,
      },
    });
  });

  it("follows the clock and the money", () => {
    const { sim } = setup({ width: 8, height: 4 });
    sim.execute("finance_take_loan", { amount: 5_000_00 });
    sim.advanceDays(40);
    expect(sim.query("park_status", {})).toEqual({
      ok: true,
      result: {
        name: "Queryland",
        tick: 16_000,
        date: "April 10, Year 1",
        year: 1,
        month: 1,
        day: 10,
        // One month of interest on the loan has been charged: 5,000.00 at 10% a year over 8 months.
        cash: 1_000_000 + 5_000_00 - 62_50,
        // April began after the interest was charged and nothing has moved the cash since.
        monthStartCash: 1_000_000 + 5_000_00 - 62_50,
        loan: 5_000_00,
        guests: 0,
        rating: 0,
        width: 8,
        height: 4,
      },
    });
  });
});

describe("park_status: the month's starting cash", () => {
  it("stays where the month began while the cash moves, so a player can see the month's change", () => {
    const { sim } = setup();
    sim.execute("finance_take_loan", { amount: 2_000_00 });
    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 });
    const status = sim.query("park_status", {});
    expect(status.ok && (status.result as { cash: number; monthStartCash: number })).toMatchObject({
      monthStartCash: 1_000_000,
    });
    expect(status.ok && (status.result as { cash: number }).cash).not.toBe(1_000_000);
  });
});

describe("park_bounds", () => {
  it("returns the map size and the height limit", () => {
    const { sim } = setup({ width: 12, height: 20 });
    expect(sim.query("park_bounds", {})).toEqual({
      ok: true,
      result: { width: 12, height: 20, maxHeight: MAX_HEIGHT },
    });
  });
});

describe("terrain_get", () => {
  it("returns 9 corners and 4 tiles for a 2x2 area at the origin", () => {
    const { sim } = setup();
    const result = sim.query("terrain_get", { x: 0, y: 0, w: 2, h: 2 });
    expect(result).toEqual({
      ok: true,
      result: {
        x: 0,
        y: 0,
        w: 2,
        h: 2,
        corners: [8, 8, 8, 8, 8, 8, 8, 8, 8],
        surface: [0, 0, 0, 0],
        water: [0, 0, 0, 0],
      },
    });
  });

  it("returns plain arrays that can be serialized", () => {
    const { sim } = setup();
    const result = sim.query("terrain_get", { x: 0, y: 0, w: 3, h: 3 });
    expect(result.ok).toBe(true);
    const data = result.ok ? (result.result as Record<string, unknown>) : {};
    for (const key of ["corners", "surface", "water"]) {
      expect(Array.isArray(data[key])).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

  it("lays out a wide, offset area row-major: a row runs along x, rows stack along y", () => {
    const { world, sim } = setup();
    // The area is 3 tiles wide and 2 tall at (2, 1), so its corners are 4 wide and 3 tall:
    // corner columns are x 2..5 and corner rows are y 1..3. It is not square, so swapping rows
    // and columns changes every index below.
    const [x, y, w, h] = [2, 1, 3, 2];
    // Each feature sits off the diagonal and is alone in its layer.
    setCorner(world.terrain, 5, 1, 21); // column 3, row 0
    setCorner(world.terrain, 4, 2, 20); // column 2, row 1
    expect(sim.execute("terrain_set_surface", { x: 4, y: 1, w: 1, h: 1, surface: 3 }).ok).toBe(
      true,
    ); // column 2, row 0
    expect(sim.execute("terrain_set_water", { x: 2, y: 2, w: 1, h: 1, level: 12 }).ok).toBe(true); // column 0, row 1

    const corners = new Array<number>((w + 1) * (h + 1)).fill(8);
    corners[0 * (w + 1) + 3] = 21;
    corners[1 * (w + 1) + 2] = 20;
    const surface = new Array<number>(w * h).fill(0);
    surface[0 * w + 2] = 3;
    const water = new Array<number>(w * h).fill(0);
    water[1 * w + 0] = 12;

    expect(sim.query("terrain_get", { x, y, w, h })).toEqual({
      ok: true,
      result: { x, y, w, h, corners, surface, water },
    });
    // Spelled out, so the expected arrays above cannot drift from the layout they describe.
    expect(corners).toEqual([8, 8, 8, 21, 8, 8, 20, 8, 8, 8, 8, 8]);
    expect(surface).toEqual([0, 0, 3, 0, 0, 0]);
    expect(water).toEqual([0, 0, 0, 12, 0, 0]);
  });

  it("lays out a tall area the same way, matching the world's own accessors", () => {
    const { world, sim } = setup();
    // Heights, surfaces, and water that differ along x and along y, so no transposition matches.
    const t = world.terrain;
    for (let cy = 0; cy <= t.height; cy++) {
      for (let cx = 0; cx <= t.width; cx++) setCorner(t, cx, cy, (cx * 5 + cy * 2) % 60);
    }
    for (let ty = 0; ty < t.height; ty++) {
      for (let tx = 0; tx < t.width; tx++) {
        t.surface[tileIndex(t, tx, ty)] = (tx + ty * 2) % 5;
        t.water[tileIndex(t, tx, ty)] = (tx * 3 + ty) % 60;
      }
    }

    for (const [x, y, w, h] of [
      [3, 2, 2, 5],
      [1, 4, 6, 2],
      [0, 0, 16, 16],
    ] as const) {
      const result = sim.query("terrain_get", { x, y, w, h });
      expect(result.ok).toBe(true);
      const data = result.ok
        ? (result.result as { corners: number[]; surface: number[]; water: number[] })
        : { corners: [], surface: [], water: [] };
      expect(data.corners).toHaveLength((w + 1) * (h + 1));
      expect(data.surface).toHaveLength(w * h);
      expect(data.water).toHaveLength(w * h);
      for (let row = 0; row <= h; row++) {
        for (let col = 0; col <= w; col++) {
          expect(data.corners[row * (w + 1) + col]).toBe(getCorner(t, x + col, y + row));
        }
      }
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const tile = tileIndex(t, x + col, y + row);
          expect(data.surface[row * w + col]).toBe(t.surface[tile]);
          expect(data.water[row * w + col]).toBe(t.water[tile]);
        }
      }
    }
  });

  it("returns copies, so changing the result does not change the world", () => {
    const { world, sim } = setup();
    const result = sim.query("terrain_get", { x: 0, y: 0, w: 1, h: 1 });
    const data = result.ok ? (result.result as { corners: number[] }) : { corners: [] };
    data.corners[0] = 40;
    expect(world.terrain.corners[0]).toBe(8);
  });

  it("can read the whole map, but not past its edge", () => {
    const { sim } = setup({ width: 5, height: 3 });
    const all = sim.query("terrain_get", { x: 0, y: 0, w: 5, h: 3 });
    expect(all.ok && (all.result as { corners: number[] }).corners).toHaveLength(6 * 4);
    for (const area of [
      { x: 0, y: 0, w: 6, h: 3 },
      { x: 0, y: 0, w: 5, h: 4 },
      { x: 1, y: 0, w: 5, h: 3 },
      { x: 5, y: 0, w: 1, h: 1 },
    ]) {
      expect(sim.query("terrain_get", area)).toEqual({
        ok: false,
        error: "Area is outside the park",
      });
    }
  });

  it("allows 64x64 and rejects anything larger or smaller than one tile", () => {
    const { sim } = setup({ width: 100, height: 100 });
    const big = sim.query("terrain_get", { x: 0, y: 0, w: 64, h: 64 });
    expect(big.ok && (big.result as { corners: number[] }).corners).toHaveLength(65 * 65);

    for (const [field, value] of [
      ["w", 65],
      ["h", 65],
      ["w", 0],
      ["h", 0],
      ["x", -1],
      ["y", -1],
      ["x", 1.5],
    ] as const) {
      const result = sim.query("terrain_get", { x: 0, y: 0, w: 2, h: 2, [field]: value });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(new RegExp(`^${field} \\S`));
    }
  });

  it("rejects a missing field", () => {
    const { sim } = setup();
    const result = sim.query("terrain_get", { x: 0, y: 0, w: 2 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/^h /);
  });
});

describe("log_recent", () => {
  it("returns nothing for an empty log", () => {
    const { sim } = setup();
    expect(sim.query("log_recent", {})).toEqual({ ok: true, result: [] });
  });

  it("returns the newest entries first, without undo data", () => {
    const { sim } = setup();
    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 }, "agent");
    sim.execute("finance_take_loan", { amount: 1_000_00 });
    const result = sim.query("log_recent", {});
    expect(result).toEqual({
      ok: true,
      result: [
        {
          id: 2,
          tick: 0,
          client: "player",
          name: "finance_take_loan",
          input: { amount: 1_000_00 },
          cost: 0,
        },
        {
          id: 1,
          tick: 0,
          client: "agent",
          name: "terrain_raise",
          input: { x: 0, y: 0, w: 1, h: 1, steps: 1 },
          cost: 200_00,
        },
      ],
    });
    const entries = result.ok ? (result.result as object[]) : [];
    for (const entry of entries) expect(entry).not.toHaveProperty("undo");
  });

  it("does not change the entries in the world", () => {
    const { world, sim } = setup();
    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 });
    const before = structuredClone(world.log);
    sim.query("log_recent", {});
    expect(world.log).toEqual(before);
    expect(world.log[0]).toHaveProperty("undo");
  });

  it("returns copies of each input, so changing the result does not change the log", () => {
    const { world, sim } = setup();
    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 });
    sim.execute("finance_take_loan", { amount: 1_000_00 });
    const before = structuredClone(world.log);

    const result = sim.query("log_recent", {});
    const entries = result.ok ? (result.result as Array<Record<string, any>>) : [];
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      entry.input.x = 99;
      entry.input.amount = 1;
      entry.name = "changed";
      entry.cost = -1;
    }

    expect(world.log).toEqual(before);
    // Redo still sees the original input.
    expect(sim.undo().ok).toBe(true);
    expect(sim.redo().ok).toBe(true);
    expect(world.finance.loan).toBe(1_000_00);
  });

  it("includes the undo and redo entries, and keeps undoneBy on an undone command", () => {
    const { sim } = setup();
    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 });
    sim.undo();
    sim.redo();
    sim.undo();
    const result = sim.query("log_recent", {});
    const entries = result.ok ? (result.result as Array<Record<string, unknown>>) : [];
    expect(entries.map((e) => e.name)).toEqual(["undo", "redo", "undo", "terrain_raise"]);
    expect(entries[0]).toMatchObject({ input: { target: 1 } });
    // The second undo set `undoneBy` again after the redo cleared it.
    expect(entries[3]).toMatchObject({ undoneBy: 4 });
    expect(entries[3]).not.toHaveProperty("undo");
  });

  it("returns 20 entries by default and as many as asked up to 200", () => {
    const { sim } = setup({ width: 4, height: 4 });
    for (let i = 0; i < 250; i++) sim.execute("sim_advance", { days: 1 });
    const count = (input: unknown) => {
      const result = sim.query("log_recent", input);
      return result.ok ? (result.result as unknown[]).length : -1;
    };
    expect(count({})).toBe(20);
    expect(count({ limit: 1 })).toBe(1);
    expect(count({ limit: 200 })).toBe(200);
    const newest = sim.query("log_recent", { limit: 3 });
    expect(newest.ok && (newest.result as Array<{ id: number }>).map((e) => e.id)).toEqual([
      250, 249, 248,
    ]);
  });

  it("returns every entry when fewer than the limit exist", () => {
    const { sim } = setup();
    sim.execute("sim_advance", { days: 1 });
    const result = sim.query("log_recent", { limit: 50 });
    expect(result.ok && (result.result as unknown[]).length).toBe(1);
  });

  it("rejects a limit outside 1 to 200", () => {
    const { sim } = setup();
    for (const limit of [0, -1, 201, 1.5, "ten"]) {
      const result = sim.query("log_recent", { limit });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(/^limit \S/);
    }
  });
});

describe("undo_state", () => {
  it("starts with nothing to undo or redo", () => {
    const { sim } = setup();
    expect(sim.query("undo_state", {})).toEqual({
      ok: true,
      result: { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 },
    });
  });

  it("can undo after a command", () => {
    const { sim } = setup();
    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 });
    expect(sim.query("undo_state", {})).toEqual({
      ok: true,
      result: { canUndo: true, canRedo: false, undoCount: 1, redoCount: 0 },
    });
  });

  it("moves a command from the undo count to the redo count, and back", () => {
    const { sim } = setup();
    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 });
    sim.execute("terrain_lower", { x: 0, y: 0, w: 1, h: 1 });
    sim.undo();
    expect(sim.query("undo_state", {})).toEqual({
      ok: true,
      result: { canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 },
    });
    sim.undo();
    expect(sim.query("undo_state", {})).toEqual({
      ok: true,
      result: { canUndo: false, canRedo: true, undoCount: 0, redoCount: 2 },
    });
    sim.redo();
    expect(sim.query("undo_state", {})).toEqual({
      ok: true,
      result: { canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 },
    });
  });

  it("does not count commands that cannot be undone", () => {
    const { sim } = setup();
    sim.execute("sim_advance", { days: 1 });
    expect(sim.query("undo_state", {})).toEqual({
      ok: true,
      result: { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 },
    });
  });
});

describe("queries never change the world", () => {
  it("leave the hash and the log as they were", () => {
    const { world, sim } = setup();
    sim.execute("terrain_raise", { x: 0, y: 0, w: 2, h: 2 });
    sim.undo();
    const hash = sim.hash();
    const logLength = world.log.length;
    sim.query("park_status", {});
    sim.query("park_bounds", {});
    sim.query("terrain_get", { x: 0, y: 0, w: 4, h: 4 });
    sim.query("log_recent", { limit: 200 });
    sim.query("undo_state", {});
    expect(sim.hash()).toBe(hash);
    expect(world.log).toHaveLength(logLength);
  });
});
