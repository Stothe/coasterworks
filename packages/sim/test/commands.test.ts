import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Registry,
  createWorld,
  defineCommand,
  defineQuery,
  executeCommand,
  hashWorld,
  redoLast,
  runQuery,
  undoLast,
  type QueryDef,
  type World,
} from "../src/index.js";

/** Adds cash. Undoable, free. Rejects amounts over $10,000 through `validate`. */
const addCash = defineCommand({
  name: "test_add_cash",
  description: "Adds cash to the park.",
  category: "finance",
  input: z.object({ amount: z.int().positive() }),
  undoable: true,
  validate: (_world, input) => (input.amount > 1_000_000 ? "Amount is over $10,000" : null),
  apply: (world, input) => {
    world.finance.cash += input.amount;
  },
  revert: (world, input) => {
    world.finance.cash -= input.amount;
  },
});

/**
 * Costs `amount` cents and marks the first tile. Refuses to run on a marked tile, and refuses to be
 * undone once the tile has been changed by something else.
 */
const spend = defineCommand({
  name: "test_spend",
  description: "Spends cash to mark the first tile.",
  category: "park",
  input: z.object({ amount: z.int().positive() }),
  undoable: true,
  cost: (_world, input) => input.amount,
  validate: (world) => (world.terrain.surface[0] === 0 ? null : "Tile is already marked"),
  apply: (world) => {
    world.terrain.surface[0] = 1;
    return { previous: 0 };
  },
  revert: (world, _input, undo) => {
    world.terrain.surface[0] = undo.previous;
  },
  validateRevert: (world) =>
    world.terrain.surface[0] === 1 ? null : "Tile was changed since it was marked",
});

/** Free, and not undoable. */
const note = defineCommand({
  name: "test_note",
  description: "Does something that cannot be undone.",
  category: "sim",
  input: z.object({}),
  undoable: false,
  validate: () => null,
  apply: (world) => {
    world.terrain.water[0] = 1;
  },
  revert: () => {},
});

/** Has a nested input and a root-level refinement, to exercise Zod error formatting. */
const place = defineCommand({
  name: "test_place",
  description: "Takes a nested position.",
  category: "terrain",
  input: z
    .object({ pos: z.object({ x: z.int(), y: z.int() }) })
    .refine((input) => input.pos.x !== input.pos.y, "x and y must differ"),
  undoable: false,
  validate: () => null,
  apply: () => {},
  revert: () => {},
});

const peek = {
  name: "test_peek_cash",
  description: "Reads cash, plus an optional extra.",
  category: "finance",
  input: z.object({ extra: z.int().default(0) }),
  run: (world: World, input: { extra: number }) => world.finance.cash + input.extra,
} satisfies QueryDef<{ extra: number }, number>;

function makeRegistry(): Registry {
  const registry = new Registry();
  for (const def of [addCash, spend, note, place]) registry.register(def);
  registry.registerQuery(peek);
  return registry;
}

function setup(cash = 1_000_00): { world: World; registry: Registry } {
  return {
    world: createWorld({ width: 4, height: 4, seed: 1, name: "t", cash }),
    registry: makeRegistry(),
  };
}

function expectError(result: { ok: boolean }): string {
  expect(result.ok).toBe(false);
  const error = (result as { error?: string }).error;
  expect(typeof error).toBe("string");
  return error as string;
}

describe("Registry", () => {
  it("registers commands and queries and finds them by name", () => {
    const registry = makeRegistry();
    expect(registry.command("test_add_cash")).toBe(addCash);
    expect(registry.command("test_peek_cash")).toBeUndefined();
    expect(registry.query("test_peek_cash")).toBe(peek);
    expect(registry.query("test_add_cash")).toBeUndefined();
    expect(registry.command("nope_nothing")).toBeUndefined();
    expect(registry.commands().map((c) => c.name)).toEqual([
      "test_add_cash",
      "test_spend",
      "test_note",
      "test_place",
    ]);
    expect(registry.queries().map((q) => q.name)).toEqual(["test_peek_cash"]);
  });

  it("rejects names that do not match the command name pattern", () => {
    const registry = new Registry();
    for (const name of [
      "Bad.Name",
      "Bad_Name",
      "nounderscore",
      "_lead_ing",
      "trail_",
      "a__b",
      "a_b-c",
      "",
    ]) {
      expect(() => registry.register({ ...addCash, name }), name).toThrow(/name/i);
      expect(() => registry.registerQuery({ ...peek, name }), name).toThrow(/name/i);
    }
    expect(registry.commands()).toEqual([]);
    expect(registry.queries()).toEqual([]);
    expect(() => registry.register({ ...addCash, name: "a_b" })).not.toThrow();
    expect(() => registry.register({ ...addCash, name: "build_ride_2" })).not.toThrow();
  });

  it("reserves the names of the MCP file tools, for commands and queries alike", () => {
    const registry = new Registry();
    for (const name of ["save_write", "save_load"]) {
      expect(() => registry.register({ ...addCash, name }), name).toThrow(
        `Name is reserved for MCP built-in tools: ${name}`,
      );
      expect(() => registry.registerQuery({ ...peek, name }), name).toThrow(
        `Name is reserved for MCP built-in tools: ${name}`,
      );
    }
    expect(registry.commands()).toEqual([]);
    expect(registry.queries()).toEqual([]);
    // Only the exact names are taken; the rest of the `save_` family is free.
    expect(() => registry.register({ ...addCash, name: "save_game" })).not.toThrow();
  });

  it("rejects a name that is already registered, across commands and queries", () => {
    const registry = makeRegistry();
    expect(() => registry.register(addCash)).toThrow(/already registered/);
    expect(() => registry.registerQuery(peek)).toThrow(/already registered/);
    expect(() => registry.registerQuery({ ...peek, name: "test_add_cash" })).toThrow(
      /already registered/,
    );
    expect(() => registry.register({ ...addCash, name: "test_peek_cash" })).toThrow(
      /already registered/,
    );
  });

  it("rejects an input that is not an object schema", () => {
    const registry = new Registry();
    const notObject = z.string() as unknown as typeof addCash.input;
    expect(() => registry.register({ ...addCash, input: notObject })).toThrow(/object schema/);
    expect(() => registry.registerQuery({ ...peek, input: notObject })).toThrow(/object schema/);
    expect(registry.commands()).toEqual([]);
    expect(registry.queries()).toEqual([]);
  });

  it("accepts object schemas in strict and loose flavours", () => {
    const registry = new Registry();
    registry.register({
      ...addCash,
      name: "test_strict",
      input: z.strictObject({ amount: z.int() }),
    });
    registry.register({
      ...addCash,
      name: "test_loose",
      input: z.looseObject({ amount: z.int() }),
    });
    expect(registry.commands()).toHaveLength(2);
  });

  it("describes every command and query in the catalog with a JSON Schema", () => {
    const catalog = makeRegistry().catalog();
    expect(catalog.map((e) => `${e.kind}:${e.name}`)).toEqual([
      "command:test_add_cash",
      "command:test_spend",
      "command:test_note",
      "command:test_place",
      "query:test_peek_cash",
    ]);

    const add = catalog.find((e) => e.name === "test_add_cash");
    expect(add).toMatchObject({
      name: "test_add_cash",
      description: "Adds cash to the park.",
      category: "finance",
      undoable: true,
      kind: "command",
    });
    const props = add?.inputSchema["properties"] as Record<string, { type: string }>;
    expect(props["amount"]?.type).toBe("integer");
    expect(add?.inputSchema["required"]).toEqual(["amount"]);

    expect(catalog.find((e) => e.name === "test_note")?.undoable).toBe(false);

    const query = catalog.find((e) => e.name === "test_peek_cash");
    expect(query).toMatchObject({ kind: "query", undoable: false, category: "finance" });
    // Describes what callers send, so a defaulted field is optional.
    expect(query?.inputSchema["required"]).toBeUndefined();
    expect(Object.keys(query?.inputSchema["properties"] as object)).toEqual(["extra"]);
  });
});

describe("executeCommand", () => {
  it("returns an error for an unknown command and changes nothing", () => {
    const { world, registry } = setup();
    const before = hashWorld(world);
    const error = expectError(executeCommand(world, registry, "nope_nothing", {}, "player"));
    expect(error).toBe("Unknown command: nope_nothing");
    expect(hashWorld(world)).toBe(before);
  });

  it("returns the Zod message for bad input and changes nothing", () => {
    const { world, registry } = setup();
    const before = hashWorld(world);
    const cash = world.finance.cash;

    const negative = expectError(
      executeCommand(world, registry, "test_add_cash", { amount: -5 }, "player"),
    );
    expect(negative).toMatch(/^amount \S/);
    const missing = expectError(executeCommand(world, registry, "test_add_cash", {}, "player"));
    expect(missing).toMatch(/^amount \S/);
    const wrongType = expectError(
      executeCommand(world, registry, "test_add_cash", { amount: "9" }, "agent"),
    );
    expect(wrongType).toMatch(/^amount \S/);

    expect(world.finance.cash).toBe(cash);
    expect(world.log).toEqual([]);
    expect(hashWorld(world)).toBe(before);
  });

  it("joins issue paths with dots and issues with semicolons; root issues show only the message", () => {
    const { world, registry } = setup();

    const nested = expectError(
      executeCommand(world, registry, "test_place", { pos: { x: 1.5, y: "no" } }, "player"),
    );
    const parts = nested.split("; ");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^pos\.x \S/);
    expect(parts[1]).toMatch(/^pos\.y \S/);

    const root = expectError(
      executeCommand(world, registry, "test_place", { pos: { x: 2, y: 2 } }, "player"),
    );
    expect(root).toBe("x and y must differ");

    const notAnObject = expectError(
      executeCommand(world, registry, "test_place", "text", "player"),
    );
    expect(notAnObject).not.toMatch(/^\s/);
    expect(notAnObject.length).toBeGreaterThan(0);
  });

  it("returns a validate rejection verbatim and changes nothing", () => {
    const { world, registry } = setup();
    const before = hashWorld(world);
    const error = expectError(
      executeCommand(world, registry, "test_add_cash", { amount: 2_000_000 }, "player"),
    );
    expect(error).toBe("Amount is over $10,000");
    expect(hashWorld(world)).toBe(before);
  });

  it("refuses a command that costs more than the cash on hand", () => {
    const { world, registry } = setup(100);
    const before = hashWorld(world);
    const error = expectError(
      executeCommand(world, registry, "test_spend", { amount: 500 }, "player"),
    );
    expect(error).toBe("Not enough cash: need $5.00, have $1.00");
    expect(world.terrain.surface[0]).toBe(0);
    expect(hashWorld(world)).toBe(before);
  });

  it("formats large and negative amounts without separators", () => {
    const { world, registry } = setup(1_234_567_89);
    world.finance.cash = -350;
    const error = expectError(
      executeCommand(world, registry, "test_spend", { amount: 1_234_567_89 }, "player"),
    );
    expect(error).toBe("Not enough cash: need $1234567.89, have -$3.50");
  });

  it("allows a command that costs exactly the cash on hand", () => {
    const { world, registry } = setup(500);
    const result = executeCommand(world, registry, "test_spend", { amount: 500 }, "player");
    expect(result.ok).toBe(true);
    expect(world.finance.cash).toBe(0);
  });

  it("does not block a free command when cash is negative", () => {
    const { world, registry } = setup();
    world.finance.cash = -1000;
    expect(executeCommand(world, registry, "test_note", {}, "player").ok).toBe(true);
    expect(world.finance.cash).toBe(-1000);
  });

  it("applies, charges, and logs a successful command", () => {
    const { world, registry } = setup(1_000);
    world.tick = 7;
    const result = executeCommand(
      world,
      registry,
      "test_spend",
      { amount: 300, ignored: true },
      "agent",
    );
    expect(result).toEqual({ ok: true, id: 1, cost: 300 });
    expect(world.finance.cash).toBe(700);
    expect(world.terrain.surface[0]).toBe(1);
    expect(world.nextId).toBe(2);
    expect(world.log).toEqual([
      {
        id: 1,
        tick: 7,
        client: "agent",
        name: "test_spend",
        input: { amount: 300 },
        cost: 300,
        undo: { previous: 0 },
      },
    ]);
    expect(world.undoStack).toEqual([1]);
    expect(world.redoStack).toEqual([]);
  });

  it("gives each logged command the next id and logs free commands at zero cost", () => {
    const { world, registry } = setup();
    const a = executeCommand(world, registry, "test_add_cash", { amount: 50 }, "player");
    const b = executeCommand(world, registry, "test_add_cash", { amount: 25 }, "replay");
    expect(a).toEqual({ ok: true, id: 1, cost: 0 });
    expect(b).toEqual({ ok: true, id: 2, cost: 0 });
    expect(world.log.map((e) => [e.id, e.client, e.cost])).toEqual([
      [1, "player", 0],
      [2, "replay", 0],
    ]);
    expect(world.finance.cash).toBe(1_000_00 + 75);
    expect(world.undoStack).toEqual([1, 2]);
  });

  it("logs an undoable command whose apply returns nothing without an undo property", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 10 }, "player");
    expect(world.undoStack).toEqual([1]);
    expect(world.log[0]).not.toHaveProperty("undo");
  });

  it("logs a non-undoable command without putting it on the undo stack", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 10 }, "player");
    const result = executeCommand(world, registry, "test_note", {}, "system");
    expect(result).toEqual({ ok: true, id: 2, cost: 0 });
    expect(world.log[1]).toMatchObject({ id: 2, client: "system", name: "test_note", cost: 0 });
    expect(world.log[1]).not.toHaveProperty("undo");
    expect(world.undoStack).toEqual([1]);
  });

  it("clears the redo stack when an undoable command succeeds", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 5 }, "player");
    undoLast(world, registry, "player");
    expect(world.redoStack).toHaveLength(1);
    expect(executeCommand(world, registry, "test_add_cash", { amount: 10 }, "player").ok).toBe(
      true,
    );
    expect(world.redoStack).toEqual([]);
  });

  it("keeps the redo stack when a command that cannot be undone succeeds", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 5 }, "player");
    undoLast(world, registry, "player");
    expect(executeCommand(world, registry, "test_note", {}, "system").ok).toBe(true);
    expect(world.redoStack).toEqual([1]);
    expect(redoLast(world, registry, "player")).toMatchObject({ ok: true });
  });

  it("keeps the redo stack when a new command fails", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 5 }, "player");
    undoLast(world, registry, "player");
    executeCommand(world, registry, "test_add_cash", { amount: -1 }, "player");
    expect(world.redoStack).toEqual([1]);
  });

  it("throws if a command computes a cost that is not a non-negative integer of cents", () => {
    for (const bad of [1.5, -100, Number.NaN]) {
      const { world, registry } = setup();
      registry.register({ ...spend, name: "test_bad_cost", cost: () => bad });
      const before = hashWorld(world);
      expect(() =>
        executeCommand(world, registry, "test_bad_cost", { amount: 1 }, "player"),
      ).toThrow(RangeError);
      expect(hashWorld(world)).toBe(before);
    }
  });
});

describe("undoLast and redoLast", () => {
  it("report an empty stack", () => {
    const { world, registry } = setup();
    expect(undoLast(world, registry, "player")).toEqual({ ok: false, error: "Nothing to undo" });
    expect(redoLast(world, registry, "player")).toEqual({ ok: false, error: "Nothing to redo" });
  });

  it("undo reverts the command, refunds its cost, and logs the undo", () => {
    const { world, registry } = setup(1_000);
    const run = executeCommand(world, registry, "test_spend", { amount: 300 }, "player");
    expect(world.finance.cash).toBe(700);

    const result = undoLast(world, registry, "agent");
    expect(result).toEqual({ ok: true, id: 2, cost: -300 });
    expect(world.finance.cash).toBe(1_000);
    expect(world.terrain.surface[0]).toBe(0);
    expect(world.undoStack).toEqual([]);
    expect(world.redoStack).toEqual([1]);
    expect(run.ok && world.log[0]?.undoneBy).toBe(2);
    expect(world.log[1]).toEqual({
      id: 2,
      tick: 0,
      client: "agent",
      name: "undo",
      input: { target: 1 },
      cost: -300,
    });
    expect(world.nextId).toBe(3);
  });

  it("undoes in last-in, first-out order", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 10 }, "player");
    executeCommand(world, registry, "test_add_cash", { amount: 20 }, "player");
    executeCommand(world, registry, "test_add_cash", { amount: 40 }, "player");
    undoLast(world, registry, "player");
    undoLast(world, registry, "player");
    expect(world.finance.cash).toBe(1_000_00 + 10);
    expect(world.redoStack).toEqual([3, 2]);
    expect(world.log.map((e) => e.undoneBy)).toEqual([undefined, 5, 4, undefined, undefined]);
  });

  it("logs a refund of a free command as zero, not negative zero", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 10 }, "player");
    undoLast(world, registry, "player");
    expect(Object.is(world.log[1]?.cost, 0)).toBe(true);
  });

  it("redo re-applies the command, charges again, and logs the redo", () => {
    const { world, registry } = setup(1_000);
    executeCommand(world, registry, "test_spend", { amount: 300 }, "player");
    undoLast(world, registry, "player");

    const result = redoLast(world, registry, "replay");
    expect(result).toEqual({ ok: true, id: 3, cost: 300 });
    expect(world.finance.cash).toBe(700);
    expect(world.terrain.surface[0]).toBe(1);
    expect(world.undoStack).toEqual([1]);
    expect(world.redoStack).toEqual([]);
    expect(world.log[0]).not.toHaveProperty("undoneBy");
    expect(world.log[0]?.undo).toEqual({ previous: 0 });
    expect(world.log[2]).toEqual({
      id: 3,
      tick: 0,
      client: "replay",
      name: "redo",
      input: { target: 1 },
      cost: 300,
    });
  });

  it("redo of a command with no undo data leaves the entry without an undo key", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 10 }, "player");
    const entry = world.log[0];
    expect(entry).toBeDefined();
    expect("undo" in (entry ?? {})).toBe(false);

    undoLast(world, registry, "player");
    expect(redoLast(world, registry, "player").ok).toBe(true);
    expect("undo" in (entry ?? {})).toBe(false);
    expect(world.log[0]).toStrictEqual({
      id: 1,
      tick: 0,
      client: "player",
      name: "test_add_cash",
      input: { amount: 10 },
      cost: 0,
    });
  });

  it("can undo a redone command again", () => {
    const { world, registry } = setup(1_000);
    executeCommand(world, registry, "test_spend", { amount: 300 }, "player");
    undoLast(world, registry, "player");
    redoLast(world, registry, "player");
    expect(undoLast(world, registry, "player")).toEqual({ ok: true, id: 4, cost: -300 });
    expect(world.finance.cash).toBe(1_000);
    expect(world.terrain.surface[0]).toBe(0);
    expect(world.log[0]?.undoneBy).toBe(4);
    expect(world.redoStack).toEqual([1]);
  });

  it("keeps the log's total cost equal to net spend through undo and redo", () => {
    const { world, registry } = setup(2_000);
    const start = world.finance.cash;
    executeCommand(world, registry, "test_spend", { amount: 300 }, "player");
    undoLast(world, registry, "player");
    redoLast(world, registry, "player");
    undoLast(world, registry, "player");
    redoLast(world, registry, "player");
    const total = world.log.reduce((sum, e) => sum + e.cost, 0);
    expect(total).toBe(300);
    expect(start - world.finance.cash).toBe(total);
  });

  it("undo refuses when validateRevert gives a reason, and leaves everything as it was", () => {
    const { world, registry } = setup(1_000);
    executeCommand(world, registry, "test_spend", { amount: 300 }, "player");
    world.terrain.surface[0] = 3;
    const before = hashWorld(world);
    const logLength = world.log.length;

    const result = undoLast(world, registry, "player");
    expect(result).toEqual({ ok: false, error: "Tile was changed since it was marked" });
    expect(world.undoStack).toEqual([1]);
    expect(world.redoStack).toEqual([]);
    expect(world.log).toHaveLength(logLength);
    expect(world.log[0]).not.toHaveProperty("undoneBy");
    expect(hashWorld(world)).toBe(before);
  });

  it("undo refuses an entry whose command is not undoable", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 10 }, "player");
    // The stack can never hold a non-undoable entry through executeCommand; corrupt it by hand.
    world.log.push({
      id: world.nextId,
      tick: 0,
      client: "player",
      name: "test_note",
      input: {},
      cost: 0,
    });
    world.undoStack.push(world.nextId++);
    const before = hashWorld(world);

    const error = expectError(undoLast(world, registry, "player"));
    expect(error).toMatch(/cannot be undone/);
    expect(hashWorld(world)).toBe(before);
  });

  it("undo and redo report a command that is no longer registered, and leave the stacks alone", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 10 }, "player");
    executeCommand(world, registry, "test_add_cash", { amount: 20 }, "player");
    undoLast(world, registry, "player");
    const empty = new Registry();
    const before = hashWorld(world);
    expect(undoLast(world, empty, "player")).toEqual({
      ok: false,
      error: "Unknown command: test_add_cash",
    });
    expect(redoLast(world, empty, "player")).toEqual({
      ok: false,
      error: "Unknown command: test_add_cash",
    });
    expect(hashWorld(world)).toBe(before);
  });

  it("redo validates again and refuses if the world has changed", () => {
    const { world, registry } = setup(1_000);
    executeCommand(world, registry, "test_spend", { amount: 300 }, "player");
    undoLast(world, registry, "player");
    world.terrain.surface[0] = 2;
    const before = hashWorld(world);

    expect(redoLast(world, registry, "player")).toEqual({
      ok: false,
      error: "Tile is already marked",
    });
    expect(world.redoStack).toEqual([1]);
    expect(world.undoStack).toEqual([]);
    expect(world.log).toHaveLength(2);
    expect(hashWorld(world)).toBe(before);
  });

  it("redo checks cash again and refuses if the park can no longer afford it", () => {
    const { world, registry } = setup(1_000);
    executeCommand(world, registry, "test_spend", { amount: 500 }, "player");
    undoLast(world, registry, "player");
    world.finance.cash = 100;
    const before = hashWorld(world);

    expect(redoLast(world, registry, "player")).toEqual({
      ok: false,
      error: "Not enough cash: need $5.00, have $1.00",
    });
    expect(world.redoStack).toEqual([1]);
    expect(hashWorld(world)).toBe(before);
  });

  it("clears the redo stack when a new command follows an undo", () => {
    const { world, registry } = setup();
    executeCommand(world, registry, "test_add_cash", { amount: 10 }, "player");
    undoLast(world, registry, "player");
    executeCommand(world, registry, "test_add_cash", { amount: 20 }, "player");
    expect(redoLast(world, registry, "player")).toEqual({ ok: false, error: "Nothing to redo" });
  });
});

describe("runQuery", () => {
  it("runs a query and returns its result", () => {
    const { world, registry } = setup(500);
    expect(runQuery(world, registry, "test_peek_cash", { extra: 5 })).toEqual({
      ok: true,
      result: 505,
    });
  });

  it("parses the input, applying defaults, and does not log or change the world", () => {
    const { world, registry } = setup(500);
    const before = hashWorld(world);
    expect(runQuery(world, registry, "test_peek_cash", {})).toEqual({ ok: true, result: 500 });
    expect(hashWorld(world)).toBe(before);
    expect(world.log).toEqual([]);
  });

  it("returns an error for an unknown query, including a command name", () => {
    const { world, registry } = setup();
    expect(runQuery(world, registry, "nope_nothing", {})).toEqual({
      ok: false,
      error: "Unknown query: nope_nothing",
    });
    expect(runQuery(world, registry, "test_add_cash", { amount: 1 })).toEqual({
      ok: false,
      error: "Unknown query: test_add_cash",
    });
  });

  it("returns the Zod message for bad input", () => {
    const { world, registry } = setup();
    const result = runQuery(world, registry, "test_peek_cash", { extra: "x" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/^extra \S/);
  });

  it("returns the message of an error the query throws, without changing the world", () => {
    const { world, registry } = setup();
    registry.registerQuery({
      name: "test_throws",
      description: "Always fails.",
      category: "park",
      input: z.object({ fail: z.boolean() }),
      run: (_world: World, input: { fail: boolean }) => {
        if (input.fail) throw new RangeError("Area is outside the park");
        return "fine";
      },
    });
    const before = hashWorld(world);
    expect(runQuery(world, registry, "test_throws", { fail: true })).toEqual({
      ok: false,
      error: "Area is outside the park",
    });
    expect(runQuery(world, registry, "test_throws", { fail: false })).toEqual({
      ok: true,
      result: "fine",
    });
    expect(hashWorld(world)).toBe(before);
  });

  it("returns a thrown value that is not an Error as text", () => {
    const { world, registry } = setup();
    registry.registerQuery({
      name: "test_throws_text",
      description: "Throws a string.",
      category: "park",
      input: z.object({}),
      run: () => {
        throw "plain text";
      },
    });
    expect(runQuery(world, registry, "test_throws_text", {})).toEqual({
      ok: false,
      error: "plain text",
    });
  });
});

describe("defineQuery", () => {
  it("returns the definition unchanged", () => {
    const def = {
      name: "test_peek_twice",
      description: "Reads cash twice.",
      category: "finance" as const,
      input: z.object({}),
      run: (world: World) => world.finance.cash * 2,
    };
    expect(defineQuery(def)).toBe(def);
  });
});
