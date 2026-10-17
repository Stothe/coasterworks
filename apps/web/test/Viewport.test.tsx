import type { SimClient } from "@coasterworks/protocol";
import type { ControlHandlers, TerrainData } from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsStore } from "../src/state/settings";
import { uiStore } from "../src/state/uiStore";
import { Viewport, type ViewportHandle, type ViewportProps } from "../src/viewport/Viewport";

// No WebGL in jsdom: the scene is a stand-in, and the controls hand over the handlers the viewport
// gave them, so that a test can click as the controls would.
const fake = vi.hoisted(() => ({
  handlers: null as unknown,
  /** What the scene was created with. */
  options: undefined as unknown,
  rig: null as unknown as {
    distance: number;
    limits: { distance: [number, number] };
    yaw: number;
    setClassic(): void;
    target: { x: number; y: number; z: number };
    clampTarget: (width: number, height: number) => void;
  },
  pickAt: ((_x: number, _y: number) => null) as (
    x: number,
    y: number,
  ) => { x: number; y: number } | null,
}));
vi.mock("@coasterworks/render", () => ({
  createScene: (_canvas: unknown, options: unknown) => {
    fake.options = options;
    return {
      rig: fake.rig,
      setTerrain: () => {},
      updateTerrain: () => {},
      setTimeOfDay: () => {},
      highlightTile: () => {},
      pickAt: (x: number, y: number) => fake.pickAt(x, y),
      resize: () => {},
      render: () => {},
      dispose: () => {},
    };
  },
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
  settingsStore.setState(settingsStore.getInitialState(), true);
  command.mockResolvedValue(OK);
  fake.pickAt = () => ({ x: 2, y: 5 });
  fake.options = undefined;
  fake.rig = {
    distance: 10,
    limits: { distance: [1, 200] },
    yaw: 0,
    setClassic: () => {},
    target: { x: 4, y: 3, z: 4 },
    clampTarget: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  command.mockReset();
  uiStore.setState(uiStore.getInitialState(), true);
  settingsStore.setState(settingsStore.getInitialState(), true);
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
  it("with nothing in hand, as the park opens, selects the tile and opens the inspector on it", () => {
    mount();
    expect(uiStore.getState().tool).toBe("select");
    expect(uiStore.getState().placement).toBeNull();
    click(3, 4);
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 3, y: 4 });
    expect(uiStore.getState().inspector).toEqual({ open: true, tab: "tile" });
    expect(command).not.toHaveBeenCalled();
  });

  it("selects another tile on the next click: the one inspector moves", () => {
    mount();
    click(3, 4);
    click(6, 1);
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 6, y: 1 });
  });

  it("with a placement in hand sends the command, and selects nothing", async () => {
    const { props } = mount();
    act(() => uiStore.getState().setTool("terrain"));
    click(3, 4);
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command).toHaveBeenCalledWith("terrain_raise", { x: 3, y: 4, w: 1, h: 1 });
    await vi.waitFor(() => expect(props.onResult).toHaveBeenCalledWith(OK));
    expect(uiStore.getState().selection).toBeNull();
    expect(uiStore.getState().inspector.open).toBe(false);
  });

  it("with a dock tool in hand that has no placement, looks at the tile all the same", () => {
    mount();
    act(() => uiStore.getState().setTool("ride"));
    expect(uiStore.getState().placement).toBeNull();
    click(3, 4);
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 3, y: 4 });
    expect(uiStore.getState().inspector).toEqual({ open: true, tab: "tile" });
    expect(command).not.toHaveBeenCalled();
  });

  it("looks at the tile under every dock tool that holds no placement", () => {
    mount();
    for (const tool of ["path", "ride", "scenery", "shop", "staff", "park"] as const) {
      act(() => {
        uiStore.getState().select(null);
        uiStore.getState().setTool(tool);
      });
      click(2, 2);
      expect(uiStore.getState().selection, tool).toEqual({ kind: "tile", x: 2, y: 2 });
    }
    expect(command).not.toHaveBeenCalled();
  });

  it("selects a tile under Select even before the connection is made: looking needs no sim", () => {
    mount({ client: null });
    click(1, 1);
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 1, y: 1 });
  });

  it("does nothing before there is terrain", () => {
    mount({ terrain: null });
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

describe("Viewport: focusTile", () => {
  function mountWithHandle(over: Partial<ViewportProps> = {}) {
    const ref = createRef<ViewportHandle>();
    const props: ViewportProps = { terrain, tick: 0, client, onResult: vi.fn(), ...over };
    render(<Viewport {...props} ref={ref} />);
    return ref;
  }

  it("puts the target over the center of the area, and keeps the way the camera looks", () => {
    const ref = mountWithHandle();
    fake.rig.yaw = 1.25;
    ref.current?.focusTile(2, 3, 4, 2);
    expect(fake.rig.target.x).toBe(4);
    expect(fake.rig.target.z).toBe(4);
    expect(fake.rig.distance).toBe(10);
    expect(fake.rig.yaw).toBe(1.25);
  });

  it("centers on the middle of a single tile", () => {
    const ref = mountWithHandle();
    ref.current?.focusTile(5, 1, 1, 1);
    expect(fake.rig.target.x).toBe(5.5);
    expect(fake.rig.target.z).toBe(1.5);
  });

  it("leaves the height to the camera, which follows the ground", () => {
    const ref = mountWithHandle();
    ref.current?.focusTile(0, 0, 2, 2);
    expect(fake.rig.target.y).toBe(3);
  });

  it("keeps the target over the map", () => {
    const ref = mountWithHandle();
    ref.current?.focusTile(6, 6, 2, 2);
    expect(fake.rig.clampTarget).toHaveBeenCalledWith(8, 8);
  });

  it("does nothing before there is a scene to move", () => {
    const ref = createRef<ViewportHandle>();
    const { unmount } = render(
      <Viewport terrain={terrain} tick={0} client={client} onResult={vi.fn()} ref={ref} />,
    );
    unmount();
    expect(() => ref.current?.focusTile(1, 1, 1, 1)).not.toThrow();
  });
});

describe("Viewport: the pixel ratio cap", () => {
  it("creates the scene with the cap the settings hold", () => {
    settingsStore.getState().setPixelRatioCap(1.5);
    mount();
    expect(fake.options).toEqual({ pixelRatioCap: 1.5 });
  });

  it("creates it with 2, the default cap", () => {
    mount();
    expect(fake.options).toEqual({ pixelRatioCap: 2 });
  });
});

describe("Viewport: the FPS counter", () => {
  const counter = () => document.body.textContent?.match(/(\d+|…) FPS/)?.[0] ?? null;

  it("is not there unless Show FPS is on", () => {
    mount();
    expect(counter()).toBeNull();
  });

  it("is there when Show FPS is on, and counts the frames of the draw loop", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    act(() => settingsStore.getState().setShowFps(true));
    mount();
    expect(counter()).toBe("… FPS");
    // Fake frames come every 16ms, which is 62 or 63 a second.
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    const fps = Number(counter()?.split(" ")[0]);
    expect(fps).toBeGreaterThanOrEqual(55);
    expect(fps).toBeLessThanOrEqual(65);
  });

  it("goes away when Show FPS is turned off", () => {
    act(() => settingsStore.getState().setShowFps(true));
    mount();
    expect(counter()).not.toBeNull();
    act(() => settingsStore.getState().setShowFps(false));
    expect(counter()).toBeNull();
  });
});
