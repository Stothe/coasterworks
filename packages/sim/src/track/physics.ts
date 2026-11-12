import {
  STEP,
  TRIG_ONE,
  TURN,
  divRound,
  icos,
  isin,
  isqrt,
  mod,
  pieceById,
  type CoasterFamily,
} from "@coasterworks/content";
import { SEG_BRAKE, SEG_LIFT, SEG_STATION, sampleTrack, type Pose, type Segment } from "./pose.js";
import type { TrainState } from "./record.js";

// Coaster physics: a train run along a track's sampled centre line, one tick at a time, with
// integer math only (the trig tables of `@coasterworks/content`), so every engine gives the same
// run.
//
// Units, as in `CoasterFamilySchema`'s physics:
//  - Positions along the track (`travelled`, the front, the back) are in 1/65536 tile, 64 to the
//    1/1024 tile of the centre line's `s` (FINE).
//  - Speeds are in 1/65536 tile per tick, so the family's speeds (1/1024 tile per tick) are
//    multiplied by FINE. A tile is taken as 3 m and a second is 40 ticks: 1/1024 tile per tick is
//    about 0.117 m/s.
//  - Accelerations are in 1/65536 tile per tick squared: the family's `gravity` (134, so 1 g) and
//    `rollingFriction` are in it, and one tick adds an acceleration to the speed as it is.
//
// The train is rigid, `cars * carLength` long. Gravity pulls it along the track by
// g * (z(front) - z(back)) / length, which is the exact pull on a uniform train between those two
// points and conserves energy with no reference to the sampled pitch. Rolling friction (a constant
// deceleration) and air drag (`drag * v^2 / 2^20` with v in 1/1024 tile per tick) slow it. At the
// family values drag is small (terminal speed far above anything a track reaches), so the rolling
// friction does most of the work: 2/134 of g for steel, about the 1.5 % of a real coaster.
//
// G forces are averaged over the train's length (Plan E ruling): the vertical and sideways
// curvature are the change in pitch and heading from the back of the train to its front, over its
// length, so they come from the shape over 3 tiles rather than from one sample's quantised angle,
// and the smoothstep easing's 1.5x peak in a single sample is evened out the way riders feel it.

/** Fine position units in one centre-line unit (1/1024 tile). */
export const FINE = 64;

/** Deceleration the station's tyres use to stop the train at the platform: about 0.3 g. */
export const STATION_DECEL = 40;

/** The slowest the station's tyres move a train toward its stopping point: 1/1024 tile per tick. */
export const STATION_CREEP = FINE;

/** The longest a stalled train is let roll before it is stopped where it is: 5 minutes. */
export const MAX_SETTLE_TICKS = 40 * 60 * 5;

/** The longest a test run may take before it fails: an hour. */
export const MAX_RUN_TICKS = 40 * 60 * 60;

/** A descent counts as a drop when it is at least this high, in 1/1024 tile: one height step. */
export const MIN_DROP = STEP;

/** Vertical G (in 1/100 g) below which riders float: airtime. */
export const AIRTIME_G = 20;

/** 2 pi as 710 / 113 (good to 3 parts in 10^7), for angles in 1/4096 turn. */
const TWO_PI_NUM = 710;
const TWO_PI_DEN = 113;

/**
 * What a train is doing:
 *  - DEPART: leaving the platform; the station's tyres push it up to `stationSpeed` while any car
 *    is still on the station run.
 *  - RUN: out on the circuit. Lift pieces hold it at `liftSpeed` or faster, brakes cap it at
 *    `brakeSpeed`. If its speed falls to 0 it has stalled and goes to SETTLE.
 *  - RETURN: its front is back on the station run; the tyres bring it to rest with its front at
 *    the end of the run, where it left from.
 *  - SETTLE: after a stall, rolling back and forth under gravity and friction with no drives on.
 *    The anti-rollback on lifts and the station's tyres hold it as soon as any of it is on them;
 *    otherwise it comes to rest when it stops where the slope is gentler than friction can hold,
 *    or after `MAX_SETTLE_TICKS`.
 *  - STOPPED: at rest out on the track after a stall (a train at rest on the platform is null).
 */
export const TrainMode = { DEPART: 1, RUN: 2, RETURN: 3, SETTLE: 4, STOPPED: 5 } as const;

/** A track's sampled centre line, ready for a train. */
export interface Line {
  /** `sampleTrack` of the circuit: its last sample is the first again, at `s` = `length`. */
  segs: Segment[];
  /** The circuit's length, in 1/1024 tile. */
  length: number;
  /** Where the station run at the start ends, in 1/1024 tile along the line. */
  stationEnd: number;
}

/** The line of a closed circuit `pieces` from `start`. */
export function buildLine(start: Pose, pieces: readonly string[]): Line {
  const segs = sampleTrack(start, pieces);
  let stations = 0;
  while (stations < pieces.length && pieceById(pieces[stations]!)?.flags.station) stations++;
  let stationEnd = 0;
  for (const seg of segs) if (seg.piece === stations - 1) stationEnd = seg.s;
  return { segs, length: segs[segs.length - 1]!.s, stationEnd };
}

/** The centre line at one point: height, angles and the flags of the piece it is on. */
export interface LinePoint {
  z: number;
  pitch: number;
  roll: number;
  heading: number;
  flags: number;
}

/** The point `pos` (in 1/65536 tile, any integer: it wraps round the circuit) along `line`. */
export function pointAt(line: Line, pos: number): LinePoint {
  const { segs } = line;
  const p = mod(pos, line.length * FINE);
  // The last sample i with s_i * FINE <= p; the closing duplicate is never reached, since p is
  // below the length.
  let lo = 0;
  let hi = segs.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((segs[mid] as Segment).s * FINE <= p) lo = mid;
    else hi = mid - 1;
  }
  const a = segs[lo] as Segment;
  const b = segs[lo + 1] as Segment;
  const span = (b.s - a.s) * FINE;
  const t = p - a.s * FINE;
  const lerp = (u: number, v: number) => (span === 0 ? u : u + divRound((v - u) * t, span));
  // Headings wrap: go the short way from a to b.
  const turn = mod(b.heading - a.heading + TURN / 2, TURN) - TURN / 2;
  return {
    z: lerp(a.z, b.z),
    pitch: lerp(a.pitch, b.pitch),
    roll: lerp(a.roll, b.roll),
    heading: mod(a.heading + (span === 0 ? 0 : divRound(turn * t, span)), TURN),
    // A stretch between two samples belongs to the piece of the sample it ends on.
    flags: b.flags,
  };
}

/** The physics a train of `family` runs with, in this file's units. */
export interface TrainSpec {
  /** Train length, in 1/1024 tile. */
  length: number;
  gravity: number;
  friction: number;
  drag: number;
  liftSpeed: number;
  brakeSpeed: number;
  stationSpeed: number;
}

/** The train spec of `family` with its default number of cars. */
export function trainSpec(family: CoasterFamily): TrainSpec {
  const { physics, train } = family;
  return {
    length: train.defaultCars * train.carLength,
    gravity: physics.gravity,
    friction: physics.rollingFriction,
    drag: physics.drag,
    liftSpeed: physics.liftSpeed * FINE,
    brakeSpeed: physics.brakeSpeed * FINE,
    stationSpeed: physics.stationSpeed * FINE,
  };
}

/** A train leaving the platform, at rest. */
export function departingTrain(): TrainState {
  return { mode: TrainMode.DEPART, travelled: 0, speed: 0, ticks: 0, modeTicks: 0 };
}

/** Where the front of `train` is along `line`, in 1/65536 tile (not wrapped). */
export function frontOf(line: Line, train: TrainState | null): number {
  return line.stationEnd * FINE + (train === null ? 0 : train.travelled);
}

/** The front, middle and back of a train whose front is at `front`. */
function trainPoints(line: Line, spec: TrainSpec, front: number) {
  return {
    front: pointAt(line, front),
    mid: pointAt(line, front - (spec.length * FINE) / 2),
    back: pointAt(line, front - spec.length * FINE),
  };
}

/**
 * The acceleration toward the centre of a curve whose direction turns by `angle` (1/4096 turn)
 * over `length` (1/1024 tile) at `speed` (1/65536 tile per tick), in 1/65536 tile per tick^2:
 * v^2 * (angle in radians) / length.
 */
function curveAccel(speed: number, angle: number, length: number): number {
  // v^2 / 4096 first keeps the products within 2^53 (v below 2^17, angle below 2^12).
  const v2 = Math.floor((speed * speed) / 4096);
  return divRound(v2 * angle * TWO_PI_NUM, TWO_PI_DEN * 64 * length);
}

/** The G forces riders feel, in 1/100 g: up through the seat, and sideways (right positive). */
export interface Forces {
  vertical: number;
  lateral: number;
}

/**
 * The G forces on a train whose front is at `front` going at `speed`, averaged over its length.
 * The felt force is the train's acceleration minus gravity. Its acceleration across the track is
 * v^2 times the curvature: up toward the inside of a valley (the pitch rising from back to front)
 * and toward the inside of a turn (the heading turning). Those are split into the car's own up
 * and sideways by the roll at its middle, so banking into a turn turns sideways G into vertical G.
 */
export function trainForces(line: Line, spec: TrainSpec, front: number, speed: number): Forces {
  const { front: f, mid, back } = trainPoints(line, spec, front);
  const g = spec.gravity;
  const climb = curveAccel(speed, f.pitch - back.pitch, spec.length);
  const turnAngle = mod(f.heading - back.heading + TURN / 2, TURN) - TURN / 2;
  const turn = curveAccel(speed, turnAngle, spec.length);
  // Scaled by TRIG_ONE: the felt force in the level frame, up and to the right.
  const up = g * icos(mid.pitch) + climb * TRIG_ONE;
  const side = turn * TRIG_ONE;
  const cos = icos(mid.roll);
  const sin = isin(mid.roll);
  const scale = g * TRIG_ONE * TRIG_ONE;
  return {
    vertical: divRound(100 * (cos * up + sin * side), scale),
    lateral: divRound(100 * (cos * side - sin * up), scale),
  };
}

/** What one tick of a train did. */
export const TrainEvent = { NONE: 0, STALLED: 1, ARRIVED: 2, SETTLED: 3 } as const;

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

/**
 * Moves `train` one tick along `line` (it must not be STOPPED). Returns what happened: STALLED
 * when a running train's speed fell to 0 (it is now SETTLE), ARRIVED when it came to rest at the
 * platform (the caller parks it), SETTLED when a stalled train came to rest (it is now STOPPED).
 */
export function stepTrain(line: Line, spec: TrainSpec, train: TrainState): number {
  const fineLength = spec.length * FINE;
  const front = frontOf(line, train);
  const { front: f, mid, back } = trainPoints(line, spec, front);
  const flags = f.flags | mid.flags | back.flags;
  const pull = -divRound(spec.gravity * (f.z - back.z), spec.length);
  const v1024sq = divRound(train.speed * train.speed, FINE * FINE);
  const drag = divRound(spec.drag * v1024sq, 1 << 20);
  train.ticks++;
  train.modeTicks++;
  const setMode = (mode: number) => {
    train.mode = mode;
    train.modeTicks = 0;
  };

  switch (train.mode) {
    case TrainMode.DEPART:
    case TrainMode.RUN: {
      let speed = train.speed + pull - (train.speed > 0 ? spec.friction + drag : 0);
      if (train.mode === TrainMode.DEPART) speed = Math.max(speed, spec.stationSpeed);
      if ((flags & SEG_LIFT) !== 0) speed = Math.max(speed, spec.liftSpeed);
      if ((flags & SEG_BRAKE) !== 0) speed = Math.min(speed, spec.brakeSpeed);
      if (speed <= 0) {
        train.speed = 0;
        setMode(TrainMode.SETTLE);
        return TrainEvent.STALLED;
      }
      train.speed = speed;
      train.travelled += speed;
      if (train.mode === TrainMode.DEPART && train.travelled >= fineLength) setMode(TrainMode.RUN);
      if (train.travelled >= (line.length - line.stationEnd) * FINE) setMode(TrainMode.RETURN);
      return TrainEvent.NONE;
    }
    case TrainMode.RETURN: {
      const left = line.length * FINE - train.travelled;
      const reach = isqrt(2 * STATION_DECEL * Math.max(0, left));
      const speed = Math.max(STATION_CREEP, Math.min(spec.stationSpeed, train.speed, reach));
      if (left <= speed) {
        train.travelled = line.length * FINE;
        train.speed = 0;
        return TrainEvent.ARRIVED;
      }
      train.speed = speed;
      train.travelled += speed;
      return TrainEvent.NONE;
    }
    case TrainMode.SETTLE: {
      // Held by a lift's anti-rollback or the station's tyres, or out of time.
      if ((flags & (SEG_LIFT | SEG_STATION)) !== 0 || train.modeTicks > MAX_SETTLE_TICKS) {
        train.speed = 0;
        setMode(TrainMode.STOPPED);
        return TrainEvent.SETTLED;
      }
      let speed: number;
      if (train.speed === 0) {
        // At rest for a moment: friction holds it where the slope is gentle enough.
        if (Math.abs(pull) <= spec.friction) {
          setMode(TrainMode.STOPPED);
          return TrainEvent.SETTLED;
        }
        speed = pull - sign(pull) * spec.friction;
      } else {
        speed = train.speed + pull - sign(train.speed) * (spec.friction + drag);
        // Turning round: stop for this tick, and look again from rest.
        if (sign(speed) !== sign(train.speed)) speed = 0;
      }
      if ((flags & SEG_BRAKE) !== 0) {
        speed = Math.max(-spec.brakeSpeed, Math.min(spec.brakeSpeed, speed));
      }
      train.speed = speed;
      train.travelled += speed;
      return TrainEvent.NONE;
    }
    default:
      throw new RangeError(`A train in mode ${train.mode} does not move`);
  }
}
