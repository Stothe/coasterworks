export const VERSION = "0.0.0";

export { fnv1a64, hashString, hexHash } from "./hash.js";
export { Rng } from "./rng.js";
export type { RngState } from "./rng.js";
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
