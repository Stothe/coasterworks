import type { SimClient, Speed } from "@coasterworks/protocol";
import { createDefaultRegistry, type ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { uiStore } from "../src/state/uiStore";
import { useHost, type HostState } from "../src/state/useHost";
import type { ViewportProps } from "../src/viewport/Viewport";

vi.mock("../src/state/useHost", () => ({ useHost: vi.fn() }));
// No WebGL in jsdom, and these tests are about the dock and its trays. What the viewport is given
// is kept, so a test can answer as a click's command would.
const viewport = vi.hoisted(() => ({ props: null as unknown }));
vi.mock("../src/viewport/Viewport", () => ({
  Viewport: (props: unknown) => {
    viewport.props = props;
    return null;
  },
}));

const catalog = createDefaultRegistry().catalog();
const OK: ExecResult = { ok: true, id: 1, cost: 0 };
const command = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>();

function host(): HostState {
  return {
    status: "ready",
    snapshot: {
      header: {
        tick: 0,
        speed: 1 as Speed,
        halted: false,
        cash: 1_000_000,
        loan: 0,
        monthStartCash: 1_000_000,
        date: "March 1, Year 1",
        terrainVersion: 0,
        hasTerrain: false,
        width: 16,
        height: 16,
      },
    },
    terrain: null,
    events: [],
    client: {
      query: async () => ({ ok: true, result: catalog }),
      setSpeed: async () => {},
      command,
    } as unknown as SimClient,
    halted: false,
  };
}

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  command.mockResolvedValue(OK);
  vi.mocked(useHost).mockReturnValue(host());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  command.mockReset();
  uiStore.setState(uiStore.getInitialState(), true);
});

/** Renders the app, with the sim's commands arrived. */
async function ready() {
  render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Renders the app and takes Terrain up, which puts Raise in hand and its tray up. */
async function readyWithTerrain() {
  await ready();
  act(() => uiStore.getState().setTool("terrain"));
}

const press = (
  key: string,
  mods: Partial<KeyboardEventInit> = {},
  target: Window | Element = window,
) => fireEvent.keyDown(target, { key, ...mods });
const dock = () => screen.getByRole("group", { name: "Tools" });
const dockButton = (name: string) => within(dock()).getByRole("button", { name });
const pressedTools = () =>
  within(dock())
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.getAttribute("aria-label"));
const tray = () => screen.queryByRole("region", { name: /tray$/ });
const store = () => uiStore.getState();

describe("the dock in the app", () => {
  it("opens with Select in hand, nothing placed, and no tray", async () => {
    await ready();
    expect(pressedTools()).toEqual(["Select"]);
    expect(tray()).toBeNull();
    expect(store().tool).toBe("select");
    expect(store().placement).toBeNull();
    // Select is the first button, ahead of the seven tools.
    expect(
      within(dock())
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Select", "Terrain", "Paths", "Rides", "Scenery", "Shops", "Staff", "Park"]);
  });

  it("1 puts Raise in hand, and shows the Terrain tray and its idle hint", async () => {
    await ready();
    press("1");
    expect(pressedTools()).toEqual(["Terrain"]);
    expect(screen.getByRole("region", { name: "Terrain tray" })).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Terrain tool" }))
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Raise"]);
    expect(store().placement).toEqual({ command: "terrain_raise", defaults: {}, size: 1 });
    expect(screen.getByLabelText("Last charge").textContent).toContain("Esc puts the tool down");
  });

  it("a click on Terrain does the same as 1", async () => {
    await ready();
    fireEvent.click(dockButton("Terrain"));
    expect(pressedTools()).toEqual(["Terrain"]);
    expect(store().placement).toMatchObject({ command: "terrain_raise", size: 1 });
  });

  it("the Select button puts the tool down, and Esc does the same", async () => {
    await ready();
    press("1");
    fireEvent.click(dockButton("Select"));
    expect(store().tool).toBe("select");
    expect(store().placement).toBeNull();
    expect(pressedTools()).toEqual(["Select"]);
    expect(tray()).toBeNull();
    press("3");
    press("Escape");
    expect(pressedTools()).toEqual(["Select"]);
  });

  it("has no terrain bar of its own any more", async () => {
    await readyWithTerrain();
    expect(screen.queryByRole("toolbar", { name: "Terrain tools" })).toBeNull();
    // One brush control, not two.
    expect(screen.getAllByRole("group", { name: "Brush size" })).toHaveLength(1);
  });

  it("3 shows the Rides tray, which is empty until the next update", async () => {
    await ready();
    press("3");
    expect(store().tool).toBe("ride");
    expect(pressedTools()).toEqual(["Rides"]);
    const rides = screen.getByRole("region", { name: "Rides tray" });
    expect(within(rides).getByText("Coming with the next update")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Terrain tray" })).toBeNull();
    expect(store().placement).toBeNull();
  });

  it("1 brings the Terrain tray back with Raise in hand", async () => {
    await ready();
    press("3");
    press("1");
    expect(pressedTools()).toEqual(["Terrain"]);
    expect(screen.getByRole("region", { name: "Terrain tray" })).toBeTruthy();
    expect(store().placement).toMatchObject({ command: "terrain_raise", size: 1 });
  });

  it("opens each tray with its key: 2 to 7", async () => {
    await ready();
    const expected = ["Paths", "Rides", "Scenery", "Shops", "Staff", "Park"];
    expected.forEach((label, index) => {
      press(String(index + 2));
      expect(pressedTools(), label).toEqual([label]);
      expect(screen.getByRole("region", { name: `${label} tray` }), label).toBeTruthy();
    });
  });

  it("goes to Select when the tool in hand is clicked again, and drops the tray", async () => {
    await readyWithTerrain();
    fireEvent.click(dockButton("Terrain"));
    expect(store().tool).toBe("select");
    expect(store().placement).toBeNull();
    expect(pressedTools()).toEqual(["Select"]);
    expect(tray()).toBeNull();
    // And the tool is taken up again with a click.
    fireEvent.click(dockButton("Terrain"));
    expect(pressedTools()).toEqual(["Terrain"]);
    expect(store().placement?.command).toBe("terrain_raise");
  });

  it("Esc puts the placement down, returns to Select, and hides the tray", async () => {
    await readyWithTerrain();
    fireEvent.click(screen.getByRole("button", { name: "Smooth" }));
    expect(store().placement?.command).toBe("terrain_smooth");
    press("Escape");
    expect(store().placement).toBeNull();
    expect(store().tool).toBe("select");
    expect(pressedTools()).toEqual(["Select"]);
    expect(tray()).toBeNull();
  });

  it("chooses a terrain verb from its chip, and from its key, whatever tool is in hand", async () => {
    await readyWithTerrain();
    fireEvent.click(screen.getByRole("button", { name: "Smooth" }));
    expect(store().placement?.command).toBe("terrain_smooth");

    const keys: Array<[string, string]> = [
      ["r", "terrain_raise"],
      ["l", "terrain_lower"],
      ["v", "terrain_level"],
      ["m", "terrain_smooth"],
      ["w", "terrain_set_water"],
      ["u", "terrain_set_surface"],
    ];
    for (const [key, name] of keys) {
      press("3");
      expect(store().tool).toBe("ride");
      press(key);
      expect(store().tool, key).toBe("terrain");
      expect(store().placement?.command, key).toBe(name);
      expect(pressedTools(), key).toEqual(["Terrain"]);
    }
  });

  it("starts Water at two steps above and Surface at grass from the keys", async () => {
    await ready();
    press("w");
    expect(store().placement?.defaults).toEqual({ levelAbove: 2 });
    press("u");
    expect(store().placement?.defaults).toEqual({ surface: 0 });
  });

  it("steps the brush with [ and ], one size a press, and stops at the ends", async () => {
    await readyWithTerrain();
    const size = () => store().placement?.size;
    press("]");
    expect(size()).toBe(2);
    press("]");
    press("]");
    expect(size()).toBe(3);
    press("[");
    expect(size()).toBe(2);
    press("[");
    press("[");
    expect(size()).toBe(1);
    expect(store().brushSize).toBe(1);
    // The chips agree.
    press("]");
    expect(
      within(screen.getByRole("group", { name: "Brush size" }))
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.textContent),
    ).toEqual(["2"]);
  });

  it("leaves the keys to a field being typed in", async () => {
    await ready();
    press("l");
    fireEvent.click(screen.getByRole("button", { name: "Level" }));
    fireEvent.click(screen.getByRole("button", { name: "Set height" }));
    const field = screen.getByLabelText("Height");
    act(() => field.focus());
    press("3", {}, field);
    press("w", {}, field);
    press("]", {}, field);
    expect(store().tool).toBe("terrain");
    expect(store().placement?.command).toBe("terrain_level");
    expect(store().placement?.size).toBe(1);
    // But Escape works there.
    press("Escape", {}, field);
    expect(store().tool).toBe("select");
  });

  it("leaves the terrain keys alone while the command bar is open", async () => {
    await ready();
    press("3");
    press("k", { ctrlKey: true });
    const search = screen.getByPlaceholderText("Type a command…");
    press("w", {}, search);
    press("w");
    expect(store().tool).toBe("ride");
  });

  it("switches the dock to Terrain when the command bar starts a terrain placement", async () => {
    await ready();
    press("3");
    expect(pressedTools()).toEqual(["Rides"]);
    press("k", { ctrlKey: true });
    const search = screen.getByPlaceholderText("Type a command…");
    fireEvent.change(search, { target: { value: "set water" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(store().placement).toMatchObject({ command: "terrain_set_water" });
    expect(pressedTools()).toEqual(["Terrain"]);
    expect(screen.getByRole("region", { name: "Terrain tray" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Rides tray" })).toBeNull();
    // The tray shows what the placement is: Water, with the level it starts at.
    expect(screen.getByRole("button", { name: "Water" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Steps above the ground") as HTMLInputElement).value).toBe("2");
    // And Esc, then, leaves nothing behind.
    press("Escape");
    expect(store().tool).toBe("select");
    expect(store().placement).toBeNull();
    expect(tray()).toBeNull();
  });

  it("is turned off when the connection is lost", async () => {
    vi.mocked(useHost).mockReturnValue({ ...host(), status: "disconnected" });
    await readyWithTerrain();
    for (const b of within(dock()).getAllByRole("button")) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    for (const b of within(screen.getByRole("region", { name: "Terrain tray" })).getAllByRole(
      "button",
    )) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe("the terrain tray's charge", () => {
  const give = (result: ExecResult) => {
    act(() => (viewport.props as ViewportProps).onResult(result));
  };

  it("shows what a click cost, and what an undo gave back", async () => {
    await readyWithTerrain();
    const charge = () => screen.getByLabelText("Last charge").textContent;
    expect(charge()).toBe("Click the ground to shape it · Esc puts the tool down");
    give({ ok: true, id: 1, cost: 5000 });
    expect(charge()).toBe("Charged $50.00");
    give({ ok: true, id: 2, cost: -5000 });
    expect(charge()).toBe("Refunded $50.00");
  });

  it("does not hand the viewport a tool or brush of its own, only a ref for the camera", async () => {
    await ready();
    expect(Object.keys(viewport.props as object).sort()).toEqual([
      "client",
      "onResult",
      "onSecondaryClick",
      "ref",
      "terrain",
      "tick",
    ]);
  });
});

describe("the park tray and the inspector", () => {
  it("opens the inspector on a tab from the Park tray, and shuts it again", async () => {
    await ready();
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
    press("7");
    fireEvent.click(screen.getByRole("button", { name: "Finances" }));
    expect(store().inspector).toEqual({ open: true, tab: "finances" });
    expect(store().selection).toEqual({ kind: "park" });
    const inspector = screen.getByRole("complementary", { name: "Inspector" });
    expect(
      within(inspector).getByRole("tab", { name: "Finances" }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(within(inspector).getByRole("button", { name: "Close inspector" }));
    expect(store().inspector.open).toBe(false);
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
  });
});
