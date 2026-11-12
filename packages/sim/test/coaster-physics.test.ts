import { familyById } from "@coasterworks/content";
import { describe, expect, it } from "vitest";
import {
  FINE,
  RidePhase,
  SEG_BRAKE,
  Sim,
  TRAIN_STALLED,
  TrainMode,
  createWorld,
  deserializeWorld,
  frontOf,
  hashWorld,
  pointAt,
  serializeWorld,
  trainSpec,
  type TrackRecord,
  type TrackStats,
} from "../src/index.js";
import {
  CLOSE_TO_TEST,
  COMPLETE_FIRST,
  NOT_A_COASTER,
  RUN_A_TEST,
  TEST_RUNNING,
} from "../src/commands/coaster.js";
import { validateWorldInvariants } from "../src/save/invariants.js";
import { lineOf } from "../src/systems/coasters.js";
import { MAX_SETTLE_TICKS } from "../src/track/physics.js";

// Plan E Task 4, Review Focus 3: coaster physics is deterministic and stable. A train that
// cannot crest a hill stalls, rolls back and comes to rest (never loops forever), and brakes and
// the station bring a good run to rest at the platform.

const STEEL = familyById("steel_coaster")!;
/** The steel coaster's lift speed, in 1/1024 tile per tick. */
const LIFT = STEEL.physics.liftSpeed;

function makeSim(): Sim {
  return new Sim(createWorld({ width: 40, height: 40, seed: 1, name: "Physics", cash: 1e8 }));
}

function ok(sim: Sim, name: string, input: unknown): void {
  const result = sim.execute(name, input);
  if (!result.ok) throw new Error(`${name} ${JSON.stringify(input)}: ${result.error}`);
}

function refused(sim: Sim, name: string, input: unknown): string {
  const result = sim.execute(name, input);
  if (result.ok) throw new Error(`${name} ${JSON.stringify(input)} was taken`);
  return result.error;
}

/** Begins a steel coaster at (8, 6) facing east, lays `pieces` after its first station piece and completes it. */
function build(pieces: readonly string[], sim = makeSim()): Sim {
  ok(sim, "coaster_begin", { family: "steel_coaster", x: 8, y: 6, dir: 1 });
  for (const piece of pieces) ok(sim, "coaster_add_piece", { id: 1, piece });
  ok(sim, "coaster_complete", { id: 1 });
  return sim;
}

const repeat = (n: number, piece: string): string[] => Array.from({ length: n }, () => piece);

/**
 * A lift-and-drop oval: a second station, a lift of 2k + 2 steps, a U-turn of large curves at the
 * top, a drop of 2k + 2 steps, two straights (the first `brakes` when asked) and a U-turn home.
 */
function oval(k: number, brakes = false): string[] {
  return [
    "station",
    "flat_to_gentle_up_lift",
    ...repeat(k, "gentle_up_lift"),
    "gentle_up_to_flat_lift",
    "right_large_curve",
    "right_large_curve",
    "flat_to_gentle_down",
    ...repeat(k, "gentle_down"),
    "gentle_down_to_flat",
    brakes ? "brakes" : "straight",
    "straight",
    "right_large_curve",
    "right_large_curve",
  ];
}

/**
 * A weak drop and then a hill too high: a lift of 4 steps, brakes at the top (so the train goes
 * over at the brake speed), a drop of 4 steps and a climb of 8. Then a U-turn, back down, and home.
 */
const STALL = [
  "station",
  "flat_to_gentle_up_lift",
  "gentle_up_lift",
  "gentle_up_to_flat_lift",
  "brakes",
  "flat_to_gentle_down",
  "gentle_down",
  "gentle_down_to_flat",
  "flat_to_gentle_up",
  "gentle_up",
  "gentle_up",
  "gentle_up",
  "gentle_up_to_flat",
  "right_large_curve",
  "right_large_curve",
  "flat_to_gentle_down",
  "gentle_down",
  "gentle_down",
  "gentle_down",
  "gentle_down_to_flat",
  ...repeat(9, "straight"),
  "right_large_curve",
  "right_large_curve",
];

/** A lift-and-drop oval whose bottom U-turn is small curves, steeply banked or not banked. */
function tightTurn(banked: boolean): string[] {
  return [
    "station",
    "flat_to_gentle_up_lift",
    ...repeat(3, "gentle_up_lift"),
    "gentle_up_to_flat_lift",
    "right_small_curve",
    "right_small_curve",
    "flat_to_gentle_down",
    ...repeat(3, "gentle_down"),
    "gentle_down_to_flat",
    "straight",
    "straight",
    ...(banked ? ["bank_right_in", "bank_right_steepen"] : ["straight", "straight"]),
    ...repeat(2, banked ? "right_small_curve_steep_banked" : "right_small_curve"),
    ...(banked ? ["bank_right_ease", "bank_right_out"] : ["straight", "straight"]),
  ];
}

function trackOf(sim: Sim): TrackRecord {
  return sim.world.tracks[0]!;
}

/** Steps until the test on coaster 1 is over, checking every tick; returns the ticks taken. */
function runTest(sim: Sim, limit = 20_000): number {
  const track = trackOf(sim);
  let ticks = 0;
  while (track.test !== null) {
    sim.step(1);
    ticks++;
    const train = track.train;
    if (train !== null) {
      for (const value of Object.values(train)) expect(Number.isInteger(value)).toBe(true);
    }
    if (ticks > limit) throw new Error("the test run did not end");
  }
  return ticks;
}

function testedStats(pieces: readonly string[]): TrackStats {
  const sim = build(pieces);
  ok(sim, "ride_test", { id: 1 });
  runTest(sim);
  const track = trackOf(sim);
  expect(track.failure).toBeNull();
  expect(track.tested).toBe(true);
  return track.stats!;
}

describe("a test run", () => {
  it("takes a lift-and-drop oval round and back to rest at the platform, with plausible stats", () => {
    const sim = build(oval(4));
    ok(sim, "ride_test", { id: 1 });
    expect(sim.world.rides[0]!.phase).toBe(RidePhase.TESTING);
    const ticks = runTest(sim);
    const track = trackOf(sim);
    expect(track).toMatchObject({ tested: true, failure: null, train: null, test: null });
    expect(sim.world.rides[0]!.phase).toBe(RidePhase.IDLE);
    const stats = track.stats!;
    for (const value of Object.values(stats)) expect(Number.isInteger(value)).toBe(true);
    expect(stats.length).toBe(lineOf(sim.world, track).length);
    expect(stats.rideTime).toBe(ticks);
    // A 10-step drop is 2.5 tiles. From the lift speed with no losses the bottom speed would be
    // sqrt(lift^2 + 2 g h), about 115.4 in 1/1024 tile per tick (13.5 m/s); friction and drag
    // take a little of it, so it must land a little under that.
    const g = STEEL.physics.gravity / 65536; // tile per tick^2
    const ideal = 1024 * Math.sqrt((LIFT / 1024) ** 2 + 2 * g * 2.5);
    expect(stats.maxSpeed).toBeLessThan(ideal);
    expect(stats.maxSpeed).toBeGreaterThan(0.9 * ideal);
    expect(stats.maxDrop).toBe(10 * 256);
    expect(stats.drops).toBe(1);
    // About 100 m of track at 6 to 13 m/s: 10 to 20 seconds.
    expect(stats.rideTime).toBeGreaterThan(400);
    expect(stats.rideTime).toBeLessThan(800);
    // The valley at the foot of the drop presses riders down (1.5 to 2.5 g); the crest at the top
    // lightens them but not out of their seats (0.3 to 0.9 g), so no airtime. The flat large curve
    // at the bottom at about 13 m/s, a radius of 7.5 m, gives v^2 / r about 2.3 g sideways.
    expect(stats.maxVerticalG).toBeGreaterThan(150);
    expect(stats.maxVerticalG).toBeLessThan(250);
    expect(stats.minVerticalG).toBeGreaterThan(30);
    expect(stats.minVerticalG).toBeLessThan(90);
    expect(stats.airtime).toBe(0);
    expect(stats.maxLateralG).toBeGreaterThan(180);
    expect(stats.maxLateralG).toBeLessThan(260);
    expect(validateWorldInvariants(sim.world)).toBeNull();
  });

  it("goes faster with a higher drop", () => {
    const speeds = [0, 1, 3, 4].map((k) => testedStats(oval(k)).maxSpeed);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThan(speeds[i - 1]!);
  });

  it("brings every good run to rest at the platform", () => {
    for (const pieces of [oval(0), oval(3), oval(4, true), tightTurn(false), tightTurn(true)]) {
      const sim = build(pieces);
      ok(sim, "ride_test", { id: 1 });
      runTest(sim);
      expect(trackOf(sim)).toMatchObject({ tested: true, train: null, test: null });
      expect(sim.world.rides[0]!.phase).toBe(RidePhase.IDLE);
    }
  });

  it("is slowed by brakes", () => {
    const sim = build(oval(4, true));
    ok(sim, "ride_test", { id: 1 });
    const track = trackOf(sim);
    const line = lineOf(sim.world, track);
    const spec = trainSpec(STEEL);
    let fastestBefore = 0;
    let onBrakes = 0;
    while (track.test !== null) {
      const train = track.train!;
      const front = pointAt(line, frontOf(line, train));
      sim.step(1);
      if ((front.flags & SEG_BRAKE) !== 0) {
        onBrakes++;
        // The train's front was on the brakes as it moved, so it went no faster than they allow.
        expect(track.train?.speed ?? 0).toBeLessThanOrEqual(spec.brakeSpeed);
      } else if (onBrakes === 0) {
        fastestBefore = Math.max(fastestBefore, train.speed);
      }
    }
    expect(onBrakes).toBeGreaterThan(0);
    expect(fastestBefore).toBeGreaterThan(2 * spec.brakeSpeed);
    const braked = track.stats!;
    const free = testedStats(oval(4));
    // Slower after the brakes: a longer ride and far gentler curves home.
    expect(braked.rideTime).toBeGreaterThan(free.rideTime);
    expect(braked.maxLateralG).toBeLessThan(free.maxLateralG / 2);
  });

  it("feels a tight turn less sideways and more downward when it is banked", () => {
    // Plan wording: "G from a tight banked turn exceeds the same turn unbanked laterally". As the
    // physics is, banking into a turn tilts its pull under the riders: sideways G falls and
    // vertical G rises. Unbanked, a small curve (radius 4.5 m) at about 12 m/s pushes riders
    // sideways by about 3 g; banked at 60 degrees most of that goes through the seat.
    const flat = testedStats(tightTurn(false));
    const banked = testedStats(tightTurn(true));
    expect(flat.maxLateralG).toBeGreaterThan(250);
    expect(banked.maxLateralG).toBeLessThan(flat.maxLateralG / 2);
    expect(banked.maxVerticalG).toBeGreaterThan(flat.maxVerticalG + 100);
    // The rest of the ride is the same.
    expect(banked.maxSpeed).toBe(flat.maxSpeed);
    expect(banked.maxDrop).toBe(flat.maxDrop);
  });
});

describe("a stall", () => {
  it("is reported, and the train rolls back and comes to rest in the dip", () => {
    const sim = build(STALL);
    ok(sim, "ride_test", { id: 1 });
    const track = trackOf(sim);
    const line = lineOf(sim.world, track);
    const spec = trainSpec(STEEL);
    let farthest = 0;
    let stalledAt = -1;
    let ticks = 0;
    while (track.test !== null) {
      sim.step(1);
      ticks++;
      const train = track.train!;
      farthest = Math.max(farthest, train.travelled);
      if (stalledAt < 0 && track.test?.stalled) stalledAt = ticks;
      expect(ticks).toBeLessThan(10_000);
    }
    expect(track).toMatchObject({ tested: false, stats: null, failure: TRAIN_STALLED, test: null });
    expect(stalledAt).toBeGreaterThan(0);
    const train = track.train!;
    expect(train.mode).toBe(TrainMode.STOPPED);
    expect(train.speed).toBe(0);
    // It rolled back from where it stalled (it stalled with its middle more than a tile up the
    // hill), and settled in well under the cap.
    expect(train.travelled).toBeLessThan(farthest - 1024 * FINE);
    expect(ticks - stalledAt).toBeLessThan(MAX_SETTLE_TICKS);
    // It rests in the dip between the drop and the hill: its middle at the bottom (ground is 8
    // steps), its front on the climb and its back on the drop.
    const front = frontOf(line, train);
    const mid = pointAt(line, front - (spec.length * FINE) / 2);
    expect(mid.z).toBeLessThanOrEqual(8 * 256 + 64);
    expect(pointAt(line, front).z).toBeGreaterThan(mid.z);
    expect(pointAt(line, front - spec.length * FINE).z).toBeGreaterThan(mid.z);
    expect(sim.world.rides[0]!.phase).toBe(RidePhase.IDLE);
    expect(validateWorldInvariants(sim.world)).toBeNull();

    // At rest it stays at rest, and the coaster cannot open.
    const resting = { ...train };
    sim.step(200);
    expect(track.train).toEqual(resting);
    expect(refused(sim, "ride_open", { id: 1 })).toBe(RUN_A_TEST);
  });

  it("sends a stalled train back to the station for the next test", () => {
    const sim = build(STALL);
    ok(sim, "ride_test", { id: 1 });
    runTest(sim);
    ok(sim, "ride_test", { id: 1 });
    expect(trackOf(sim)).toMatchObject({ failure: null, test: { stalled: false } });
    expect(trackOf(sim).train).toMatchObject({ mode: TrainMode.DEPART, travelled: 0 });
    runTest(sim);
    expect(trackOf(sim).failure).toBe(TRAIN_STALLED);
  });
});

describe("determinism", () => {
  it("gives the same stats run twice", () => {
    expect(testedStats(oval(3))).toEqual(testedStats(oval(3)));
    expect(testedStats(tightTurn(true))).toEqual(testedStats(tightTurn(true)));
  });

  it("carries on identically after a save and load in the middle of a run", () => {
    for (const [pieces, at] of [
      [oval(4), 250],
      [STALL, 900],
    ] as const) {
      const sim = build(pieces);
      ok(sim, "ride_test", { id: 1 });
      sim.step(at);
      expect(trackOf(sim).test).not.toBeNull();
      const loaded = new Sim(deserializeWorld(serializeWorld(sim.world)));
      expect(hashWorld(loaded.world)).toBe(sim.hash());
      expect(loaded.world.tracks).toEqual(sim.world.tracks);
      runTest(sim);
      runTest(loaded);
      expect(loaded.world.tracks).toEqual(sim.world.tracks);
      expect(loaded.hash()).toBe(sim.hash());
    }
  });

  it("is cheap: a whole test run of one coaster takes little time", () => {
    const sim = build(oval(4));
    ok(sim, "ride_test", { id: 1 });
    const start = performance.now();
    const ticks = runTest(sim);
    const perTick = (performance.now() - start) / ticks;
    // Measured at about 0.002 ms a tick (with the test's own checks); allow plenty for CI.
    expect(perTick).toBeLessThan(0.5);
  });
});

describe("ride_test", () => {
  it("is refused for what it cannot test", () => {
    const sim = makeSim();
    ok(sim, "coaster_begin", { family: "steel_coaster", x: 8, y: 6, dir: 1 });
    expect(refused(sim, "ride_test", { id: 1 })).toBe(COMPLETE_FIRST);
    expect(refused(sim, "ride_test", { id: 9 })).toBe("No ride with id 9");
    ok(sim, "ride_build", { type: "carousel", x: 20, y: 20, rot: 0 });
    expect(refused(sim, "ride_test", { id: 2 })).toBe(NOT_A_COASTER(2));
  });

  it("is refused while a test runs, which also keeps the track and the opening waiting", () => {
    const sim = build(oval(0));
    ok(sim, "ride_test", { id: 1 });
    sim.step(10);
    expect(refused(sim, "ride_test", { id: 1 })).toBe(TEST_RUNNING);
    expect(refused(sim, "ride_open", { id: 1 })).toBe(TEST_RUNNING);
    expect(refused(sim, "coaster_remove_piece", { id: 1 })).toBe(TEST_RUNNING);
    runTest(sim);
    ok(sim, "ride_open", { id: 1 });
    expect(refused(sim, "ride_test", { id: 1 })).toBe(CLOSE_TO_TEST);
    expect(validateWorldInvariants(sim.world)).toBeNull();
  });

  it("is undone by stopping the run, or by taking a finished run's result away", () => {
    const sim = build(oval(0));
    ok(sim, "ride_test", { id: 1 });
    sim.step(50);
    expect(sim.undo().ok).toBe(true);
    expect(trackOf(sim)).toMatchObject({ tested: false, train: null, test: null, stats: null });
    expect(sim.world.rides[0]!.phase).toBe(RidePhase.IDLE);
    expect(validateWorldInvariants(sim.world)).toBeNull();
    // Redone, the run starts again from the platform.
    expect(sim.redo().ok).toBe(true);
    expect(trackOf(sim).train).toMatchObject({ mode: TrainMode.DEPART, travelled: 0 });
    runTest(sim);
    const stats = trackOf(sim).stats;
    expect(stats).not.toBeNull();
    // A second test of a tested coaster, undone after it finished, gives the first result back.
    ok(sim, "ride_test", { id: 1 });
    runTest(sim);
    expect(sim.undo().ok).toBe(true);
    expect(trackOf(sim)).toMatchObject({ tested: true, stats, train: null, test: null });
    // And the first, undone, leaves it untested as it was.
    expect(sim.undo().ok).toBe(true);
    expect(trackOf(sim)).toMatchObject({ tested: false, stats: null });
  });

  it("is cleared by editing the track, and given back when the edit is undone", () => {
    const sim = build(oval(0));
    ok(sim, "ride_test", { id: 1 });
    runTest(sim);
    const stats = trackOf(sim).stats;
    ok(sim, "coaster_remove_piece", { id: 1 });
    expect(trackOf(sim)).toMatchObject({ complete: false, tested: false, stats: null });
    expect(refused(sim, "ride_open", { id: 1 })).toBe(COMPLETE_FIRST);
    expect(sim.undo().ok).toBe(true);
    expect(trackOf(sim)).toMatchObject({ complete: true, tested: true, stats });
    ok(sim, "ride_open", { id: 1 });
  });

  it("ends with the coaster when it is demolished mid-run; undone, the coaster is untested", () => {
    const sim = build(oval(0));
    ok(sim, "ride_test", { id: 1 });
    sim.step(100);
    ok(sim, "ride_demolish", { id: 1 });
    expect(sim.world.tracks).toEqual([]);
    expect(sim.undo().ok).toBe(true);
    expect(trackOf(sim)).toMatchObject({ tested: false, train: null, test: null });
    expect(sim.world.rides[0]!.phase).toBe(RidePhase.IDLE);
    expect(validateWorldInvariants(sim.world)).toBeNull();
    sim.step(1000);
    expect(trackOf(sim).train).toBeNull();
  });
});
