import type { SimClient, Speed } from "@coasterworks/protocol";
import type { SceneHandle, TerrainData } from "@coasterworks/render";
import { createDefaultRegistry, type ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { uiStore } from "../src/state/uiStore";
import { useHost, type HostState } from "../src/state/useHost";

vi.mock("../src/state/useHost", () => ({ useHost: vi.fn() }));

// The real viewport and the real `attachControls` with only the WebGL scene a stub, so a click on
// the canvas goes the way a player's does: the stub says which tile is under the pointer, the
// placement in the UI store says what to do with it, and the client is told.
const stage = vi.hoisted(() => ({
  scene: null as SceneHandle | null,
  highlight: null as ReturnType<typeof import("vitest").vi.fn> | null,
  /** The tile the stub finds under the pointer, or null for none. */
  under: { x: 5, y: 6 } as { x: number; y: number } | null,
}));
vi.mock("@coasterworks/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@coasterworks/render")>();
  return {
    ...actual,
    createScene: (): SceneHandle => {
      const highlight = vi.fn();
      stage.highlight = highlight;
      const scene: SceneHandle = {
        rig: new actual.CameraRig(),
        setTerrain() {},
        updateTerrain() {},
        setTimeOfDay() {},
        render() {},
        resize() {},
        pickAt: () => stage.under,
        highlightTile: highlight,
        dispose() {},
      };
      stage.scene = scene;
      return scene;
    },
  };
});
vi.mock("../src/host/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/host/shell")>()),
  onShellEvent: () => () => {},
}));

const catalog = createDefaultRegistry().catalog();
const OK: ExecResult = { ok: true, id: 1, cost: 0 };
const command = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>();

/** A 16 by 16 park, flat at height 4 but for one tile with a corner down at 2. */
function terrain(): TerrainData {
  const corners = new Int16Array(17 * 17).fill(4);
  corners[9 * 17 + 8] = 2;
  return {
    width: 16,
    height: 16,
    corners,
    surface: new Uint8Array(16 * 16),
    water: new Uint8Array(16 * 16),
  };
}

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
        terrainVersion: 1,
        hasTerrain: true,
        width: 16,
        height: 16,
      },
    },
    terrain: terrain(),
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
  stage.scene = null;
  stage.highlight = null;
  stage.under = { x: 5, y: 6 };
  command.mockResolvedValue(OK);
  vi.mocked(useHost).mockReturnValue(host());
});
afterEach(() => {
  cleanup();
  command.mockReset();
  uiStore.setState(uiStore.getInitialState(), true);
});

async function mount() {
  render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The park with Terrain taken up, which puts Raise in hand: the park itself opens with nothing. */
async function mountWithTerrain() {
  await mount();
  act(() => uiStore.getState().setTool("terrain"));
}

const canvas = () => screen.getByLabelText("Park view");

/** A left click on the canvas, as a pointer makes it, with the modifier keys held. */
async function clickMap(mods: { altKey?: boolean; shiftKey?: boolean } = {}) {
  const at = { pointerId: 1, button: 0, clientX: 100, clientY: 100, ...mods };
  await act(async () => {
    fireEvent.pointerDown(canvas(), at);
    fireEvent.pointerUp(canvas(), at);
  });
}
const hover = (x = 100, y = 100) =>
  act(() => {
    fireEvent.pointerMove(canvas(), { pointerId: 1, clientX: x, clientY: y });
  });
const press = (key: string) => fireEvent.keyDown(window, { key });
const choose = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const lastCall = () => command.mock.calls.at(-1);

describe("a click on the map runs what the tray has in hand", () => {
  it("raises with the Raise tool that taking up Terrain puts in hand", async () => {
    await mountWithTerrain();
    await clickMap();
    expect(command).toHaveBeenCalledExactlyOnceWith("terrain_raise", { x: 5, y: 6, w: 1, h: 1 });
  });

  it("lowers on Shift-click with Raise in hand", async () => {
    await mountWithTerrain();
    await clickMap({ shiftKey: true });
    expect(lastCall()).toEqual(["terrain_lower", { x: 5, y: 6, w: 1, h: 1 }]);
  });

  it("covers the brush: 3 by 3 around the tile, and less at the edge of the map", async () => {
    await mountWithTerrain();
    choose("3");
    await clickMap();
    expect(lastCall()).toEqual(["terrain_raise", { x: 4, y: 5, w: 3, h: 3 }]);
    stage.under = { x: 15, y: 0 };
    await clickMap();
    expect(lastCall()).toEqual(["terrain_raise", { x: 14, y: 0, w: 2, h: 2 }]);
  });

  it("smooths the brush", async () => {
    await mountWithTerrain();
    choose("Smooth");
    choose("2");
    await clickMap();
    expect(lastCall()).toEqual(["terrain_smooth", { x: 5, y: 6, w: 2, h: 2 }]);
  });

  it("fills water two steps above the clicked tile's lowest corner, and drains with Alt", async () => {
    await mountWithTerrain();
    choose("Water");
    await clickMap();
    expect(lastCall()).toEqual(["terrain_set_water", { x: 5, y: 6, w: 1, h: 1, level: 6 }]);
    await clickMap({ altKey: true });
    expect(lastCall()).toEqual(["terrain_set_water", { x: 5, y: 6, w: 1, h: 1, level: 0 }]);
    // The tile with a corner down at 2 has its lowest corner there: the level is 2 above that.
    stage.under = { x: 8, y: 9 };
    await clickMap();
    expect(lastCall()).toEqual(["terrain_set_water", { x: 8, y: 9, w: 1, h: 1, level: 4 }]);
  });

  it("fills as far above as the stepper says", async () => {
    await mountWithTerrain();
    choose("Water");
    choose("Increase water level");
    choose("Increase water level");
    await clickMap();
    expect(lastCall()).toEqual(["terrain_set_water", { x: 5, y: 6, w: 1, h: 1, level: 8 }]);
  });

  it("sets the surface the chip row names: Sand is 1", async () => {
    await mountWithTerrain();
    choose("Surface");
    await clickMap();
    expect(lastCall()).toEqual(["terrain_set_surface", { x: 5, y: 6, w: 1, h: 1, surface: 0 }]);
    choose("Sand");
    await clickMap();
    expect(lastCall()).toEqual(["terrain_set_surface", { x: 5, y: 6, w: 1, h: 1, surface: 1 }]);
    choose("Snow");
    await clickMap();
    expect(lastCall()).toEqual(["terrain_set_surface", { x: 5, y: 6, w: 1, h: 1, surface: 4 }]);
  });

  it("levels to the clicked tile's lowest corner, or to the height it was set to", async () => {
    await mountWithTerrain();
    choose("Level");
    stage.under = { x: 8, y: 9 };
    await clickMap();
    expect(lastCall()).toEqual(["terrain_level", { x: 8, y: 9, w: 1, h: 1, height: 2 }]);

    choose("Set height");
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "12" } });
    await clickMap();
    expect(lastCall()).toEqual(["terrain_level", { x: 8, y: 9, w: 1, h: 1, height: 12 }]);
  });

  it("does what the command bar started, in place of the tool the tray was on", async () => {
    await mountWithTerrain();
    choose("Lower");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const search = screen.getByPlaceholderText("Type a command…");
    fireEvent.change(search, { target: { value: "raise terrain" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await clickMap();
    expect(lastCall()?.[0]).toBe("terrain_raise");
  });

  it("does nothing with the pointer over no tile", async () => {
    await mountWithTerrain();
    stage.under = null;
    await clickMap();
    expect(command).not.toHaveBeenCalled();
  });

  it("shows what a click was charged in the tray", async () => {
    command.mockResolvedValue({ ok: true, id: 3, cost: 5000 });
    await mountWithTerrain();
    await clickMap();
    expect(screen.getByLabelText("Last charge").textContent).toBe("Charged $50.00");
  });

  it("tells the player why a click was refused", async () => {
    command.mockResolvedValue({ ok: false, error: "Not enough cash" });
    await mountWithTerrain();
    choose("Water");
    await clickMap();
    expect(screen.getByRole("alert").textContent).toContain("Not enough cash");
  });
});

describe("with nothing in hand", () => {
  it("does nothing on a click after Esc, and outlines nothing", async () => {
    await mount();
    press("Escape");
    expect(uiStore.getState().tool).toBe("select");
    await clickMap();
    expect(command).not.toHaveBeenCalled();
  });

  it("does nothing on a click once the tool in hand has been clicked again", async () => {
    await mountWithTerrain();
    fireEvent.click(screen.getByRole("button", { name: "Terrain" }));
    await clickMap();
    expect(command).not.toHaveBeenCalled();
  });

  it("looks at the tile instead, as the park opens: no command, and the inspector on the tile", async () => {
    await mount();
    expect(uiStore.getState().tool).toBe("select");
    await clickMap();
    expect(command).not.toHaveBeenCalled();
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 5, y: 6 });
    expect(screen.getByRole("heading", { name: "Tile (5, 6)" })).toBeTruthy();
  });

  it("sends no command with a tool that has no placement, such as Rides, but looks at the tile", async () => {
    await mount();
    press("3");
    await clickMap();
    expect(command).not.toHaveBeenCalled();
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 5, y: 6 });
  });
});

describe("the outline under the pointer", () => {
  it("is the brush on the tile under the pointer", async () => {
    await mountWithTerrain();
    await hover();
    expect(stage.highlight).toHaveBeenLastCalledWith(5, 6, 1, 1);
    choose("3");
    expect(stage.highlight).toHaveBeenLastCalledWith(4, 5, 3, 3);
  });

  it("is gone when Esc puts the placement down, without the pointer moving", async () => {
    await mountWithTerrain();
    await hover();
    expect(stage.highlight).toHaveBeenLastCalledWith(5, 6, 1, 1);
    act(() => press("Escape"));
    expect(uiStore.getState().placement).toBeNull();
    expect(stage.highlight).toHaveBeenLastCalledWith(null);
    // And it stays gone as the pointer moves over the map.
    await hover(120, 120);
    expect(stage.highlight).toHaveBeenLastCalledWith(null);
  });

  it("is gone when the tool in hand is clicked again, and when another tool is taken up", async () => {
    await mountWithTerrain();
    await hover();
    fireEvent.click(screen.getByRole("button", { name: "Terrain" }));
    expect(stage.highlight).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Terrain" }));
    expect(stage.highlight).toHaveBeenLastCalledWith(5, 6, 1, 1);
    press("3");
    expect(stage.highlight).toHaveBeenLastCalledWith(null);
  });

  it("comes back with the placement the command bar starts, from another tool", async () => {
    await mountWithTerrain();
    await hover();
    press("3");
    expect(stage.highlight).toHaveBeenLastCalledWith(null);
    act(() => uiStore.getState().startPlacement("terrain_raise", { steps: 1 }, 2));
    expect(uiStore.getState().tool).toBe("terrain");
    expect(stage.highlight).toHaveBeenLastCalledWith(5, 6, 2, 2);
  });
});
