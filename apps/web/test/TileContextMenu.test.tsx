import type { TerrainData } from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiStore } from "../src/state/uiStore";
import { TileContextMenu, type TileMenuHandle } from "../src/ui/TileContextMenu";

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

function setup(over: { disabled?: boolean; map?: TerrainData | null; result?: ExecResult } = {}) {
  const ref = createRef<TileMenuHandle>();
  const execute = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>(
    async () => over.result ?? OK,
  );
  const notify = vi.fn();
  const view = render(
    <TileContextMenu
      ref={ref}
      terrain={over.map === undefined ? terrain() : over.map}
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

  it("opens a menu of Inspect and the five tile actions", async () => {
    const { open } = setup();
    open();
    expect(await items()).toEqual([
      "Inspect",
      "Raise here",
      "Lower here",
      "Level here",
      "Set water",
      "Drain",
    ]);
  });

  it("says how high Set water fills there too", async () => {
    const { open } = setup();
    open();
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Set water" }).getAttribute("title")).toBe(
      "2 steps above the lowest corner",
    );
    expect(menu.getByRole("menuitem", { name: "Drain" }).hasAttribute("title")).toBe(false);
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
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "Raise here" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("terrain_raise", { x: 6, y: 1, w: 1, h: 1 });
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Raised (6, 1): charged $10.00", {}));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("levels to the tile's lowest corner and sets water two above it, as the inspector does", async () => {
    const { open, execute } = setup();
    open(3, 3);
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "Level here" }));
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
