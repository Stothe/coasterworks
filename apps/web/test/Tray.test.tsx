import type { SimClient } from "@coasterworks/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, ActionContext, DockTool } from "../src/actions/types";
import { uiStore } from "../src/state/uiStore";
import { Tray, type TrayProps } from "../src/ui/Tray";
import { costHintOf } from "../src/ui/trays/CatalogTray";

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
});
afterEach(() => {
  cleanup();
  uiStore.setState(uiStore.getInitialState(), true);
});

const ctx: ActionContext = {
  client: {} as SimClient,
  snapshot: null,
  ui: { tool: "ride", selection: null, inspectorOpen: false },
};

function renderTray(props: Partial<TrayProps> = {}) {
  const onError = vi.fn();
  const view = render(
    <Tray tool="terrain" actions={[]} ctx={ctx} lastCharge={null} onError={onError} {...props} />,
  );
  return { ...view, onError };
}

const placement = () => uiStore.getState().placement;
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const pressed = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.getAttribute("aria-label"));

describe("Tray", () => {
  it("is nothing while Select is in hand", () => {
    const { container } = renderTray({ tool: "select" });
    expect(container.innerHTML).toBe("");
  });

  it("is a region named for its tool", () => {
    const { rerender, onError } = renderTray({ tool: "terrain" });
    expect(screen.getByRole("region", { name: "Terrain tray" })).toBeTruthy();
    rerender(<Tray tool="ride" actions={[]} ctx={ctx} lastCharge={null} onError={onError} />);
    expect(screen.getByRole("region", { name: "Rides tray" })).toBeTruthy();
    rerender(<Tray tool="park" actions={[]} ctx={ctx} lastCharge={null} onError={onError} />);
    expect(screen.getByRole("region", { name: "Park tray" })).toBeTruthy();
  });

  it("floats on dark glass", () => {
    renderTray();
    expect(screen.getByRole("region").className).toContain("glass");
  });
});

describe("TerrainTray: the verbs", () => {
  it("has Raise, Lower, Level, Smooth, Water and Surface, each with its key", () => {
    renderTray();
    const group = screen.getByRole("group", { name: "Terrain tool" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Raise",
      "Lower",
      "Level",
      "Smooth",
      "Water",
      "Surface",
    ]);
    expect(buttons.map((b) => b.querySelector("kbd")?.textContent)).toEqual([
      "R",
      "L",
      "V",
      "M",
      "W",
      "U",
    ]);
  });

  it("opens on Raise, which is what the park starts with in hand", () => {
    renderTray();
    expect(pressed("Terrain tool")).toEqual(["Raise"]);
  });

  it("puts a verb in hand with the click of its chip", () => {
    renderTray();
    click("Smooth");
    expect(placement()).toEqual({ command: "terrain_smooth", defaults: {}, size: 1 });
    expect(uiStore.getState().tool).toBe("terrain");
    expect(pressed("Terrain tool")).toEqual(["Smooth"]);
    click("Lower");
    expect(placement()?.command).toBe("terrain_lower");
    expect(pressed("Terrain tool")).toEqual(["Lower"]);
  });

  it("starts the verbs that need more with the options they start at", () => {
    renderTray();
    click("Water");
    expect(placement()).toMatchObject({
      command: "terrain_set_water",
      defaults: { levelAbove: 2 },
    });
    click("Surface");
    expect(placement()).toMatchObject({ command: "terrain_set_surface", defaults: { surface: 0 } });
    click("Level");
    expect(placement()).toMatchObject({
      command: "terrain_level",
      defaults: { heightMode: "tile", height: 8 },
    });
  });

  it("follows a placement started somewhere else, as the command bar does", () => {
    renderTray();
    act(() => uiStore.getState().startPlacement("terrain_set_surface", { surface: 3 }));
    expect(pressed("Terrain tool")).toEqual(["Surface"]);
    expect(pressed("Surface")).toEqual(["Rock"]);
    act(() => uiStore.getState().startPlacement("terrain_lower", { steps: 1 }));
    expect(pressed("Terrain tool")).toEqual(["Lower"]);
    expect(screen.queryByRole("group", { name: "Surface" })).toBeNull();
  });

  it("presses no chip for something that is not one of its verbs", () => {
    renderTray();
    act(() => uiStore.getState().startPlacement("finance_thing", {}));
    expect(pressed("Terrain tool")).toEqual([]);
  });

  it("says what a modifier key does for the verb in hand", () => {
    renderTray();
    expect(screen.getByText("Shift lowers")).toBeTruthy();
    click("Lower");
    expect(screen.getByText("Shift raises")).toBeTruthy();
    click("Water");
    expect(screen.getByText("Alt drains")).toBeTruthy();
    click("Smooth");
    expect(screen.queryByText(/Shift|Alt/)).toBeNull();
  });

  it("is turned off with the rest of the editing", () => {
    renderTray({ disabled: true });
    for (const b of screen.getAllByRole("button")) {
      expect((b as HTMLButtonElement).disabled, b.getAttribute("aria-label") ?? "").toBe(true);
    }
  });
});

describe("TerrainTray: the brush", () => {
  it("has sizes 1, 2 and 3, with 1 pressed, and the keys that step them", () => {
    renderTray();
    const group = screen.getByRole("group", { name: "Brush size" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["1", "2", "3"]);
    expect(pressed("Brush size")).toEqual(["1"]);
    expect(screen.getByText("[").tagName).toBe("KBD");
    expect(screen.getByText("]").tagName).toBe("KBD");
  });

  it("sets the size of what is in hand and of the next thing put in hand", () => {
    renderTray();
    click("3");
    expect(placement()?.size).toBe(3);
    expect(uiStore.getState().brushSize).toBe(3);
    expect(pressed("Brush size")).toEqual(["3"]);
    click("Water");
    expect(placement()?.size).toBe(3);
    click("2");
    expect(placement()).toMatchObject({ command: "terrain_set_water", size: 2 });
  });

  it("follows the keys, which set the size in the store", () => {
    renderTray();
    act(() => uiStore.getState().setBrushSize(2));
    expect(pressed("Brush size")).toEqual(["2"]);
  });
});

describe("TerrainTray: water", () => {
  const level = () => screen.getByLabelText("Steps above the ground") as HTMLInputElement;

  it("shows how far above the ground it fills, two to begin with", () => {
    renderTray();
    expect(screen.queryByRole("group", { name: "Water level" })).toBeNull();
    click("Water");
    expect(screen.getByRole("group", { name: "Water level" })).toBeTruthy();
    expect(level().value).toBe("2");
  });

  it("steps the level and puts the placement in hand again with it", () => {
    renderTray();
    click("Water");
    click("Increase water level");
    expect(level().value).toBe("3");
    expect(placement()).toMatchObject({
      command: "terrain_set_water",
      defaults: { levelAbove: 3 },
    });
    click("Decrease water level");
    click("Decrease water level");
    expect(placement()?.defaults).toEqual({ levelAbove: 1 });
  });

  it("goes from 1 to 8 steps and no further", () => {
    renderTray();
    click("Water");
    click("Decrease water level");
    expect(level().value).toBe("1");
    expect(
      (screen.getByRole("button", { name: "Decrease water level" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    for (let i = 0; i < 9; i++) {
      const up = screen.getByRole("button", { name: "Increase water level" }) as HTMLButtonElement;
      if (!up.disabled) fireEvent.click(up);
    }
    expect(level().value).toBe("8");
    expect(placement()?.defaults).toEqual({ levelAbove: 8 });
    expect(
      (screen.getByRole("button", { name: "Increase water level" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("steps a level that came from somewhere else back into range", () => {
    renderTray();
    act(() => uiStore.getState().startPlacement("terrain_set_water", { levelAbove: 40 }));
    expect(level().value).toBe("40");
    click("Decrease water level");
    expect(placement()?.defaults).toEqual({ levelAbove: 8 });
    act(() => uiStore.getState().startPlacement("terrain_set_water", { levelAbove: -3 }));
    click("Increase water level");
    expect(placement()?.defaults).toEqual({ levelAbove: 1 });
  });

  it("takes a typed number, and keeps the old one for what is out of range", () => {
    renderTray();
    click("Water");
    fireEvent.change(level(), { target: { value: "5" } });
    expect(placement()?.defaults).toEqual({ levelAbove: 5 });
    fireEvent.change(level(), { target: { value: "40" } });
    expect(placement()?.defaults).toEqual({ levelAbove: 5 });
    expect(level().getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(level());
    expect(level().value).toBe("5");
    expect(level().getAttribute("aria-invalid")).not.toBe("true");
  });

  it("is a placement in the store, read back, when it comes from the command bar", () => {
    renderTray();
    act(() => uiStore.getState().startPlacement("terrain_set_water", {}));
    expect(level().value).toBe("2");
    act(() => uiStore.getState().startPlacement("terrain_set_water", { levelAbove: 6 }));
    expect(level().value).toBe("6");
  });

  it("starts again at two steps when Water is taken up again", () => {
    renderTray();
    click("Water");
    click("Increase water level");
    click("Raise");
    expect(placement()?.defaults).toEqual({});
    click("Water");
    expect(placement()?.defaults).toEqual({ levelAbove: 2 });
    expect(level().value).toBe("2");
  });
});

describe("TerrainTray: surface", () => {
  it("has Grass, Sand, Dirt, Rock and Snow, with Grass pressed to begin with", () => {
    renderTray();
    click("Surface");
    const group = screen.getByRole("group", { name: "Surface" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Grass", "Sand", "Dirt", "Rock", "Snow"]);
    expect(pressed("Surface")).toEqual(["Grass"]);
  });

  it("puts the surface in hand with the number the sim takes", () => {
    renderTray();
    click("Surface");
    for (const [name, id] of [
      ["Sand", 1],
      ["Dirt", 2],
      ["Rock", 3],
      ["Snow", 4],
      ["Grass", 0],
    ] as const) {
      click(name);
      expect(placement(), name).toMatchObject({
        command: "terrain_set_surface",
        defaults: { surface: id },
      });
      expect(pressed("Surface"), name).toEqual([name]);
    }
  });
});

describe("TerrainTray: level", () => {
  const height = () => screen.getByLabelText("Height") as HTMLInputElement;

  it("levels to the clicked tile to begin with, and shows no height to choose", () => {
    renderTray();
    click("Level");
    expect(pressed("Level to")).toEqual(["Clicked tile"]);
    expect(screen.queryByRole("group", { name: "Level height" })).toBeNull();
  });

  it("can level to a height of its own, which it starts at 8", () => {
    renderTray();
    click("Level");
    click("Set height");
    expect(pressed("Level to")).toEqual(["Set height"]);
    expect(height().value).toBe("8");
    expect(placement()).toMatchObject({
      command: "terrain_level",
      defaults: { heightMode: "height", height: 8 },
    });
  });

  it("takes a typed height from 0 to 63", () => {
    renderTray();
    click("Level");
    click("Set height");
    fireEvent.change(height(), { target: { value: "12" } });
    expect(placement()?.defaults).toEqual({ heightMode: "height", height: 12 });
    fireEvent.change(height(), { target: { value: "63" } });
    expect(placement()?.defaults).toEqual({ heightMode: "height", height: 63 });
    fireEvent.change(height(), { target: { value: "0" } });
    expect(placement()?.defaults).toEqual({ heightMode: "height", height: 0 });
    fireEvent.change(height(), { target: { value: "64" } });
    expect(placement()?.defaults).toEqual({ heightMode: "height", height: 0 });
    fireEvent.change(height(), { target: { value: "-1" } });
    expect(placement()?.defaults).toEqual({ heightMode: "height", height: 0 });
  });

  it("steps the height with its buttons", () => {
    renderTray();
    click("Level");
    click("Set height");
    click("Increase level height");
    expect(placement()?.defaults).toEqual({ heightMode: "height", height: 9 });
    click("Decrease level height");
    click("Decrease level height");
    expect(placement()?.defaults).toEqual({ heightMode: "height", height: 7 });
  });

  it("goes back to the tile with the height it had kept", () => {
    renderTray();
    click("Level");
    click("Set height");
    fireEvent.change(height(), { target: { value: "20" } });
    click("Clicked tile");
    expect(placement()?.defaults).toEqual({ heightMode: "tile", height: 20 });
    click("Set height");
    expect(height().value).toBe("20");
  });
});

describe("TerrainTray: the last charge", () => {
  const charge = () => screen.getByLabelText("Last charge");

  it("tells the player what to do before anything has been charged", () => {
    renderTray({ lastCharge: null });
    expect(charge().textContent).toBe("Click the ground to shape it");
  });

  it("says what the last command cost", () => {
    renderTray({ lastCharge: 5000 });
    expect(charge().textContent).toBe("Charged $50.00");
  });

  it("says what an undo gave back", () => {
    renderTray({ lastCharge: -12_345 });
    expect(charge().textContent).toBe("Refunded $123.45");
  });

  it("calls a free command free of charge, as it is charged nothing", () => {
    renderTray({ lastCharge: 0 });
    expect(charge().textContent).toBe("Charged $0.00");
  });
});

/** An action of the sim, as a card in a tray. */
function action(id: string, category: Action["category"], extra: Partial<Action> = {}): Action {
  return {
    id,
    title: `Title of ${id}`,
    description: `Does ${id}.`,
    category,
    kind: "command",
    keywords: [],
    run: vi.fn(),
    ...extra,
  };
}

describe("CatalogTray", () => {
  const catalogTools: DockTool[] = ["path", "ride", "scenery", "shop", "staff"];

  it.each(catalogTools)(
    "says it is coming with the next update when %s has no commands",
    (tool) => {
      renderTray({ tool, actions: [action("terrain_raise", "terrain"), action("ui.pause", "ui")] });
      expect(screen.getByText("Coming with the next update")).toBeTruthy();
      expect(
        screen.getByText("Paths, rides, scenery, shops and staff are coming soon."),
      ).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    },
  );

  it("lists the commands of its category as cards, and none of another's", () => {
    const actions = [
      action("ride_build_carousel", "ride", {
        title: "Build carousel",
        description: "Builds a carousel. Costs $4,000.00 to build.",
      }),
      action("ride_demolish", "ride", {
        title: "Demolish ride",
        description: "Tears a ride down.",
      }),
      action("path_build", "path", { title: "Build path" }),
      action("terrain_raise", "terrain"),
    ];
    renderTray({ tool: "ride", actions });
    const cards = screen.getAllByRole("button");
    expect(cards.map((c) => c.querySelector("span")?.textContent)).toEqual([
      "Build carousel",
      "Demolish ride",
    ]);
    expect(screen.queryByText("Coming with the next update")).toBeNull();
    expect(screen.queryByText("Build path")).toBeNull();
    // The card says what it does, and what it costs when it says so.
    expect(within(cards[0] as HTMLElement).getByText(/Builds a carousel/)).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText("Costs $4,000.00 to build")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).queryByText(/Costs/)).toBeNull();
  });

  it.each([
    ["path", "path"],
    ["ride", "ride"],
    ["scenery", "scenery"],
    ["shop", "shop"],
    ["staff", "staff"],
  ] as const)("lists the %s tool's commands under the %s category", (tool, category) => {
    const other = tool === "ride" ? "shop" : "ride";
    renderTray({ tool, actions: [action("mine", category), action("theirs", other)] });
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      expect.stringContaining("Title of mine"),
    ]);
  });

  it("runs the action of the card that is clicked, with the context", () => {
    const build = action("ride_build", "ride");
    renderTray({ tool: "ride", actions: [build] });
    click(/Title of ride_build/);
    expect(build.run).toHaveBeenCalledExactlyOnceWith(ctx);
  });

  it("turns a card off while the connection is not made, or the action cannot be done", () => {
    const card = () =>
      screen.getByRole("button", { name: /Title of ride_build/ }) as HTMLButtonElement;
    const build = action("ride_build", "ride", { run: vi.fn() });
    const { rerender, onError } = renderTray({ tool: "ride", actions: [build], ctx: null });
    expect(card().disabled).toBe(true);
    fireEvent.click(card());
    expect(build.run).not.toHaveBeenCalled();

    const refused = action("ride_build", "ride", { enabled: () => false });
    rerender(
      <Tray tool="ride" actions={[refused]} ctx={ctx} lastCharge={null} onError={onError} />,
    );
    expect(card().disabled).toBe(true);
    fireEvent.click(card());
    expect(refused.run).not.toHaveBeenCalled();

    rerender(<Tray tool="ride" actions={[build]} ctx={ctx} lastCharge={null} onError={onError} />);
    expect(card().disabled).toBe(false);
    rerender(
      <Tray tool="ride" actions={[build]} ctx={ctx} lastCharge={null} onError={onError} disabled />,
    );
    expect(card().disabled).toBe(true);
  });

  it("reports an action that throws, or whose promise is rejected", async () => {
    const throws = action("ride_throws", "ride", {
      run: () => {
        throw new Error("nope");
      },
    });
    const rejects = action("ride_rejects", "ride", {
      run: () => Promise.reject(new Error("later")),
    });
    const { onError } = renderTray({ tool: "ride", actions: [throws, rejects] });
    click(/Title of ride_throws/);
    expect(onError).toHaveBeenLastCalledWith("nope");
    await act(async () => {
      click(/Title of ride_rejects/);
    });
    expect(onError).toHaveBeenLastCalledWith("later");
  });
});

describe("costHintOf", () => {
  it("quotes the sentence of the description that says what it costs", () => {
    expect(
      costHintOf(action("a", "ride", { description: "Builds it. Costs $50 for each tile." })),
    ).toBe("Costs $50 for each tile");
    expect(
      costHintOf(action("a", "ride", { description: "Costs $1,200.50 up front. Then it runs." })),
    ).toBe("Costs $1,200.50 up front");
    expect(costHintOf(action("a", "ride", { description: "Priced at $15 a ticket." }))).toBe(
      "Priced at $15 a ticket",
    );
  });

  it("is nothing when the description names no price", () => {
    expect(costHintOf(action("a", "ride", { description: "Builds it." }))).toBeNull();
    expect(costHintOf(action("a", "ride", { description: "It costs a lot." }))).toBeNull();
    expect(costHintOf(action("a", "ride", { description: "Holds $5 of change." }))).toBeNull();
  });
});

describe("ParkTray", () => {
  it("has Overview, Finances and Timeline, which open the inspector on that tab", () => {
    renderTray({ tool: "park" });
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Overview",
      "Finances",
      "Timeline",
    ]);
    for (const [name, tab] of [
      ["Overview", "overview"],
      ["Finances", "finances"],
      ["Timeline", "timeline"],
    ] as const) {
      uiStore.getState().closeInspector();
      click(name);
      expect(uiStore.getState().inspector, name).toEqual({ open: true, tab });
    }
  });

  it("selects the park, so the one inspector shows it and not a tile that was selected before", () => {
    renderTray({ tool: "park" });
    uiStore.getState().inspectTile(3, 3);
    click("Finances");
    expect(uiStore.getState().selection).toEqual({ kind: "park" });
    expect(uiStore.getState().inspector).toEqual({ open: true, tab: "finances" });
  });

  it("is turned off with the rest", () => {
    renderTray({ tool: "park", disabled: true });
    for (const b of screen.getAllByRole("button"))
      expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});
