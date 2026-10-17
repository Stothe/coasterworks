import type { SimClient } from "@coasterworks/protocol";
import type { ControlHandlers, TerrainData } from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiStore } from "../src/state/uiStore";
import { Viewport, type ViewportProps } from "../src/viewport/Viewport";

// No WebGL in jsdom: the scene is a stand-in, and the controls hand over the handlers the viewport
// gave them, so that a test can click as the controls would.
const fake = vi.hoisted(() => ({
  handlers: null as unknown,
  pickAt: ((_x: number, _y: number) => null) as (
    x: number,
    y: number,
  ) => { x: number; y: number } | null,
}));
vi.mock("@coasterworks/render", () => ({
  createScene: () => ({
    rig: { distance: 10, limits: { distance: [1, 200] }, yaw: 0, setClassic: () => {} },
    setTerrain: () => {},
    updateTerrain: () => {},
    setTimeOfDay: () => {},
    highlightTile: () => {},
    pickAt: (x: number, y: number) => fake.pickAt(x, y),
    resize: () => {},
    render: () => {},
    dispose: () => {},
  }),
  attachControls: (_canvas: unknown, _rig: unknown, handlers: unknown) => {
    fake.handlers = handlers;
    return () => {};
  },
}));

const terrain: TerrainData = {
  width: 8,
  height: 8,
  corners: new Int16Array(81).fill(4),
  surface: new Uint8Array(64),
  water: new Uint8Array(64),
};
const OK: ExecResult = { ok: true, id: 1, cost: 0 };
const command = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>();
const client = { command } as unknown as SimClient;

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  command.mockResolvedValue(OK);
  fake.pickAt = () => ({ x: 2, y: 5 });
});
afterEach(() => {
  cleanup();
  command.mockReset();
  uiStore.setState(uiStore.getInitialState(), true);
});

function mount(over: Partial<ViewportProps> = {}) {
  const props: ViewportProps = { terrain, tick: 0, client, onResult: vi.fn(), ...over };
  const view = render(<Viewport {...props} />);
  return { props, canvas: view.getByLabelText("Park view") as HTMLCanvasElement };
}
const handlers = () => fake.handlers as ControlHandlers;
const click = (x = 3, y = 4, mods = { shift: false, alt: false }) =>
  handlers().onTileClick(x, y, mods);

describe("Viewport: a left click", () => {
  it("under Select, with nothing in hand, selects the tile and opens the inspector on it", () => {
    mount();
    act(() => uiStore.getState().cancel());
    expect(uiStore.getState().tool).toBe("select");
    click(3, 4);
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 3, y: 4 });
    expect(uiStore.getState().inspector).toEqual({ open: true, tab: "tile" });
    expect(command).not.toHaveBeenCalled();
  });

  it("selects another tile on the next click: the one inspector moves", () => {
    mount();
    act(() => uiStore.getState().cancel());
    click(3, 4);
    click(6, 1);
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 6, y: 1 });
  });

  it("with a placement in hand sends the command, and selects nothing", async () => {
    const { props } = mount();
    click(3, 4);
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command).toHaveBeenCalledWith("terrain_raise", { x: 3, y: 4, w: 1, h: 1 });
    await vi.waitFor(() => expect(props.onResult).toHaveBeenCalledWith(OK));
    expect(uiStore.getState().selection).toBeNull();
    expect(uiStore.getState().inspector.open).toBe(false);
  });

  it("with a dock tool in hand that has no placement, does nothing", () => {
    mount();
    act(() => uiStore.getState().setTool("ride"));
    click(3, 4);
    expect(uiStore.getState().selection).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it("selects a tile under Select even before the connection is made: looking needs no sim", () => {
    mount({ client: null });
    act(() => uiStore.getState().cancel());
    click(1, 1);
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 1, y: 1 });
  });

  it("does nothing before there is terrain", () => {
    mount({ terrain: null });
    act(() => uiStore.getState().cancel());
    click(1, 1);
    expect(uiStore.getState().selection).toBeNull();
  });
});

describe("Viewport: a right click", () => {
  /** A pointer event of the kind the canvas hears. jsdom's own `PointerEvent` may not carry a button. */
  function pointer(
    canvas: HTMLCanvasElement,
    type: string,
    init: { button?: number; x: number; y: number; ctrlKey?: boolean; id?: number },
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: init.button ?? 0,
      clientX: init.x,
      clientY: init.y,
      ctrlKey: init.ctrlKey ?? false,
    });
    Object.defineProperty(event, "pointerId", { value: init.id ?? 1 });
    canvas.dispatchEvent(event);
  }

  it("asks for the menu of the tile under the pointer, at the pointer", () => {
    const onSecondaryClick = vi.fn();
    const { canvas } = mount({ onSecondaryClick });
    fake.pickAt = (x, y) => (x === 210 && y === 130 ? { x: 4, y: 6 } : null);
    pointer(canvas, "pointerdown", { button: 2, x: 210, y: 130 });
    pointer(canvas, "pointerup", { button: 2, x: 210, y: 130 });
    expect(onSecondaryClick).toHaveBeenCalledTimes(1);
    expect(onSecondaryClick).toHaveBeenCalledWith({ x: 4, y: 6 }, { clientX: 210, clientY: 130 });
  });

  it("allows a few pixels of shake: a hand is not perfectly still", () => {
    const onSecondaryClick = vi.fn();
    const { canvas } = mount({ onSecondaryClick });
    pointer(canvas, "pointerdown", { button: 2, x: 100, y: 100 });
    pointer(canvas, "pointermove", { x: 102, y: 103 });
    pointer(canvas, "pointerup", { button: 2, x: 102, y: 103 });
    expect(onSecondaryClick).toHaveBeenCalledTimes(1);
  });

  it("is not a click when the press was dragged: that is the view turning", () => {
    const onSecondaryClick = vi.fn();
    const { canvas } = mount({ onSecondaryClick });
    pointer(canvas, "pointerdown", { button: 2, x: 100, y: 100 });
    pointer(canvas, "pointermove", { x: 140, y: 110 });
    // Back where it began, still an orbit: the press moved.
    pointer(canvas, "pointermove", { x: 100, y: 100 });
    pointer(canvas, "pointerup", { button: 2, x: 100, y: 100 });
    expect(onSecondaryClick).not.toHaveBeenCalled();
  });

  it("is the Mac's too: control and a left press", () => {
    const onSecondaryClick = vi.fn();
    const { canvas } = mount({ onSecondaryClick });
    pointer(canvas, "pointerdown", { button: 0, ctrlKey: true, x: 50, y: 60 });
    pointer(canvas, "pointerup", { button: 0, ctrlKey: true, x: 50, y: 60 });
    expect(onSecondaryClick).toHaveBeenCalledTimes(1);
  });

  it("is not a plain left click", () => {
    const onSecondaryClick = vi.fn();
    const { canvas } = mount({ onSecondaryClick });
    pointer(canvas, "pointerdown", { button: 0, x: 50, y: 60 });
    pointer(canvas, "pointerup", { button: 0, x: 50, y: 60 });
    expect(onSecondaryClick).not.toHaveBeenCalled();
  });

  it("says nothing over nothing: no tile under the pointer, no menu", () => {
    const onSecondaryClick = vi.fn();
    const { canvas } = mount({ onSecondaryClick });
    fake.pickAt = () => null;
    pointer(canvas, "pointerdown", { button: 2, x: 5, y: 5 });
    pointer(canvas, "pointerup", { button: 2, x: 5, y: 5 });
    expect(onSecondaryClick).not.toHaveBeenCalled();
  });

  it("forgets a press that was cancelled", () => {
    const onSecondaryClick = vi.fn();
    const { canvas } = mount({ onSecondaryClick });
    pointer(canvas, "pointerdown", { button: 2, x: 5, y: 5 });
    pointer(canvas, "pointercancel", { x: 5, y: 5 });
    pointer(canvas, "pointerup", { button: 2, x: 5, y: 5 });
    expect(onSecondaryClick).not.toHaveBeenCalled();
  });

  it("neither selects nor sends anything itself: the menu decides", () => {
    const { canvas } = mount({ onSecondaryClick: vi.fn() });
    act(() => uiStore.getState().cancel());
    pointer(canvas, "pointerdown", { button: 2, x: 5, y: 5 });
    pointer(canvas, "pointerup", { button: 2, x: 5, y: 5 });
    expect(uiStore.getState().selection).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it("stops listening when the view goes", () => {
    const onSecondaryClick = vi.fn();
    const view = mount({ onSecondaryClick });
    const canvas = view.canvas;
    cleanup();
    pointer(canvas, "pointerdown", { button: 2, x: 5, y: 5 });
    pointer(canvas, "pointerup", { button: 2, x: 5, y: 5 });
    expect(onSecondaryClick).not.toHaveBeenCalled();
  });
});
