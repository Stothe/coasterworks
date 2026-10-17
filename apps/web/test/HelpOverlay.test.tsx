import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildActions, type UiActionDeps } from "../src/actions/registry";
import type { Action } from "../src/actions/types";
import { KEYMAP, formatCombo } from "../src/state/keys";
import { uiStore } from "../src/state/uiStore";
import { HelpOverlay } from "../src/ui/HelpOverlay";

const noop = () => {};
const deps: UiActionDeps = {
  startPlacement: noop,
  openForm: noop,
  execute: async () => ({ ok: true, id: 1, cost: 0 }),
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
const byId: ReadonlyMap<string, Action> = new Map(buildActions([], deps).map((a) => [a.id, a]));

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  uiStore.setState(uiStore.getInitialState(), true);
});

const overlay = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });

describe("HelpOverlay", () => {
  it("shows nothing while help is closed", () => {
    render(<HelpOverlay byId={byId} />);
    expect(overlay()).toBeNull();
  });

  it("shows when the store says help is open", () => {
    render(<HelpOverlay byId={byId} />);
    act(() => uiStore.getState().toggleHelp());
    expect(overlay()).not.toBeNull();
    act(() => uiStore.getState().toggleHelp());
    expect(overlay()).toBeNull();
  });

  it("is not modal: it takes no part of the page away from assistive technology", () => {
    uiStore.setState({ helpOpen: true });
    render(<HelpOverlay byId={byId} />);
    expect(overlay()?.getAttribute("aria-modal")).not.toBe("true");
  });

  it("groups the keys: Tools, Terrain, Camera, Speed, History, Panels", () => {
    uiStore.setState({ helpOpen: true });
    render(<HelpOverlay byId={byId} />);
    const headings = within(overlay() as HTMLElement)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Tools", "Terrain", "Camera", "Speed", "History", "Panels"]);
  });

  it("lists the title of the action of every key of the map", () => {
    uiStore.setState({ helpOpen: true });
    render(<HelpOverlay byId={byId} />);
    const dialog = overlay() as HTMLElement;
    for (const { actionId } of KEYMAP) {
      const title = byId.get(actionId)?.title;
      expect(title, actionId).toBeDefined();
      expect(within(dialog).getAllByText(title as string).length, title).toBeGreaterThan(0);
    }
    expect(within(dialog).getByText("Command bar")).toBeTruthy();
  });

  it("shows every combo of the map as a key cap", () => {
    uiStore.setState({ helpOpen: true });
    render(<HelpOverlay byId={byId} />);
    const caps = Array.from(
      (overlay() as HTMLElement).querySelectorAll("kbd"),
      (kbd) => kbd.textContent,
    );
    for (const { combo } of KEYMAP) expect(caps, combo).toContain(formatCombo(combo, false));
  });

  it("writes Ctrl on a PC and Command on a Mac", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    uiStore.setState({ helpOpen: true });
    const pc = render(<HelpOverlay byId={byId} />);
    const row = (name: string) =>
      (screen.getByText(name).closest("li") as HTMLElement).textContent as string;
    expect(row("Command bar")).toContain("Ctrl+K");
    pc.unmount();

    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<HelpOverlay byId={byId} />);
    expect(row("Command bar")).toContain("⌘K");
  });

  it("lists both keys of an action that has two on one line", () => {
    uiStore.setState({ helpOpen: true });
    render(<HelpOverlay byId={byId} />);
    const speedUp = screen.getByText("Speed up").closest("li") as HTMLElement;
    expect(Array.from(speedUp.querySelectorAll("kbd"), (k) => k.textContent)).toEqual(["+", "="]);
  });

  it("lists Undo before Redo, though the map names Redo's chord first", () => {
    uiStore.setState({ helpOpen: true });
    render(<HelpOverlay byId={byId} />);
    const history = within(overlay() as HTMLElement).getByRole("region", { name: "History" });
    expect(
      within(history)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["UndoCtrl+Z", "RedoCtrl+Shift+ZCtrl+Y"]);
  });

  it("closes on a click outside it, and stays on a click inside", () => {
    uiStore.setState({ helpOpen: true });
    render(<HelpOverlay byId={byId} />);
    fireEvent.click(screen.getByRole("heading", { name: "Keyboard shortcuts" }));
    expect(uiStore.getState().helpOpen).toBe(true);
    fireEvent.click(screen.getByTestId("help-backdrop"));
    expect(uiStore.getState().helpOpen).toBe(false);
  });

  it("closes with the Close button", () => {
    uiStore.setState({ helpOpen: true });
    render(<HelpOverlay byId={byId} />);
    fireEvent.click(screen.getByRole("button", { name: "Close shortcuts" }));
    expect(uiStore.getState().helpOpen).toBe(false);
  });
});
