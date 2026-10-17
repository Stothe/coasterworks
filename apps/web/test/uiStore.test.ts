// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "../src/actions/types";
import { uiStore } from "../src/state/uiStore";

afterEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
});

const state = () => uiStore.getState();

/** An action to put in a form; the store only holds it. */
const loan: Action = {
  id: "finance_take_loan",
  title: "Take loan",
  description: "Borrows money.",
  category: "finance",
  kind: "command",
  keywords: ["loan"],
  run: () => {},
};

describe("uiStore: starting state", () => {
  it("has Raise in hand, no selection, and everything closed", () => {
    expect(state().tool).toBe("terrain");
    expect(state().placement).toEqual({ command: "terrain_raise", defaults: {}, size: 1 });
    expect(state().brushSize).toBe(1);
    expect(state().selection).toBeNull();
    expect(state().inspector).toEqual({ open: false, tab: "overview" });
    expect(state().commandBarOpen).toBe(false);
    expect(state().formAction).toBeNull();
    expect(state().helpOpen).toBe(false);
  });
});

describe("uiStore: tools and placement", () => {
  it("startPlacement keeps the command and its defaults, and puts the dock on the command's tool", () => {
    state().startPlacement("terrain_raise", { steps: 1 });
    expect(state().placement).toEqual({
      command: "terrain_raise",
      defaults: { steps: 1 },
      size: 1,
    });
    expect(state().tool).toBe("terrain");
  });

  it("maps a command to the dock tool of its category, and leaves the tool for any other", () => {
    state().startPlacement("ride_build", {});
    expect(state().tool).toBe("ride");
    state().startPlacement("shop_build", {});
    expect(state().tool).toBe("shop");
    state().setTool("park");
    state().startPlacement("mystery_thing", {});
    expect(state().tool).toBe("park");
    expect(state().placement?.command).toBe("mystery_thing");
  });

  it("takes the brush size given, else the last one chosen", () => {
    state().startPlacement("terrain_raise", {}, 3);
    expect(state().placement?.size).toBe(3);
    state().setBrushSize(2);
    expect(state().placement?.size).toBe(2);
    state().startPlacement("terrain_lower", {});
    expect(state().placement?.size).toBe(2);
  });

  it("setBrushSize with nothing placed is remembered for the next placement", () => {
    state().cancel();
    state().setBrushSize(3);
    expect(state().placement).toBeNull();
    state().startPlacement("terrain_level", {});
    expect(state().placement?.size).toBe(3);
  });

  it("closes the command bar when a placement starts", () => {
    state().openCommandBar();
    state().startPlacement("terrain_raise", {});
    expect(state().commandBarOpen).toBe(false);
  });

  it("setTool to another tool drops the placement; to the same tool keeps it", () => {
    state().startPlacement("terrain_set_water", { levelAbove: 5 });
    state().setTool("terrain");
    expect(state().placement).toMatchObject({
      command: "terrain_set_water",
      defaults: { levelAbove: 5 },
    });
    state().setTool("ride");
    expect(state().tool).toBe("ride");
    expect(state().placement).toBeNull();
    state().setTool("select");
    expect(state().tool).toBe("select");
    expect(state().placement).toBeNull();
  });

  it("setTool to Terrain puts Raise in hand at the brush size last chosen", () => {
    state().setBrushSize(3);
    state().setTool("ride");
    state().setTool("terrain");
    expect(state().tool).toBe("terrain");
    expect(state().placement).toEqual({ command: "terrain_raise", defaults: {}, size: 3 });
    // And from Select, which is what Esc leaves.
    state().cancel();
    expect(state().placement).toBeNull();
    state().setTool("terrain");
    expect(state().placement?.command).toBe("terrain_raise");
  });

  it("startTerrain puts a terrain verb in hand with the options it starts at, from any tool", () => {
    state().setTool("ride");
    state().startTerrain("water");
    expect(state().tool).toBe("terrain");
    expect(state().placement).toEqual({
      command: "terrain_set_water",
      defaults: { levelAbove: 2 },
      size: 1,
    });
    state().startTerrain("surface", { waterAbove: 2, surface: 4, heightMode: "tile", height: 8 });
    expect(state().placement?.defaults).toEqual({ surface: 4 });
    state().startTerrain("smooth");
    expect(state().placement).toEqual({ command: "terrain_smooth", defaults: {}, size: 1 });
  });

  it("startTerrain with the verb already in hand keeps its options, and another verb starts from its own", () => {
    state().startTerrain("water", { waterAbove: 5, surface: 3, heightMode: "tile", height: 8 });
    // Pressing W again, or clicking Water again, is not a reset.
    state().startTerrain("water");
    expect(state().placement?.defaults).toEqual({ levelAbove: 5 });
    state().startTerrain("surface", { waterAbove: 5, surface: 3, heightMode: "tile", height: 8 });
    state().startTerrain("surface");
    expect(state().placement?.defaults).toEqual({ surface: 3 });
    state().startTerrain("level", { waterAbove: 2, surface: 0, heightMode: "height", height: 12 });
    state().startTerrain("level");
    expect(state().placement?.defaults).toEqual({ heightMode: "height", height: 12 });
    // Another verb starts from the tray's own options, not from the last verb's.
    state().startTerrain("water");
    expect(state().placement?.defaults).toEqual({ levelAbove: 2 });
    // And so does a verb picked up again after the tool was put down.
    state().startTerrain("water", { waterAbove: 7, surface: 0, heightMode: "tile", height: 8 });
    state().cancel();
    state().startTerrain("water");
    expect(state().placement?.defaults).toEqual({ levelAbove: 2 });
  });

  it("startTerrain keeps the brush size, and closes the command bar", () => {
    state().setBrushSize(3);
    state().openCommandBar();
    state().startTerrain("lower");
    expect(state().placement?.size).toBe(3);
    expect(state().commandBarOpen).toBe(false);
  });

  it("keeps a copy of the defaults, so the caller cannot change a placement afterwards", () => {
    const defaults: Record<string, unknown> = { steps: 1 };
    state().startPlacement("terrain_raise", defaults);
    defaults["steps"] = 9;
    expect(state().placement?.defaults).toEqual({ steps: 1 });
  });
});

describe("uiStore: selection and inspector", () => {
  it("selects a tile, the park, or nothing", () => {
    state().select({ kind: "tile", x: 3, y: 4 });
    expect(state().selection).toEqual({ kind: "tile", x: 3, y: 4 });
    state().select({ kind: "park" });
    expect(state().selection).toEqual({ kind: "park" });
    state().select(null);
    expect(state().selection).toBeNull();
  });

  it("opens the inspector on a tab and closes it, remembering the tab", () => {
    state().openInspector("finances");
    expect(state().inspector).toEqual({ open: true, tab: "finances" });
    state().closeInspector();
    expect(state().inspector).toEqual({ open: false, tab: "finances" });
  });
});

describe("uiStore: what the inspector shows", () => {
  it("opening a park tab selects the park, from any tile", () => {
    state().select({ kind: "tile", x: 3, y: 4 });
    state().openInspector("finances");
    expect(state().selection).toEqual({ kind: "park" });
    expect(state().inspector).toEqual({ open: true, tab: "finances" });
  });

  it("inspectTile selects the tile and opens the inspector on it, replacing a park tab", () => {
    state().openInspector("timeline");
    state().inspectTile(3, 4);
    expect(state().selection).toEqual({ kind: "tile", x: 3, y: 4 });
    expect(state().inspector).toEqual({ open: true, tab: "tile" });
    // Another tile moves the one inspector; there is never a second.
    state().inspectTile(5, 6);
    expect(state().selection).toEqual({ kind: "tile", x: 5, y: 6 });
  });

  it("opening the tile tab does not change what is selected", () => {
    state().select({ kind: "tile", x: 1, y: 1 });
    state().openInspector("tile");
    expect(state().selection).toEqual({ kind: "tile", x: 1, y: 1 });
  });

  it("closing the inspector keeps the selection", () => {
    state().inspectTile(2, 2);
    state().closeInspector();
    expect(state().inspector.open).toBe(false);
    expect(state().selection).toEqual({ kind: "tile", x: 2, y: 2 });
  });
});

describe("uiStore: command bar, form and help", () => {
  it("opens and closes the bar", () => {
    state().openCommandBar();
    expect(state().commandBarOpen).toBe(true);
    state().closeCommandBar();
    expect(state().commandBarOpen).toBe(false);
  });

  it("opening a form shows the bar with the form in it; closing the form leaves the bar", () => {
    state().openForm(loan);
    expect(state().formAction).toBe(loan);
    expect(state().commandBarOpen).toBe(true);
    state().closeForm();
    expect(state().formAction).toBeNull();
    expect(state().commandBarOpen).toBe(true);
  });

  it("closing the bar closes its form, and opening it starts at the list", () => {
    state().openForm(loan);
    state().closeCommandBar();
    expect(state().formAction).toBeNull();
    state().openForm(loan);
    state().openCommandBar();
    expect(state().formAction).toBeNull();
  });

  it("toggles help", () => {
    state().toggleHelp();
    expect(state().helpOpen).toBe(true);
    state().toggleHelp();
    expect(state().helpOpen).toBe(false);
  });
});

describe("uiStore: cancel", () => {
  it("with the bar open closes the bar only: the placement and tool stay", () => {
    state().startPlacement("terrain_raise", {});
    state().openCommandBar();
    state().cancel();
    expect(state().commandBarOpen).toBe(false);
    expect(state().placement?.command).toBe("terrain_raise");
    expect(state().tool).toBe("terrain");
  });

  it("with a form open goes back to the list, then closes the bar", () => {
    state().openForm(loan);
    state().cancel();
    expect(state().formAction).toBeNull();
    expect(state().commandBarOpen).toBe(true);
    state().cancel();
    expect(state().commandBarOpen).toBe(false);
  });

  it("with help open closes help only", () => {
    state().startPlacement("terrain_raise", {});
    state().toggleHelp();
    state().cancel();
    expect(state().helpOpen).toBe(false);
    expect(state().placement).not.toBeNull();
  });

  it("with a placement active clears it and returns to Select, keeping the selection", () => {
    state().select({ kind: "tile", x: 1, y: 2 });
    state().startPlacement("terrain_raise", {});
    state().cancel();
    expect(state().placement).toBeNull();
    expect(state().tool).toBe("select");
    expect(state().selection).toEqual({ kind: "tile", x: 1, y: 2 });
  });

  it("closes the inspector only once nothing else is up: help, form, bar, placement, tool first", () => {
    state().openInspector("overview");
    state().startPlacement("terrain_raise", {});
    state().toggleHelp();
    state().cancel();
    expect(state().helpOpen).toBe(false);
    expect(state().inspector.open).toBe(true);

    state().openForm(loan);
    state().cancel();
    expect(state().formAction).toBeNull();
    state().cancel();
    expect(state().commandBarOpen).toBe(false);
    expect(state().inspector.open).toBe(true);

    // The placement and the tool go next: the first Esc puts them down ...
    state().cancel();
    expect(state().placement).toBeNull();
    expect(state().tool).toBe("select");
    expect(state().inspector.open).toBe(true);
    // ... and the next closes the inspector, which the tray's Park tool does not need open.
    state().cancel();
    expect(state().inspector.open).toBe(false);
  });

  it("does not close the inspector while a dock tool is in hand, even with no placement", () => {
    state().openInspector("finances");
    state().setTool("ride");
    state().cancel();
    expect(state().tool).toBe("select");
    expect(state().inspector.open).toBe(true);
    state().cancel();
    expect(state().inspector).toEqual({ open: false, tab: "finances" });
  });

  it("keeps the selection when it closes the inspector", () => {
    state().inspectTile(4, 4);
    state().setTool("select");
    state().cancel();
    expect(state().inspector.open).toBe(false);
    expect(state().selection).toEqual({ kind: "tile", x: 4, y: 4 });
  });

  it("with only a dock tool chosen returns to Select; with nothing to cancel changes nothing", () => {
    state().setTool("ride");
    state().cancel();
    expect(state().tool).toBe("select");
    const before = state();
    state().cancel();
    expect(state().tool).toBe("select");
    expect(state().placement).toBeNull();
    expect(state().selection).toBe(before.selection);
  });
});
