import {
  STEP,
  familyById,
  pieceById,
  type CoasterFamily,
  type TrackPiece,
} from "@coasterworks/content";
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
  NOT_CLOSED,
  NO_LIFT,
  STATION_LENGTH,
  circuitRefusal,
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
  type TrackBand,
} from "../track/occupancy.js";
import {
  ALREADY_REACHED,
  FIX_EARLIER,
  TOO_LONG,
  fitPoints,
  worldStamp,
  type FitPoint,
  type PointFit,
} from "../track/fit.js";
import { applyPiece, endPose, pieceTiles, poseAtTile, type Dir, type Pose } from "../track/pose.js";
import { cancelTest, startTest } from "../systems/coasters.js";
import {
  MAX_TRACK_PIECES,
  copyStats,
  copyTest,
  copyTrain,
  copyTrack,
  findTrack,
  insertTrack,
  pieceCost,
  takeTrack,
  trackRefund,
  type TestProgress,
  type TrackRecord,
  type TrackStats,
  type TrainState,
} from "../track/record.js";
import { MAX_MAP, type World } from "../world/types.js";
import { defineCommand } from "./define.js";
import { checkCash } from "./execute.js";

// Building a coaster piece by piece. A coaster is a ride record of kind `coaster` (its `type` the
// family id) and a `TrackRecord` in `World.tracks` with the same id. Every piece is placed by
// `placementRefusal` in `track/occupancy.ts`; the track index is updated with the pieces.

export { NOT_CLOSED, NO_LIFT, STATION_LENGTH, circuitRefusal };

export const NOT_A_COASTER = (id: number) => `Ride ${id} is not a coaster`;
export const ALREADY_COMPLETE = "The circuit is already complete";
export const KEEP_FIRST_STATION =
  "The first station piece stays: demolish the coaster to remove it";
export const CLOSE_FIRST = "Close the coaster before changing its track";
export const TOO_MANY_PIECES = `A coaster can have at most ${MAX_TRACK_PIECES} pieces`;
export const RUN_A_TEST = "Run a test first";
export const COMPLETE_FIRST = "Complete the circuit first";
export const TEST_RUNNING = "Wait for the test run to finish";
export const CLOSE_TO_TEST = "Close the coaster before testing it";

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
  return circuitRefusal(track.start, track.pieces);
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
    return { id: beginCoaster(world, family, input.x, input.y, input.dir as Dir, ["station"]) };
  },
  revert: (world, _input, undo: { id: number }) => unbeginCoaster(world, undo.id),
});

/**
 * Stands a new coaster of `family` with its first station piece on tile (x, y) facing `dir`, as
 * `coaster_begin` does, and lays `pieces` (from that first station piece on) as its track; marks
 * it complete when `complete`. The caller has validated all of it. Returns its ride id.
 */
function beginCoaster(
  world: World,
  family: CoasterFamily,
  x: number,
  y: number,
  dir: Dir,
  pieces: readonly string[],
  complete = false,
): number {
  const plan = beginPlan(world, { family: family.id, x, y, dir });
  const index = trackIndex(world);
  const id = world.nextRideId++;
  const ride: RideRecord = {
    id,
    type: family.id,
    kind: "coaster",
    x,
    y,
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
    pieces: [...pieces],
    complete,
    tested: false,
    stats: null,
    failure: null,
    train: null,
    test: null,
  };
  insertTrack(world, track);
  indexAddTrack(index, track);
  world.rideVersion++;
  return id;
}

/** Undoes `beginCoaster`: takes coaster `id`, its track and its ride id back out of the world. */
function unbeginCoaster(world: World, id: number): void {
  const index = trackIndex(world);
  const ride = findRide(world, id);
  if (ride !== undefined) ejectGuests(world, ride);
  indexRemoveTrack(index, takeTrack(world, id));
  removeRide(world, id);
  world.nextRideId = id;
  world.rideVersion++;
}

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

/**
 * What removing a piece saves: the piece, the refund it paid, and the test result it cleared
 * (the last four are missing from entries logged before test runs, when they were all empty).
 */
interface RemoveUndo {
  piece: string;
  refund: number;
  complete: boolean;
  tested: boolean;
  stats?: TrackStats | null;
  failure?: string | null;
  train?: TrainState | null;
}

/** A copy of `track`'s test result, for undo data. */
function testResult(track: TrackRecord) {
  return {
    tested: track.tested,
    stats: track.stats === null ? null : copyStats(track.stats),
    failure: track.failure,
    train: track.train === null ? null : copyTrain(track.train),
  };
}

export const coasterRemovePiece = defineCommand({
  name: "coaster_remove_piece",
  description:
    "Removes the last piece of a coaster's track, by the coaster's ride id, and refunds half of what it cost, rounded down to the cent, straight into cash (the command's own cost is 0). A complete circuit becomes incomplete and untested: its test result is cleared and a train stalled out on the track goes back to the station. The first station piece cannot be removed (demolish the coaster instead), an open coaster must be closed first, and a test run must finish first. Undoing it lays the piece again and takes the refund back, so the undo is refused if the park no longer has that much cash.",
  category: "ride",
  input: z.object({ id: z.int().min(1) }),
  undoable: true,
  validate: (world, { id }) => {
    const found = coasterOf(world, id);
    if (typeof found === "string") return found;
    if (found.ride.open) return CLOSE_FIRST;
    if (found.track.test !== null) return TEST_RUNNING;
    return found.track.pieces.length <= 1 ? KEEP_FIRST_STATION : null;
  },
  apply: (world, { id }): RemoveUndo => {
    const { track } = coaster(world, id);
    const index = trackIndex(world);
    const piece = track.pieces.pop() as string;
    indexRemovePiece(index, id, track.pieces.length, endPose(track.start, track.pieces), piece);
    const refund = Math.floor(pieceCost(track.family, piece) / 2);
    world.finance.cash += refund;
    const undo: RemoveUndo = { piece, refund, complete: track.complete, ...testResult(track) };
    track.complete = false;
    track.tested = false;
    track.stats = null;
    track.failure = null;
    track.train = null;
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
    track.stats = undo.stats ?? null;
    track.failure = undo.failure ?? null;
    track.train = undo.train ?? null;
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
  if (track.test !== null) return TEST_RUNNING;
  return track.tested ? null : RUN_A_TEST;
}

/** Why `ride_test` must refuse ride `id`, or null if it may run. */
export function testRefusal(world: World, id: number): string | null {
  const found = coasterOf(world, id);
  if (typeof found === "string") return found;
  const { ride, track } = found;
  if (ride.open) return CLOSE_TO_TEST;
  if (!track.complete) return COMPLETE_FIRST;
  return track.test !== null ? TEST_RUNNING : null;
}

/** What starting a test saves: the result and train it replaced, and the ride's phase. */
interface TestUndo {
  tested: boolean;
  stats: TrackStats | null;
  failure: string | null;
  train: TrainState | null;
  test: TestProgress | null;
  phase: number;
  phaseTicks: number;
}

export const rideTest = defineCommand({
  name: "ride_test",
  description:
    "Runs a test of a coaster, by its ride id: its train goes round the circuit once, empty, in the sim's own time (the ride's phase is TESTING, 4, until it is done; a run of a small coaster takes a minute or so of park time). Free. A run that comes back to rest at the platform passes: the coaster is tested and `coaster_get` gives its stats (length, ride time, top speed, biggest drop, drops, airtime and the vertical and lateral G forces); then it can open. A train that stops out on the track fails the test (\"The train stalled\"): it rolls back to rest in the nearest dip, and `coaster_get` gives the reason as `track.failure`. Starting a test clears the last result, and a train stalled out on the track goes back to the station for it. Refused unless the coaster's circuit is complete and the coaster closed, and while a test is under way. Undoing it stops the run (or takes a finished one's result away) and puts back the result from before.",
  category: "ride",
  input: z.object({ id: z.int().min(1) }),
  undoable: true,
  validate: (world, { id }) => testRefusal(world, id),
  apply: (world, { id }): TestUndo => {
    const { ride, track } = coaster(world, id);
    const undo: TestUndo = {
      ...testResult(track),
      test: track.test === null ? null : copyTest(track.test),
      phase: ride.phase,
      phaseTicks: ride.phaseTicks,
    };
    startTest(world, track);
    world.rideVersion++;
    return undo;
  },
  revert: (world, { id }, undo: TestUndo) => {
    const { ride, track } = coaster(world, id);
    track.tested = undo.tested;
    track.stats = undo.stats === null ? null : copyStats(undo.stats);
    track.failure = undo.failure;
    track.train = undo.train === null ? null : copyTrain(undo.train);
    track.test = undo.test === null ? null : copyTest(undo.test);
    ride.phase = undo.phase;
    ride.phaseTicks = undo.phaseTicks;
    world.rideVersion++;
  },
});

/** What demolishing a coaster saves beyond the ride record: its track. */
export interface CoasterDemolish {
  track: TrackRecord;
  refund: number;
}

/** Takes coaster `id`'s track out of the world and its index; returns it and the refund owed. */
export function demolishTrack(world: World, id: number): CoasterDemolish {
  const index = trackIndex(world);
  // A test under way ends with it: an undo gives the coaster back untested.
  const standing = findTrack(world, id);
  if (standing !== undefined) cancelTest(world, standing);
  const track = takeTrack(world, id);
  indexRemoveTrack(index, track);
  return { track: copyTrack(track), refund: trackRefund(track) };
}

/** Puts a demolished coaster's track back, into the world and its index. */
export function restoreTrack(world: World, track: TrackRecord): void {
  const index = trackIndex(world);
  const copy = copyTrack(track);
  insertTrack(world, copy);
  indexAddTrack(index, copy);
}

// Building from points (Plan E, Task 3). `track/fit.ts` lays the pieces; these commands build
// what it laid, exactly as `coaster_begin`, `coaster_add_piece` and `coaster_complete` would.

/** Most points one `coaster_build_from_points` or `coaster_fit_preview` takes. */
export const MAX_FIT_POINTS = 64;
export const STATION_ON_GROUND = "The station sits on the ground: leave out this point's height";
export { ALREADY_REACHED };

export const fitPointSchema = z.object({
  x: z.int().min(0).max(MAX_MAP),
  y: z.int().min(0).max(MAX_MAP),
  height: z.int().min(0).max(255).optional(),
});
export type FitPointInput = z.infer<typeof fitPointSchema>;

/** What fitting points to a coaster came to: what to build, and how each point went. */
export interface PointsPlan {
  /** For a new coaster, where its first station piece goes. */
  begin: { x: number; y: number; dir: Dir } | null;
  /** For a new coaster its whole track, station included; for an extension the added pieces. */
  pieces: string[];
  points: PointFit[];
  close: PointFit | null;
  /** The first failure, naming its point ("Point 2: Too steep to reach"); null when all fit. */
  error: string | null;
  /** What the pieces cost, in cents (only those that would be built). */
  cost: number;
}

/** The ground height of tile (x, y) in steps (its highest corner), or 0 off the map. */
function groundAt(world: World, x: number, y: number): number {
  const t = world.terrain;
  if (x >= t.width || y >= t.height) return 0;
  return Math.max(...tileCorners(t, x, y));
}

function fitPointsOf(world: World, points: readonly FitPointInput[]): FitPoint[] {
  return points.map((p) => ({ x: p.x, y: p.y, height: p.height ?? groundAt(world, p.x, p.y) }));
}

/** The first failure of a fit, as the commands report it. */
function fitError(fit: { points: PointFit[]; close: PointFit | null }): string | null {
  for (const [i, point] of fit.points.entries()) {
    if (!point.ok) return `Point ${i}: ${point.reason}`;
  }
  if (fit.close !== null && !fit.close.ok) return `Closing the circuit: ${fit.close.reason}`;
  return null;
}

/**
 * The direction a new coaster's station faces: toward the second point along whichever axis it
 * is farther away on (east or west on a tie), or east when there is no second point.
 */
export function stationFacing(points: readonly { x: number; y: number }[]): Dir {
  const [a, b] = points;
  if (a === undefined || b === undefined) return 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return 1;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 1 : 3;
  return dy > 0 ? 2 : 0;
}

/**
 * Plans a new coaster of `familyId` from `points`: a station of `MIN_STATION_PIECES` pieces on
 * the ground at points[0] (see `stationFacing`), then track fitted through the other points and,
 * when `close`, back to the station and checked as `coaster_complete` would check it.
 */
export function planFromPoints(
  world: World,
  familyId: string,
  input: readonly FitPointInput[],
  close: boolean,
): PointsPlan {
  const family = familyFor(familyId);
  if (typeof family === "string") throw new RangeError(family);
  const points = fitPointsOf(world, input);
  const fail = (reason: string): PointsPlan => {
    const out: PointsPlan = {
      begin: null,
      pieces: [],
      points: points.map((_, i) => ({
        ok: false,
        reason: i === 0 ? reason : FIX_EARLIER,
        pieces: 0,
      })),
      close: close ? { ok: false, reason: FIX_EARLIER, pieces: 0 } : null,
      error: null,
      cost: 0,
    };
    out.error = fitError(out);
    return out;
  };
  const first = points[0];
  if (first === undefined) throw new RangeError("Give at least one point");
  const p0 = input[0] as FitPointInput;
  const x = first.x;
  const y = first.y;
  const dir = stationFacing(points);
  if (p0.height !== undefined && p0.height !== groundAt(world, x, y)) {
    return fail(STATION_ON_GROUND);
  }
  const refused = beginRefusal(world, { family: family.id, x, y, dir });
  if (refused !== null) return fail(refused);
  const { start, entrance, exit } = beginPlan(world, { family: family.id, x, y, dir });
  const width = world.terrain.width;
  const reserved = reservedTiles(world);
  reserved.add(entrance.y * width + entrance.x);
  reserved.add(exit.y * width + exit.x);
  const rideId = world.nextRideId;
  const stations: string[] = ["station"];
  while (stations.length < MIN_STATION_PIECES) {
    const ctx: PieceContext = {
      rideId,
      family,
      start,
      pieces: stations,
      pose: endPose(start, stations),
      reserved,
    };
    const why = placementRefusal(world, ctx, pieceById("station") as TrackPiece);
    if (why !== null) return fail(why);
    stations.push("station");
  }
  const fit = fitPoints(
    world,
    { rideId, family, start, pieces: stations, laid: 0, reserved },
    points.slice(1),
    close,
  );
  const pieces = [...stations, ...fit.pieces];
  const plan: PointsPlan = {
    begin: { x, y, dir },
    pieces,
    points: [{ ok: true, reason: null, pieces: stations.length }, ...fit.points],
    close: fit.close,
    error: null,
    cost: pieces.reduce((sum, piece) => sum + pieceCost(family.id, piece), 0),
  };
  if (fit.ok && close) {
    const why = circuitRefusal(start, pieces);
    if (why !== null) plan.close = { ok: false, reason: why, pieces: plan.close?.pieces ?? 0 };
  }
  plan.error = fitError(plan);
  return plan;
}

/**
 * Plans extending coaster `id` from the end of its track through `points` (and, when `close`,
 * back to its station). Throws when there is no such coaster; refuses an open or complete one.
 */
export function planExtend(
  world: World,
  id: number,
  input: readonly FitPointInput[],
  close: boolean,
): PointsPlan {
  const found = coasterOf(world, id);
  if (typeof found === "string") throw new RangeError(found);
  const { ride, track } = found;
  const points = fitPointsOf(world, input);
  const refused = ride.open ? CLOSE_FIRST : track.complete ? ALREADY_COMPLETE : null;
  if (refused !== null) {
    const out: PointsPlan = {
      begin: null,
      pieces: [],
      points: points.map(() => ({ ok: false, reason: refused, pieces: 0 })),
      close: close ? { ok: false, reason: refused, pieces: 0 } : null,
      error: refused,
      cost: 0,
    };
    return out;
  }
  const fit = fitPoints(
    world,
    {
      rideId: id,
      family: familyOf(track),
      start: track.start,
      pieces: track.pieces,
      laid: track.pieces.length,
      reserved: reservedTiles(world),
    },
    points,
    close,
  );
  const plan: PointsPlan = {
    begin: null,
    pieces: fit.pieces,
    points: fit.points,
    close: fit.close,
    error: null,
    cost: fit.pieces.reduce((sum, piece) => sum + pieceCost(track.family, piece), 0),
  };
  if (fit.ok && close) {
    const why = circuitRefusal(track.start, [...track.pieces, ...fit.pieces]);
    if (why !== null) plan.close = { ok: false, reason: why, pieces: plan.close?.pieces ?? 0 };
  }
  plan.error = fitError(plan);
  return plan;
}

/**
 * Plans worked out by a command's `validate`, kept for its `cost` and `apply`: `executeCommand`
 * and `redoLast` call the three with the same parsed input object, one after another, on a world
 * nothing else touches in between, so fitting once serves all three. Keyed by that input object
 * and used again only on the same world with the same `worldStamp`, which every logged command,
 * undo and redo moves, and which these commands' own apply and revert move too (`rideVersion`),
 * so a kept plan is never used after the world has changed.
 */
const planMemo = new WeakMap<object, { world: World; stamp: string; plan: unknown }>();

function memoized<T>(world: World, input: object, make: () => T): T {
  const stamp = worldStamp(world);
  const kept = planMemo.get(input);
  if (kept !== undefined && kept.world === world && kept.stamp === stamp) return kept.plan as T;
  const plan = make();
  planMemo.set(input, { world, stamp, plan });
  return plan;
}

/**
 * Checks a fitted plan once more before it is built: `pieces`, laid one by one after `before`
 * (which is in the world's track index already, or empty for a new coaster) from `start`, each
 * taken by `placementRefusal` exactly as `coaster_begin` and `coaster_add_piece` would take it.
 * The fit only lays such pieces, so a refusal here is a bug in it: this throws rather than build
 * track the piece commands would refuse.
 */
export function assertPlanned(
  world: World,
  rideId: number,
  family: CoasterFamily,
  start: Pose,
  before: readonly string[],
  reserved: ReadonlySet<number>,
  pieces: readonly string[],
): void {
  const width = world.terrain.width;
  const pending = new Map<number, TrackBand[]>();
  const laid = [...before];
  let pose = endPose(start, before);
  const ctx: PieceContext = {
    rideId,
    family,
    start,
    pieces: laid,
    pose,
    reserved,
    extra: (tile) => pending.get(tile) ?? [],
  };
  for (const id of pieces) {
    const piece = pieceById(id);
    const why =
      piece === undefined
        ? `unknown piece ${id}`
        : placementRefusal(world, { ...ctx, pose }, piece);
    if (why !== null) {
      throw new Error(
        `Internal error: the fit planned piece ${laid.length} (${id}), refused: ${why}`,
      );
    }
    for (const t of pieceTiles(pose, id)) {
      const tile = t.y * width + t.x;
      const band: TrackBand = { rideId, piece: laid.length, zLo: t.zLo * STEP, zHi: t.zHi * STEP };
      const list = pending.get(tile);
      if (list === undefined) pending.set(tile, [band]);
      else list.push(band);
    }
    laid.push(id);
    pose = applyPiece(pose, id);
  }
}

const buildFromPointsSchema = z.object({
  family: z.string(),
  points: z.array(fitPointSchema).min(1).max(MAX_FIT_POINTS),
  close: z.boolean().optional(),
});
type BuildFromPointsInput = z.infer<typeof buildFromPointsSchema>;

function buildPlanFor(world: World, input: BuildFromPointsInput): PointsPlan | string {
  return memoized(world, input, () => {
    const family = familyFor(input.family);
    if (typeof family === "string") return family;
    return planFromPoints(world, family.id, input.points, input.close === true);
  });
}

export const coasterBuildFromPoints = defineCommand({
  name: "coaster_build_from_points",
  description: `Builds a whole coaster of a family (such as \`steel_coaster\`) through a list of points, in one undoable step. Each point is { x, y, height? }: a tile and a height in whole height steps (the tile's ground height when left out). points[0] is where the station goes: ${MIN_STATION_PIECES} station pieces on the ground there, facing toward points[1] along whichever axis it is farther on (east on a tie or with one point); its entrance and exit are beside the first station piece, as with \`coaster_begin\`. Track is then fitted through every later point in order: a point is reached when a piece passes over its tile with the height inside that piece's span there, preferring fewer and gentler pieces (straight before slopes, gentle before steep, large curves before small), never banking, and using lift pieces for every climb before the track's first drop. With \`close\` it then fits back onto the start of the station and completes the circuit, as \`coaster_complete\` would. Costs the sum of the pieces. All or nothing: if any point cannot be reached nothing is built, and the error names the first failing point (0-based) and why, such as "Point 2: Too steep to reach" (more height to climb or drop than the direct way to the point has room for: add a point to give a climb a longer way round), "Too tight a turn" (behind the track, nearer its line than a U-turn is wide, and no way round to it was found), the placement reason that blocked it, or "${TOO_LONG}" (fitting the whole course would take too long). A point the track already passes over adds no pieces. \`coaster_fit_preview\` shows the same fit without building it.`,
  category: "ride",
  input: buildFromPointsSchema,
  undoable: true,
  cost: (world, input: BuildFromPointsInput) => {
    const plan = buildPlanFor(world, input);
    return typeof plan === "string" ? 0 : plan.cost;
  },
  validate: (world, input: BuildFromPointsInput) => {
    const plan = buildPlanFor(world, input);
    return typeof plan === "string" ? plan : plan.error;
  },
  apply: (world, input: BuildFromPointsInput): { id: number } => {
    const plan = buildPlanFor(world, input);
    if (typeof plan === "string" || plan.begin === null || plan.error !== null) {
      throw new RangeError(typeof plan === "string" ? plan : (plan.error ?? "No station"));
    }
    const family = familyFor(input.family) as CoasterFamily;
    const { x, y, dir } = plan.begin;
    const { start, entrance, exit } = beginPlan(world, { family: family.id, x, y, dir });
    const reserved = reservedTiles(world);
    reserved.add(entrance.y * world.terrain.width + entrance.x);
    reserved.add(exit.y * world.terrain.width + exit.x);
    assertPlanned(world, world.nextRideId, family, start, [], reserved, plan.pieces);
    return { id: beginCoaster(world, family, x, y, dir, plan.pieces, input.close === true) };
  },
  revert: (world, _input, undo: { id: number }) => unbeginCoaster(world, undo.id),
});

const extendSchema = z.object({ id: z.int().min(1), point: fitPointSchema });
type ExtendInput = z.infer<typeof extendSchema>;

/** The pieces `coaster_extend_to` would add, or why it refuses. */
function extendPlan(world: World, input: ExtendInput): string[] | string {
  return memoized(world, input, () => {
    const found = coasterOf(world, input.id);
    if (typeof found === "string") return found;
    const plan = planExtend(world, input.id, [input.point], false);
    if (plan.error !== null) return plan.error;
    if (plan.pieces.length === 0) return ALREADY_REACHED;
    return plan.pieces;
  });
}

export const coasterExtendTo = defineCommand({
  name: "coaster_extend_to",
  description: `Extends a coaster's track, by its ride id, from where it ends to one point { x, y, height? } (a tile and a height in whole height steps, the ground's when left out), fitting pieces the way \`coaster_build_from_points\` does and adding them in one undoable step. Costs the sum of the pieces. It lays exactly what \`coaster_fit_preview\` with this id and this one point shows. Refused, with nothing built, when the point cannot be reached ("Point 0: Too steep to reach", "Point 0: Too tight a turn" or the placement reason that blocked it), when the track already passes over it with its last piece ("${ALREADY_REACHED}", which the preview reports as ok with that reason), or when the coaster is open or complete.`,
  category: "ride",
  input: extendSchema,
  undoable: true,
  cost: (world, input: ExtendInput) => {
    const plan = extendPlan(world, input);
    const track = findTrack(world, input.id);
    if (typeof plan === "string" || track === undefined) return 0;
    return plan.reduce((sum, piece) => sum + pieceCost(track.family, piece), 0);
  },
  validate: (world, input: ExtendInput) => {
    const plan = extendPlan(world, input);
    return typeof plan === "string" ? plan : null;
  },
  apply: (world, input: ExtendInput): { count: number } => {
    const plan = extendPlan(world, input);
    if (typeof plan === "string") throw new RangeError(plan);
    const { track } = coaster(world, input.id);
    assertPlanned(
      world,
      track.id,
      familyOf(track),
      track.start,
      track.pieces,
      reservedTiles(world),
      plan,
    );
    const index = trackIndex(world);
    let pose = endPose(track.start, track.pieces);
    for (const piece of plan) {
      indexAddPiece(index, input.id, track.pieces.length, pose, piece);
      track.pieces.push(piece);
      pose = applyPiece(pose, piece);
    }
    world.rideVersion++;
    return { count: plan.length };
  },
  revert: (world, input: ExtendInput, undo: { count: number }) => {
    const { track } = coaster(world, input.id);
    const index = trackIndex(world);
    for (let k = 0; k < undo.count; k++) {
      const piece = track.pieces.pop() as string;
      indexRemovePiece(
        index,
        input.id,
        track.pieces.length,
        endPose(track.start, track.pieces),
        piece,
      );
    }
    world.rideVersion++;
  },
});
