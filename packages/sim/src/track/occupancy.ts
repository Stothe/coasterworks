import {
  STEP,
  TILE,
  familyById,
  familyRefusesPiece,
  pieceById,
  type CoasterFamily,
  type TrackPiece,
} from "@coasterworks/content";
import { tileCorners } from "../terrain/terrain.js";
import type { World } from "../world/types.js";
import {
  applyPiece,
  localToWorld,
  pieceRefusal,
  pieceTiles,
  posesEqual,
  type Dir,
  type Pose,
} from "./pose.js";
import type { TrackRecord } from "./record.js";

// Where track lies: a runtime index from each tile to the height bands of the track pieces over
// it, and the one set of rules every piece is placed by (`coaster_begin`, `coaster_add_piece`, the
// piece options query and the save invariants all use `pieceRefusal` below).
//
// Heights here are in the fixed-point units of `@coasterworks/content` (a height step is `STEP`).

/** Clear height steps a track needs above a path's ground, so guests walk under it. */
export const PATH_CLEARANCE = 8;
/** Clear height steps between two stretches of track on the same tile, so cars pass. */
export const TRACK_CLEARANCE = 6;
/** Most station pieces in the one run a coaster starts with, and fewest it can complete with. */
export const MAX_STATION_PIECES = 8;
export const MIN_STATION_PIECES = 2;

export const TRACK_OUTSIDE = "Area is outside the park";
export const TRACK_OVER_WATER = "Track cannot be built over water";
export const TRACK_RIDE_IN_WAY = "A ride or stall is in the way";
export const TRACK_ENTRANCE_IN_WAY = "Track cannot cross a ride's entrance or exit";
export const TRACK_PARK_ENTRANCE = "Tile is the park entrance";
export const TRACK_UNDERGROUND = "Track cannot go into the ground";
export const TRACK_LOW_OVER_PATH = "Track is too low over a path";
export const TRACK_HITS_ITSELF = "The track would run into itself";
export const TRACK_HITS_OTHER = "Another coaster's track is in the way";
export const STATION_NOT_CONTIGUOUS = "Station pieces must form one run at the start";
export const STATION_TOO_LONG = `A station is at most ${MAX_STATION_PIECES} pieces long`;
export const BAD_POSE = "Track must start on the middle of a tile edge at a whole height step";

/** One piece's stretch of track over one tile, between heights `zLo` and `zHi` (fixed point). */
export interface TrackBand {
  rideId: number;
  piece: number;
  zLo: number;
  zHi: number;
}

/** The bands on each tile with track, by tile index; each tile's bands sorted by ride, piece. */
export interface TrackIndex {
  width: number;
  height: number;
  tiles: Map<number, TrackBand[]>;
}

function compareBands(a: TrackBand, b: TrackBand): number {
  return a.rideId - b.rideId || a.piece - b.piece || a.zLo - b.zLo;
}

/** Adds the bands of piece `n` of ride `rideId`, laid from `pose`, to `index`. */
export function indexAddPiece(
  index: TrackIndex,
  rideId: number,
  n: number,
  pose: Pose,
  piece: string,
): void {
  for (const t of pieceTiles(pose, piece)) {
    const key = t.y * index.width + t.x;
    const band: TrackBand = { rideId, piece: n, zLo: t.zLo * STEP, zHi: t.zHi * STEP };
    const list = index.tiles.get(key);
    if (list === undefined) {
      index.tiles.set(key, [band]);
      continue;
    }
    let at = list.length;
    while (at > 0 && compareBands(list[at - 1] as TrackBand, band) > 0) at--;
    list.splice(at, 0, band);
  }
}

/** Takes the bands of piece `n` of ride `rideId`, laid from `pose`, out of `index`. */
export function indexRemovePiece(
  index: TrackIndex,
  rideId: number,
  n: number,
  pose: Pose,
  piece: string,
): void {
  for (const t of pieceTiles(pose, piece)) {
    const key = t.y * index.width + t.x;
    const list = index.tiles.get(key);
    if (list === undefined) continue;
    const at = list.findIndex((b) => b.rideId === rideId && b.piece === n);
    if (at !== -1) list.splice(at, 1);
    if (list.length === 0) index.tiles.delete(key);
  }
}

/** Adds every piece of `track` to `index`. */
export function indexAddTrack(index: TrackIndex, track: TrackRecord): void {
  let pose = track.start;
  for (const [n, piece] of track.pieces.entries()) {
    indexAddPiece(index, track.id, n, pose, piece);
    pose = applyPiece(pose, piece);
  }
}

/** Takes every piece of `track` out of `index`. */
export function indexRemoveTrack(index: TrackIndex, track: TrackRecord): void {
  let pose = track.start;
  for (const [n, piece] of track.pieces.entries()) {
    indexRemovePiece(index, track.id, n, pose, piece);
    pose = applyPiece(pose, piece);
  }
}

/** A new index of every track in `world`, built from `world.tracks`. */
export function buildTrackIndex(world: World): TrackIndex {
  const { width, height } = world.terrain;
  const index: TrackIndex = { width, height, tiles: new Map() };
  for (const track of world.tracks) indexAddTrack(index, track);
  return index;
}

/** The world's track index, built from `world.tracks` the first time it is asked for. */
export function trackIndex(world: World): TrackIndex {
  const { width, height } = world.terrain;
  const current = world.trackIndex;
  if (current !== undefined && current.width === width && current.height === height) {
    return current;
  }
  const built = buildTrackIndex(world);
  world.trackIndex = built;
  return built;
}

/** The track bands on tile index `tile`, empty when there are none. */
export function bandsAt(world: World, tile: number): readonly TrackBand[] {
  return trackIndex(world).tiles.get(tile) ?? [];
}

/** True when any track lies over tile index `tile` (its supports are taken to stand there too). */
export function tileHasTrack(world: World, tile: number): boolean {
  return world.tracks.length > 0 && bandsAt(world, tile).length > 0;
}

/** The bottom of the lowest track over tile index `tile`, or null when there is none. */
export function lowestTrack(world: World, tile: number): number | null {
  if (world.tracks.length === 0) return null;
  let low: number | null = null;
  for (const band of bandsAt(world, tile)) if (low === null || band.zLo < low) low = band.zLo;
  return low;
}

/** True when a path on tile (x, y) would leave too little room under any track there. */
export function trackTooLowForPath(world: World, x: number, y: number): boolean {
  const low = lowestTrack(world, y * world.terrain.width + x);
  if (low === null) return false;
  return low < (Math.max(...tileCorners(world.terrain, x, y)) + PATH_CLEARANCE) * STEP;
}

/** True when `pose` is where pieces join: integers, the middle of a tile edge, a whole step. */
export function isJoinPose(pose: Pose): boolean {
  const ints = [pose.x, pose.y, pose.z, pose.pitch, pose.bank];
  if (!ints.every(Number.isInteger)) return false;
  if (![0, 1, 2, 3].includes(pose.dir)) return false;
  if (Math.abs(pose.pitch) > 2 || Math.abs(pose.bank) > 2) return false;
  if (pose.z % STEP !== 0 || pose.z < 0) return false;
  const half = TILE / 2;
  const mx = ((pose.x % TILE) + TILE) % TILE;
  const my = ((pose.y % TILE) + TILE) % TILE;
  // Facing north or south the pose is on a tile's north or south edge; east or west, on a side.
  return pose.dir % 2 === 0 ? mx === half && my === 0 : mx === 0 && my === half;
}

/** What placing a piece needs to know about the track it joins. */
export interface PieceContext {
  rideId: number;
  family: CoasterFamily;
  start: Pose;
  /** The pieces already laid, from the first station piece on. */
  pieces: readonly string[];
  /** Where they end, which is where the new piece starts. */
  pose: Pose;
  /** Indexes of every ride's and stall's entrance, exit and service tiles. */
  reserved: ReadonlySet<number>;
  /**
   * Bands of this track's own pieces that are not in the world's index yet, on a tile index: the
   * pieces a fit has laid out but not built (see `track/fit.ts`). Checked exactly like indexed ones.
   */
  extra?: (tile: number) => Iterable<TrackBand>;
}

/** Indexes of every ride's and stall's access tiles: entrances, exits and service tiles. */
export function reservedTiles(world: World): Set<number> {
  const out = new Set<number>();
  const width = world.terrain.width;
  for (const ride of world.rides) {
    for (const tile of [ride.entrance, ride.exit, ride.service]) {
      if (tile !== null) out.add(tile.y * width + tile.x);
    }
  }
  return out;
}

/**
 * Why `piece` cannot be laid at the end of the track `ctx` describes, or null if it can. The one
 * rule set for track, checked in this order:
 *
 *   1. the family has the piece, and the piece starts with the pitch and bank the track ends on;
 *   2. station pieces only in the one run at the start, at most `MAX_STATION_PIECES` of them;
 *   3. the piece starts where pieces join (`isJoinPose`);
 *   4. on each tile it covers: on the map and off its outer ring; no water; no ride or stall
 *      footprint, no ride's or stall's entrance, exit or service tile, not the park entrance; its
 *      lowest point at or above the ground's highest corner; at least `PATH_CLEARANCE` steps above
 *      the ground over a path; and at least `TRACK_CLEARANCE` steps clear of every other track
 *      band there, its own track's included, except the piece it joins (and, when it closes the
 *      circuit, the first piece). Its own pieces from `ctx.pieces.length` on are not counted, so
 *      a saved track replays piece by piece against the world without itself.
 */
export function placementRefusal(
  world: World,
  ctx: PieceContext,
  piece: TrackPiece,
): string | null {
  const refused = familyRefusesPiece(ctx.family, piece) ?? pieceRefusal(ctx.pose, piece);
  if (refused !== null) return refused;
  if (piece.flags.station) {
    if (ctx.pieces.some((id) => !pieceById(id)?.flags.station)) return STATION_NOT_CONTIGUOUS;
    if (ctx.pieces.length >= MAX_STATION_PIECES) return STATION_TOO_LONG;
  }
  if (!isJoinPose(ctx.pose)) return BAD_POSE;

  const t = world.terrain;
  const n = ctx.pieces.length;
  const closes = posesEqual(applyPiece(ctx.pose, piece), ctx.start);
  const index = trackIndex(world);
  const clearance = TRACK_CLEARANCE * STEP;
  const extra = ctx.extra;
  for (const tile of pieceTiles(ctx.pose, piece)) {
    const { x, y } = tile;
    const ground = tileRefusal(world, ctx.reserved, x, y, tile.zLo);
    if (ground !== null) return ground;
    const at = y * t.width + x;
    const lo = tile.zLo * STEP;
    const hi = tile.zHi * STEP;
    for (const band of index.tiles.get(at) ?? []) {
      const hit = bandClash(band, ctx.rideId, n, closes, lo - clearance, hi + clearance);
      if (hit !== null) return hit;
    }
    if (extra !== undefined) {
      for (const band of extra(at)) {
        const hit = bandClash(band, ctx.rideId, n, closes, lo - clearance, hi + clearance);
        if (hit !== null) return hit;
      }
    }
  }
  return null;
}

/**
 * Why `band` is in the way of piece `n` of ride `rideId` passing between `lo` and `hi` (its band
 * widened by the clearance): never for its own pieces from `n` on, the piece it joins, or the
 * first piece when it closes the circuit.
 */
function bandClash(
  band: TrackBand,
  rideId: number,
  n: number,
  closes: boolean,
  lo: number,
  hi: number,
): string | null {
  const own = band.rideId === rideId;
  if (own && (band.piece >= n || band.piece === n - 1 || (closes && band.piece === 0))) return null;
  if (band.zLo < hi && band.zHi > lo) return own ? TRACK_HITS_ITSELF : TRACK_HITS_OTHER;
  return null;
}

/**
 * Why track whose lowest point over tile (x, y) is `zLo` (whole steps) cannot pass there, apart
 * from other track: rule 4 of `placementRefusal` for one tile. Null when it can.
 */
export function tileRefusal(
  world: World,
  reserved: ReadonlySet<number>,
  x: number,
  y: number,
  zLo: number,
): string | null {
  const t = world.terrain;
  if (!Number.isInteger(x) || x < 1 || y < 1 || x > t.width - 2 || y > t.height - 2) {
    return TRACK_OUTSIDE;
  }
  const at = y * t.width + x;
  if ((t.water[at] as number) > 0) return TRACK_OVER_WATER;
  if ((t.occupant[at] as number) !== 0) return TRACK_RIDE_IN_WAY;
  if (reserved.has(at)) return TRACK_ENTRANCE_IN_WAY;
  const entrance = world.park.entrance;
  if (entrance !== null && entrance.x === x && entrance.y === y) return TRACK_PARK_ENTRANCE;
  const ground = Math.max(...tileCorners(t, x, y));
  if (zLo < ground) return TRACK_UNDERGROUND;
  if ((t.path[at] as number) !== 0 && zLo < ground + PATH_CLEARANCE) return TRACK_LOW_OVER_PATH;
  return null;
}

/** The family a track names; throws for an unknown one (the invariants refuse such a save). */
export function familyOf(track: Pick<TrackRecord, "family">): CoasterFamily {
  const family = familyById(track.family);
  if (family === undefined) throw new RangeError(`Unknown coaster family ${track.family}`);
  return family;
}

/**
 * The entrance and exit of a coaster whose first station piece is on tile (x, y) facing `dir`:
 * the tiles beside it on its left and on its right.
 */
export function stationAccess(
  x: number,
  y: number,
  dir: Dir,
): { entrance: { x: number; y: number }; exit: { x: number; y: number } } {
  const right = localToWorld(dir, 0, 1);
  return {
    entrance: { x: x - right.dx, y: y - right.dy },
    exit: { x: x + right.dx, y: y + right.dy },
  };
}
