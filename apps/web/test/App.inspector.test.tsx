import type { SimClient, Speed } from "@coasterworks/protocol";
import type { TerrainData } from "@coasterworks/render";
import { createDefaultRegistry, type ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { uiStore } from "../src/state/uiStore";
import { useHost, type HostState } from "../src/state/useHost";
import {
  CLEAR_OF_INSPECTOR_REM,
  EDGE_GAP_REM,
  INSPECTOR_GAP_REM,
  INSPECTOR_WIDTH_REM,
  TOAST_RIGHT_BESIDE_INSPECTOR_REM,
} from "../src/ui/layout";
import type { ViewportProps } from "../src/viewport/Viewport";

vi.mock("../src/state/useHost", () => ({ useHost: vi.fn() }));
// No WebGL in jsdom. What the viewport is given is kept, so a test can answer as a click would.
const viewport = vi.hoisted(() => ({ props: null as unknown }));
vi.mock("../src/viewport/Viewport", () => ({
  Viewport: (props: unknown) => {
    viewport.props = props;
    return null;
  },
}));

const catalog = createDefaultRegistry().catalog();
const OK: ExecResult = { ok: true, id: 1, cost: 2000 };
const command = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>();
const setSpeed = vi.fn<(speed: Speed) => Promise<void>>();
const query = vi.fn(async () => ({ ok: true, result: catalog }));

/** A 16 by 16 map at height 8 whose tile (3, 3) has its own four corners. */
function terrain(corners: [number, number, number, number] = [5, 6, 7, 4]): TerrainData {
  const data = new Int16Array(17 * 17).fill(8);
  data[3 * 17 + 3] = corners[0];
  data[3 * 17 + 4] = corners[1];
  data[4 * 17 + 4] = corners[2];
  data[4 * 17 + 3] = corners[3];
  return {
    width: 16,
    height: 16,
    corners: data,
    surface: new Uint8Array(256),
    water: new Uint8Array(256),
  };
}

function host(over: Partial<HostState> = {}): HostState {
  return {
    status: "ready",
    name: "Queryland",
    snapshot: {
      header: {
        tick: 0,
        speed: 1 as Speed,
        halted: false,
        cash: 1_000_000,
        loan: 500_000,
        monthStartCash: 1_000_000,
        date: "March 1, Year 1",
        terrainVersion: 0,
        hasTerrain: true,
        width: 16,
        height: 16,
      },
    },
    terrain: terrain(),
    events: [],
    client: { query, setSpeed, command } as unknown as SimClient,
    halted: false,
    ...over,
  };
}

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  command.mockResolvedValue(OK);
  setSpeed.mockResolvedValue(undefined);
  vi.mocked(useHost).mockReturnValue(host());
});
afterEach(() => {
  cleanup();
  command.mockReset();
  setSpeed.mockReset();
  query.mockClear();
  uiStore.setState(uiStore.getInitialState(), true);
});

/** Renders the app, with the sim's commands arrived. */
async function ready() {
  const view = render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

const store = () => uiStore.getState();
const press = (key: string, target: Window | Element = window) =>
  fireEvent.keyDown(target, { key });
const inspector = () => screen.queryByRole("complementary", { name: "Inspector" });
const cashPill = () => screen.getByRole("button", { name: /^Open finances/ });
const datePill = () => screen.getByRole("button", { name: /^Open park overview/ });
const props = () => viewport.props as ViewportProps;

describe("the tray and the dock keep clear of the inspector", () => {
  /** The box the tray and the dock are centered in: the whole window, less the inspector's side. */
  const room = () =>
    screen.getByRole("group", { name: "Tools" }).parentElement?.parentElement as HTMLElement;

  it("have the whole width while it is shut, and the space left of it while it is open", async () => {
    await ready();
    expect(room().style.right).toBe("0px");
    act(() => store().openInspector("finances"));
    expect(room().style.right).toBe(`${CLEAR_OF_INSPECTOR_REM}rem`);
    act(() => store().closeInspector());
    expect(room().style.right).toBe("0px");
  });

  it("keep that space from the same measures as the inspector and the toasts", async () => {
    await ready();
    act(() => store().openInspector("overview"));
    const panel = inspector() as HTMLElement;
    expect(Number.parseFloat(room().style.right)).toBe(
      Number.parseFloat(panel.style.right) +
        Number.parseFloat(panel.style.width) +
        INSPECTOR_GAP_REM,
    );
  });
});

describe("the page's hook for tests", () => {
  it("says what the player has in hand, from the interface's own store", async () => {
    await ready();
    const hook = window.__coasterworks;
    expect(hook?.ready).toBe(true);
    // The park opens with nothing in hand.
    expect(hook?.uiState()).toEqual({ tool: "select", placement: null });
    act(() => press("1"));
    expect(hook?.uiState().tool).toBe("terrain");
    expect(hook?.uiState().placement?.command).toBe("terrain_raise");
    act(() => press("Escape"));
    expect(hook?.uiState()).toEqual({ tool: "select", placement: null });
  });
});

describe("the status pills open the inspector", () => {
  it("the cash pill opens Finances on the park", async () => {
    await ready();
    expect(inspector()).toBeNull();
    fireEvent.click(cashPill());
    expect(store().inspector).toEqual({ open: true, tab: "finances" });
    expect(store().selection).toEqual({ kind: "park" });
    expect(within(inspector() as HTMLElement).getByText("This month")).toBeTruthy();
  });

  it("names the park in the panel's heading, from the host's welcome", async () => {
    await ready();
    fireEvent.click(datePill());
    expect(
      within(inspector() as HTMLElement).getByRole("heading", { name: "Queryland" }),
    ).toBeTruthy();
  });

  it("the date pill opens Overview on the park", async () => {
    await ready();
    fireEvent.click(datePill());
    expect(store().inspector).toEqual({ open: true, tab: "overview" });
    expect(store().selection).toEqual({ kind: "park" });
    expect(
      await within(inspector() as HTMLElement).findAllByText("Coming with guests"),
    ).toHaveLength(2);
  });

  it("the pills still show the cash and the date", async () => {
    await ready();
    expect(cashPill().textContent).toContain("$10,000.00");
    expect(datePill().textContent).toContain("March 1, Year 1");
  });

  it("a click on the pill of a tile's panel brings the park back in its place", async () => {
    await ready();
    act(() => store().inspectTile(3, 3));
    expect(
      within(inspector() as HTMLElement).getByRole("heading", { name: "Tile (3, 3)" }),
    ).toBeTruthy();
    fireEvent.click(cashPill());
    expect(within(inspector() as HTMLElement).getAllByRole("tab")).toHaveLength(3);
    expect(screen.getAllByRole("complementary", { name: "Inspector" })).toHaveLength(1);
  });

  it("the Park tray's buttons open the inspector on the park too", async () => {
    await ready();
    act(() => store().inspectTile(3, 3));
    press("7");
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(store().selection).toEqual({ kind: "park" });
    expect(screen.getByText("Nothing has happened yet.")).toBeTruthy();
  });
});

describe("Escape and the close button", () => {
  it("the × closes it", async () => {
    await ready();
    fireEvent.click(cashPill());
    fireEvent.click(
      within(inspector() as HTMLElement).getByRole("button", { name: "Close inspector" }),
    );
    expect(store().inspector.open).toBe(false);
    expect(inspector()).toBeNull();
  });

  it("Escape puts the tool down first, and closes the inspector the second time", async () => {
    await ready();
    press("1");
    fireEvent.click(cashPill());
    expect(store().tool).toBe("terrain");
    press("Escape");
    expect(store().tool).toBe("select");
    expect(store().placement).toBeNull();
    expect(inspector()).not.toBeNull();
    press("Escape");
    expect(inspector()).toBeNull();
    expect(store().inspector.open).toBe(false);
  });
});

describe("keys while typing in the loan amount (Review Focus 5)", () => {
  let view: Awaited<ReturnType<typeof ready>>;
  async function openFinances() {
    view = await ready();
    // With Raise in hand, so a key that got through would show.
    press("1");
    fireEvent.click(cashPill());
    const take = await screen.findByRole("form", { name: "Take loan" });
    return within(take).getByLabelText("Amount") as HTMLInputElement;
  }

  it("fire nothing: letters, digits, Space and the speed keys stay in the field", async () => {
    const amount = await openFinances();
    amount.focus();
    for (const key of ["r", "w", "l", "1", "2", "7", " ", "+", "-", "?", "q", "["]) {
      press(key, amount);
    }
    expect(store().tool).toBe("terrain");
    expect(store().placement).toEqual({ command: "terrain_raise", defaults: {}, size: 1 });
    expect(store().helpOpen).toBe(false);
    expect(store().brushSize).toBe(1);
    expect(setSpeed).not.toHaveBeenCalled();
  });

  it("fire again when the focus is somewhere else", async () => {
    const amount = await openFinances();
    amount.focus();
    press("w", amount);
    expect(store().placement?.command).toBe("terrain_raise");
    amount.blur();
    press("w", document.body);
    expect(store().placement?.command).toBe("terrain_set_water");
  });

  it("Escape in the field leaves the field first, and keeps the tool and the inspector", async () => {
    const amount = await openFinances();
    amount.focus();
    press("Escape", amount);
    expect(document.activeElement).not.toBe(amount);
    expect(store().tool).toBe("terrain");
    expect(inspector()).not.toBeNull();
  });

  it("takes the loan, and the next snapshot shows it", async () => {
    const amount = await openFinances();
    fireEvent.change(amount, { target: { value: "100" } });
    fireEvent.click(
      within(screen.getByRole("form", { name: "Take loan" })).getByRole("button", {
        name: "Take loan",
      }),
    );
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("finance_take_loan", { amount: 10_000 }),
    );
    // The host answers a command with a snapshot at once, and the panel shows the loan from it.
    const books = () =>
      within(inspector() as HTMLElement).getByText("Loan").nextElementSibling?.textContent;
    expect(books()).toBe("$5,000.00");
    const header = host().snapshot?.header;
    if (!header) throw new Error("no snapshot");
    vi.mocked(useHost).mockReturnValue(
      host({ snapshot: { header: { ...header, loan: 510_000, cash: 1_010_000 } } }),
    );
    view.rerender(<App />);
    expect(books()).toBe("$5,100.00");
  });
});

describe("a tile in the inspector follows the latest terrain (Review Focus 3)", () => {
  const corner = (name: string) =>
    within(screen.getByRole("group", { name: "Corner heights" })).getByText(name).nextElementSibling
      ?.textContent;

  it("shows the heights of the terrain the host has now, and updates when a new snapshot changes them", async () => {
    const { rerender } = await ready();
    act(() => store().inspectTile(3, 3));
    expect([corner("NW"), corner("NE"), corner("SE"), corner("SW")]).toEqual(["5", "6", "7", "4"]);

    vi.mocked(useHost).mockReturnValue(host({ terrain: terrain([9, 9, 10, 8]) }));
    rerender(<App />);
    expect([corner("NW"), corner("NE"), corner("SE"), corner("SW")]).toEqual(["9", "9", "10", "8"]);
  });

  it("Raise here sends terrain_raise for the tile, and a toast says what it cost", async () => {
    await ready();
    act(() => store().inspectTile(3, 3));
    fireEvent.click(screen.getByRole("button", { name: "Raise here" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("terrain_raise", { x: 3, y: 3, w: 1, h: 1 }),
    );
    expect(await screen.findByText("Raised (3, 3): charged $20.00")).toBeTruthy();
  });

  it("a refusal is an error toast", async () => {
    command.mockResolvedValue({ ok: false, error: "Not enough cash" });
    await ready();
    act(() => store().inspectTile(3, 3));
    fireEvent.click(screen.getByRole("button", { name: "Set water" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Not enough cash");
  });

  it("the toast moves aside for the inspector rather than covering its close button", async () => {
    command.mockResolvedValue({ ok: false, error: "Not enough cash" });
    await ready();
    act(() => store().inspectTile(3, 3));
    fireEvent.click(screen.getByRole("button", { name: "Drain" }));
    const stack = (await screen.findByRole("alert")).parentElement as HTMLElement;
    const panel = inspector() as HTMLElement;
    // The stack's right edge is the inspector's left edge, and a gap: both come from one set of
    // measures, so changing the inspector's width moves the toasts with it.
    const panelWidth = Number.parseFloat(panel.style.width);
    const panelRight = Number.parseFloat(panel.style.right);
    expect(panel.style.width).toBe(`${INSPECTOR_WIDTH_REM}rem`);
    expect(Number.parseFloat(stack.style.right)).toBe(panelRight + panelWidth + INSPECTOR_GAP_REM);
    expect(stack.style.right).toBe(`${TOAST_RIGHT_BESIDE_INSPECTOR_REM}rem`);
  });

  it("the toast is back at the window's edge once the inspector is shut", async () => {
    command.mockResolvedValue({ ok: false, error: "Not enough cash" });
    await ready();
    act(() => store().inspectTile(3, 3));
    fireEvent.click(screen.getByRole("button", { name: "Drain" }));
    const stack = (await screen.findByRole("alert")).parentElement as HTMLElement;
    act(() => store().closeInspector());
    expect(stack.style.right).toBe(`${EDGE_GAP_REM}rem`);
  });
});

describe("the tile menu in the app", () => {
  const openMenu = (x = 3, y = 3) =>
    act(() => props().onSecondaryClick?.({ x, y }, { clientX: 100, clientY: 100 }));

  it("gives the viewport a way to ask for it", async () => {
    await ready();
    expect(typeof props().onSecondaryClick).toBe("function");
  });

  it("lists Inspect and the five actions for the tile that was right-clicked", async () => {
    await ready();
    openMenu(5, 6);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Tile (5, 6)")).toBeTruthy();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Inspect", "Raise here", "Lower here", "Level here", "Set water", "Drain"]);
  });

  it("an action runs on that tile and reports as a toast", async () => {
    await ready();
    openMenu(5, 6);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Lower here" }),
    );
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("terrain_lower", { x: 5, y: 6, w: 1, h: 1 }),
    );
    expect(await screen.findByText("Lowered (5, 6): charged $20.00")).toBeTruthy();
  });

  it("Inspect opens the inspector on the tile", async () => {
    await ready();
    openMenu(5, 6);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Inspect" }),
    );
    expect(
      within(inspector() as HTMLElement).getByRole("heading", { name: "Tile (5, 6)" }),
    ).toBeTruthy();
  });

  it("stays shut when the connection is lost", async () => {
    vi.mocked(useHost).mockReturnValue(host({ status: "disconnected" }));
    await ready();
    openMenu();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("holds the shortcut keys while it is open: Space chooses, it does not pause", async () => {
    await ready();
    // With Raise in hand, so a key that got through would show.
    act(() => store().setTool("terrain"));
    openMenu();
    const item = within(await screen.findByRole("menu")).getByRole("menuitem", {
      name: "Raise here",
    });
    press(" ", item);
    press("w", item);
    expect(setSpeed).not.toHaveBeenCalled();
    expect(store().placement?.command).toBe("terrain_raise");
  });
});

describe("the dock does not swallow clicks beside it", () => {
  it("its wrapper lets pointer events through, and the tray and the dock take them", async () => {
    await ready();
    act(() => store().setTool("terrain"));
    const dock = screen.getByRole("group", { name: "Tools" });
    const tray = screen.getByRole("region", { name: "Terrain tray" });
    const wrapper = dock.parentElement as HTMLElement;
    expect(tray.parentElement).toBe(wrapper);
    expect(wrapper.className).toContain("pointer-events-none");
    expect(wrapper.className).not.toContain("pointer-events-auto");
    expect(dock.className).toContain("pointer-events-auto");
    expect(tray.className).toContain("pointer-events-auto");
  });
});

describe("what the player reads", () => {
  it("names no plan or task, and no inspector stand-in", async () => {
    await ready();
    press("3");
    fireEvent.click(cashPill());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Paths, rides, scenery, shops and staff are coming soon.");
    expect(text).not.toMatch(/\bPlan [A-Z0-9]\b|next task|Task \d|coming in the next/i);
  });
});
