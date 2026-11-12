import { deepFreeze } from "./freeze.js";
import { iatan2, STEP, TILE } from "./fixed.js";
import {
  LARGE_CURVE_RADIUS,
  SMALL_CURVE_RADIUS,
  TrackPieceSchema,
  pitchRise,
  type PieceKind,
  type TrackPiece,
} from "./schema.js";

// The coaster piece table. Every piece starts at the centre of a tile edge at a whole height
// step, facing one of the four directions, and ends the same way, so pieces join exactly.
// Coordinates are in the piece's own frame (see `schema.ts`): `forward` and `right` in 1/1024
// tile, `dz` in height steps, `dDir` in quarter turns (+1 right).
//
// Pitch: gentle climbs 2 steps (half a tile, about 27 degrees) per tile and steep 4 steps (one
// tile, 45 degrees). Those rises keep every one-tile transition on a whole step (flat to gentle
// climbs 1, gentle to steep 3) and give lift hills and drops a sensible look. Curves and banks
// are flat; slopes are unbanked. Inside a piece pitch and roll ease in and out (smoothstep), so
// the centre line is smooth; `samples` and `length` describe the sim's sampling of it (see
// `packages/sim/src/track/pose.ts`), and the tests hold the two together.

/** Roll angle of each bank level -2..2, in 1/4096 turn (about 30 and 60 degrees). */
export const BANK_ROLL: readonly number[] = Object.freeze([-683, -341, 0, 341, 683]);

/** Roll angle of bank `level` (-2..2), right side down positive, in 1/4096 turn. */
export function bankRoll(level: number): number {
  const roll = BANK_ROLL[level + 2];
  if (roll === undefined) throw new RangeError(`Bank level must be -2..2, got ${level}`);
  return roll;
}

/** Pitch angle of pitch `level` (-2..2), up positive, in 1/4096 turn. */
export function pitchAngle(level: number): number {
  return iatan2(pitchRise(level) * STEP, TILE);
}

const NO_FLAGS = { station: false, lift: false, brake: false };

type Lengths = { samples: number; length: number };

/** Samples and chord length of a one-tile straight from rise `a` to rise `b` (steps per tile). */
function straightSampling(a: number, b: number): Lengths {
  const key = `${Math.min(Math.abs(a), Math.abs(b))}:${Math.max(Math.abs(a), Math.abs(b))}`;
  const table: Record<string, Lengths> = {
    "0:0": { samples: 8, length: 1024 },
    "0:2": { samples: 8, length: 1066 },
    "2:2": { samples: 9, length: 1141 },
    "2:4": { samples: 10, length: 1283 },
    "4:4": { samples: 11, length: 1442 },
  };
  const found = table[key];
  if (!found) throw new Error(`No sampling for rises ${a} to ${b}`);
  return found;
}

function straight(
  id: string,
  name: string,
  kind: PieceKind,
  from: { pitch: number; bank: number },
  to: { pitch: number; bank: number },
  flags: Partial<TrackPiece["flags"]> = {},
): TrackPiece {
  const r0 = pitchRise(from.pitch);
  const r1 = pitchRise(to.pitch);
  const dz = (r0 + r1) / 2;
  return {
    id,
    name,
    kind,
    entry: { pitch: from.pitch, bank: from.bank },
    exit: { forward: TILE, right: 0, dz, dDir: 0, pitch: to.pitch, bank: to.bank },
    shape: "straight",
    flags: { ...NO_FLAGS, ...flags },
    ...straightSampling(r0, r1),
    tiles: [{ f: 0, r: 0, zLo: Math.min(0, dz), zHi: Math.max(0, dz) }],
  };
}

function curve(
  id: string,
  name: string,
  size: "small" | "large",
  turn: 1 | -1,
  bank: number,
): TrackPiece {
  const radius = size === "small" ? SMALL_CURVE_RADIUS : LARGE_CURVE_RADIUS;
  const span = size === "small" ? 2 : 3;
  const tiles: TrackPiece["tiles"] = [];
  for (let f = 0; f < span; f++) {
    for (let r = 0; r < span; r++) {
      // The large curve leaves out the inner and outer corners, which it does not come near.
      if (size === "large" && ((f === 0 && r === 2) || (f === 2 && r === 0))) continue;
      tiles.push({ f, r: r * turn, zLo: 0, zHi: 0 });
    }
  }
  return {
    id,
    name,
    kind: size === "small" ? "curve_small" : "curve_large",
    entry: { pitch: 0, bank },
    exit: { forward: radius, right: radius * turn, dz: 0, dDir: turn, pitch: 0, bank },
    shape: "arc",
    flags: { ...NO_FLAGS },
    ...(size === "small" ? { samples: 19, length: 2405 } : { samples: 31, length: 4008 }),
    tiles,
  };
}

const flat = { pitch: 0, bank: 0 };
const at = (pitch: number) => ({ pitch, bank: 0 });
const banked = (bank: number) => ({ pitch: 0, bank });

const pieces: TrackPiece[] = [
  straight("station", "Station", "station", flat, flat, { station: true }),
  straight("straight", "Straight", "straight", flat, flat),
  straight("brakes", "Brakes", "brake", flat, flat, { brake: true }),

  curve("left_small_curve", "Left small curve", "small", -1, 0),
  curve("right_small_curve", "Right small curve", "small", 1, 0),
  curve("left_large_curve", "Left large curve", "large", -1, 0),
  curve("right_large_curve", "Right large curve", "large", 1, 0),
];

// Slopes up, each with a lift-chain twin, and slopes down.
const ups: [string, string, number, number][] = [
  ["flat_to_gentle_up", "Flat to gentle up", 0, 1],
  ["gentle_up", "Gentle up", 1, 1],
  ["gentle_up_to_flat", "Gentle up to flat", 1, 0],
  ["gentle_to_steep_up", "Gentle to steep up", 1, 2],
  ["steep_up", "Steep up", 2, 2],
  ["steep_to_gentle_up", "Steep to gentle up", 2, 1],
];
for (const [id, name, a, b] of ups) pieces.push(straight(id, name, "slope", at(a), at(b)));
for (const [id, name, a, b] of ups) {
  pieces.push(straight(`${id}_lift`, `${name} (lift)`, "lift", at(a), at(b), { lift: true }));
}
const downs: [string, string, number, number][] = [
  ["flat_to_gentle_down", "Flat to gentle down", 0, -1],
  ["gentle_down", "Gentle down", -1, -1],
  ["gentle_down_to_flat", "Gentle down to flat", -1, 0],
  ["gentle_to_steep_down", "Gentle to steep down", -1, -2],
  ["steep_down", "Steep down", -2, -2],
  ["steep_to_gentle_down", "Steep to gentle down", -2, -1],
];
for (const [id, name, a, b] of downs) pieces.push(straight(id, name, "slope", at(a), at(b)));

// Bank transitions on a flat straight, and banked curves.
for (const [side, sign] of [
  ["left", -1],
  ["right", 1],
] as const) {
  const Side = side === "left" ? "Left" : "Right";
  pieces.push(
    straight(`bank_${side}_in`, `Bank ${side}`, "bank", flat, banked(sign)),
    straight(`bank_${side}_out`, `Unbank from ${side}`, "bank", banked(sign), flat),
    straight(
      `bank_${side}_steepen`,
      `Steepen ${side} bank`,
      "bank",
      banked(sign),
      banked(2 * sign),
    ),
    straight(`bank_${side}_ease`, `Ease ${side} bank`, "bank", banked(2 * sign), banked(sign)),
    curve(`${side}_small_curve_banked`, `${Side} small banked curve`, "small", sign, sign),
    curve(`${side}_large_curve_banked`, `${Side} large banked curve`, "large", sign, sign),
    curve(
      `${side}_small_curve_steep_banked`,
      `${Side} small steep-banked curve`,
      "small",
      sign,
      2 * sign,
    ),
    curve(
      `${side}_large_curve_steep_banked`,
      `${Side} large steep-banked curve`,
      "large",
      sign,
      2 * sign,
    ),
  );
}

export const TRACK_PIECES: readonly TrackPiece[] = Object.freeze(
  pieces.map((p) => deepFreeze(TrackPieceSchema.parse(p))),
);

const byId = new Map(TRACK_PIECES.map((p) => [p.id, p]));

/** Looks a track piece up by id; undefined when there is no such piece. */
export function pieceById(id: string): TrackPiece | undefined {
  return byId.get(id);
}
