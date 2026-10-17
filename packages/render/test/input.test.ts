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
