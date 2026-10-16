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
export { redoLast, undoLast } from "./commands/undo.js";
export { fnv1a64, hashString, hexHash } from "./hash.js";
export { createDefaultRegistry } from "./registry-default.js";
export { Rng } from "./rng.js";
export type { RngState } from "./rng.js";
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
