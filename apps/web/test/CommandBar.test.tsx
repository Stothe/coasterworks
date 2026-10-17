import type { SimClient } from "@coasterworks/protocol";
import { createDefaultRegistry, type CatalogEntry, type ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildActions, type UiActionDeps } from "../src/actions/registry";
import type { Action, ActionContext } from "../src/actions/types";
import { uiStore } from "../src/state/uiStore";
import { CommandBar } from "../src/ui/CommandBar";

const catalog = createDefaultRegistry().catalog();

const OK: ExecResult = { ok: true, id: 1, cost: 0 };
const HINT = "Click the map to place · Esc to cancel";

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
});
afterEach(() => {
  cleanup();
  uiStore.setState(uiStore.getInitialState(), true);
});

const ctx = {
  client: {} as SimClient,
  snapshot: null,
  ui: { tool: "select", selection: null, inspectorOpen: false },
} satisfies ActionContext;

/** A command the sim does not have, as the catalog would list it. */
const entry = (
  name: string,
  inputSchema: Record<string, unknown>,
  category: CatalogEntry["category"] = "park",
): CatalogEntry => ({
  name,
  description: `Does ${name}.`,
  category,
  inputSchema,
  undoable: true,
  kind: "command",
});

function setup(extra: CatalogEntry[] = [], tweak?: (actions: Action[]) => Action[]) {
  const execute = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>(async () => OK);
  const notify = vi.fn();
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
  };
  const deps: UiActionDeps = {
    startPlacement: (command, defaults) => uiStore.getState().startPlacement(command, defaults),
    openForm: (action) => uiStore.getState().openForm(action),
    execute,
    ui,
  };
  let actions = buildActions([...catalog, ...extra], deps);
  if (tweak) actions = tweak(actions);
  render(<CommandBar actions={actions} ctx={ctx} execute={execute} notify={notify} />);
  return { execute, notify, ui };
}

const open = () => act(() => uiStore.getState().openCommandBar());
const input = () => screen.getByPlaceholderText("Type a command…");
const search = (text: string) => fireEvent.change(input(), { target: { value: text } });
const option = (name: RegExp | string) => screen.getByRole("option", { name });
const queryOption = (name: RegExp | string) => screen.queryByRole("option", { name });

describe("CommandBar: opening", () => {
  it("is not there until it is opened, and then has a labeled search field", () => {
    setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    expect(screen.getByRole("dialog", { name: "Command bar" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Command bar" })).toBe(input());
    expect(document.activeElement).toBe(input());
  });

  it("closes when the store says so", () => {
    setup();
    open();
    act(() => uiStore.getState().closeCommandBar());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("CommandBar: the list", () => {
  it("groups the actions Terrain, Finance, Park, View, Speed, History, Time and Other", () => {
    setup([entry("park_close_gates", {})]);
    open();
    const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map(
      (el) => el.textContent,
    );
    expect(headings).toEqual([
      "Terrain",
      "Finance",
      "Park",
      "View",
      "Speed",
      "History",
      "Time",
      "Other",
    ]);
  });

  it("puts each action in its group", () => {
    setup([entry("park_close_gates", {})]);
    open();
    const inGroup = (heading: string) => {
      const group = [...document.querySelectorAll<HTMLElement>("[cmdk-group]")].find(
        (el) => el.querySelector("[cmdk-group-heading]")?.textContent === heading,
      );
      return within(group as HTMLElement)
        .getAllByRole("option")
        .map((el) => el.getAttribute("data-value"));
    };
    expect(inGroup("Terrain")).toContain("terrain_raise");
    expect(inGroup("Terrain")).toContain("terrain_set_water");
    expect(inGroup("Finance")).toEqual(["finance_take_loan", "finance_repay_loan"]);
    expect(inGroup("Park")).toEqual(["park_close_gates"]);
    expect(inGroup("View")).toContain("ui.classicView");
    expect(inGroup("View")).toContain("ui.tool.terrain");
    expect(inGroup("Speed")).toEqual([
      "ui.pause",
      "ui.speed.1",
      "ui.speed.2",
      "ui.speed.4",
      "ui.speed.8",
      "ui.speed.up",
      "ui.speed.down",
    ]);
    expect(inGroup("History")).toEqual(["ui.undo", "ui.redo"]);
    expect(inGroup("Time")).toEqual(["sim_advance"]);
    expect(inGroup("Other")).toEqual(["ui.help"]);
  });

  it("shows the title, the description dimmed, and the shortcut as a key cap", () => {
    setup();
    open();
    const undo = option(/Undo/);
    expect(within(undo).getByText("Undo")).toBeTruthy();
    expect(within(undo).getByText("Undo the last command.").className).toContain("text-muted");
    expect(within(undo).getByText("⌘Z").tagName).toBe("KBD");
    expect(within(option(/Raise terrain/)).queryByText(/^⌘/)).toBeNull();
  });

  it("leaves out the actions that exist only for a key", () => {
    setup();
    open();
    expect(queryOption(/Command bar/)).toBeNull();
    expect(queryOption(/^Cancel/)).toBeNull();
  });

  it("matches fuzzily on the title and the keywords", () => {
    setup();
    open();
    search("loan");
    expect(option(/Take loan/)).toBeTruthy();
    expect(option(/Repay loan/)).toBeTruthy();
    expect(queryOption(/Raise terrain/)).toBeNull();
    search("borrow");
    expect(queryOption(/Take loan/)).toBeNull();
    // Letters in order are enough.
    search("lwr");
    expect(option(/Lower terrain/)).toBeTruthy();
    search("faster");
    expect(option(/Speed up/)).toBeTruthy();
  });

  it("says when nothing matches", () => {
    setup();
    open();
    search("zzzzqq");
    expect(screen.getByText("No matching commands")).toBeTruthy();
  });

  it("lists a disabled action dimmed and aria-disabled, and does not run it", () => {
    const { ui } = setup([], (actions) =>
      actions.map((action) =>
        action.id === "ui.undo" ? { ...action, enabled: () => false } : action,
      ),
    );
    open();
    const undo = option(/Undo/);
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(undo);
    expect(ui.undo).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(option(/Redo/).getAttribute("aria-disabled")).toBe("false");
  });

  it("explains when the sim's commands have not loaded", () => {
    const execute = vi.fn();
    render(
      <CommandBar actions={[]} ctx={ctx} execute={execute} notify={vi.fn()} catalogReady={false} />,
    );
    open();
    expect(screen.getByText("Loading commands…")).toBeTruthy();
    cleanup();
    render(
      <CommandBar
        actions={[]}
        ctx={ctx}
        execute={execute}
        notify={vi.fn()}
        catalogReady={false}
        catalogError="no catalog"
      />,
    );
    expect(screen.getByText("Could not load the commands: no catalog")).toBeTruthy();
  });
});

describe("CommandBar: running an action", () => {
  it("runs an interface action on Enter and closes the bar", () => {
    const { ui } = setup();
    open();
    search("undo");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(ui.undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("runs an interface action on a click", () => {
    const { ui } = setup();
    open();
    fireEvent.click(option(/Speed 4x/));
    expect(ui.setSpeed).toHaveBeenCalledWith(4);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("runs a command with no input at once, and closes the bar", () => {
    const { execute } = setup([entry("park_close_gates", {})]);
    open();
    fireEvent.click(option(/Park close gates/));
    expect(execute).toHaveBeenCalledWith("park_close_gates", {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts a placement for a command that takes an area: closes the bar and hints", () => {
    const { notify } = setup();
    open();
    search("raise terrain");
    fireEvent.click(option(/Raise terrain/));
    expect(uiStore.getState().placement?.command).toBe("terrain_raise");
    expect(uiStore.getState().tool).toBe("terrain");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(notify).toHaveBeenCalledWith(HINT);
  });

  it("starts a placement on Enter as well", () => {
    setup();
    open();
    search("lower terrain");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(uiStore.getState().placement?.command).toBe("terrain_lower");
  });

  it("does not hint for anything but a placement", () => {
    const { notify } = setup();
    open();
    fireEvent.click(option(/Undo/));
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("CommandBar: forms", () => {
  it("opens the form for an action with input, in place of the list", () => {
    setup();
    open();
    search("take loan");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("form", { name: "Take loan" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Amount" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Type a command…")).toBeNull();
    expect(uiStore.getState().formAction?.id).toBe("finance_take_loan");
  });

  it("puts the player's focus in the first field", () => {
    setup();
    open();
    fireEvent.click(option(/Take loan/));
    expect(document.activeElement).toBe(screen.getByRole("spinbutton", { name: "Amount" }));
  });

  it("sends the loan in cents, closes the bar, and says it is done", async () => {
    const { execute, notify } = setup();
    open();
    fireEvent.click(option(/Take loan/));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Take loan" }));
    });
    expect(execute).toHaveBeenCalledWith("finance_take_loan", { amount: 50_000 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(notify).toHaveBeenCalledWith("Take loan done");
  });

  it("tells the player what a command charged", async () => {
    const { execute, notify } = setup([
      entry("park_resurface", { type: "object", properties: { n: { type: "integer" } } }),
    ]);
    execute.mockResolvedValue({ ok: true, id: 2, cost: 123_456 });
    open();
    fireEvent.click(option(/Park resurface/));
    fireEvent.change(screen.getByLabelText("N"), { target: { value: "1" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Park resurface" }));
    });
    expect(notify).toHaveBeenCalledWith("Charged $1,234.56");
  });

  it("keeps the bar open and shows the error when the command is refused", async () => {
    const { execute, notify } = setup();
    execute.mockResolvedValue({ ok: false, error: "Loan limit is $50000.00" });
    open();
    fireEvent.click(option(/Take loan/));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Take loan" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Loan limit is $50000.00");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(notify).not.toHaveBeenCalled();
  });

  it("goes back to the list from Back, and from Escape; Escape again closes the bar", () => {
    setup();
    open();
    fireEvent.click(option(/Take loan/));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(uiStore.getState().formAction).toBeNull();
    expect(input()).toBeTruthy();
    // The search field has the focus again, so the player can type at once.
    expect(document.activeElement).toBe(input());

    fireEvent.click(option(/Take loan/));
    fireEvent.keyDown(screen.getByLabelText("Amount"), { key: "Escape" });
    expect(uiStore.getState().formAction).toBeNull();
    expect(input()).toBeTruthy();
    expect(document.activeElement).toBe(input());
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has the focus in the search field after Back from an action that needs the full UI", () => {
    setup([
      entry("park_build_ride", { type: "object", properties: { layout: { type: "object" } } }),
    ]);
    open();
    fireEvent.click(option(/Park build ride/));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(input());
  });

  it("says an action needs the full UI when its form cannot be drawn, and does not crash", () => {
    setup([
      entry("park_build_ride", {
        type: "object",
        properties: {
          layout: {
            type: "object",
            properties: { tiles: { type: "array", items: { type: "integer" } } },
          },
        },
      }),
    ]);
    open();
    fireEvent.click(option(/Park build ride/));
    expect(screen.getByText("This action needs the full UI")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    // The bar still works: Back returns to the list.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(input()).toBeTruthy();
    expect(option(/Take loan/)).toBeTruthy();
  });
});

describe("CommandBar: Escape", () => {
  it("closes the bar and nothing else: a placement stays", () => {
    setup();
    act(() => uiStore.getState().startPlacement("terrain_raise", {}));
    open();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uiStore.getState().placement?.command).toBe("terrain_raise");
    expect(uiStore.getState().tool).toBe("terrain");
  });

  it("closes when the player clicks outside it", async () => {
    setup();
    open();
    // Radix starts listening for outside clicks on the next tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
