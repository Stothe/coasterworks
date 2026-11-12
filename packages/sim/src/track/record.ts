import { familyById, pieceById } from "@coasterworks/content";
import type { World } from "../world/types.js";
import type { Pose } from "./pose.js";

/**
 * A coaster's shape: its family, the pose its first station piece starts from, and its pieces in
 * order. `id` is the coaster's ride id. Plain JSON, so it is saved, hashed and kept in undo data as
 * it is. `stats` is filled in by a test run (Plan E, Task 4) and null until then.
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
  stats: null;
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
    stats: null,
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
