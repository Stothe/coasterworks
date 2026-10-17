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
export { PATH_COST } from "./commands/path.js";
export { MAX_ADVANCE_DAYS } from "./commands/sim.js";
export { redoLast, undoLast } from "./commands/undo.js";
export { fnv1a64, hashString, hexHash } from "./hash.js";
export {
  DEFAULT_ENTRY_FEE,
  DEFAULT_RATING,
  MAX_ENTRY_FEE,
  MAX_RATING,
  createParkState,
} from "./park/types.js";
export type { EdgeSide, Entrance, ParkState } from "./park/types.js";
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
export { createDefaultRegistry } from "./registry-default.js";
export { Rng } from "./rng.js";
export type { RngState } from "./rng.js";
export { deserializeWorld, serializeWorld } from "./save/codec.js";
export { SaveError } from "./save/error.js";
export { MIGRATIONS, migrate } from "./save/migrate.js";
export type { Migration } from "./save/migrate.js";
export { SAMPLE_SIZE, createSamplePark } from "./sample-park.js";
export { Sim } from "./sim.js";
export { LOAN_MAX, financeSystem } from "./systems/finance.js";
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
