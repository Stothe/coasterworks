import type {
  GuestSection,
  QueryResult,
  RidePublic,
  RideStatusSection,
  SimClient,
} from "@coasterworks/protocol";
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
  /** The scene's calls, in order, as [method, ...args]. */
  calls: [] as unknown[][],
  pickAt: ((_x: number, _y: number) => null) as (
    x: number,
    y: number,
  ) => { x: number; y: number } | null,
  pickGuestAt: ((_x: number, _y: number) => null) as (
    x: number,
    y: number,
  ) => { id: number } | null,
}));
vi.mock("@coasterworks/render", () => ({
  createScene: (_canvas: unknown, options: unknown) => {
    fake.options = options;
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        fake.calls.push([name, ...args]);
      };
    return {
      rig: fake.rig,
      setTerrain: () => {},
      updateTerrain: () => {},
      setTimeOfDay: () => {},
      setPaths: record("setPaths"),
      setGuests: record("setGuests"),
      setRides: record("setRides"),
      setRideStatus: record("setRideStatus"),
      setEntrance: record("setEntrance"),
      setGridVisible: record("setGridVisible"),
      setQuality: record("setQuality"),
      highlightTile: () => {},
      pickAt: (x: number, y: number) => fake.pickAt(x, y),
      pickGuestAt: (x: number, y: number) => fake.pickGuestAt(x, y),
      resize: () => {},
      render: record("render"),
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
const query = vi.fn<(name: string, input: unknown) => Promise<QueryResult<unknown>>>();
const client = { command, query } as unknown as SimClient;

/** A `path_check_tiles` that refuses the tiles `refuse` says, with its reason. */
function checking(refuse: (x: number, y: number) => string | null = () => null) {
  query.mockImplementation(async (_name, input) => {
    const { tiles } = input as { tiles: Array<{ x: number; y: number }> };
    const refused = tiles.flatMap(({ x, y }) => {
      const reason = refuse(x, y);
      return reason === null ? [] : [{ x, y, reason }];
    });
    return { ok: true, result: { refused, changes: tiles.length - refused.length, cost: 0 } };
  });
}

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  settingsStore.setState(settingsStore.getInitialState(), true);
  command.mockResolvedValue(OK);
  checking();
  fake.pickAt = () => ({ x: 2, y: 5 });
  fake.pickGuestAt = () => null;
  fake.options = undefined;
  fake.calls = [];
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
  query.mockReset();
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
    // (Terrain and Paths have a tool in hand as soon as they are chosen.)
    for (const tool of ["ride", "scenery", "shop", "staff", "park"] as const) {
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
    expect(fake.options).toEqual({ pixelRatioCap: 1.5, quality: "auto" });
  });

  it("creates it with 2, the default cap", () => {
    mount();
    expect(fake.options).toEqual({ pixelRatioCap: 2, quality: "auto" });
  });
});

/** The scene's calls to one method, as their argument lists. */
const callsTo = (name: string) => fake.calls.filter(([n]) => n === name).map((c) => c.slice(1));

describe("Viewport: the graphics quality", () => {
  it("creates the scene with the quality the settings hold", () => {
    settingsStore.getState().setGraphicsQuality("medium");
    mount();
    expect(fake.options).toEqual({ pixelRatioCap: 2, quality: "medium" });
  });

  it("does not ask the new scene again for the quality it was made with", () => {
    mount();
    expect(callsTo("setQuality")).toEqual([]);
    settingsStore.getState().setGraphicsQuality("high");
    cleanup();
    fake.calls = [];
    mount();
    expect(fake.options).toEqual({ pixelRatioCap: 2, quality: "high" });
    expect(callsTo("setQuality")).toEqual([]);
  });

  it("gives a change of quality to the scene that is up, without making another", () => {
    mount();
    const options = fake.options;
    act(() => settingsStore.getState().setGraphicsQuality("low"));
    expect(callsTo("setQuality")).toEqual([["low"]]);
    act(() => settingsStore.getState().setGraphicsQuality("auto"));
    expect(callsTo("setQuality")).toEqual([["low"], ["auto"]]);
    expect(fake.options).toBe(options);
  });
});

describe("Viewport: the path layer and the grid", () => {
  it("gives the scene the paths it is mounted with, and each new layer after", () => {
    const first = new Uint8Array(64).fill(1);
    const view = render(
      <Viewport terrain={terrain} tick={0} client={client} onResult={vi.fn()} paths={first} />,
    );
    // Once: the scene bakes the layer it is given, every time it is given one.
    expect(callsTo("setPaths")).toEqual([[first]]);
    const second = new Uint8Array(64).fill(2);
    view.rerender(
      <Viewport terrain={terrain} tick={0} client={client} onResult={vi.fn()} paths={second} />,
    );
    expect(callsTo("setPaths")).toEqual([[first], [second]]);
  });

  it("gives null when there are no paths, and when they are taken away", () => {
    mount();
    expect(callsTo("setPaths")).toEqual([[null]]);
    cleanup();
    fake.calls = [];
    const paths = new Uint8Array(64).fill(1);
    const view = render(
      <Viewport terrain={terrain} tick={0} client={client} onResult={vi.fn()} paths={paths} />,
    );
    view.rerender(
      <Viewport terrain={terrain} tick={0} client={client} onResult={vi.fn()} paths={null} />,
    );
    expect(callsTo("setPaths")).toEqual([[paths], [null]]);
  });

  it("gives a scene that is made anew the layer the last one had", () => {
    const paths = new Uint8Array(64).fill(1);
    const props = { terrain, tick: 0, client, onResult: vi.fn(), paths };
    render(<Viewport {...props} />);
    cleanup();
    fake.calls = [];
    render(<Viewport {...props} />);
    expect(callsTo("setPaths")).toEqual([[paths]]);
  });

  it("does not send the same layer again for a render that did not change it", () => {
    const paths = new Uint8Array(64);
    const view = render(
      <Viewport terrain={terrain} tick={0} client={client} onResult={vi.fn()} paths={paths} />,
    );
    const before = callsTo("setPaths").length;
    view.rerender(
      <Viewport terrain={terrain} tick={5} client={client} onResult={vi.fn()} paths={paths} />,
    );
    expect(callsTo("setPaths")).toHaveLength(before);
  });

  it("shows the grid exactly while a placement is in hand", () => {
    mount();
    expect(callsTo("setGridVisible").at(-1)).toEqual([false]);
    act(() => uiStore.getState().setTool("terrain"));
    expect(callsTo("setGridVisible").at(-1)).toEqual([true]);
    act(() => uiStore.getState().cancel());
    expect(callsTo("setGridVisible").at(-1)).toEqual([false]);
  });
});

describe("Viewport: the guests and the entrance", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  });
  const frames = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const section = (count: number) => ({ count }) as unknown as GuestSection;

  it("reads the guests through the getter in the frame, and gives the scene a new section once", () => {
    let current: GuestSection | null = section(1);
    const getGuests = vi.fn(() => current);
    mount({ getGuests });
    frames(100);
    const first = callsTo("setGuests");
    expect(first).toHaveLength(1);
    expect(first[0]?.[0]).toBe(current);
    expect(typeof first[0]?.[1]).toBe("number");
    expect(getGuests.mock.calls.length).toBeGreaterThan(1);
    const next = section(2);
    current = next;
    frames(100);
    const all = callsTo("setGuests");
    expect(all).toHaveLength(2);
    expect(all[1]?.[0]).toBe(next);
  });

  it("draws with the frame time, and gives the guests the same time", () => {
    mount({ getGuests: () => section(1) });
    frames(50);
    const times = callsTo("render").map(([now]) => now);
    expect(times.every((t) => typeof t === "number")).toBe(true);
    expect(callsTo("setGuests")[0]?.[1]).toBe(times[0]);
  });

  it("sends no guests, and then none, when there is no getter", () => {
    mount();
    frames(50);
    expect(callsTo("setGuests")).toEqual([[null, expect.any(Number)]]);
  });

  it("gives the scene the entrance, and again only when it moves", () => {
    let entrance: { x: number; y: number; side: 0 | 1 | 2 | 3 } | undefined = {
      x: 3,
      y: 7,
      side: 2,
    };
    mount({ getEntrance: () => entrance });
    frames(100);
    expect(callsTo("setEntrance")).toEqual([[{ x: 3, y: 7, side: 2 }]]);
    // A new object for the same place, as every snapshot brings, is not a change.
    entrance = { x: 3, y: 7, side: 2 };
    frames(100);
    expect(callsTo("setEntrance")).toHaveLength(1);
    entrance = { x: 4, y: 7, side: 2 };
    frames(100);
    expect(callsTo("setEntrance")).toEqual([[{ x: 3, y: 7, side: 2 }], [{ x: 4, y: 7, side: 2 }]]);
    entrance = undefined;
    frames(100);
    expect(callsTo("setEntrance").at(-1)).toEqual([null]);
  });
});

describe("Viewport: the rides", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  });
  const frames = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const status = (count: number) => ({ count }) as unknown as RideStatusSection;
  const carousel: RidePublic = {
    id: 1,
    type: "carousel",
    kind: "ride",
    x: 2,
    y: 2,
    rot: 0,
    name: "Carousel 1",
    open: true,
    price: 100,
    entrance: { x: 3, y: 5 },
    exit: { x: 5, y: 3 },
    service: null,
  };

  it("gives the scene the host's rides once per new list, and the status once per snapshot", () => {
    let current: RideStatusSection | null = status(1);
    const first = [carousel];
    const props: ViewportProps = {
      terrain,
      tick: 0,
      client,
      onResult: vi.fn(),
      rides: first,
      getRideStatus: () => current,
    };
    const view = render(<Viewport {...props} />);
    frames(100);
    expect(callsTo("setRides")).toEqual([[first]]);
    expect(callsTo("setRideStatus")).toEqual([[current]]);
    const next = status(2);
    current = next;
    frames(100);
    expect(callsTo("setRideStatus")).toHaveLength(2);
    expect(callsTo("setRideStatus")[1]?.[0]).toBe(next);
    const second = [carousel, { ...carousel, id: 2, x: 6 }];
    view.rerender(<Viewport {...props} rides={second} />);
    frames(100);
    expect(callsTo("setRides")).toEqual([[first], [second]]);
  });

  it("gives null rides and no status when the host has none", () => {
    mount();
    frames(50);
    expect(callsTo("setRides")).toEqual([[null]]);
    expect(callsTo("setRideStatus")).toEqual([[null]]);
  });
});

describe("Viewport: the entrance tile, which the sim's path layer leaves out", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  });
  const frames = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  /** The layer the scene was last given. */
  const laid = () => callsTo("setPaths").at(-1)?.[0] as Uint8Array | null;
  /** An avenue up column 3 of the 8 by 8 map, stopping short of the entrance tile at (3, 7). */
  const avenue = () => {
    const paths = new Uint8Array(64);
    for (let y = 2; y < 7; y++) paths[y * 8 + 3] = 1;
    return paths;
  };
  const south = { x: 3, y: 7, side: 2 } as const;

  it("is paved in the layer the scene is given, and the host's layer is left as it was", () => {
    const paths = avenue();
    mount({ paths, getEntrance: () => south });
    expect(callsTo("setPaths")).toHaveLength(1);
    const expected = avenue();
    expected[7 * 8 + 3] = 1;
    expect(laid()).toEqual(expected);
    expect(laid()).not.toBe(paths);
    expect(paths).toEqual(avenue());
  });

  it("is given the layer itself when there is no entrance, or its tile is paved already", () => {
    const bare = avenue();
    mount({ paths: bare });
    expect(laid()).toBe(bare);
    cleanup();
    const paved = avenue();
    paved[7 * 8 + 3] = 2;
    mount({ paths: paved, getEntrance: () => south });
    expect(laid()).toBe(paved);
  });

  it("is paved where the entrance moves to, and no longer where it was", () => {
    let entrance: { x: number; y: number; side: 0 | 1 | 2 | 3 } | null = south;
    const paths = avenue();
    mount({ paths, getEntrance: () => entrance });
    entrance = { x: 0, y: 4, side: 3 };
    frames(50);
    expect(callsTo("setPaths")).toHaveLength(2);
    expect(laid()?.[4 * 8]).toBe(1);
    expect(laid()?.[7 * 8 + 3]).toBe(0);
    // With the entrance gone the layer is the sim's own again.
    entrance = null;
    frames(50);
    expect(callsTo("setPaths")).toHaveLength(3);
    expect(laid()).toBe(paths);
  });

  it("is paved in each new layer, once per layer however many frames pass", () => {
    const first = avenue();
    const view = render(
      <Viewport
        terrain={terrain}
        tick={0}
        client={client}
        onResult={vi.fn()}
        paths={first}
        getEntrance={() => ({ ...south })}
      />,
    );
    frames(100);
    expect(callsTo("setPaths")).toHaveLength(1);
    const second = avenue();
    second[2 * 8 + 4] = 1;
    view.rerender(
      <Viewport
        terrain={terrain}
        tick={0}
        client={client}
        onResult={vi.fn()}
        paths={second}
        getEntrance={() => ({ ...south })}
      />,
    );
    frames(100);
    expect(callsTo("setPaths")).toHaveLength(2);
    expect(laid()?.[2 * 8 + 4]).toBe(1);
    expect(laid()?.[7 * 8 + 3]).toBe(1);
    expect(callsTo("setEntrance")).toEqual([[south]]);
  });

  it("is left alone in a layer that is not this map's, and for an entrance that is off it", () => {
    const other = new Uint8Array(16);
    mount({ paths: other, getEntrance: () => south });
    expect(laid()).toBe(other);
    cleanup();
    const paths = avenue();
    mount({ paths, getEntrance: () => ({ x: 8, y: 7, side: 1 }) });
    expect(laid()).toBe(paths);
  });

  it("is paved once the terrain says how wide the map is, if the layer came first", () => {
    const paths = avenue();
    const props = { tick: 0, client, onResult: vi.fn(), paths, getEntrance: () => south };
    const view = render(<Viewport {...props} terrain={null} />);
    expect(callsTo("setPaths")).toHaveLength(1);
    expect(laid()).toBe(paths);
    view.rerender(<Viewport {...props} terrain={terrain} />);
    frames(50);
    expect(callsTo("setPaths")).toHaveLength(2);
    expect(laid()?.[7 * 8 + 3]).toBe(1);
    // Terrain that is only reshaped lays nothing again.
    view.rerender(<Viewport {...props} terrain={{ ...terrain }} />);
    frames(50);
    expect(callsTo("setPaths")).toHaveLength(2);
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

describe("Viewport: drawing paths", () => {
  /** Drags the path tool over `tiles`, the first being the press, and lets go. */
  const drag = (tiles: Array<[number, number]>) => {
    const paint = handlers().paint;
    if (!paint) throw new Error("no paint handlers");
    expect(paint.active()).toBe(true);
    const [first, ...rest] = tiles;
    paint.start(first![0], first![1]);
    for (const [x, y] of rest) paint.move(x, y);
    paint.end(false);
  };

  it("is not drawing with nothing in hand, nor with a terrain tool", () => {
    mount();
    expect(handlers().paint?.active()).toBe(false);
    act(() => uiStore.getState().setTool("terrain"));
    expect(handlers().paint?.active()).toBe(false);
  });

  /** The tiles of the stroke the one command sent, as [x, y] pairs. */
  const sentTiles = (call = 0) =>
    (command.mock.calls[call]![1] as { tiles: Array<{ x: number; y: number }> }).tiles.map(
      ({ x, y }) => [x, y],
    );

  it("lays the whole drag as one command, each tile once, with the tiles between", async () => {
    const { props } = mount();
    act(() => uiStore.getState().setTool("path"));
    command.mockResolvedValue({ ok: true, id: 7, cost: 3000 });
    drag([
      [1, 1],
      [3, 1],
      [1, 1],
    ]);
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0]![0]).toBe("path_build_tiles");
    expect(command.mock.calls[0]![1]).toMatchObject({ kind: "foot" });
    expect(sentTiles()).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    await vi.waitFor(() =>
      expect(props.onResult).toHaveBeenCalledWith({ ok: true, id: 7, cost: 3000 }),
    );
    expect(props.onResult).toHaveBeenCalledTimes(1);
  });

  it("leaves out the tiles the sim refuses, sends the rest, and says so once at the end", async () => {
    const { props } = mount();
    act(() => uiStore.getState().startPlacement("path_build", { kind: "queue" }));
    checking((x) => (x === 2 || x === 3 ? "Cannot build on water" : null));
    command.mockResolvedValue({ ok: true, id: 1, cost: 2000 });
    drag([
      [1, 0],
      [4, 0],
    ]);
    await vi.waitFor(() =>
      expect(props.onResult).toHaveBeenCalledWith({
        ok: false,
        error: "2 tiles skipped: Cannot build on water",
      }),
    );
    expect(props.onResult).toHaveBeenCalledWith({ ok: true, id: 1, cost: 2000 });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]![1]).toMatchObject({ kind: "queue" });
    expect(sentTiles()).toEqual([
      [1, 0],
      [4, 0],
    ]);
  });

  it("sends nothing when every tile is refused, and takes the preview away", async () => {
    const { props } = mount();
    act(() => uiStore.getState().setTool("path"));
    checking(() => "Tile is too steep");
    drag([
      [0, 0],
      [1, 0],
    ]);
    await vi.waitFor(() =>
      expect(props.onResult).toHaveBeenCalledWith({
        ok: false,
        error: "2 tiles skipped: Tile is too steep",
      }),
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("shows the stroke while it is drawn, before the sim has it", async () => {
    mount({ paths: new Uint8Array(8 * 8) });
    act(() => uiStore.getState().setTool("path"));
    const paint = handlers().paint!;
    paint.start(2, 3);
    paint.move(3, 3);
    await vi.waitFor(() => {
      const laid = callsTo("setPaths").at(-1)?.[0] as Uint8Array | null;
      expect(laid?.[3 * 8 + 2]).toBe(1);
      expect(laid?.[3 * 8 + 3]).toBe(1);
    });
    expect(command).not.toHaveBeenCalled();
    paint.end(false);
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  });

  it("takes the preview away when the stroke is refused", async () => {
    const { props } = mount({ paths: new Uint8Array(8 * 8) });
    act(() => uiStore.getState().setTool("path"));
    command.mockResolvedValue({ ok: false, error: "Not enough cash" });
    drag([[2, 3]]);
    await vi.waitFor(() =>
      expect(props.onResult).toHaveBeenCalledWith({ ok: false, error: "Not enough cash" }),
    );
    await vi.waitFor(() => {
      const laid = callsTo("setPaths").at(-1)?.[0] as Uint8Array | null;
      expect(laid?.[3 * 8 + 2] ?? 0).toBe(0);
    });
  });

  it("lays nothing if the tool is put down or changed mid-drag", async () => {
    const { props } = mount();
    act(() => uiStore.getState().setTool("path"));
    const paint = handlers().paint!;
    paint.start(0, 0);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    act(() => uiStore.getState().setTool("terrain"));
    paint.move(1, 0);
    paint.end(false);
    await new Promise((done) => setTimeout(done, 20));
    expect(command).not.toHaveBeenCalled();
    expect(props.onResult).not.toHaveBeenCalled();
  });

  it("lays nothing when the pointer is cancelled", async () => {
    mount();
    act(() => uiStore.getState().setTool("path"));
    const paint = handlers().paint!;
    paint.start(0, 0);
    paint.move(2, 0);
    paint.end(true);
    await new Promise((done) => setTimeout(done, 20));
    expect(command).not.toHaveBeenCalled();
  });

  it("checks the stroke again before sending it, and leaves out what changed meanwhile", async () => {
    const { props } = mount();
    act(() => uiStore.getState().setTool("path"));
    let flooded = false;
    checking((x) => (flooded && x === 1 ? "Cannot build on water" : null));
    const paint = handlers().paint!;
    paint.start(0, 0);
    paint.move(2, 0);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    // Tile (1, 0) is flooded by someone else before the drag ends.
    flooded = true;
    command.mockResolvedValue({ ok: true, id: 3, cost: 2000 });
    paint.end(false);
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(sentTiles()).toEqual([
      [0, 0],
      [2, 0],
    ]);
    await vi.waitFor(() =>
      expect(props.onResult).toHaveBeenCalledWith({
        ok: false,
        error: "1 tile skipped: Cannot build on water",
      }),
    );
  });

  it("keeps the first stroke shown while a second is drawn before the first is through", async () => {
    mount({ paths: new Uint8Array(8 * 8) });
    act(() => uiStore.getState().setTool("path"));
    let answer: (result: ExecResult) => void = () => {};
    command.mockImplementation(() => new Promise((done) => (answer = done)));
    const paint = handlers().paint!;
    paint.start(1, 1);
    paint.end(false);
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    // A second stroke begins while the first is still on its way.
    paint.start(5, 5);
    await vi.waitFor(() => {
      const laid = callsTo("setPaths").at(-1)?.[0] as Uint8Array | null;
      expect(laid?.[1 * 8 + 1]).toBe(1);
      expect(laid?.[5 * 8 + 5]).toBe(1);
    });
    // The first is refused: it goes, the second stays.
    answer({ ok: false, error: "Not enough cash" });
    await vi.waitFor(() => {
      const laid = callsTo("setPaths").at(-1)?.[0] as Uint8Array | null;
      expect(laid?.[1 * 8 + 1] ?? 0).toBe(0);
      expect(laid?.[5 * 8 + 5]).toBe(1);
    });
    paint.end(false);
  });

  it("does not fill in the tiles between leaving the map and coming back", async () => {
    mount();
    act(() => uiStore.getState().setTool("path"));
    const paint = handlers().paint!;
    paint.start(0, 0);
    paint.leave?.();
    paint.move(4, 0);
    paint.end(false);
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(sentTiles()).toEqual([
      [0, 0],
      [4, 0],
    ]);
  });

  it("removes paths by dragging too, as one command", async () => {
    mount();
    act(() => uiStore.getState().startPlacement("path_remove", {}));
    drag([
      [0, 0],
      [0, 1],
    ]);
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0]).toEqual([
      "path_remove_tiles",
      {
        tiles: [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
        ],
      },
    ]);
    expect(query.mock.calls[0]![1]).toMatchObject({ kind: "remove" });
  });
});

describe("Viewport: guests and the entrance", () => {
  it("looks at a guest clicked with nothing in hand", () => {
    mount();
    fake.pickGuestAt = () => ({ id: 42 });
    expect(handlers().onPointClick?.(100, 100)).toBe(true);
    expect(uiStore.getState().selection).toEqual({ kind: "guest", id: 42 });
    expect(uiStore.getState().inspector.open).toBe(true);
  });

  it("leaves a click with no guest under it to the tile", () => {
    mount();
    expect(handlers().onPointClick?.(100, 100)).toBe(false);
  });

  it("does not pick guests while placing", () => {
    mount();
    fake.pickGuestAt = () => ({ id: 42 });
    act(() => uiStore.getState().setTool("terrain"));
    expect(handlers().onPointClick?.(100, 100)).toBe(false);
  });

  it("looks at the entrance when its tile is clicked", () => {
    mount({ getEntrance: () => ({ x: 4, y: 7, side: 2 }) });
    click(4, 7);
    expect(uiStore.getState().selection).toEqual({ kind: "entrance" });
    click(4, 6);
    expect(uiStore.getState().selection).toEqual({ kind: "tile", x: 4, y: 6 });
  });
});
