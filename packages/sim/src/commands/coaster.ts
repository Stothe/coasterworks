import { familyById, pieceById, type CoasterFamily, type TrackPiece } from "@coasterworks/content";
import { z } from "zod";
import { MAX_PATH_SLOPE } from "../paths/paths.js";
import { ejectGuests } from "../rides/operation.js";
import {
  NOT_FLAT,
  OUTSIDE_PARK,
  SOMETHING_HERE,
  TOO_MANY_BUILT,
  TOO_MANY_RIDES,
  addRide,
  defaultRideName,
  findRide,
  removeRide,
} from "../rides/rides.js";
import { MAX_RIDE_ID, RIDE_CAP, RidePhase, type RideRecord } from "../rides/types.js";
import { tileCorners } from "../terrain/terrain.js";
import {
  MAX_STATION_PIECES,
  MIN_STATION_PIECES,
  familyOf,
  indexAddPiece,
  indexAddTrack,
  indexRemovePiece,
  indexRemoveTrack,
  placementRefusal,
  reservedTiles,
  stationAccess,
  tileHasTrack,
  trackIndex,
  type PieceContext,
} from "../track/occupancy.js";
import { applyPiece, endPose, poseAtTile, posesEqual, type Dir, type Pose } from "../track/pose.js";
import {
  MAX_TRACK_PIECES,
  copyTrack,
  findTrack,
  insertTrack,
  pieceCost,
  takeTrack,
  trackCost,
  type TrackRecord,
} from "../track/record.js";
import { MAX_MAP, type World } from "../world/types.js";
import { defineCommand } from "./define.js";
import { checkCash } from "./execute.js";

// Building a coaster piece by piece. A coaster is a ride record of kind `coaster` (its `type` the
// family id) and a `TrackRecord` in `World.tracks` with the same id. Every piece is placed by
// `placementRefusal` in `track/occupancy.ts`; the track index is updated with the pieces.

export const NOT_A_COASTER = (id: number) => `Ride ${id} is not a coaster`;
export const ALREADY_COMPLETE = "The circuit is already complete";
export const KEEP_FIRST_STATION =
  "The first station piece stays: demolish the coaster to remove it";
export const CLOSE_FIRST = "Close the coaster before changing its track";
export const TOO_MANY_PIECES = `A coaster can have at most ${MAX_TRACK_PIECES} pieces`;
export const NOT_CLOSED = "The track does not join back up with the start of the station";
export const STATION_LENGTH = `A coaster needs one station of ${MIN_STATION_PIECES} to ${MAX_STATION_PIECES} pieces`;
export const NO_LIFT =
  "A coaster with no lift hill must never climb above its station: add a lift piece";
export const RUN_A_TEST = "Run a test first";
export const COMPLETE_FIRST = "Complete the circuit first";

/** The family named `id`, or the reason there is none. */
function familyFor(id: string): CoasterFamily | string {
  return familyById(id) ?? `Unknown coaster family: ${id}`;
}

/** The coaster ride and its track for ride id `id`, or the reason there is none. */
export function coasterOf(
  world: World,
  id: number,
): { ride: RideRecord; track: TrackRecord } | string {
  const ride = findRide(world, id);
  if (ride === undefined) return `No ride with id ${id}`;
  if (ride.kind !== "coaster") return NOT_A_COASTER(id);
  const track = findTrack(world, id);
  if (track === undefined) throw new RangeError(`Coaster ${id} has no track`);
  return { ride, track };
}

/** `coasterOf` for a command whose validation has already passed. */
function coaster(world: World, id: number): { ride: RideRecord; track: TrackRecord } {
  const found = coasterOf(world, id);
  if (typeof found === "string") throw new RangeError(found);
  return found;
}

/** What placing the next piece at the end of `track` needs. */
export function contextFor(world: World, track: TrackRecord): PieceContext {
  return {
    rideId: track.id,
    family: familyOf(track),
    start: track.start,
    pieces: track.pieces,
    pose: endPose(track.start, track.pieces),
    reserved: reservedTiles(world),
  };
}

/** Why `pieceId` cannot be appended to coaster `id` now, or null if it can. */
export function appendRefusal(world: World, id: number, pieceId: string): string | null {
  const found = coasterOf(world, id);
  if (typeof found === "string") return found;
  const { ride, track } = found;
  const piece = pieceById(pieceId);
  if (piece === undefined) return `Unknown track piece: ${pieceId}`;
  if (ride.open) return CLOSE_FIRST;
  if (track.complete) return ALREADY_COMPLETE;
  if (track.pieces.length >= MAX_TRACK_PIECES) return TOO_MANY_PIECES;
  return placementRefusal(world, contextFor(world, track), piece);
}

/**
 * Why coaster `id` cannot be completed, or null if it can: the end pose must be the start pose
 * exactly, the track must have one station run of 2 to 8 pieces at its start, and it must either
 * have a lift piece or never rise above the station's height anywhere.
 */
export function completeRefusal(world: World, id: number): string | null {
  const found = coasterOf(world, id);
  if (typeof found === "string") return found;
  const { track } = found;
  if (track.complete) return ALREADY_COMPLETE;
  if (!posesEqual(endPose(track.start, track.pieces), track.start)) return NOT_CLOSED;
  const pieces = track.pieces.map((p) => pieceById(p) as TrackPiece);
  let run = 0;
  while (run < pieces.length && pieces[run]!.flags.station) run++;
  const stations = pieces.filter((p) => p.flags.station).length;
  if (stations !== run || run < MIN_STATION_PIECES || run > MAX_STATION_PIECES) {
    return STATION_LENGTH;
  }
  if (!pieces.some((p) => p.flags.lift)) {
    let pose = track.start;
    for (const piece of pieces) {
      pose = applyPiece(pose, piece);
      if (pose.z > track.start.z) return NO_LIFT;
    }
  }
  return null;
}

const beginSchema = z.object({
  family: z.string(),
  x: z.int().min(0).max(MAX_MAP),
  y: z.int().min(0).max(MAX_MAP),
  dir: z.int().min(0).max(3),
});
type BeginInput = z.infer<typeof beginSchema>;

/** Where `coaster_begin` would put the first station piece and the coaster's entrance and exit. */
function beginPlan(world: World, input: BeginInput) {
  const dir = input.dir as Dir;
  const { width, height } = world.terrain;
  const onMap = input.x < width && input.y < height;
  const height0 = onMap ? Math.max(...tileCorners(world.terrain, input.x, input.y)) : 0;
  const start: Pose = poseAtTile(input.x, input.y, dir, height0);
  return { dir, start, ...stationAccess(input.x, input.y, dir) };
}

/** Why a coaster cannot begin with a station on (x, y) facing `dir`, or null if it can. */
export function beginRefusal(world: World, input: BeginInput): string | null {
  const family = familyFor(input.family);
  if (typeof family === "string") return family;
  const t = world.terrain;
  const { x, y } = input;
  if (x < 1 || y < 1 || x > t.width - 2 || y > t.height - 2) return OUTSIDE_PARK;
  const corners = tileCorners(t, x, y);
  if (Math.max(...corners) !== Math.min(...corners)) return NOT_FLAT;
  const plan = beginPlan(world, input);
  const reserved = reservedTiles(world);
  // The entrance and exit must be free the way a ride's are, and clear of track.
  const entrance = world.park.entrance;
  for (const tile of [plan.entrance, plan.exit]) {
    if (tile.x < 1 || tile.y < 1 || tile.x > t.width - 2 || tile.y > t.height - 2) {
      return OUTSIDE_PARK;
    }
    const index = tile.y * t.width + tile.x;
    if (
      (t.occupant[index] as number) !== 0 ||
      (t.water[index] as number) > 0 ||
      reserved.has(index) ||
      (entrance !== null && entrance.x === tile.x && entrance.y === tile.y) ||
      tileHasTrack(world, index)
    ) {
      return SOMETHING_HERE;
    }
    const around = tileCorners(t, tile.x, tile.y);
    if (Math.max(...around) - Math.min(...around) > MAX_PATH_SLOPE) {
      return "The way in or out is too steep for a path";
    }
  }
  if (world.rides.length >= RIDE_CAP) return TOO_MANY_RIDES;
  if (world.nextRideId > MAX_RIDE_ID) return TOO_MANY_BUILT;
  // The coaster's own entrance and exit are reserved as soon as it stands.
  const own = new Set(reserved);
  own.add(plan.entrance.y * t.width + plan.entrance.x);
  own.add(plan.exit.y * t.width + plan.exit.x);
  const ctx: PieceContext = {
    rideId: world.nextRideId,
    family,
    start: plan.start,
    pieces: [],
    pose: plan.start,
    reserved: own,
  };
  return placementRefusal(world, ctx, pieceById("station") as TrackPiece);
}

export const coasterBegin = defineCommand({
  name: "coaster_begin",
  description: `Begins a coaster of a family (a \`content_list\` type of kind \`coaster\`, such as \`steel_coaster\`): lays its first station piece on tile (x, y) facing \`dir\` (0 north, 1 east, 2 south, 3 west) at that tile's ground height, which must be flat. The coaster is a ride, closed and untested, named like "Steel Coaster 1"; its entrance is the tile beside the station on its left and its exit the tile on its right, which must be free as a ride's are. Costs the family's station piece. Then add pieces with \`coaster_add_piece\` (see \`coaster_piece_options\`) and close the circuit with \`coaster_complete\`. Refused if the tile or its entrance or exit is off the map or on its outer ring, if the station could not be placed (water, a ride, a path, other track), or if ${RIDE_CAP} rides and stalls already stand.`,
  category: "ride",
  input: beginSchema,
  undoable: true,
  cost: (_world, input: BeginInput) => pieceCost(input.family, "station"),
  validate: beginRefusal,
  apply: (world, input: BeginInput): { id: number } => {
    const family = familyFor(input.family) as CoasterFamily;
    const plan = beginPlan(world, input);
    const index = trackIndex(world);
    const id = world.nextRideId++;
    const ride: RideRecord = {
      id,
      type: family.id,
      kind: "coaster",
      x: input.x,
      y: input.y,
      rot: plan.dir,
      name: defaultRideName(world, family),
      open: false,
      price: family.defaultPrice,
      entrance: plan.entrance,
      exit: plan.exit,
      service: null,
      phase: RidePhase.IDLE,
      phaseTicks: 0,
      riders: [],
      queue: [],
      stats: { customers: 0, income: 0, runningCost: 0, monthCustomers: 0, monthIncome: 0 },
    };
    addRide(world, ride);
    const track: TrackRecord = {
      id,
      family: family.id,
      start: plan.start,
      pieces: ["station"],
      complete: false,
      tested: false,
      stats: null,
    };
    insertTrack(world, track);
    indexAddPiece(index, id, 0, plan.start, "station");
    world.rideVersion++;
    return { id };
  },
  revert: (world, _input, undo: { id: number }) => {
    const index = trackIndex(world);
    const ride = findRide(world, undo.id);
    if (ride !== undefined) ejectGuests(world, ride);
    indexRemoveTrack(index, takeTrack(world, undo.id));
    removeRide(world, undo.id);
    world.nextRideId = undo.id;
    world.rideVersion++;
  },
});

const pieceSchema = z.object({ id: z.int().min(1), piece: z.string() });

export const coasterAddPiece = defineCommand({
  name: "coaster_add_piece",
  description:
    "Adds a track piece (a `track_pieces_list` id, such as `straight` or `right_large_curve`) to the end of a coaster's track, by the coaster's ride id. Costs the family's price for that kind of piece. Refused if the family does not have the piece, if the piece does not start at the pitch and bank the track ends on, if a station piece does not follow the station run at the start (at most 8), if the circuit is complete or the coaster open, or if the piece would leave the park (or touch its outer ring), cross water, a ride or stall, an entrance or exit, or the park entrance, go into the ground, pass less than 8 height steps over a path, or come within 6 height steps of other track on a tile, its own included. `coaster_piece_options` says which pieces fit next and why the others do not.",
  category: "ride",
  input: pieceSchema,
  undoable: true,
  cost: (world, { id, piece }) => {
    const track = findTrack(world, id);
    return track === undefined ? 0 : pieceCost(track.family, piece);
  },
  validate: (world, { id, piece }) => appendRefusal(world, id, piece),
  apply: (world, { id, piece }) => {
    const { track } = coaster(world, id);
    const index = trackIndex(world);
    indexAddPiece(index, id, track.pieces.length, endPose(track.start, track.pieces), piece);
    track.pieces.push(piece);
    world.rideVersion++;
  },
  revert: (world, { id }) => {
    const { track } = coaster(world, id);
    const index = trackIndex(world);
    const piece = track.pieces.pop() as string;
    indexRemovePiece(index, id, track.pieces.length, endPose(track.start, track.pieces), piece);
    world.rideVersion++;
  },
});

/** What removing a piece saves: the piece, the refund it paid, and the flags it cleared. */
interface RemoveUndo {
  piece: string;
  refund: number;
  complete: boolean;
  tested: boolean;
}

export const coasterRemovePiece = defineCommand({
  name: "coaster_remove_piece",
  description:
    "Removes the last piece of a coaster's track, by the coaster's ride id, and refunds half of what it cost, rounded down to the cent, straight into cash (the command's own cost is 0). A complete circuit becomes incomplete and untested. The first station piece cannot be removed (demolish the coaster instead), and an open coaster must be closed first. Undoing it lays the piece again and takes the refund back, so the undo is refused if the park no longer has that much cash.",
  category: "ride",
  input: z.object({ id: z.int().min(1) }),
  undoable: true,
  validate: (world, { id }) => {
    const found = coasterOf(world, id);
    if (typeof found === "string") return found;
    if (found.ride.open) return CLOSE_FIRST;
    return found.track.pieces.length <= 1 ? KEEP_FIRST_STATION : null;
  },
  apply: (world, { id }): RemoveUndo => {
    const { track } = coaster(world, id);
    const index = trackIndex(world);
    const piece = track.pieces.pop() as string;
    indexRemovePiece(index, id, track.pieces.length, endPose(track.start, track.pieces), piece);
    const refund = Math.floor(pieceCost(track.family, piece) / 2);
    world.finance.cash += refund;
    const undo = { piece, refund, complete: track.complete, tested: track.tested };
    track.complete = false;
    track.tested = false;
    world.rideVersion++;
    return undo;
  },
  revert: (world, { id }, undo: RemoveUndo) => {
    const { track } = coaster(world, id);
    const index = trackIndex(world);
    indexAddPiece(index, id, track.pieces.length, endPose(track.start, track.pieces), undo.piece);
    track.pieces.push(undo.piece);
    track.complete = undo.complete;
    track.tested = undo.tested;
    world.finance.cash -= undo.refund;
    world.rideVersion++;
  },
  validateRevert: (world, _input, undo: RemoveUndo) => checkCash(world, undo.refund),
});

export const coasterComplete = defineCommand({
  name: "coaster_complete",
  description: `Completes a coaster's circuit, by its ride id. Free. Refused unless the track ends exactly where its first station piece starts (same tile edge, height, direction, pitch and bank), it has one station run of ${MIN_STATION_PIECES} to ${MAX_STATION_PIECES} pieces at the start, and it has a lift piece or never rises above the station's height (a coaster without a lift must never climb above its station). A complete coaster still needs a test run before it can open.`,
  category: "ride",
  input: z.object({ id: z.int().min(1) }),
  undoable: true,
  validate: (world, { id }) => completeRefusal(world, id),
  apply: (world, { id }) => {
    coaster(world, id).track.complete = true;
    world.rideVersion++;
  },
  revert: (world, { id }) => {
    const { track } = coaster(world, id);
    track.complete = false;
    track.tested = false;
    world.rideVersion++;
  },
});

/** Why `ride_open` must refuse coaster `ride`, or null if it may open. */
export function coasterOpenRefusal(world: World, ride: RideRecord): string | null {
  if (ride.kind !== "coaster") return null;
  const track = findTrack(world, ride.id);
  if (track === undefined || !track.complete) return COMPLETE_FIRST;
  return track.tested ? null : RUN_A_TEST;
}

/** What demolishing a coaster saves beyond the ride record: its track. */
export interface CoasterDemolish {
  track: TrackRecord;
  refund: number;
}

/** Takes coaster `id`'s track out of the world and its index; returns it and the refund owed. */
export function demolishTrack(world: World, id: number): CoasterDemolish {
  const index = trackIndex(world);
  const track = takeTrack(world, id);
  indexRemoveTrack(index, track);
  return { track: copyTrack(track), refund: Math.floor(trackCost(track) / 2) };
}

/** Puts a demolished coaster's track back, into the world and its index. */
export function restoreTrack(world: World, track: TrackRecord): void {
  const index = trackIndex(world);
  const copy = copyTrack(track);
  insertTrack(world, copy);
  indexAddTrack(index, copy);
}
