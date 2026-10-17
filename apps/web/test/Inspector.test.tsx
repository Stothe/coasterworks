import type { SimClient } from "@coasterworks/protocol";
import type { TerrainData } from "@coasterworks/render";
import { createDefaultRegistry, type ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildActions, type UiActionDeps } from "../src/actions/registry";
import type { ActionContext } from "../src/actions/types";
import { uiStore } from "../src/state/uiStore";
import { buildTimeline } from "../src/state/useTimeline";
import { Inspector, type InspectorProps } from "../src/ui/Inspector";
import { makeSource, type TestSource } from "./snapshotSource";

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

const query = vi.fn<(name: string, input: unknown) => Promise<unknown>>();
const client = { query } as unknown as SimClient;
let source: TestSource;
const ctx: ActionContext = {
  client,
  connected: true,
  halted: false,
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
  source = makeSource({ loan: 500_000, cash: 1_500_000, monthStartCash: 1_200_000 });
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
    source,
    parkName: "Queryland",
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
    // Nothing follows the clock while nothing shows it.
    expect(source.listeners()).toBe(0);
  });

  it("is one panel on the right, with a heading naming what it shows", async () => {
    store().openInspector("overview");
    renderInspector();
    expect(screen.getAllByRole("complementary", { name: "Inspector" })).toHaveLength(1);
    expect(within(inspector()).getByRole("heading", { name: "Queryland" })).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "Queryland" })).toBeTruthy();
  });

  it("has the tabs Overview, Finances and Timeline, on the one that was opened", async () => {
    store().openInspector("finances");
    renderInspector();
    expect(tabs()).toEqual(["Overview", "Finances", "Timeline"]);
    expect(selectedTab()).toBe("Finances");
    expect(screen.getByText("This month")).toBeTruthy();
  });

  it("shows the date as the header's status once it knows it", () => {
    store().openInspector("overview");
    renderInspector();
    expect(within(inspector()).getAllByText("March 1, Year 1")).not.toHaveLength(0);
  });

  it("is titled Park until the host has said what the park is called", () => {
    store().openInspector("overview");
    renderInspector({ parkName: undefined });
    expect(within(inspector()).getByRole("heading", { name: "Park" })).toBeTruthy();
  });

  it("shows no numbers before the first snapshot", () => {
    store().openInspector("overview");
    renderInspector({ source: makeSource(null) });
    expect(screen.getByText("Loading the park")).toBeTruthy();
  });

  it("Overview lists the park's name, date, cash and loan", async () => {
    store().openInspector("overview");
    renderInspector();
    expect(screen.getByText("$15,000.00")).toBeTruthy();
    expect(screen.getByText("$5,000.00")).toBeTruthy();
    expect(screen.getAllByText("Coming with guests")).toHaveLength(2);
  });

  it("Timeline says so when nothing has happened", () => {
    store().openInspector("timeline");
    renderInspector();
    expect(selectedTab()).toBe("Timeline");
    expect(screen.getByText("Nothing has happened yet.")).toBeTruthy();
  });

  it("Timeline lists the events it is given, and a click on one with an area focuses it", () => {
    store().openInspector("timeline");
    const focusTile = vi.fn();
    renderInspector({
      timeline: buildTimeline([
        {
          t: "event",
          kind: "log",
          entry: {
            id: 1,
            tick: 0,
            client: "agent",
            name: "terrain_raise",
            input: { x: 1, y: 2, w: 3, h: 4 },
            cost: 400,
          },
        },
      ]),
      focusTile,
    });
    expect(within(inspector()).getByText("Agent")).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: /Raise terrain/ }));
    expect(focusTile).toHaveBeenCalledWith({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("a tab click shows that tab and remembers it in the store, still on the park", async () => {
    store().openInspector("overview");
    renderInspector();
    fireEvent.mouseDown(within(inspector()).getByRole("tab", { name: "Finances" }), { button: 0 });
    // Radix opens a tab on mouse down; a keyboard focus does the same.
    await waitFor(() => expect(store().inspector.tab).toBe("finances"));
    expect(store().selection).toEqual({ kind: "park" });
    expect(screen.getByText("This month")).toBeTruthy();
  });

  it("falls back to Overview when the tab is the tile's but the park is selected", async () => {
    store().openInspector("overview");
    store().select({ kind: "park" });
    uiStore.setState({ inspector: { open: true, tab: "tile" } });
    renderInspector();
    expect(selectedTab()).toBe("Overview");
    expect(screen.getByRole("heading", { name: "Queryland" })).toBeTruthy();
  });

  it("Finances forms run through the execute it was given", async () => {
    store().openInspector("finances");
    renderInspector();
    const repay = screen.getByRole("form", { name: "Repay loan" });
    fireEvent.change(within(repay).getByLabelText("Amount"), { target: { value: "20" } });
    fireEvent.click(within(repay).getByRole("button", { name: "Repay loan" }));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("finance_repay_loan", { amount: 2000 }),
    );
  });

  it("shows a loan in the next snapshot, which the host sends at once", () => {
    store().openInspector("finances");
    renderInspector();
    const books = within(
      inspector().querySelector<HTMLElement>('dl[aria-label="Finances"]') as HTMLElement,
    );
    expect(books.getByText("$5,000.00")).toBeTruthy();
    act(() => source.push({ loan: 300_000, cash: 1_300_000 }));
    expect(books.getByText("$3,000.00")).toBeTruthy();
    expect(books.getByText("$13,000.00")).toBeTruthy();
  });

  it("tells notify when a loan form went through", async () => {
    store().openInspector("finances");
    renderInspector();
    const repay = screen.getByRole("form", { name: "Repay loan" });
    fireEvent.change(within(repay).getByLabelText("Amount"), { target: { value: "20" } });
    fireEvent.click(within(repay).getByRole("button", { name: "Repay loan" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Loan repaid"));
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
    fireEvent.click(within(inspector()).getByRole("button", { name: "Raise terrain" }));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("terrain_raise", { x: 3, y: 3, w: 1, h: 1 }),
    );
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Raised (3, 3)", {}));
  });
});

describe("Inspector: following the snapshots", () => {
  it("shows the cash, the loan, the date and the month's change as they change", () => {
    store().openInspector("finances");
    renderInspector();
    const books = within(
      inspector().querySelector<HTMLElement>('dl[aria-label="Finances"]') as HTMLElement,
    );
    // $15,000 now against $12,000 when the month began.
    expect(books.getByText("This month").nextSibling?.textContent).toBe("+$3,000.00");
    act(() => source.push({ cash: 1_100_000 }));
    expect(books.getByText("This month").nextSibling?.textContent).toBe("\u2212$1,000.00");
    act(() => source.push({ monthStartCash: 1_100_000, date: "April 1, Year 1" }));
    expect(books.getByText("This month").nextSibling?.textContent).toBe("$0.00");
    expect(within(inspector()).getAllByText("April 1, Year 1")).not.toHaveLength(0);
  });

  it("asks the host for nothing: it reads what the host sent", () => {
    store().openInspector("finances");
    renderInspector();
    act(() => source.push({ cash: 1 }));
    expect(query).not.toHaveBeenCalled();
  });

  it("does not render again for a snapshot that changes none of what it shows", () => {
    store().openInspector("overview");
    let commits = 0;
    render(
      <Profiler id="inspector" onRender={() => commits++}>
        <Inspector
          terrain={terrain()}
          source={source}
          parkName="Queryland"
          actions={actions}
          ctx={ctx}
          execute={execute}
          notify={notify}
        />
      </Profiler>,
    );
    const first = commits;
    // Time moving on and the speed changing are not the park's name, date, cash or loan.
    act(() => source.push({ tick: 40 }));
    act(() => source.push({ tick: 80, speed: 2 }));
    expect(commits).toBe(first);
    act(() => source.push({ cash: 1_000_001 }));
    expect(commits).toBeGreaterThan(first);
  });

  it("stops following when it is closed", () => {
    store().openInspector("overview");
    renderInspector();
    expect(source.listeners()).toBeGreaterThan(0);
    act(() => store().closeInspector());
    expect(source.listeners()).toBe(0);
  });

  it("does not follow the clock while a tile is shown", () => {
    store().inspectTile(3, 3);
    renderInspector();
    expect(source.listeners()).toBe(0);
    act(() => store().openInspector("overview"));
    expect(source.listeners()).toBeGreaterThan(0);
  });
});
