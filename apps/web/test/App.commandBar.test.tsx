import type { SimClient, Speed } from "@coasterworks/protocol";
import { createDefaultRegistry, type CatalogEntry, type ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { uiStore } from "../src/state/uiStore";
import { useHost, type HostState } from "../src/state/useHost";
import { CLASSIC_VIEW_REQUEST } from "../src/viewport/classicView";

vi.mock("../src/state/useHost", () => ({ useHost: vi.fn() }));
// No WebGL in jsdom, and these tests are about the keys and the bar.
vi.mock("../src/viewport/Viewport", () => ({ Viewport: () => null }));

const catalog = createDefaultRegistry().catalog();
const OK: ExecResult = { ok: true, id: 1, cost: 0 };

const setSpeed = vi.fn<(speed: Speed) => Promise<void>>();
const command = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>();
const undo = vi.fn<() => Promise<ExecResult>>();
const redo = vi.fn<() => Promise<ExecResult>>();
// The sim's own commands, and one with no input to run at once.
const gates: CatalogEntry = {
  name: "park_close_gates",
  description: "Closes the gates.",
  category: "park",
  inputSchema: { type: "object", properties: {} },
  undoable: true,
  kind: "command",
};
const query = vi.fn(async (name: string) =>
  name === "catalog_list"
    ? { ok: true as const, result: [...catalog, gates] }
    : { ok: false as const, error: `no ${name}` },
);

function host(speed: Speed = 1): HostState {
  return {
    status: "ready",
    snapshot: {
      header: {
        tick: 0,
        speed,
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
    client: { setSpeed, command, undo, redo, query } as unknown as SimClient,
    halted: false,
  };
}

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  setSpeed.mockResolvedValue(undefined);
  command.mockResolvedValue(OK);
  undo.mockResolvedValue(OK);
  redo.mockResolvedValue(OK);
  vi.mocked(useHost).mockReturnValue(host());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of [setSpeed, command, undo, redo]) fn.mockReset();
  uiStore.setState(uiStore.getInitialState(), true);
});

const press = (
  key: string,
  mods: Partial<KeyboardEventInit> = {},
  target: Window | Element = window,
) => fireEvent.keyDown(target, { key, ...mods });
const input = () => screen.getByPlaceholderText("Type a command…");

/** Renders the app and waits for the sim's commands to arrive, so the bar has them. */
async function ready() {
  render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the command bar in the app", () => {
  it("opens with Control+K, and with the search button", async () => {
    await ready();
    expect(screen.queryByRole("dialog")).toBeNull();
    press("k", { ctrlKey: true });
    expect(input()).toBeTruthy();
    press("Escape", {}, input());
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open command bar" }));
    expect(input()).toBeTruthy();
  });

  it("opens with Command+K on a Mac, and not with Control+K", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await ready();
    press("k", { ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    press("k", { metaKey: true });
    expect(input()).toBeTruthy();
  });

  it("lists the sim's commands once they have arrived, and runs a form through the client", async () => {
    await ready();
    press("k", { ctrlKey: true });
    fireEvent.change(input(), { target: { value: "take loan" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Take loan" }));
    });
    expect(command).toHaveBeenCalledWith("finance_take_loan", { amount: 50_000 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts a placement from the bar, with the hint on screen", async () => {
    await ready();
    press("k", { ctrlKey: true });
    fireEvent.change(input(), { target: { value: "raise terrain" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(uiStore.getState().placement?.command).toBe("terrain_raise");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Click the map to place · Esc to cancel")).toBeTruthy();
    // Esc, then, gives the tool back.
    press("Escape");
    expect(uiStore.getState().placement).toBeNull();
    expect(uiStore.getState().tool).toBe("select");
  });

  it("runs Undo from the bar through the client and reports a refusal", async () => {
    undo.mockResolvedValue({ ok: false, error: "Nothing to undo" });
    await ready();
    press("k", { ctrlKey: true });
    fireEvent.change(input(), { target: { value: "undo" } });
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter" });
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("Nothing to undo");
  });

  it("shows a refusal as a message when a command with no input fails", async () => {
    command.mockResolvedValue({ ok: false, error: "The gates are shut" });
    await ready();
    press("k", { ctrlKey: true });
    fireEvent.change(input(), { target: { value: "close gates" } });
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter" });
    });
    expect(command).toHaveBeenCalledWith("park_close_gates", {});
    expect(screen.getByRole("alert").textContent).toContain("The gates are shut");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the keys while the bar is in use", () => {
  it("do nothing while the cmdk input has focus, except Escape", async () => {
    await ready();
    act(() => uiStore.getState().setTool("terrain"));
    press("k", { ctrlKey: true });
    const field = input();
    expect(document.activeElement).toBe(field);

    press("2", {}, field);
    press(" ", {}, field);
    press("+", {}, field);
    press("z", { ctrlKey: true }, field);
    press("z", { ctrlKey: true, shiftKey: true }, field);
    press("?", {}, field);
    press("Home", {}, field);
    // Terrain is in hand, so a key that took another tool would show.
    expect(uiStore.getState().tool).toBe("terrain");
    expect(uiStore.getState().helpOpen).toBe(false);
    expect(setSpeed).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    // What was typed is still there for the player.
    expect(screen.getByRole("dialog")).toBeTruthy();

    press("Escape", {}, field);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("do nothing while the form's field has focus", async () => {
    await ready();
    act(() => uiStore.getState().setTool("terrain"));
    press("k", { ctrlKey: true });
    fireEvent.change(input(), { target: { value: "take loan" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    const amount = screen.getByLabelText("Amount");
    press("2", {}, amount);
    press(" ", {}, amount);
    press("z", { ctrlKey: true }, amount);
    expect(uiStore.getState().tool).toBe("terrain");
    expect(setSpeed).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
  });

  it("do nothing at all while the bar is open, wherever the focus is", async () => {
    await ready();
    act(() => uiStore.getState().setTool("terrain"));
    press("k", { ctrlKey: true });
    press("3");
    press(" ");
    press("z", { ctrlKey: true });
    expect(uiStore.getState().tool).toBe("terrain");
    expect(setSpeed).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
  });
});

describe("the keymap", () => {
  it("undoes and redoes with Control+Z and Control+Shift+Z", async () => {
    await ready();
    press("z", { ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    press("Z", { ctrlKey: true, shiftKey: true });
    expect(redo).toHaveBeenCalledTimes(1);
    press("y", { ctrlKey: true });
    expect(redo).toHaveBeenCalledTimes(2);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("undoes and redoes with Command on a Mac", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await ready();
    press("z", { metaKey: true });
    press("z", { metaKey: true, shiftKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("shows a refusal from undo", async () => {
    undo.mockResolvedValue({ ok: false, error: "Nothing to undo" });
    await ready();
    await act(async () => press("z", { ctrlKey: true }));
    expect(screen.getByRole("alert").textContent).toContain("Nothing to undo");
  });

  it("opens the dock tools with 1 to 7 and Escape returns to Select", async () => {
    await ready();
    press("1");
    expect(uiStore.getState().tool).toBe("terrain");
    press("3");
    expect(uiStore.getState().tool).toBe("ride");
    press("7");
    expect(uiStore.getState().tool).toBe("park");
    press("Escape");
    expect(uiStore.getState().tool).toBe("select");
  });

  it("toggles help on ?", async () => {
    await ready();
    press("?", { shiftKey: true });
    expect(uiStore.getState().helpOpen).toBe(true);
    press("?", { shiftKey: true });
    expect(uiStore.getState().helpOpen).toBe(false);
  });

  it("asks the view to go classic on Home", async () => {
    await ready();
    const heard = vi.fn();
    window.addEventListener(CLASSIC_VIEW_REQUEST, heard);
    press("Home");
    window.removeEventListener(CLASSIC_VIEW_REQUEST, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("pauses on Space and brings the speed back, and steps the speed with + and -", async () => {
    vi.mocked(useHost).mockReturnValue(host(2));
    await ready();
    press(" ");
    press("+");
    press("-");
    expect(setSpeed.mock.calls.map(([speed]) => speed)).toEqual([0, 4, 2]);
  });

  it("leaves Space to a focused button", async () => {
    await ready();
    const button = screen.getByRole("button", { name: "Speed 2x" });
    press(" ", {}, button);
    expect(setSpeed).not.toHaveBeenCalled();
  });

  it("ignores a key some other part of the page already handled", async () => {
    await ready();
    act(() => uiStore.getState().setTool("terrain"));
    const event = new KeyboardEvent("keydown", { key: "2", cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(uiStore.getState().tool).toBe("terrain");
  });

  it("does nothing when the connection is lost", async () => {
    vi.mocked(useHost).mockReturnValue({
      ...host(),
      status: "disconnected",
      client: null,
      error: "closed",
    });
    await ready();
    act(() => uiStore.getState().setTool("terrain"));
    press("2");
    press("k", { ctrlKey: true });
    expect(uiStore.getState().tool).toBe("terrain");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
