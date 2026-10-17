// @vitest-environment node
import { createDefaultRegistry, type CatalogEntry, type ExecResult } from "@coasterworks/sim";
import type { SimClient } from "@coasterworks/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildActions, humanizeName, type UiActionDeps } from "../src/actions/registry";
import { fieldsFor } from "../src/actions/schema";
import type { Action, ActionContext, DockTool } from "../src/actions/types";
import { KEYMAP, formatCombo } from "../src/state/keys";

const catalog = createDefaultRegistry().catalog();

function makeDeps() {
  const ok: ExecResult = { ok: true, id: 1, cost: 0 };
  const ui = {
    pause: vi.fn(),
    setSpeed: vi.fn(),
    stepSpeed: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    classicView: vi.fn(),
    setTool: vi.fn(),
    openInspector: vi.fn(),
    help: vi.fn(),
    commandBar: vi.fn(),
    cancel: vi.fn(),
    terrain: vi.fn(),
    brush: vi.fn(),
  };
  const deps = {
    startPlacement: vi.fn(),
    openForm: vi.fn(),
    execute: vi.fn(async () => ok),
    ui,
  } satisfies UiActionDeps;
  return { deps, ui };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The shortcuts are read from the keymap as the keyboard in use writes them. */
const onMac = () => vi.stubGlobal("navigator", { platform: "MacIntel" });
const onWindows = () => vi.stubGlobal("navigator", { platform: "Win32" });

const ctx = {
  client: {} as SimClient,
  connected: true,
  halted: false,
  snapshot: null,
  ui: { tool: "select", selection: null, inspectorOpen: false },
} satisfies ActionContext;

function setup(entries: CatalogEntry[] = catalog) {
  const { deps, ui } = makeDeps();
  const actions = buildActions(entries, deps);
  const byId = new Map(actions.map((action) => [action.id, action]));
  const get = (id: string): Action => {
    const action = byId.get(id);
    if (!action) throw new Error(`No action ${id}`);
    return action;
  };
  return { deps, ui, actions, byId, get };
}

/** A catalog entry for a command the sim does not have yet. */
const entry = (name: string, inputSchema: Record<string, unknown>): CatalogEntry => ({
  name,
  description: `Does ${name}.`,
  category: "park",
  inputSchema,
  undoable: true,
  kind: "command",
});

describe("buildActions: commands", () => {
  it("names the command each command action runs", () => {
    const { actions } = setup();
    for (const action of actions.filter((a) => a.kind === "command")) {
      expect(action.commandName, action.id).toBe(action.id);
    }
    expect(actions.filter((a) => a.kind === "ui").every((a) => a.commandName === undefined)).toBe(
      true,
    );
  });

  it("makes one action per command and none for a query", () => {
    const { actions } = setup();
    const commands = catalog.filter((e) => e.kind === "command").map((e) => e.name);
    const fromCatalog = actions.filter((a) => a.kind === "command").map((a) => a.id);
    expect(fromCatalog).toEqual(commands);
    expect(actions.some((a) => a.kind === "query")).toBe(false);
    for (const query of catalog.filter((e) => e.kind === "query")) {
      expect(
        actions.some((a) => a.id === query.name),
        query.name,
      ).toBe(false);
    }
  });

  it("gives every action a unique id", () => {
    const { actions } = setup();
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
  });

  it("takes the description and category from the catalog and carries the schema", () => {
    const { get } = setup();
    const raise = catalog.find((e) => e.name === "terrain_raise");
    expect(get("terrain_raise")).toMatchObject({
      id: "terrain_raise",
      title: "Raise terrain",
      description: raise?.description,
      category: "terrain",
      kind: "command",
      schema: raise?.inputSchema,
    });
  });

  it("marks the terrain commands as rect placement, and runs them by starting placement", () => {
    const { get, deps } = setup();
    expect(get("terrain_raise").placement).toBe("rect");
    get("terrain_raise").run(ctx);
    // `steps` has a default that the tray may change; the rectangle comes from the map.
    expect(deps.startPlacement).toHaveBeenCalledWith("terrain_raise", { steps: 1 });
    expect(deps.openForm).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("starts placement with no defaults when the command has none", () => {
    const { get, deps } = setup();
    for (const name of ["terrain_smooth", "terrain_level", "terrain_set_surface"]) {
      get(name).run(ctx);
      expect(get(name).placement, name).toBe("rect");
    }
    expect(deps.startPlacement.mock.calls).toEqual([
      ["terrain_smooth", {}],
      ["terrain_level", {}],
      ["terrain_set_surface", {}],
    ]);
  });

  it("marks every command with a rectangle as rect placement, and no other", () => {
    const { actions } = setup();
    expect(
      actions
        .filter((a) => a.placement === "rect")
        .map((a) => a.id)
        .sort(),
    ).toEqual(
      [
        "terrain_level",
        "terrain_lower",
        "terrain_raise",
        "terrain_set_surface",
        "terrain_set_water",
        "terrain_smooth",
      ].sort(),
    );
  });

  it("makes the loan a form action with one integer field", () => {
    const { get, deps } = setup();
    const loan = get("finance_take_loan");
    expect(loan.placement).toBeUndefined();
    expect(loan.title).toBe("Take loan");

    const fields = loan.schema ? fieldsFor(loan.schema) : null;
    expect(fields).toHaveLength(1);
    expect(fields?.[0]).toMatchObject({
      name: "amount",
      kind: "integer",
      min: 100,
      max: 5_000_000,
    });

    loan.run(ctx);
    expect(deps.openForm).toHaveBeenCalledTimes(1);
    expect(deps.openForm).toHaveBeenCalledWith(loan);
    expect(deps.startPlacement).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("makes advancing time a form action", () => {
    const { get, deps } = setup();
    expect(get("sim_advance").title).toBe("Advance time");
    get("sim_advance").run(ctx);
    expect(deps.openForm).toHaveBeenCalledWith(get("sim_advance"));
  });

  it("runs a command that takes nothing straight away", async () => {
    const { get, deps } = setup([entry("park_close_gates", { type: "object", properties: {} })]);
    await get("park_close_gates").run(ctx);
    expect(deps.execute).toHaveBeenCalledWith("park_close_gates", {});
    expect(deps.openForm).not.toHaveBeenCalled();
    expect(deps.startPlacement).not.toHaveBeenCalled();
  });

  it("treats a schema with no properties key at all as taking nothing", async () => {
    const { get, deps } = setup([entry("park_open_gates", { type: "object" })]);
    await get("park_open_gates").run(ctx);
    expect(deps.execute).toHaveBeenCalledWith("park_open_gates", {});
  });

  it("still gives a form action to a command the generic form cannot render", () => {
    // Showing the "needs the full UI" notice is the form's job; the action must exist and open it.
    const nested = entry("park_move_gate", {
      type: "object",
      properties: { at: { type: "object", properties: { x: { type: "integer" } } } },
    });
    const { get, deps } = setup([nested]);
    get("park_move_gate").run(ctx);
    expect(deps.openForm).toHaveBeenCalledWith(get("park_move_gate"));
    expect(fieldsFor(get("park_move_gate").schema ?? {})).toBeNull();
  });

  it("is not placement when the rectangle is incomplete", () => {
    const int = { type: "integer" };
    const partial = entry("park_pick_tile", {
      type: "object",
      properties: { x: int, y: int },
      required: ["x", "y"],
    });
    const { get } = setup([partial]);
    expect(get("park_pick_tile").placement).toBeUndefined();
  });

  it("matches on the words of the name and on the category", () => {
    const { get } = setup();
    expect(get("terrain_set_water").keywords).toEqual(["terrain", "set", "water"]);
    expect(get("finance_take_loan").keywords).toEqual(["finance", "take", "loan"]);
    expect(get("sim_advance").keywords).toEqual(["sim", "advance"]);
    expect(setup([entry("park_close_gates", {})]).get("park_close_gates").keywords).toEqual([
      "park",
      "close",
      "gates",
    ]);
  });
});

describe("humanizeName", () => {
  it("capitalizes the first word and lowercases the rest", () => {
    expect(humanizeName("park_close_gates")).toBe("Park close gates");
    expect(humanizeName("ride_build")).toBe("Ride build");
  });

  it("uses the friendlier names for the commands that have one", () => {
    expect(humanizeName("terrain_set_water")).toBe("Set water");
    expect(humanizeName("terrain_set_surface")).toBe("Set surface");
    expect(humanizeName("finance_take_loan")).toBe("Take loan");
    expect(humanizeName("finance_repay_loan")).toBe("Repay loan");
    expect(humanizeName("sim_advance")).toBe("Advance time");
    expect(humanizeName("terrain_raise")).toBe("Raise terrain");
    expect(humanizeName("terrain_lower")).toBe("Lower terrain");
    expect(humanizeName("terrain_level")).toBe("Level terrain");
    expect(humanizeName("terrain_smooth")).toBe("Smooth terrain");
  });
});

describe("buildActions: interface actions", () => {
  it("lists them with their shortcuts, as a Mac writes them", () => {
    onMac();
    const { get } = setup([]);
    const shortcuts = [
      ["ui.pause", "Space"],
      ["ui.undo", "⌘Z"],
      ["ui.redo", "⇧⌘Z"],
      ["ui.classicView", "Home"],
      ["ui.help", "?"],
      ["ui.tool.terrain", "1"],
      ["ui.tool.path", "2"],
      ["ui.tool.ride", "3"],
      ["ui.tool.scenery", "4"],
      ["ui.tool.shop", "5"],
      ["ui.tool.staff", "6"],
      ["ui.tool.park", "7"],
    ] as const;
    for (const [id, shortcut] of shortcuts) {
      expect(get(id).shortcut, id).toBe(shortcut);
      expect(get(id).kind, id).toBe("ui");
      expect(get(id).category, id).toBe("ui");
    }
    for (const id of [
      "ui.speed.1",
      "ui.speed.2",
      "ui.speed.4",
      "ui.speed.8",
      "ui.inspector.park",
    ]) {
      expect(get(id).kind, id).toBe("ui");
    }
  });

  it("writes them for the keyboard in use: Ctrl+Z, not ⌘Z, on a PC", () => {
    onWindows();
    const { get } = setup([]);
    expect(get("ui.undo").shortcut).toBe("Ctrl+Z");
    expect(get("ui.redo").shortcut).toBe("Ctrl+Shift+Z");
    expect(get("ui.pause").shortcut).toBe("Space");
    expect(get("ui.tool.ride").shortcut).toBe("3");
  });

  it("works each shortcut out when it is read, so the same action follows the keyboard", () => {
    const { get } = setup([]);
    onMac();
    expect(get("ui.undo").shortcut).toBe("⌘Z");
    onWindows();
    expect(get("ui.undo").shortcut).toBe("Ctrl+Z");
  });

  it("takes every shortcut from the keymap: each is a binding's combo, none is typed in", () => {
    onWindows();
    const { actions } = setup([]);
    for (const action of actions) {
      const binding = KEYMAP.find((candidate) => candidate.actionId === action.id);
      expect(action.shortcut, action.id).toBe(
        binding ? formatCombo(binding.combo, false) : undefined,
      );
    }
    // The ones with no key have none.
    expect(setup([]).get("ui.speed.4").shortcut).toBeUndefined();
    expect(setup([]).get("ui.inspector.park").shortcut).toBeUndefined();
  });

  it("steps the speed from + and -", () => {
    const { get, ui } = setup([]);
    expect(get("ui.speed.up").shortcut).toBe("+");
    expect(get("ui.speed.down").shortcut).toBe("-");
    get("ui.speed.up").run(ctx);
    get("ui.speed.down").run(ctx);
    expect(ui.stepSpeed.mock.calls).toEqual([[1], [-1]]);
  });

  it("has actions for the keys that open the bar and cancel, which the bar does not list", () => {
    const { get, ui } = setup([]);
    for (const id of ["ui.commandBar", "ui.cancel"]) {
      expect(get(id).kind, id).toBe("ui");
      expect(get(id).hidden, id).toBe(true);
    }
    // Everything else is listed, bar the keys of the terrain tray, which the catalog's own terrain
    // commands already list.
    expect(
      setup()
        .actions.filter(
          (a) => a.hidden && !a.id.startsWith("ui.terrain.") && !a.id.startsWith("ui.brush."),
        )
        .map((a) => a.id),
    ).toEqual(["ui.commandBar", "ui.cancel"]);
    get("ui.commandBar").run(ctx);
    get("ui.cancel").run(ctx);
    expect(ui.commandBar).toHaveBeenCalledTimes(1);
    expect(ui.cancel).toHaveBeenCalledTimes(1);
  });

  it("has an action for each terrain verb's key, which the bar does not list", () => {
    const { get, ui } = setup([]);
    const verbs = [
      ["raise", "R"],
      ["lower", "L"],
      ["level", "V"],
      ["smooth", "M"],
      ["water", "W"],
      ["surface", "U"],
    ] as const;
    for (const [verb, shortcut] of verbs) {
      const action = get(`ui.terrain.${verb}`);
      expect(action.kind, verb).toBe("ui");
      expect(action.hidden, verb).toBe(true);
      expect(action.shortcut, verb).toBe(shortcut);
      action.run(ctx);
    }
    expect(ui.terrain.mock.calls.map(([verb]) => verb)).toEqual(verbs.map(([verb]) => verb));
  });

  it("steps the brush from [ and ]", () => {
    const { get, ui } = setup([]);
    expect(get("ui.brush.smaller").shortcut).toBe("[");
    expect(get("ui.brush.larger").shortcut).toBe("]");
    expect(get("ui.brush.smaller").hidden).toBe(true);
    get("ui.brush.larger").run(ctx);
    get("ui.brush.smaller").run(ctx);
    expect(ui.brush.mock.calls).toEqual([[1], [-1]]);
  });

  it("has no listed action for the bar's own key", () => {
    onMac();
    const { actions } = setup();
    // The bar's action exists for the key to run, and the bar does not list it.
    expect(actions.filter((a) => !a.hidden).some((a) => a.shortcut === "⌘K")).toBe(false);
    expect(actions.find((a) => a.id === "ui.commandBar")?.shortcut).toBe("⌘K");
  });

  it("disables pause and the speeds while the sim is halted or the connection is lost", () => {
    const { get } = setup([]);
    const speedIds = [
      "ui.pause",
      "ui.speed.1",
      "ui.speed.2",
      "ui.speed.4",
      "ui.speed.8",
      "ui.speed.up",
      "ui.speed.down",
    ];
    for (const id of speedIds) {
      const enabled = get(id).enabled;
      expect(enabled, id).toBeTypeOf("function");
      expect(enabled?.(ctx), id).toBe(true);
      expect(enabled?.({ ...ctx, halted: true }), `${id} halted`).toBe(false);
      expect(enabled?.({ ...ctx, connected: false }), `${id} disconnected`).toBe(false);
    }
  });

  it("leaves the rest enabled: undo, the tools and the panels need no running sim", () => {
    const { actions } = setup([]);
    const gated = actions.filter((a) => a.enabled).map((a) => a.id);
    expect(gated.sort()).toEqual(
      [
        "ui.pause",
        "ui.speed.1",
        "ui.speed.2",
        "ui.speed.4",
        "ui.speed.8",
        "ui.speed.up",
        "ui.speed.down",
      ].sort(),
    );
  });

  it("marks as offline only the actions that change the interface and nothing else", () => {
    const { actions } = setup();
    expect(
      actions
        .filter((a) => a.offline)
        .map((a) => a.id)
        .sort(),
    ).toEqual(["ui.cancel", "ui.classicView", "ui.help"]);
  });

  it("gives each a title, a description and keywords", () => {
    const { actions } = setup([]);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.title.length, action.id).toBeGreaterThan(0);
      expect(action.description.length, action.id).toBeGreaterThan(0);
      expect(action.keywords.length, action.id).toBeGreaterThan(0);
    }
  });

  it("calls the matching handler when run", () => {
    const { get, ui } = setup([]);
    get("ui.pause").run(ctx);
    get("ui.speed.1").run(ctx);
    get("ui.speed.2").run(ctx);
    get("ui.speed.4").run(ctx);
    get("ui.speed.8").run(ctx);
    get("ui.undo").run(ctx);
    get("ui.redo").run(ctx);
    get("ui.classicView").run(ctx);
    get("ui.inspector.park").run(ctx);
    get("ui.help").run(ctx);
    expect(ui.pause).toHaveBeenCalledTimes(1);
    expect(ui.setSpeed.mock.calls).toEqual([[1], [2], [4], [8]]);
    expect(ui.undo).toHaveBeenCalledTimes(1);
    expect(ui.redo).toHaveBeenCalledTimes(1);
    expect(ui.classicView).toHaveBeenCalledTimes(1);
    expect(ui.openInspector).toHaveBeenCalledWith("overview");
    expect(ui.help).toHaveBeenCalledTimes(1);
  });

  it("switches to each dock tool", () => {
    const { get, ui } = setup([]);
    const tools: DockTool[] = ["terrain", "path", "ride", "scenery", "shop", "staff", "park"];
    for (const tool of tools) get(`ui.tool.${tool}`).run(ctx);
    expect(ui.setTool.mock.calls).toEqual(tools.map((tool) => [tool]));
  });

  it("is there even before the catalog has loaded", () => {
    const { actions } = setup([]);
    expect(actions.every((a) => a.kind === "ui")).toBe(true);
    expect(actions.map((a) => a.id)).toContain("ui.undo");
  });
});
