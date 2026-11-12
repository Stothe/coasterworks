import { familyById, pieceById } from "@coasterworks/content";
import type { World } from "../world/types.js";
import type { Pose } from "./pose.js";

/**
 * What a passed test run measured (see `systems/coasters.ts`). Every value is an integer:
 *
 *  - `length`: the circuit's centre line, in 1/1024 tile.
 *  - `rideTime`: ticks from leaving the platform to coming to rest at it again (40 a second).
 *  - `maxSpeed`: in 1/1024 tile per tick (a tile is taken as 3 m, so 100 is about 11.7 m/s).
 *  - `maxDrop`: the biggest single descent the front of the train made, in 1/1024 tile (256 to a
 *    height step); `drops`: how many descents of at least one height step it made.
 *  - `airtime`: ticks with the vertical G below 0.20.
 *  - `maxVerticalG`, `minVerticalG`: the most and least vertical G felt, in 1/100 g (100 is
 *    sitting still; below 0 lifts riders out of their seats). `maxLateralG`: the largest sideways
 *    G either way, in 1/100 g. All three are averaged over the train's length (see
 *    `track/physics.ts`).
 */
export interface TrackStats {
  length: number;
  rideTime: number;
  maxSpeed: number;
  maxDrop: number;
  drops: number;
  airtime: number;
  maxVerticalG: number;
  minVerticalG: number;
  maxLateralG: number;
}

/** The keys of `TrackStats`, in the order they are saved and hashed. */
export const TRACK_STAT_KEYS = [
  "length",
  "rideTime",
  "maxSpeed",
  "maxDrop",
  "drops",
  "airtime",
  "maxVerticalG",
  "minVerticalG",
  "maxLateralG",
] as const satisfies readonly (keyof TrackStats)[];

/**
 * A coaster's train out of the station (see `track/physics.ts` for the units and `TrainMode` for
 * the modes). `travelled` is how far its front has come along the track from where it stands
 * parked (the end of the station run), in 1/65536 tile, and `speed` its speed along the track in
 * 1/65536 tile per tick, forward positive. `ticks` counts ticks since it left the platform and
 * `modeTicks` ticks in its current mode.
 */
export interface TrainState {
  mode: number;
  travelled: number;
  speed: number;
  ticks: number;
  modeTicks: number;
}

/**
 * A test run in progress: the stats so far (in `TrackStats` units), and the bookkeeping for the
 * drops (`lastZ` the front's height last tick, `peakZ` where the current descent began, both in
 * 1/1024 tile, and `descending`). `stalled` is set once the train has stalled: the run then only
 * waits for it to come to rest, and fails.
 */
export interface TestProgress {
  maxSpeed: number;
  maxDrop: number;
  drops: number;
  airtime: number;
  maxVerticalG: number;
  minVerticalG: number;
  maxLateralG: number;
  lastZ: number;
  peakZ: number;
  descending: boolean;
  stalled: boolean;
}

/**
 * A coaster's shape: its family, the pose its first station piece starts from, and its pieces in
 * order, and what testing it has found. `id` is the coaster's ride id. Plain JSON, so it is saved,
 * hashed and kept in undo data as it is. `stats` is what the last passed test run measured (null
 * until one passes), `failure` why the last test run failed (null if it passed or none has run),
 * `train` the train when it is not parked at rest on the platform (null when it is), and `test`
 * the test run under way (null when none is).
 */
export interface TrackRecord {
  id: number;
  /** The coaster family's id, such as `steel_coaster` (also the ride's `type`). */
  family: string;
  start: Pose;
  /** Track piece ids, from the first station piece on. */
  pieces: string[];
  /** True once `coaster_complete` has found the circuit closed. */
  complete: boolean;
  /** True once a test run has passed. */
  tested: boolean;
  stats: TrackStats | null;
  failure: string | null;
  train: TrainState | null;
  test: TestProgress | null;
}

/** Most pieces one coaster can have. */
export const MAX_TRACK_PIECES = 1000;

/** A deep copy of a track record, with its keys in a fixed order (so its JSON is stable). */
export function copyTrack(track: TrackRecord): TrackRecord {
  const { start } = track;
  return {
    id: track.id,
    family: track.family,
    start: {
      x: start.x,
      y: start.y,
      z: start.z,
      dir: start.dir,
      pitch: start.pitch,
      bank: start.bank,
    },
    pieces: [...track.pieces],
    complete: track.complete,
    tested: track.tested,
    stats: track.stats === null ? null : copyStats(track.stats),
    failure: track.failure,
    train: track.train === null ? null : copyTrain(track.train),
    test: track.test === null ? null : copyTest(track.test),
  };
}

/** A copy of test stats, keys in a fixed order. */
export function copyStats(stats: TrackStats): TrackStats {
  return {
    length: stats.length,
    rideTime: stats.rideTime,
    maxSpeed: stats.maxSpeed,
    maxDrop: stats.maxDrop,
    drops: stats.drops,
    airtime: stats.airtime,
    maxVerticalG: stats.maxVerticalG,
    minVerticalG: stats.minVerticalG,
    maxLateralG: stats.maxLateralG,
  };
}

/** A copy of a train, keys in a fixed order. */
export function copyTrain(train: TrainState): TrainState {
  return {
    mode: train.mode,
    travelled: train.travelled,
    speed: train.speed,
    ticks: train.ticks,
    modeTicks: train.modeTicks,
  };
}

/** A copy of a test run's progress, keys in a fixed order. */
export function copyTest(test: TestProgress): TestProgress {
  return {
    maxSpeed: test.maxSpeed,
    maxDrop: test.maxDrop,
    drops: test.drops,
    airtime: test.airtime,
    maxVerticalG: test.maxVerticalG,
    minVerticalG: test.minVerticalG,
    maxLateralG: test.maxLateralG,
    lastZ: test.lastZ,
    peakZ: test.peakZ,
    descending: test.descending,
    stalled: test.stalled,
  };
}

/** The track of the coaster with ride id `id`, or undefined. `world.tracks` is in id order. */
export function findTrack(world: World, id: number): TrackRecord | undefined {
  const tracks = world.tracks;
  let lo = 0;
  let hi = tracks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const track = tracks[mid] as TrackRecord;
    if (track.id === id) return track;
    if (track.id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** Puts `track` into `world.tracks` in id order. */
export function insertTrack(world: World, track: TrackRecord): void {
  let at = world.tracks.length;
  while (at > 0 && (world.tracks[at - 1] as TrackRecord).id > track.id) at--;
  world.tracks.splice(at, 0, track);
}

/** Takes the track with ride id `id` out of `world.tracks` and returns it; throws if absent. */
export function takeTrack(world: World, id: number): TrackRecord {
  const at = world.tracks.findIndex((track) => track.id === id);
  if (at === -1) throw new RangeError(`No track for ride ${id}`);
  return world.tracks.splice(at, 1)[0] as TrackRecord;
}

/** What one piece of `family` costs to build, in cents; 0 for an unknown family or piece. */
export function pieceCost(family: string, piece: string): number {
  const f = familyById(family);
  const p = pieceById(piece);
  return f === undefined || p === undefined ? 0 : f.pieceCost[p.kind];
}

/** What every piece of `track` cost to build together, in cents. */
export function trackCost(track: TrackRecord): number {
  let total = 0;
  for (const piece of track.pieces) total += pieceCost(track.family, piece);
  return total;
}

/**
 * What demolishing `track` refunds, in cents: half of each piece's cost rounded down, summed, so
 * it is exactly what removing its pieces one by one with `coaster_remove_piece` would refund.
 */
export function trackRefund(track: TrackRecord): number {
  let total = 0;
  for (const piece of track.pieces) total += Math.floor(pieceCost(track.family, piece) / 2);
  return total;
}
