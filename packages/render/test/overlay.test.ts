import { Texture, Vector2, Vector4 } from "three";
import { describe, expect, it } from "vitest";
import { createSharedUniforms, type FrameInfo, type RenderContext } from "../src/context.js";
import { sunFor } from "../src/sky.js";
import {
  GRID_FOLLOW_SECONDS,
  HIGHLIGHT_GLIDE_SECONDS,
  OVERLAY_FADE_SECONDS,
  approach,
  createOverlay,
  easeInOut,
  glideShare,
  type OverlayModule,
} from "../src/terrain/overlay.glsl.js";

/** The overlay reads nothing from the context but the shared uniforms. */
function makeContext(): RenderContext {
  return { uniforms: createSharedUniforms() } as unknown as RenderContext;
}

/** Draws frames on a clock the test moves: `at(ms)` is one `update` at that time. */
function drive(overlay: OverlayModule) {
  const frame: FrameInfo = { time: 0, dt: 0, nowMs: 0, sun: sunFor(0.4) };
  return {
    at(nowMs: number): void {
      frame.nowMs = nowMs;
      overlay.update?.(frame);
    },
    /** Frames every `stepMs` from `fromMs` up to and including `toMs`. */
    run(fromMs: number, toMs: number, stepMs: number): void {
      for (let ms = fromMs; ms <= toMs + 1e-9; ms += stepMs) this.at(ms);
    },
  };
}

const grid = (overlay: OverlayModule) => overlay.uniforms.cwOvl_grid!.value as number;
const highlight = (overlay: OverlayModule) => overlay.uniforms.cwOvl_hl!.value as number;
const center = (overlay: OverlayModule) => overlay.uniforms.cwOvl_center!.value as Vector2;
const core = (overlay: OverlayModule) => overlay.uniforms.cwOvl_core!.value as Vector2;
const rect = (overlay: OverlayModule) => overlay.uniforms.cwOvl_rect!.value as Vector4;

const FADE_MS = OVERLAY_FADE_SECONDS * 1000;

describe("approach", () => {
  it("moves by the step toward the target, from either side", () => {
    expect(approach(0, 1, 0.25)).toBe(0.25);
    expect(approach(1, 0, 0.25)).toBe(0.75);
  });

  it("stops on the target and never passes it", () => {
    expect(approach(0.9, 1, 0.25)).toBe(1);
    expect(approach(0.1, 0, 0.25)).toBe(0);
    expect(approach(0.4, 0.4, 0.25)).toBe(0.4);
    expect(approach(0.4, 1, 0)).toBe(0.4);
  });
});

describe("easeInOut", () => {
  it("runs from 0 to 1 through the middle and is held outside 0..1", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(-3)).toBe(0);
    expect(easeInOut(7)).toBe(1);
  });

  it("never steps back, starts and stops gently, and is the same shape both ways", () => {
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      const value = easeInOut(i / 100);
      expect(value).toBeGreaterThanOrEqual(last);
      expect(value + easeInOut(1 - i / 100)).toBeCloseTo(1, 12);
      last = value;
    }
    // A hundredth of the way in, far less than a hundredth of the change has happened.
    expect(easeInOut(0.01)).toBeLessThan(0.001);
    expect(1 - easeInOut(0.99)).toBeLessThan(0.001);
  });
});

describe("glideShare", () => {
  it("is nothing for no time, everything without a time constant, and stays inside 0..1", () => {
    expect(glideShare(0, 0.1)).toBe(0);
    expect(glideShare(-1, 0.1)).toBe(0);
    expect(glideShare(Number.NaN, 0.1)).toBe(0);
    expect(glideShare(0.016, 0)).toBe(1);
    expect(glideShare(0.016, 0.1)).toBeGreaterThan(0);
    expect(glideShare(60, 0.1)).toBeLessThanOrEqual(1);
  });

  it("covers the same ground in one long frame as in many short ones", () => {
    const whole = glideShare(0.1, 0.04);
    let left = 1;
    for (let i = 0; i < 10; i++) left *= 1 - glideShare(0.01, 0.04);
    expect(1 - left).toBeCloseTo(whole, 12);
  });

  it("closes about 63 percent of the gap in one time constant", () => {
    expect(glideShare(0.04, 0.04)).toBeCloseTo(1 - 1 / Math.E, 12);
  });
});

describe("the overlay chunk", () => {
  const overlay = createOverlay(makeContext());

  it("defines the entry function the terrain material calls", () => {
    expect(overlay.glsl).toContain("void cwOverlay(inout CwSurf s, vec3 worldPos)");
  });

  it("declares exactly the uniforms the module hands over, each under its own name", () => {
    const declared = [...overlay.glsl.matchAll(/^uniform\s+\w+\s+(\w+);/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(Object.keys(overlay.uniforms).sort());
  });

  it("gives each uniform a value of the type its declaration names", () => {
    const types = new Map(
      [...overlay.glsl.matchAll(/^uniform\s+(\w+)\s+(\w+);/gm)].map((m) => [m[2], m[1]]),
    );
    for (const [name, uniform] of Object.entries(overlay.uniforms)) {
      const value: unknown = uniform.value;
      const type =
        typeof value === "number"
          ? "float"
          : value instanceof Vector2
            ? "vec2"
            : value instanceof Vector4
              ? "vec4"
              : value instanceof Texture
                ? "sampler2D"
                : "other";
      expect(type, name).toBe(types.get(name));
    }
  });

  it("names everything it adds to the shader with its own prefix", () => {
    const functions = [
      ...overlay.glsl.matchAll(/^(?:float|vec2|vec3|vec4|void)\s+(\w+)\s*\(/gm),
    ].map((m) => m[1]);
    const constants = [...overlay.glsl.matchAll(/^const\s+\w+\s+(\w+)/gm)].map((m) => m[1]);
    const names = [...functions, ...constants, ...Object.keys(overlay.uniforms)];
    expect(functions).toContain("cwOverlay");
    for (const name of names) {
      if (name !== "cwOverlay") expect(name).toMatch(/^cwOvl_/);
    }
  });

  it("takes no screen-space derivative after it has branched on position", () => {
    // A derivative inside or after a branch that differs between neighboring pixels is
    // undefined there. All of them are taken up front, before the first such branch: the
    // early return for ground outside the park.
    const body = overlay.glsl.slice(overlay.glsl.indexOf("void cwOverlay"));
    const firstBranch = body.indexOf("uMapSize");
    const lastDerivative = Math.max(body.lastIndexOf("dFdx"), body.lastIndexOf("dFdy"));
    expect(lastDerivative).toBeGreaterThan(0);
    expect(firstBranch).toBeGreaterThan(lastDerivative);
    expect(body).not.toContain("fwidth");
  });

  it("keeps white ink at or under 0.8, as the lighting convention asks", () => {
    for (const match of overlay.glsl.matchAll(/^const vec3 \w+ = vec3\(([^)]*)\);/gm)) {
      for (const part of match[1]!.split(",")) {
        expect(Number(part)).toBeGreaterThanOrEqual(0);
        expect(Number(part)).toBeLessThanOrEqual(1);
      }
    }
    const ink = (name: string) =>
      new RegExp(`const vec3 ${name} = vec3\\(([^)]*)\\);`)
        .exec(overlay.glsl)![1]!
        .split(",")
        .map(Number);
    expect(Math.max(...ink("cwOvl_GRID_INK"))).toBeLessThanOrEqual(0.8);
    expect(Math.max(...ink("cwOvl_EDGE_INK"))).toBeLessThanOrEqual(0.8);
  });
});

describe("the build grid", () => {
  it("is hidden to start with and stays hidden until asked for", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    expect(grid(overlay)).toBe(0);
    clock.run(0, 1000, 16);
    expect(grid(overlay)).toBe(0);
  });

  it("fades in over the fade time, passing the middle half way, and out again", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    overlay.setGridVisible(true);
    clock.at(FADE_MS / 2);
    expect(grid(overlay)).toBeCloseTo(0.5, 9);
    clock.at(FADE_MS);
    expect(grid(overlay)).toBe(1);
    clock.at(FADE_MS * 5);
    expect(grid(overlay)).toBe(1);

    overlay.setGridVisible(false);
    clock.at(FADE_MS * 5 + FADE_MS / 4);
    expect(grid(overlay)).toBeCloseTo(easeInOut(0.75), 9);
    clock.at(FADE_MS * 6);
    expect(grid(overlay)).toBe(0);
  });

  it("is eased: slow to leave and slow to arrive", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    overlay.setGridVisible(true);
    clock.at(FADE_MS * 0.1);
    expect(grid(overlay)).toBeGreaterThan(0);
    expect(grid(overlay)).toBeLessThan(0.05);
    clock.at(FADE_MS * 0.9);
    expect(grid(overlay)).toBeGreaterThan(0.95);
    expect(grid(overlay)).toBeLessThan(1);
  });

  it("fades at the same pace whatever the frame rate", () => {
    const fast = createOverlay(makeContext());
    const slow = createOverlay(makeContext());
    const fastClock = drive(fast);
    const slowClock = drive(slow);
    fastClock.at(0);
    slowClock.at(0);
    fast.setGridVisible(true);
    slow.setGridVisible(true);
    fastClock.run(5, 90, 5);
    slowClock.at(90);
    expect(grid(fast)).toBeCloseTo(grid(slow), 9);
  });

  it("does not jump on the first frame, however late that frame comes", () => {
    const overlay = createOverlay(makeContext());
    overlay.setGridVisible(true);
    const clock = drive(overlay);
    clock.at(123456);
    expect(grid(overlay)).toBe(0);
    clock.at(123456 + FADE_MS);
    expect(grid(overlay)).toBe(1);
  });

  it("turns around from where it is when switched back mid-fade", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    overlay.setGridVisible(true);
    clock.at(FADE_MS * 0.6);
    const reached = grid(overlay);
    overlay.setGridVisible(false);
    clock.at(FADE_MS * 0.7);
    expect(grid(overlay)).toBeLessThan(reached);
    expect(grid(overlay)).toBeCloseTo(easeInOut(0.5), 9);
  });

  it("gathers around the camera's target until there is a pointer, then around the pointer", () => {
    const ctx = makeContext();
    ctx.uniforms.uCamTarget.value.set(20, 3, 40);
    const overlay = createOverlay(ctx);
    const clock = drive(overlay);
    clock.at(0);
    // Out of sight it simply sits where it belongs.
    expect(center(overlay).x).toBe(20);
    expect(center(overlay).y).toBe(40);
    overlay.setCursor({ x: 5, z: 9 });
    clock.at(16);
    expect(center(overlay).x).toBe(5);
    expect(center(overlay).y).toBe(9);
    overlay.setCursor(null);
    clock.at(32);
    expect(center(overlay).x).toBe(20);
    expect(center(overlay).y).toBe(40);
  });

  it("follows the pointer smoothly while it shows", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    overlay.setCursor({ x: 10, z: 10 });
    overlay.setGridVisible(true);
    clock.run(0, 1000, 20);
    expect(center(overlay).x).toBeCloseTo(10, 6);

    overlay.setCursor({ x: 20, z: 10 });
    clock.at(1000 + GRID_FOLLOW_SECONDS * 1000);
    // One time constant on: about 63 percent of the way, not there and not left behind.
    expect(center(overlay).x).toBeCloseTo(10 + 10 * (1 - 1 / Math.E), 6);
    expect(center(overlay).y).toBeCloseTo(10, 6);
    clock.run(1200, 3000, 16);
    expect(center(overlay).x).toBeCloseTo(20, 4);
  });

  it("has the highlighted rectangle for its core, and a point when there is none", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    expect(core(overlay).toArray()).toEqual([0, 0]);
    // Out of sight the core is simply set, like the center.
    overlay.setHighlight({ x: 10, y: 20, w: 14, h: 10 });
    clock.at(16);
    expect(core(overlay).toArray()).toEqual([7, 5]);

    // In sight it eases, at the pace the center follows the pointer.
    overlay.setGridVisible(true);
    clock.run(32, 1000, 8);
    overlay.setHighlight({ x: 10, y: 20, w: 2, h: 2 });
    clock.at(1000 + GRID_FOLLOW_SECONDS * 1000);
    expect(core(overlay).x).toBeCloseTo(1 + 6 / Math.E, 6);
    expect(core(overlay).y).toBeCloseTo(1 + 4 / Math.E, 6);

    overlay.setHighlight(null);
    clock.run(1200, 4000, 16);
    expect(core(overlay).x).toBeCloseTo(0, 4);
    expect(core(overlay).y).toBeCloseTo(0, 4);
  });
});

describe("the highlight", () => {
  it("is off to start with", () => {
    const overlay = createOverlay(makeContext());
    drive(overlay).run(0, 500, 16);
    expect(highlight(overlay)).toBe(0);
  });

  it("carries a tile rectangle as its middle and half its size", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    overlay.setHighlight({ x: 4, y: 10, w: 3, h: 2 });
    clock.at(16);
    expect(rect(overlay).toArray()).toEqual([5.5, 11, 1.5, 1]);
  });

  it("appears where it is wanted, without sliding in from where it last was", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    overlay.setHighlight({ x: 2, y: 2, w: 1, h: 1 });
    clock.run(16, 400, 16);
    overlay.setHighlight(null);
    clock.run(416, 1000, 16);
    expect(highlight(overlay)).toBe(0);

    overlay.setHighlight({ x: 50, y: 40, w: 2, h: 2 });
    clock.at(1016);
    expect(rect(overlay).toArray()).toEqual([51, 41, 1, 1]);
  });

  it("fades in and out over the fade time", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    overlay.setHighlight({ x: 2, y: 2, w: 1, h: 1 });
    clock.at(FADE_MS / 2);
    expect(highlight(overlay)).toBeCloseTo(0.5, 9);
    clock.at(FADE_MS);
    expect(highlight(overlay)).toBe(1);
    overlay.setHighlight(null);
    clock.at(FADE_MS * 1.5);
    expect(highlight(overlay)).toBeCloseTo(0.5, 9);
    clock.at(FADE_MS * 2);
    expect(highlight(overlay)).toBe(0);
  });

  it("stays where it was while it fades out", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    overlay.setHighlight({ x: 7, y: 8, w: 1, h: 1 });
    clock.run(16, 400, 16);
    overlay.setHighlight(null);
    clock.at(450);
    expect(highlight(overlay)).toBeGreaterThan(0);
    expect(rect(overlay).toArray()).toEqual([7.5, 8.5, 0.5, 0.5]);
  });

  it("glides to a new rectangle while it shows, in position and in size", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    overlay.setHighlight({ x: 10, y: 10, w: 1, h: 1 });
    clock.run(16, 400, 16);
    overlay.setHighlight({ x: 11, y: 10, w: 3, h: 1 });
    clock.at(400 + HIGHLIGHT_GLIDE_SECONDS * 1000);
    const share = 1 - 1 / Math.E;
    expect(rect(overlay).x).toBeCloseTo(10.5 + 2 * share, 6);
    expect(rect(overlay).z).toBeCloseTo(0.5 + share, 6);
    expect(rect(overlay).y).toBeCloseTo(10.5, 6);
    clock.run(456, 1000, 16);
    expect(rect(overlay).x).toBeCloseTo(12.5, 4);
    expect(rect(overlay).z).toBeCloseTo(1.5, 4);
    expect(highlight(overlay)).toBe(1);
  });

  it("treats a rectangle with no area as none", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(0);
    overlay.setHighlight({ x: 3, y: 3, w: 0, h: 2 });
    clock.run(16, 400, 16);
    expect(highlight(overlay)).toBe(0);
  });
});

describe("the overlay's frame", () => {
  it("runs on the frame's real-time clock, so it also fades while the animation is frozen", () => {
    const overlay = createOverlay(makeContext());
    const frame: FrameInfo = { time: 2, dt: 0, nowMs: 0, sun: sunFor(0.4) };
    overlay.update?.(frame);
    overlay.setGridVisible(true);
    frame.nowMs = FADE_MS;
    overlay.update?.(frame);
    expect(grid(overlay)).toBe(1);
  });

  it("writes into the uniforms' own objects: nothing is made per frame or per hover", () => {
    const overlay = createOverlay(makeContext());
    const uniforms = { ...overlay.uniforms };
    const values = Object.values(uniforms).map((uniform) => uniform.value as unknown);
    const glsl = overlay.glsl;
    const clock = drive(overlay);
    overlay.setGridVisible(true);
    for (let i = 0; i < 60; i++) {
      overlay.setHighlight({ x: i, y: 2 * i, w: 1 + (i % 3), h: 1 });
      overlay.setCursor({ x: i + 0.5, z: 2 * i + 0.5 });
      clock.at(i * 16);
    }
    expect(overlay.glsl).toBe(glsl);
    for (const [name, uniform] of Object.entries(overlay.uniforms)) {
      expect(uniform).toBe(uniforms[name]);
    }
    Object.values(overlay.uniforms).forEach((uniform, i) => {
      if (typeof uniform.value === "object") expect(uniform.value).toBe(values[i]);
    });
  });

  it("holds still when time does not move or runs backwards", () => {
    const overlay = createOverlay(makeContext());
    const clock = drive(overlay);
    clock.at(1000);
    overlay.setGridVisible(true);
    clock.at(1000 + FADE_MS / 2);
    const reached = grid(overlay);
    clock.at(1000 + FADE_MS / 2);
    expect(grid(overlay)).toBe(reached);
    clock.at(900);
    expect(grid(overlay)).toBe(reached);
  });
});
