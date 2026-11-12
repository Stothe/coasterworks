import { familyById } from "@coasterworks/content";
import { findRide } from "../rides/rides.js";
import { RidePhase } from "../rides/types.js";
import {
  AIRTIME_G,
  FINE,
  MAX_RUN_TICKS,
  MIN_DROP,
  TrainEvent,
  TrainMode,
  buildLine,
  departingTrain,
  frontOf,
  pointAt,
  stepTrain,
  trainForces,
  trainSpec,
  type Line,
  type TrainSpec,
} from "../track/physics.js";
import type { TestProgress, TrackRecord, TrackStats, TrainState } from "../track/record.js";
import type { World } from "../world/types.js";
import type { System } from "./types.js";

// The coasters' trains. One train per coaster (Plan E). In this task a train only runs for a test:
// `ride_test` sends it off empty (`startTest`), this system moves it every tick and measures the
// run, and when it comes to rest the result goes on the track: `tested` and `stats` when it came
// back to the platform, `failure` when it stalled. Plan E Task 5 dispatches trains with riders
// through the same `stepTrain`.

export const TRAIN_STALLED = "The train stalled";
export const RUN_TOO_LONG = "The test run took too long";

/** A cached line, with the ride version it was checked at and the pieces it was built from. */
interface CachedLine {
  version: number;
  key: string;
  line: Line;
}

const lines = new WeakMap<TrackRecord, CachedLine>();

/**
 * The sampled centre line of complete track `track`. Cached on the record and checked again only
 * when the world's ride version has moved (every change to a track moves it).
 */
export function lineOf(world: World, track: TrackRecord): Line {
  const cached = lines.get(track);
  if (cached !== undefined && cached.version === world.rideVersion) return cached.line;
  const key = track.pieces.join(",");
  if (cached !== undefined && cached.key === key) {
    cached.version = world.rideVersion;
    return cached.line;
  }
  const line = buildLine(track.start, track.pieces);
  lines.set(track, { version: world.rideVersion, key, line });
  return line;
}

function freshTest(z: number): TestProgress {
  return {
    maxSpeed: 0,
    maxDrop: 0,
    drops: 0,
    airtime: 0,
    maxVerticalG: 0,
    minVerticalG: 0,
    maxLateralG: 0,
    lastZ: z,
    peakZ: z,
    descending: false,
    stalled: false,
  };
}

/**
 * Starts a test run on complete track `track`: the train leaves the platform empty, and the
 * coaster shows TESTING. Clears the last result. The caller has checked it may.
 */
export function startTest(world: World, track: TrackRecord): void {
  const line = lineOf(world, track);
  track.tested = false;
  track.stats = null;
  track.failure = null;
  track.train = departingTrain();
  track.test = freshTest(pointAt(line, frontOf(line, null)).z);
  const ride = findRide(world, track.id);
  if (ride !== undefined) {
    ride.phase = RidePhase.TESTING;
    ride.phaseTicks = 0;
  }
}

/** Ends any test run on `track` and parks its train on the platform, as if none had run. */
export function cancelTest(world: World, track: TrackRecord): void {
  track.train = null;
  track.test = null;
  const ride = findRide(world, track.id);
  if (ride !== undefined && ride.phase === RidePhase.TESTING) {
    ride.phase = RidePhase.IDLE;
    ride.phaseTicks = 0;
  }
}

/** Ends a descent, if one is under way, counting it when it is high enough. */
function endDrop(test: TestProgress): void {
  if (!test.descending) return;
  test.descending = false;
  const height = test.peakZ - test.lastZ;
  if (height >= MIN_DROP) {
    test.drops++;
    if (height > test.maxDrop) test.maxDrop = height;
  }
}

/** Records one tick of a running train in `test`. */
function measure(test: TestProgress, line: Line, spec: TrainSpec, train: TrainState): void {
  const front = frontOf(line, train);
  const z = pointAt(line, front).z;
  if (z < test.lastZ && !test.descending) {
    test.descending = true;
    test.peakZ = test.lastZ;
  } else if (z > test.lastZ) {
    endDrop(test);
  }
  test.lastZ = z;
  const speed = Math.floor(train.speed / FINE);
  if (speed > test.maxSpeed) test.maxSpeed = speed;
  const g = trainForces(line, spec, front, train.speed);
  if (train.ticks === 1 || g.vertical > test.maxVerticalG) test.maxVerticalG = g.vertical;
  if (train.ticks === 1 || g.vertical < test.minVerticalG) test.minVerticalG = g.vertical;
  if (Math.abs(g.lateral) > test.maxLateralG) test.maxLateralG = Math.abs(g.lateral);
  if (g.vertical < AIRTIME_G) test.airtime++;
}

/** Finishes the test on `track` as passed, with the stats measured. */
function pass(world: World, track: TrackRecord, line: Line): void {
  const test = track.test!;
  endDrop(test);
  const stats: TrackStats = {
    length: line.length,
    rideTime: track.train!.ticks,
    maxSpeed: test.maxSpeed,
    maxDrop: test.maxDrop,
    drops: test.drops,
    airtime: test.airtime,
    maxVerticalG: test.maxVerticalG,
    minVerticalG: test.minVerticalG,
    maxLateralG: test.maxLateralG,
  };
  cancelTest(world, track);
  track.tested = true;
  track.stats = stats;
  world.rideVersion++;
}

/** Finishes the test on `track` as failed, leaving the train where it stopped. */
function fail(world: World, track: TrackRecord, reason: string): void {
  const train = track.train!;
  train.mode = TrainMode.STOPPED;
  train.speed = 0;
  train.modeTicks = 0;
  track.test = null;
  track.failure = reason;
  const ride = findRide(world, track.id);
  if (ride !== undefined && ride.phase === RidePhase.TESTING) {
    ride.phase = RidePhase.IDLE;
    ride.phaseTicks = 0;
  }
  world.rideVersion++;
}

/** One tick of the train on `track`, if it is running a test. */
function tickTrack(world: World, track: TrackRecord): void {
  const train = track.train;
  const test = track.test;
  if (train === null || test === null || train.mode === TrainMode.STOPPED) return;
  const family = familyById(track.family);
  if (family === undefined) return;
  const line = lineOf(world, track);
  const spec = trainSpec(family);
  const event = stepTrain(line, spec, train);
  const ride = findRide(world, track.id);
  if (ride !== undefined) ride.phaseTicks = Math.min(ride.phaseTicks + 1, 0xffff);
  switch (event) {
    case TrainEvent.ARRIVED:
      pass(world, track, line);
      return;
    case TrainEvent.STALLED:
      test.stalled = true;
      return;
    case TrainEvent.SETTLED:
      fail(world, track, TRAIN_STALLED);
      return;
  }
  if (!test.stalled) {
    measure(test, line, spec, train);
    if (train.ticks >= MAX_RUN_TICKS) fail(world, track, RUN_TOO_LONG);
  }
}

/**
 * The coasters. Each tick, every coaster in id order moves its train if it is out on a test run.
 * Runs after the rides and before the guests.
 */
export const coasterSystem: System = {
  name: "coasters",
  tick(world) {
    for (const track of world.tracks) tickTrack(world, track);
  },
};
