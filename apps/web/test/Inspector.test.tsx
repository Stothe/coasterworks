import type { SimClient } from "@coasterworks/protocol";
import type { TerrainData } from "@coasterworks/render";
import { createDefaultRegistry, type ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildActions, type UiActionDeps } from "../src/actions/registry";
import type { ActionContext } from "../src/actions/types";
import { uiStore } from "../src/state/uiStore";
import type { ParkStatus } from "../src/state/useParkStatus";
import { Inspector, type InspectorProps } from "../src/ui/Inspector";

const noop = vi.fn();
const deps: UiActionDeps = {
  startPlacement: noop,
  openForm: noop,
  execute: noop,
  ui: {
    pause: noop,
    setSpeed: noop,
    stepSpeed: noop,
    undo: noop,
    redo: noop,
    classicView: noop,
    setTool: noop,
    openInspector: noop,
    help: noop,
    commandBar: noop,
    cancel: noop,
    terrain: noop,
    brush: noop,
  },
};
const actions = buildActions(createDefaultRegistry().catalog(), deps);

const park = (over: Partial<ParkStatus> = {}): ParkStatus => ({
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
  ...over,
});

const query = vi.fn<(name: string, input: unknown) => Promise<unknown>>();
const client = { query } as unknown as SimClient;
const ctx: ActionContext = {
  client,
  snapshot: null,
  ui: { tool: "select", selection: { kind: "park" }, inspectorOpen: true },
};
const execute = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>();
const notify = vi.fn();

function terrain(): TerrainData {
  const corners = new Int16Array(9 * 9).fill(3);
  const surface = new Uint8Array(64);
  const water = new Uint8Array(64);
  surface[3 * 8 + 3] = 1;
  return { width: 8, height: 8, corners, surface, water };
}

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  query.mockResolvedValue({ ok: true, result: park({ loan: 500_000, cash: 1_500_000 }) });
  execute.mockResolvedValue({ ok: true, id: 1, cost: 0 });
});
afterEach(() => {
  cleanup();
  query.mockReset();
  execute.mockReset();
  notify.mockReset();
  uiStore.setState(uiStore.getInitialState(), true);
});

function renderInspector(props: Partial<InspectorProps> = {}) {
  const all: InspectorProps = {
    terrain: terrain(),
    client,
    actions,
    ctx,
    execute,
    notify,
    ...props,
  };
  const view = render(<Inspector {...all} />);
  return {
    ...view,
    again: (next: Partial<InspectorProps> = {}) => view.rerender(<Inspector {...all} {...next} />),
  };
}

const store = () => uiStore.getState();
const inspector = () => screen.getByRole("complementary", { name: "Inspector" });
const tabs = () =>
  within(inspector())
    .queryAllByRole("tab")
    .map((tab) => tab.textContent);
const selectedTab = () =>
  within(inspector())
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

describe("Inspector: when it shows", () => {
  it("is nothing while it is closed", () => {
    const { container } = renderInspector();
    expect(container.innerHTML).toBe("");
    expect(query).not.toHaveBeenCalled();
  });

  it("is one panel on the right, with a heading naming what it shows", async () => {
    store().openInspector("overview");
    renderInspector();
    expect(screen.getAllByRole("complementary", { name: "Inspector" })).toHaveLength(1);
    expect(await within(inspector()).findByRole("heading", { name: "Queryland" })).toBeTruthy();
  });

  it("floats on glass", () => {
    store().openInspector("overview");
    renderInspector();
    expect(inspector().querySelector(".glass")).not.toBeNull();
  });

  it("closes from its × button, and says so for assistive technology", () => {
    store().openInspector("overview");
    renderInspector();
    const close = within(inspector()).getByRole("button", { name: "Close inspector" });
    expect(close.className).toContain("hud-button");
    fireEvent.click(close);
    expect(store().inspector.open).toBe(false);
  });
});

describe("Inspector: the park", () => {
  it("shows the park when nothing is selected: it is the default", async () => {
    store().openInspector("overview");
    store().select(null);
    renderInspector();
    expect(tabs()).toEqual(["Overview", "Finances", "Timeline"]);
    expect(await screen.findByRole("heading", { name: "Queryland" })).toBeTruthy();
  });

  it("has the tabs Overview, Finances and Timeline, on the one that was opened", async () => {
    store().openInspector("finances");
    renderInspector();
    expect(tabs()).toEqual(["Overview", "Finances", "Timeline"]);
    expect(selectedTab()).toBe("Finances");
    expect(await screen.findByText("This month")).toBeTruthy();
  });

  it("shows the date as the header's status once it knows it", async () => {
    store().openInspector("overview");
    renderInspector();
    expect(await within(inspector()).findAllByText("March 1, Year 1")).not.toHaveLength(0);
  });

  it("Overview lists the park's name, date, cash and loan", async () => {
    store().openInspector("overview");
    renderInspector();
    expect(await screen.findByText("$15,000.00")).toBeTruthy();
    expect(screen.getByText("$5,000.00")).toBeTruthy();
    expect(screen.getAllByText("Coming with guests")).toHaveLength(2);
  });

  it("Timeline holds its place until the next update", () => {
    store().openInspector("timeline");
    renderInspector();
    expect(selectedTab()).toBe("Timeline");
    expect(screen.getByText("Timeline arrives in the next update")).toBeTruthy();
  });

  it("a tab click shows that tab and remembers it in the store, still on the park", async () => {
    store().openInspector("overview");
    renderInspector();
    fireEvent.mouseDown(within(inspector()).getByRole("tab", { name: "Finances" }), { button: 0 });
    // Radix opens a tab on mouse down; a keyboard focus does the same.
    await waitFor(() => expect(store().inspector.tab).toBe("finances"));
    expect(store().selection).toEqual({ kind: "park" });
    expect(await screen.findByText("This month")).toBeTruthy();
  });

  it("falls back to Overview when the tab is the tile's but the park is selected", async () => {
    store().openInspector("overview");
    store().select({ kind: "park" });
    uiStore.setState({ inspector: { open: true, tab: "tile" } });
    renderInspector();
    expect(selectedTab()).toBe("Overview");
    expect(await screen.findByRole("heading", { name: "Queryland" })).toBeTruthy();
  });

  it("Finances forms run through the execute it was given", async () => {
    store().openInspector("finances");
    renderInspector();
    const repay = await screen.findByRole("form", { name: "Repay loan" });
    fireEvent.change(within(repay).getByLabelText("Amount"), { target: { value: "20" } });
    fireEvent.click(within(repay).getByRole("button", { name: "Repay loan" }));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("finance_repay_loan", { amount: 2000 }),
    );
  });

  it("asks for the status again after a loan, so the numbers show it", async () => {
    store().openInspector("finances");
    renderInspector();
    const repay = await screen.findByRole("form", { name: "Repay loan" });
    const asked = query.mock.calls.length;
    query.mockResolvedValue({ ok: true, result: park({ loan: 300_000, cash: 1_300_000 }) });
    fireEvent.change(within(repay).getByLabelText("Amount"), { target: { value: "2000" } });
    fireEvent.click(within(repay).getByRole("button", { name: "Repay loan" }));
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(asked));
    expect(await screen.findByText("$13,000.00")).toBeTruthy();
    expect(notify).toHaveBeenCalledWith("Loan repaid");
  });
});

describe("Inspector: a tile", () => {
  it("shows the tile's coordinates as its heading, with no tabs", () => {
    store().inspectTile(3, 3);
    renderInspector();
    expect(within(inspector()).getByRole("heading", { name: "Tile (3, 3)" })).toBeTruthy();
    expect(tabs()).toEqual([]);
  });

  it("shows the corner heights and the surface from the terrain it is given", () => {
    store().inspectTile(3, 3);
    renderInspector();
    const corners = within(inspector()).getByRole("group", { name: "Corner heights" });
    expect(within(corners).getAllByText("3")).toHaveLength(4);
    // The surface is the header's status as well as a fact of the tile.
    expect(within(inspector()).getAllByText("Sand").length).toBeGreaterThan(0);
  });

  it("follows the terrain it is given, render after render", () => {
    store().inspectTile(3, 3);
    const { again } = renderInspector();
    const next = terrain();
    next.corners.fill(7);
    again({ terrain: next });
    const corners = within(inspector()).getByRole("group", { name: "Corner heights" });
    expect(within(corners).getAllByText("7")).toHaveLength(4);
  });

  it("moves to another tile rather than opening a second panel", () => {
    store().inspectTile(3, 3);
    renderInspector();
    act(() => store().inspectTile(5, 6));
    expect(screen.getAllByRole("complementary", { name: "Inspector" })).toHaveLength(1);
    expect(within(inspector()).getByRole("heading", { name: "Tile (5, 6)" })).toBeTruthy();
  });

  it("gives way to the park when a park tab is opened, and back to the tile", async () => {
    store().inspectTile(3, 3);
    renderInspector();
    act(() => store().openInspector("finances"));
    expect(tabs()).toEqual(["Overview", "Finances", "Timeline"]);
    act(() => store().inspectTile(1, 1));
    expect(tabs()).toEqual([]);
    expect(within(inspector()).getByRole("heading", { name: "Tile (1, 1)" })).toBeTruthy();
  });

  it("runs a tile action through execute and tells notify", async () => {
    store().inspectTile(3, 3);
    renderInspector();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Raise here" }));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("terrain_raise", { x: 3, y: 3, w: 1, h: 1 }),
    );
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Raised (3, 3)", {}));
  });
});

describe("Inspector: the status it polls", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("asks for park_status while the park is shown, every second", async () => {
    store().openInspector("overview");
    renderInspector();
    await act(async () => {});
    expect(query).toHaveBeenCalledWith("park_status", {});
    const before = query.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(query.mock.calls.length).toBe(before + 2);
  });

  it("does not ask while a tile is shown, and asks again when the park comes back", async () => {
    store().inspectTile(3, 3);
    renderInspector();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(query).not.toHaveBeenCalled();
    act(() => store().openInspector("overview"));
    await act(async () => {});
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("asks once more after each new event", async () => {
    store().openInspector("overview");
    const { again } = renderInspector({ lastEventId: 3 });
    await act(async () => {});
    const before = query.mock.calls.length;
    again({ lastEventId: 4 });
    await act(async () => {});
    expect(query.mock.calls.length).toBe(before + 1);
  });

  it("stops asking when it is closed", async () => {
    store().openInspector("overview");
    renderInspector();
    await act(async () => {});
    act(() => store().closeInspector());
    query.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(query).not.toHaveBeenCalled();
  });
});
