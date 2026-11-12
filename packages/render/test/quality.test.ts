import { describe, expect, it } from "vitest";
import type { Quality } from "../src/context.js";
import {
  SETTLE_MS,
  SOFTWARE,
  SLOW_FRAME_MS,
  SLOW_HOLD_MS,
  STEP_UP_MS,
  createFrameMeter,
  createGovernor,
  detectQuality,
  higherQuality,
  postPlan,
  isSoftwareRenderer,
  lowerQuality,
  softwareFrameDue,
  stepGovernor,
  type GovernorState,
} from "../src/quality.js";

const FAST = 16.7;
const SLOW = 40;
/** A machine the drawing slows down: every step down makes its frames faster, but none fast. */
const GPU_BOUND = (q: Quality) => (q === "high" ? 60 : q === "medium" ? 40 : 30);

/**
 * Runs the governor for `ms` of frames that each take `frameMs`, from time `from`. Returns the
 * state, the time it ended at, and every quality change with when it happened.
 */
function run(
  state: GovernorState,
  from: number,
  ms: number,
  frame: number | ((quality: Quality) => number),
) {
  const changes: { at: number; quality: Quality }[] = [];
  let now = from;
  let s = state;
  while (now < from + ms) {
    const frameMs = typeof frame === "number" ? frame : frame(s.quality);
    now += frameMs;
    const next = stepGovernor(s, frameMs, now);
    if (next.quality !== s.quality) changes.push({ at: now, quality: next.quality });
    s = next;
  }
  return { state: s, now, changes };
}

describe("detectQuality", () => {
  it("gives software renderers the low tier", () => {
    expect(
      detectQuality("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader)"),
    ).toBe("low");
    expect(detectQuality("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe("low");
    expect(detectQuality("Google SwiftShader")).toBe("low");
    expect(detectQuality("Microsoft Basic Render Driver")).toBe("low");
    expect(detectQuality("Software Rasterizer")).toBe("low");
  });

  it("gives a browser that will not say the low tier", () => {
    expect(detectQuality("")).toBe("low");
    expect(detectQuality("  ")).toBe("low");
  });

  it("starts real hardware at high", () => {
    expect(
      detectQuality("ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)"),
    ).toBe("high");
    expect(detectQuality("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)")).toBe("high");
    expect(detectQuality("Mali-G78")).toBe("high");
  });
});

describe("lowerQuality and higherQuality", () => {
  it("move one step and stop at the ends", () => {
    expect(lowerQuality("high")).toBe("medium");
    expect(lowerQuality("medium")).toBe("low");
    expect(lowerQuality("low")).toBe("low");
    expect(higherQuality("low")).toBe("medium");
    expect(higherQuality("medium")).toBe("high");
    expect(higherQuality("high")).toBe("high");
  });
});

describe("stepGovernor", () => {
  it("holds its quality while frames are fast", () => {
    const { state, changes } = run(createGovernor("high", 0), 0, 5 * 60_000, FAST);
    expect(changes).toEqual([]);
    expect(state.quality).toBe("high");
  });

  it("steps down after sustained slow frames, and not before", () => {
    const started = createGovernor("high", 0);
    // Past the settling time, so only the length of the slow spell decides.
    const warm = run(started, 0, SETTLE_MS + 1000, FAST);
    const brief = run(warm.state, warm.now, SLOW_HOLD_MS - 200, SLOW);
    expect(brief.state.quality).toBe("high");
    const longer = run(brief.state, brief.now, 400, SLOW);
    expect(longer.state.quality).toBe("medium");
    expect(longer.changes).toHaveLength(1);
  });

  it("ignores a hitch: a slow spell that fast frames interrupt starts over", () => {
    let at = run(createGovernor("high", 0), 0, SETTLE_MS + 1000, FAST);
    for (let i = 0; i < 20; i++) {
      at = run(at.state, at.now, SLOW_HOLD_MS - 300, SLOW);
      at = run(at.state, at.now, 100, FAST);
    }
    expect(at.state.quality).toBe("high");
  });

  it("does not count a frame right at the threshold as slow", () => {
    const { state } = run(createGovernor("high", 0), 0, 30_000, SLOW_FRAME_MS);
    expect(state.quality).toBe("high");
  });

  it("goes down a step at a time, with time to settle between, and stops at low", () => {
    const { state, changes } = run(createGovernor("high", 0), 0, 60_000, GPU_BOUND);
    expect(changes.map((c) => c.quality)).toEqual(["medium", "low"]);
    expect((changes[1]?.at ?? 0) - (changes[0]?.at ?? 0)).toBeGreaterThanOrEqual(SETTLE_MS);
    expect(state.quality).toBe("low");
  });

  it("never goes above the quality it started at", () => {
    const { state, changes } = run(createGovernor("medium", 0), 0, 10 * 60_000, FAST);
    expect(changes).toEqual([]);
    expect(state.quality).toBe("medium");
    expect(run(createGovernor("low", 0), 0, 10 * 60_000, FAST).state.quality).toBe("low");
  });

  it("steps back up only after a full minute of fast frames", () => {
    const down = run(createGovernor("high", 0), 0, SETTLE_MS + 1000, SLOW);
    expect(down.state.quality).toBe("medium");
    const nearly = run(down.state, down.now, STEP_UP_MS - 1000, FAST);
    expect(nearly.state.quality).toBe("medium");
    const up = run(nearly.state, nearly.now, 2000, FAST);
    expect(up.state.quality).toBe("high");
  });

  it("never steps up more than once a minute", () => {
    const down = run(createGovernor("high", 0), 0, 20_000, GPU_BOUND);
    expect(down.state.quality).toBe("low");
    const { changes } = run(down.state, down.now, 5 * 60_000, FAST);
    expect(changes.map((c) => c.quality)).toEqual(["medium", "high"]);
    expect((changes[1]?.at ?? 0) - (changes[0]?.at ?? 0)).toBeGreaterThanOrEqual(STEP_UP_MS);
  });

  it("never oscillates: a step up that proves too much is not tried again", () => {
    // A machine that is fast at medium and slow at high, for a whole hour.
    let state = createGovernor("high", 0);
    let now = 0;
    const changes: Quality[] = [];
    while (now < 60 * 60_000) {
      const frameMs = state.quality === "high" ? SLOW : FAST;
      now += frameMs;
      const next = stepGovernor(state, frameMs, now);
      if (next.quality !== state.quality) changes.push(next.quality);
      state = next;
    }
    // Down, one more try a minute later, down again, and then it stays.
    expect(changes).toEqual(["medium", "high", "medium"]);
    expect(state.quality).toBe("medium");
    expect(state.ceiling).toBe("medium");
  });

  it("takes back a step down that made frames no faster, and stays (a capped frame rate)", () => {
    // 30 frames a second whatever is drawn: the display or the browser caps it.
    const capped = run(createGovernor("high", 0), 0, 60 * 60_000, 33.3);
    expect(capped.changes.map((c) => c.quality)).toEqual(["medium", "high"]);
    expect(capped.state.quality).toBe("high");
  });

  it("keeps a step down that helped, even when frames stay slow", () => {
    const { state, changes } = run(createGovernor("high", 0), 0, 60 * 60_000, (q) =>
      q === "high" ? 60 : 40,
    );
    // Medium is still slow and low would be no better than medium is than high: it reaches low.
    expect(changes[0]?.quality).toBe("medium");
    expect(state.quality).not.toBe("high");
  });

  it("steps down again from a held level when frames get much slower", () => {
    const capped = run(createGovernor("high", 0), 0, 20_000, 33.3);
    expect(capped.state.quality).toBe("high");
    const worse = run(capped.state, capped.now, 20_000, GPU_BOUND);
    expect(worse.changes[0]?.quality).toBe("medium");
  });

  it("returns the same state object when nothing changed", () => {
    const first = stepGovernor(createGovernor("high", 0), FAST, 16);
    expect(stepGovernor(first, FAST, 33)).toBe(first);
  });

  /**
   * Drives a frame meter and the governor the way the post module does, through a list of gaps
   * between frames. Returns the state and the clock.
   */
  function drive(
    meter: ReturnType<typeof createFrameMeter>,
    state: GovernorState,
    from: number,
    gaps: readonly number[],
  ) {
    let now = from;
    let s = state;
    for (const gap of gaps) {
      now += gap;
      const frameMs = meter.sample(now);
      if (frameMs > 0) s = stepGovernor(s, frameMs, now, meter.pausedMs);
    }
    return { state: s, now };
  }
  const steady = (ms: number) => Array<number>(Math.round(ms / FAST)).fill(FAST);

  it("does not take a hidden tab for slow frames: one long frame, then a pause, changes nothing", () => {
    const meter = createFrameMeter();
    meter.sample(0);
    let at = drive(meter, createGovernor("high", 0), 0, steady(10_000));
    // One frame long enough to lift the average over the line, and then the tab is hidden.
    at = drive(meter, at.state, at.now, [90]);
    expect(meter.frameMs).toBeGreaterThan(SLOW_FRAME_MS);
    at = drive(meter, at.state, at.now, [30_000]);
    expect(at.state.quality).toBe("high");
    at = drive(meter, at.state, at.now, steady(5000));
    expect(at.state.quality).toBe("high");
    expect(at.state.ceiling).toBe("high");

    // The same again a minute later, and again: a fast machine is never marked down for it.
    for (let i = 0; i < 3; i++) {
      at = drive(meter, at.state, at.now, [...steady(70_000), 90, 30_000, ...steady(5000)]);
      expect(at.state.quality).toBe("high");
      expect(at.state.ceiling).toBe("high");
    }
  });

  it("starts the slow spell over after a pause, and still steps down if frames stay slow", () => {
    const warm = run(createGovernor("high", 0), 0, SETTLE_MS + 1000, FAST);
    const brief = run(warm.state, warm.now, SLOW_HOLD_MS - 200, SLOW);
    // Back from a pause: the slow frames before it no longer count.
    let now = brief.now + 10_000;
    let state = stepGovernor(brief.state, SLOW, now, 10_000);
    expect(state.quality).toBe("high");
    const short = run(state, now, SLOW_HOLD_MS - 200, SLOW);
    expect(short.state.quality).toBe("high");
    const longer = run(short.state, short.now, 400, SLOW);
    expect(longer.state.quality).toBe("medium");
    now = longer.now;
    state = longer.state;

    // Nor does a pause count toward the minute of fast frames a step up waits for.
    const nearly = run(state, now, STEP_UP_MS - 5000, FAST);
    const back = stepGovernor(nearly.state, FAST, nearly.now + 20_000, 20_000);
    expect(back.quality).toBe("medium");
    const soon = run(back, nearly.now + 20_000, STEP_UP_MS - 1000, FAST);
    expect(soon.state.quality).toBe("medium");
    expect(run(soon.state, soon.now, 2000, FAST).state.quality).toBe("high");
  });

  it("does not count a pause toward the settling time after a change", () => {
    // Slow from the start: the step down comes with the last frame of this run.
    const down = run(createGovernor("high", 0), 0, SETTLE_MS, GPU_BOUND);
    expect(down.changes).toEqual([{ at: down.now, quality: "medium" }]);
    // Hidden right after the step down, for far longer than the settling time.
    const back = stepGovernor(down.state, GPU_BOUND("medium"), down.now + 60_000, 60_000);
    const early = run(back, down.now + 60_000, SLOW_HOLD_MS + 200, GPU_BOUND);
    expect(early.state.quality).toBe("medium");
    // The settling time is still served in frames drawn.
    expect(run(early.state, early.now, SETTLE_MS, GPU_BOUND).state.quality).toBe("low");
  });
});

describe("createFrameMeter", () => {
  it("reports nothing until it has seen two frames", () => {
    const meter = createFrameMeter();
    expect(meter.frameMs).toBe(0);
    expect(meter.sample(1000)).toBe(0);
    expect(meter.sample(1016)).toBe(16);
  });

  it("settles on a steady frame time and follows a change gradually", () => {
    const meter = createFrameMeter();
    let now = 0;
    for (let i = 0; i < 200; i++) meter.sample((now += 16));
    expect(meter.frameMs).toBeCloseTo(16, 6);
    meter.sample((now += 50));
    expect(meter.frameMs).toBeGreaterThan(16);
    expect(meter.frameMs).toBeLessThan(25);
    for (let i = 0; i < 200; i++) meter.sample((now += 33));
    expect(meter.frameMs).toBeCloseTo(33, 3);
  });

  it("skips a pause, such as a tab that was hidden", () => {
    const meter = createFrameMeter();
    let now = 0;
    for (let i = 0; i < 50; i++) meter.sample((now += 16));
    meter.sample((now += 5000));
    expect(meter.frameMs).toBeCloseTo(16, 6);
  });

  it("says how long a pause was, for the one frame that follows it", () => {
    const meter = createFrameMeter();
    expect(meter.pausedMs).toBe(0);
    meter.sample(100);
    meter.sample(116);
    expect(meter.pausedMs).toBe(0);
    meter.sample(5116);
    expect(meter.pausedMs).toBe(5000);
    meter.sample(5132);
    expect(meter.pausedMs).toBe(0);
  });
});

describe("createFrameMeter with a page visibility probe", () => {
  it("counts a long frame on a visible page as slow, held to a second", () => {
    const meter = createFrameMeter({ wasHidden: () => false });
    meter.sample(0);
    meter.sample(400);
    expect(meter.pausedMs).toBe(0);
    expect(meter.frameMs).toBe(400);
    meter.sample(5400);
    expect(meter.pausedMs).toBe(0);
    expect(meter.frameMs).toBeCloseTo(400 + (1000 - 400) * 0.1, 6);
  });

  it("takes a gap the page was hidden for as a pause", () => {
    let hidden = false;
    const meter = createFrameMeter({ wasHidden: () => hidden });
    meter.sample(0);
    meter.sample(16);
    hidden = true;
    meter.sample(5016);
    expect(meter.pausedMs).toBe(5000);
    expect(meter.frameMs).toBe(16);
  });

  it("lets the governor step down on a software-slow machine", () => {
    const meter = createFrameMeter({ wasHidden: () => false });
    let state = createGovernor("high", 0);
    let now = 0;
    meter.sample(now);
    for (let i = 0; i < 40; i++) {
      now += state.quality === "high" ? 400 : 150;
      const frameMs = meter.sample(now);
      state = stepGovernor(state, frameMs, now, meter.pausedMs);
    }
    expect(state.quality).not.toBe("high");
  });
});

describe("softwareFrameDue", () => {
  it("draws the first frame, then rests in proportion to what a frame cost", () => {
    expect(softwareFrameDue(0, null, 0)).toBe(true);
    expect(softwareFrameDue(40, 0, 0)).toBe(false);
    expect(softwareFrameDue(SOFTWARE.frameIntervalMs, 0, 0)).toBe(true);
    // A frame that took 200 ms is followed by a rest of three times that.
    expect(softwareFrameDue(500, 0, 200)).toBe(false);
    expect(softwareFrameDue(600, 0, 200)).toBe(true);
    // But never longer than the longest interval.
    expect(softwareFrameDue(SOFTWARE.maxIntervalMs, 0, 5000)).toBe(true);
  });
});

describe("isSoftwareRenderer", () => {
  it("knows SwiftShader and llvmpipe, and not a real GPU", () => {
    expect(
      isSoftwareRenderer(
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)",
      ),
    ).toBe(true);
    expect(isSoftwareRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(isSoftwareRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max)")).toBe(false);
  });
});

describe("postPlan", () => {
  it("builds a pipeline at medium and high, none at low", () => {
    expect(postPlan("low", 1)).toBeNull();
    expect(postPlan("medium", 1)).not.toBeNull();
    expect(postPlan("high", 2)).not.toBeNull();
  });

  it("builds none where the context cannot render into half-float targets", () => {
    expect(postPlan("medium", 1, false)).toBeNull();
    expect(postPlan("high", 1, false)).toBeNull();
  });
});
