import { RIDE_TYPES } from "./rides.js";
import type { ContentType } from "./schema.js";
import { STALL_TYPES } from "./stalls.js";

export * from "./schema.js";
export * from "./rotate.js";
export * from "./fixed.js";
export { BANK_ROLL, TRACK_PIECES, bankRoll, pieceById, pitchAngle } from "./track-pieces.js";
export { COASTER_FAMILIES, familyById, familyRefusesPiece } from "./coasters.js";
export { RIDE_TYPES } from "./rides.js";
export { STALL_TYPES } from "./stalls.js";

export const ALL_TYPES: readonly ContentType[] = Object.freeze([...RIDE_TYPES, ...STALL_TYPES]);

/** Looks a content type up by id; undefined when there is no such type. */
export function typeById(id: string): ContentType | undefined {
  return ALL_TYPES.find((t) => t.id === id);
}
