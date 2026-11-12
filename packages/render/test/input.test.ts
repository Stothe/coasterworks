import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraRig } from "../src/camera.js";
import { attachControls } from "../src/input.js";

/** Just enough of an event target to listen on and fire events at. */
class FakeTarget {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
  fire(type: string, event: unknown) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

let now = 0;
let frames: Array<() => void> = [];
/** Runs the animation frames asked for so far, at the time `at` ms after the start. */
function frame(at: number) {
  now = at;
  const due = frames;
  frames = [];
  for (const callback of due) callback();
}

beforeEach(() => {
  now = 0;
  frames = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const rig = new CameraRig();
  const canvas = Object.assign(new FakeTarget(), {
    style: { touchAction: "" },
    clientHeight: 600,
  }) as unknown as HTMLCanvasElement;
  const keys = new FakeTarget();
  const detach = attachControls(
    canvas,
    rig,
    { onTileClick: () => {}, onHover: () => {}, pick: () => null },
    { keyTarget: keys as unknown as Window },
  );
  const setClassic = vi.spyOn(rig, "setClassic");
  /** Presses a key; returns whether the controls took it (prevented it). */
  const press = (key: string, extra: Record<string, unknown> = {}) => {
    const event = {
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      target: { tagName: "DIV" },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    keys.fire("keydown", event);
    return event.defaultPrevented;
  };
  return { rig, keys, detach, press, setClassic };
}

describe("attachControls: keys", () => {
  it("turns the view a quarter turn with q and e, over 250 ms", () => {
    const { rig, press } = setup();
    const start = rig.yaw;
    expect(press("e")).toBe(true);
    frame(125);
    expect(rig.yaw).toBeGreaterThan(start);
    expect(rig.yaw).toBeLessThan(start + Math.PI / 2);
    frame(250);
    expect(rig.yaw).toBeCloseTo(start + Math.PI / 2, 10);
    expect(press("q")).toBe(true);
    frame(500);
    expect(rig.yaw).toBeCloseTo(start, 10);
  });

  it("snaps a quarter turn at once, with no frames, when the system asks for reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    }));
    const { rig, press } = setup();
    const start = rig.yaw;
    expect(press("e")).toBe(true);
    expect(rig.yaw).toBeCloseTo(start + Math.PI / 2, 10);
    expect(frames).toHaveLength(0);
    // Pressed again, it adds another quarter; and q takes one back.
    press("e");
    expect(rig.yaw).toBeCloseTo(start + Math.PI, 10);
    press("q");
    expect(rig.yaw).toBeCloseTo(start + Math.PI / 2, 10);
    expect(frames).toHaveLength(0);
  });

  it("settles a turn in progress where it is headed when motion is reduced mid-turn", () => {
    const { rig, press } = setup();
    const start = rig.yaw;
    press("e");
    frame(100);
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    press("e");
    frame(100);
    expect(rig.yaw).toBeCloseTo(start + Math.PI, 10);
    frame(600);
    expect(rig.yaw).toBeCloseTo(start + Math.PI, 10);
  });

  it("still animates when the system does not ask for reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { rig, press } = setup();
    const start = rig.yaw;
    press("e");
    expect(rig.yaw).toBe(start);
    frame(125);
    expect(rig.yaw).toBeGreaterThan(start);
    expect(rig.yaw).toBeLessThan(start + Math.PI / 2);
  });

  it("continues from where the last turn is headed when pressed again mid-turn", () => {
    const { rig, press } = setup();
    const start = rig.yaw;
    press("e");
    frame(100);
    press("e");
    frame(100);
    frame(600);
    expect(rig.yaw).toBeCloseTo(start + Math.PI, 10);
  });

  it("leaves the number keys and Home to the app: no snap, and the key is not taken", () => {
    const { rig, press, setClassic } = setup();
    const start = rig.yaw;
    for (const key of ["1", "2", "3", "4", "5", "6", "7", "Home"]) {
      expect(press(key), key).toBe(false);
    }
    expect(setClassic).not.toHaveBeenCalled();
    expect(rig.yaw).toBe(start);
  });

  it("ignores keys with a modifier held, keys typed into a field, and a held key's repeats", () => {
    const { rig, press } = setup();
    const start = rig.yaw;
    expect(press("q", { ctrlKey: true })).toBe(false);
    expect(press("q", { metaKey: true })).toBe(false);
    expect(press("q", { altKey: true })).toBe(false);
    expect(press("q", { target: { tagName: "INPUT" } })).toBe(false);
    frame(300);
    expect(rig.yaw).toBe(start);
    press("q", { repeat: true });
    frame(300);
    expect(rig.yaw).toBe(start);
  });

  it("gives way when something else sets the yaw mid-turn, as a snap to a classic angle does", () => {
    const { rig, press } = setup();
    press("e");
    frame(100);
    rig.setClassic(2);
    const classic = rig.yaw;
    frame(150);
    frame(400);
    expect(rig.yaw).toBe(classic);
    // The next turn starts from the classic angle.
    press("e");
    frame(400 + 250);
    expect(rig.yaw).toBeCloseTo(classic + Math.PI / 2, 10);
  });

  it("stops listening when detached", () => {
    const { keys, rig, detach, press } = setup();
    detach();
    expect(keys.listenerCount("keydown")).toBe(0);
    const start = rig.yaw;
    press("e");
    frame(300);
    expect(rig.yaw).toBe(start);
  });
});

describe("attachControls: pointer", () => {
  /** A canvas whose pick maps client x, y to tile (x / 10, y / 10), and the calls it made. */
  function pointerSetup(paintActive: boolean, takesClick = false) {
    const rig = new CameraRig();
    const canvas = Object.assign(new FakeTarget(), {
      style: { touchAction: "" },
      clientHeight: 600,
      setPointerCapture() {},
      hasPointerCapture: () => false,
      releasePointerCapture() {},
    });
    const calls: string[] = [];
    const pan = vi.spyOn(rig, "pan");
    attachControls(
      canvas as unknown as HTMLCanvasElement,
      rig,
      {
        onTileClick: (x, y) => calls.push(`click ${x},${y}`),
        onHover: () => {},
        pick: (cx, cy) => (cx < 0 ? null : { x: Math.floor(cx / 10), y: Math.floor(cy / 10) }),
        onPointClick: (cx, cy) => {
          calls.push(`point ${cx},${cy}`);
          return takesClick;
        },
        paint: {
          active: () => paintActive,
          start: (x, y) => calls.push(`start ${x},${y}`),
          move: (x, y) => calls.push(`move ${x},${y}`),
          end: (cancelled) => calls.push(`end ${cancelled}`),
        },
      },
      { keyTarget: new FakeTarget() as unknown as Window },
    );
    const at = (clientX: number, clientY: number, extra: Record<string, unknown> = {}) => ({
      pointerId: 1,
      button: 0,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      clientX,
      clientY,
      ...extra,
    });
    return { canvas, calls, pan, at };
  }

  it("paints instead of panning while painting is active", () => {
    const { canvas, calls, pan, at } = pointerSetup(true);
    canvas.fire("pointerdown", at(5, 5));
    canvas.fire("pointermove", at(15, 5));
    canvas.fire("pointermove", at(25, 5));
    canvas.fire("pointerup", at(25, 5));
    expect(calls).toEqual(["start 0,0", "move 1,0", "move 2,0", "end false"]);
    expect(pan).not.toHaveBeenCalled();
  });

  it("paints one tile on a press that does not move, and does not click", () => {
    const { canvas, calls, at } = pointerSetup(true);
    canvas.fire("pointerdown", at(5, 5));
    canvas.fire("pointerup", at(5, 5));
    expect(calls).toEqual(["start 0,0", "end false"]);
  });

  it("tells a cancelled paint", () => {
    const { canvas, calls, at } = pointerSetup(true);
    canvas.fire("pointerdown", at(5, 5));
    canvas.fire("pointercancel", at(5, 5));
    expect(calls).toEqual(["start 0,0", "end true"]);
  });

  it("pans from a press off the map, even while painting", () => {
    const { canvas, calls, pan, at } = pointerSetup(true);
    canvas.fire("pointerdown", at(-5, 5));
    canvas.fire("pointermove", at(-50, 50));
    canvas.fire("pointerup", at(-50, 50));
    expect(calls).toEqual([]);
    expect(pan).toHaveBeenCalled();
  });

  it("asks onPointClick before clicking a tile, and a true answer takes the click", () => {
    const passes = pointerSetup(false);
    passes.canvas.fire("pointerdown", passes.at(35, 45));
    passes.canvas.fire("pointerup", passes.at(35, 45));
    expect(passes.calls).toEqual(["point 35,45", "click 3,4"]);

    const takes = pointerSetup(false, true);
    takes.canvas.fire("pointerdown", takes.at(35, 45));
    takes.canvas.fire("pointerup", takes.at(35, 45));
    expect(takes.calls).toEqual(["point 35,45"]);
  });

  it("pans on a left drag when painting is not active", () => {
    const { canvas, calls, pan, at } = pointerSetup(false);
    canvas.fire("pointerdown", at(5, 5));
    canvas.fire("pointermove", at(50, 5));
    canvas.fire("pointerup", at(50, 5));
    expect(calls).toEqual([]);
    expect(pan).toHaveBeenCalled();
  });
});
