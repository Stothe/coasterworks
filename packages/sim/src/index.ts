export const VERSION = "0.0.0";

export { defineCommand, defineQuery, runQuery } from "./commands/define.js";
export type {
  CatalogEntry,
  Category,
  CommandDef,
  QueryDef,
  QueryResult,
} from "./commands/define.js";
export { executeCommand } from "./commands/execute.js";
export type { ExecResult } from "./commands/execute.js";
export { Registry } from "./commands/registry.js";
export { ENTRANCE_COST } from "./commands/park.js";
export { MAX_PATH_TILES, PATH_COST } from "./commands/path.js";
export { MAX_ADVANCE_DAYS } from "./commands/sim.js";
export { redoLast, undoLast } from "./commands/undo.js";
export { LOST_GIVE_UP } from "./guests/behavior.js";
export { guestName } from "./guests/names.js";
export { THOUGHT, THOUGHTS, thoughtText } from "./guests/thoughts.js";
export type { Mood, Thought } from "./guests/thoughts.js";
export { GUEST_CAP, GuestState } from "./guests/types.js";
export type { GuestStore, Waypoints } from "./guests/types.js";
export { fnv1a64, hashString, hexHash } from "./hash.js";
export {
  DEFAULT_ENTRY_FEE,
  DEFAULT_RATING,
  MAX_ENTRY_FEE,
  MAX_RATING,
  createParkState,
} from "./park/types.js";
export type { EdgeSide, Entrance, MonthRecord, ParkState } from "./park/types.js";
export {
  MAX_PATH_SLOPE,
  PATH_FOOT,
  PATH_NONE,
  PATH_QUEUE,
  canBuildPath,
  edgeSide,
  isEdgeTile,
  neighborsOnPath,
  pathAt,
} from "./paths/paths.js";
export { RouteCache, UNREACHABLE } from "./paths/routing.js";
export { QUEUE_PER_TILE, queueCapacity, queueInfo, queueSlotTile } from "./rides/queue.js";
export type { QueueInfo } from "./rides/queue.js";
export { canPlaceRide } from "./rides/rides.js";
export { MAX_RIDE_ID, MAX_RIDE_NAME, MAX_RIDE_PRICE, RIDE_CAP, RidePhase } from "./rides/types.js";
export type { RideRecord, RideStats, Tile } from "./rides/types.js";
export { createDefaultRegistry } from "./registry-default.js";
export { Rng } from "./rng.js";
export type { RngState } from "./rng.js";
export { deserializeWorld, serializeWorld } from "./save/codec.js";
export { SaveError } from "./save/error.js";
export { MIGRATIONS, migrate } from "./save/migrate.js";
export type { Migration } from "./save/migrate.js";
export { SAMPLE_SIZE, createSamplePark } from "./sample-park.js";
export { Sim } from "./sim.js";
export {
  SEG_BRAKE,
  SEG_LIFT,
  SEG_STATION,
  applyPiece,
  circuitCloses,
  endPose,
  localToWorld,
  pieceRefusal,
  pieceTiles,
  poseAtTile,
  posesEqual,
  samplePiece,
  sampleTrack,
} from "./track/pose.js";
export type { Dir, PieceTile, Pose, Segment } from "./track/pose.js";
export {
  MAX_STATION_PIECES,
  MIN_STATION_PIECES,
  PATH_CLEARANCE,
  TRACK_CLEARANCE,
  buildTrackIndex,
  trackIndex,
} from "./track/occupancy.js";
export type { TrackBand, TrackIndex } from "./track/occupancy.js";
export { MAX_TRACK_PIECES } from "./track/record.js";
export {
  ALREADY_REACHED,
  FIX_EARLIER,
  MAX_EXPANSIONS,
  MAX_FIT_EXPANSIONS,
  NO_FIT,
  TOO_LONG,
  TOO_STEEP,
  TOO_TIGHT,
  fitPoints,
  pieceWeight,
} from "./track/fit.js";
export type { FitLimits, FitPoint, FitResult, FitStart, FitWork, PointFit } from "./track/fit.js";
export type { TestProgress, TrackRecord, TrackStats, TrainState } from "./track/record.js";
export {
  FINE,
  TrainMode,
  buildLine,
  frontOf,
  pointAt,
  trainForces,
  trainSpec,
} from "./track/physics.js";
export type { Forces, Line, LinePoint, TrainSpec } from "./track/physics.js";
export { RUN_TOO_LONG, TRAIN_STALLED, coasterSystem } from "./systems/coasters.js";
export { LOAN_MAX, financeSystem } from "./systems/finance.js";
export { guestSystem } from "./systems/guests.js";
export { rideSystem } from "./systems/rides.js";
export type { System } from "./systems/types.js";
export {
  cornerIndex,
  forEachCornerInRect,
  getCorner,
  inBounds,
  setCorner,
  tileBase,
  tileCorners,
  tileIndex,
} from "./terrain/terrain.js";
export {
  DAYS_PER_MONTH,
  MONTHS_PER_YEAR,
  MONTH_NAMES,
  TICKS_PER_DAY,
  TICKS_PER_SECOND,
  dateOf,
  formatDate,
  isMonthStart,
} from "./time.js";
export type { GameDate } from "./time.js";
export { createWorld } from "./world/create.js";
export type { CreateWorldOptions } from "./world/create.js";
export { hashWorld } from "./world/hash.js";
export { MAX_HEIGHT, MAX_MAP, SCHEMA_VERSION } from "./world/types.js";
export type {
  ClientKind,
  Finance,
  LogEntry,
  Rect,
  Surface,
  Terrain,
  World,
} from "./world/types.js";
