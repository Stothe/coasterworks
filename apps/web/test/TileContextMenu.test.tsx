import type { TerrainData } from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiStore } from "../src/state/uiStore";
import { TileContextMenu, type TileMenuHandle } from "../src/ui/TileContextMenu";
import { FAKE_RECT, registryActions } from "./actionsFixture";
import type { Action } from "../src/actions/types";

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
});
afterEach(() => {
  cleanup();
  uiStore.setState(uiStore.getInitialState(), true);
});

function terrain(): TerrainData {
  const corners = new Int16Array(9 * 9).fill(5);
  corners[3 * 9 + 3] = 4;
  return { width: 8, height: 8, corners, surface: new Uint8Array(64), water: new Uint8Array(64) };
}

const OK: ExecResult = { ok: true, id: 1, cost: 1000 };

function setup(
  over: {
    disabled?: boolean;
    map?: TerrainData | null;
    result?: ExecResult;
    actions?: Action[];
  } = {},
) {
  const ref = createRef<TileMenuHandle>();
  const execute = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>(
    async () => over.result ?? OK,
  );
  const notify = vi.fn();
  const view = render(
    <TileContextMenu
      ref={ref}
      terrain={over.map === undefined ? terrain() : over.map}
      actions={over.actions ?? registryActions()}
      execute={execute}
      notify={notify}
      disabled={over.disabled ?? false}
    >
      <div data-testid="stage">the park</div>
    </TileContextMenu>,
  );
  const open = (x = 3, y = 3) =>
    act(() => ref.current?.openAt({ x, y }, { clientX: 120, clientY: 80 }));
  return { ref, execute, notify, open, ...view };
}

const menu = () => screen.findByRole("menu");
const items = async () =>
  within(await menu())
    .getAllByRole("menuitem")
    .map((item) => item.textContent);

describe("TileContextMenu", () => {
  it("shows what it wraps, and no menu until it is asked", () => {
    setup();
    expect(screen.getByTestId("stage").textContent).toBe("the park");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens a menu of Inspect and the registry's placement actions, then Drain after Set water", async () => {
    const { open } = setup();
    open();
    expect(await items()).toEqual([
      "Inspect",
      "Raise terrain",
      "Lower terrain",
      "Level terrain",
      "Smooth terrain",
      "Set water",
      "Drain",
      "Set surface",
    ]);
  });

  it("lists what the actions give it: a placement action the sim adds appears, after the known ones", async () => {
    const { open } = setup({ actions: registryActions([FAKE_RECT]) });
    open();
    expect(await items()).toEqual([
      "Inspect",
      "Raise terrain",
      "Lower terrain",
      "Level terrain",
      "Smooth terrain",
      "Set water",
      "Drain",
      "Set surface",
      "Terrain flatten fake",
    ]);
  });

  it("lists no more than it is given: no placement actions, only Inspect", async () => {
    const { open } = setup({ actions: registryActions().filter((a) => a.placement !== "rect") });
    open();
    expect(await items()).toEqual(["Inspect"]);
    expect(within(await menu()).queryByRole("separator")).toBeNull();
  });

  it("lists in a fixed order whatever order the actions come in", async () => {
    const { open } = setup({ actions: [...registryActions([FAKE_RECT])].reverse() });
    open();
    expect(await items()).toEqual([
      "Inspect",
      "Raise terrain",
      "Lower terrain",
      "Level terrain",
      "Smooth terrain",
      "Set water",
      "Drain",
      "Set surface",
      "Terrain flatten fake",
    ]);
  });

  it("does the made-up action to the tile as it would be placed with a brush of one", async () => {
    const { open, execute, notify } = setup({ actions: registryActions([FAKE_RECT]) });
    open(2, 5);
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "Terrain flatten fake" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_flatten_fake", { x: 2, y: 5, w: 1, h: 1 });
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith("Terrain flatten fake (2, 5): charged $10.00", {}),
    );
  });

  it("says how high Set water fills there too", async () => {
    const { open } = setup();
    open();
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Set water" }).getAttribute("title")).toBe(
      "2 steps above the lowest corner",
    );
    expect(menu.getByRole("menuitem", { name: "Drain" }).hasAttribute("title")).toBe(false);
    expect(menu.getByRole("menuitem", { name: "Raise terrain" }).hasAttribute("title")).toBe(false);
  });

  it("says which tile it is for", async () => {
    const { open } = setup();
    open(5, 2);
    expect(within(await menu()).getByText("Tile (5, 2)")).toBeTruthy();
    expect((await menu()).getAttribute("aria-label")).toBe("Tile (5, 2) actions");
  });

  it("gives every item a full-size target on glass", async () => {
    const { open } = setup();
    open();
    expect((await menu()).className).toContain("glass");
    for (const item of within(await menu()).getAllByRole("menuitem")) {
      expect(item.className).toContain("hud-button");
    }
  });

  it("runs an action on the tile it was opened for, and closes", async () => {
    const { open, execute, notify } = setup();
    open(6, 1);
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "Raise terrain" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_raise", { x: 6, y: 1, w: 1, h: 1 });
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Raised (6, 1): charged $10.00", {}));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("levels to the tile's lowest corner and sets water two above it, as the inspector does", async () => {
    const { open, execute } = setup();
    open(3, 3);
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "Level terrain" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenLastCalledWith("terrain_level", {
      x: 3,
      y: 3,
      w: 1,
      h: 1,
      height: 4,
    });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    open(3, 3);
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "Set water" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenLastCalledWith("terrain_set_water", {
      x: 3,
      y: 3,
      w: 1,
      h: 1,
      level: 6,
    });
  });

  it("smooths the tile, drains it with the level 0, and sets grass when the tray has chosen nothing", async () => {
    const { open, execute } = setup();
    const choose = async (name: string) => {
      open(3, 3);
      fireEvent.click(within(await menu()).getByRole("menuitem", { name }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    };
    await choose("Smooth terrain");
    expect(execute).toHaveBeenLastCalledWith("terrain_smooth", { x: 3, y: 3, w: 1, h: 1 });
    await choose("Drain");
    expect(execute).toHaveBeenLastCalledWith("terrain_set_water", {
      x: 3,
      y: 3,
      w: 1,
      h: 1,
      level: 0,
    });
    await choose("Set surface");
    expect(execute).toHaveBeenLastCalledWith("terrain_set_surface", {
      x: 3,
      y: 3,
      w: 1,
      h: 1,
      surface: 0,
    });
  });

  it("sets the surface the Terrain tray has chosen", async () => {
    uiStore.getState().startTerrain("surface", {
      waterAbove: 2,
      surface: 3,
      heightMode: "tile",
      height: 8,
    });
    const { open, execute } = setup();
    open(1, 2);
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "Set surface" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_set_surface", {
      x: 1,
      y: 2,
      w: 1,
      h: 1,
      surface: 3,
    });
  });

  it("shows a refusal as an error message", async () => {
    const { open, notify } = setup({ result: { ok: false, error: "Not enough cash" } });
    open();
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "Drain" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Not enough cash", { kind: "error" }));
  });

  it("Inspect selects the tile and opens the inspector on it", async () => {
    const { open, execute } = setup();
    open(4, 7);
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "Inspect" }));
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 4, y: 7 });
    expect(uiStore.getState().inspector).toEqual({ open: true, tab: "tile" });
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("opens for another tile when asked again", async () => {
    const { open } = setup();
    open(1, 1);
    expect(within(await menu()).getByText("Tile (1, 1)")).toBeTruthy();
    fireEvent.keyDown(await menu(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    open(2, 2);
    expect(within(await menu()).getByText("Tile (2, 2)")).toBeTruthy();
  });

  it("Escape closes it and nothing else: the app's own Escape does not also run", async () => {
    uiStore.getState().inspectTile(1, 1);
    const { open } = setup();
    open();
    const seenByApp = vi.fn();
    window.addEventListener("keydown", seenByApp);
    fireEvent.keyDown(await menu(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Radix handled it and said so, which is how the app's key handler knows to leave it.
    expect(seenByApp.mock.calls.every(([event]) => (event as KeyboardEvent).defaultPrevented)).toBe(
      true,
    );
    window.removeEventListener("keydown", seenByApp);
  });

  it("does not open while it is disabled, as when the connection is lost", () => {
    const { open } = setup({ disabled: true });
    open();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not open a menu of the browser's own: a real context menu event is left alone", () => {
    setup();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByTestId("stage").dispatchEvent(event);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
