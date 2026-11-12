import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { z } from "zod";
import { createGuestStore } from "../guests/guests.js";
import { GUEST_ARRAYS, GUEST_CAP, type GuestArray, type GuestStore } from "../guests/types.js";
import { copyParkState } from "../park/types.js";
import { copyRide, type RideRecord } from "../rides/types.js";
import { Rng } from "../rng.js";
import type { Dir } from "../track/pose.js";
import { copyTrack, type TrackRecord } from "../track/record.js";
import { hashWorld } from "../world/hash.js";
import { MAX_MAP, SCHEMA_VERSION, type LogEntry, type World } from "../world/types.js";
import { fromBase64, toBase64 } from "./base64.js";
import { crc32 } from "./crc32.js";
import { CORRUPT_MESSAGE, SaveError } from "./error.js";
import { validateWorldInvariants } from "./invariants.js";
import { migrate, schemaVersionOf } from "./migrate.js";

/*
 * Save format: gzip of one JSON document.
 *
 *   { schemaVersion, meta: { name, seed, created }, tick,
 *     terrain: { width, height, corners, surface, water, path, occupant },
 *     finance, park,
 *     guests: { count, nextGuestId, id, x, y, tx, ty, dest, state, happiness, energy, hunger,
 *               thirst, bathroom, nausea, cash, color, name, thought, thoughtTick, sinceAction,
 *               lostTicks, ride, intensityPref, lastRide, queueTicks },
 *     rides: [RideRecord...], tracks: [TrackRecord...], nextRideId,
 *     rng: [w0, w1, w2, w3], rngStreams: { guests: [w0, w1, w2, w3] },
 *     log, undoStack, redoStack, nextId, hash }
 *
 * Each array is `{ "$t": "Int16Array" | "Int32Array" | "Uint16Array" | "Uint8Array", "$b64":
 * "<base64>" }`, holding the array's values as little-endian bytes. `park` is plain JSON
 * (`ParkState`, no typed arrays; its `history` is an array of month records), and so is each
 * entry of `rides` (`RideRecord`, in id order) and of `tracks` (`TrackRecord`, one per coaster,
 * in ride id order; the runtime track index is rebuilt from them, never saved). The guest arrays
 * hold only the `count` live guests, in slot order, with the gaps squeezed out; loading puts them
 * in slots `0..count-1`. The sim packs the store the same way every tick, so a loaded park carries
 * on exactly as the saved one would have.
 * `fflate` does the gzip so the same code runs in Node and in browsers. Keys are written in a
 * fixed order and the gzip header carries no timestamp, so saving the same world twice gives the
 * same bytes.
 *
 * `hash` is `hashWorld` of the saved world and is the last key. Loading guards against damage in
 * three ways.
 *
 * 1. The gzip trailer. `gunzipSync` does not check it, so `deserializeWorld` reads it itself before
 *    it parses anything: the last eight bytes are the CRC32 of the unzipped bytes, then their
 *    length, both little-endian, and a mismatch is "Save file is corrupt". It depends on the file
 *    alone, so it holds for a save from any schema version.
 * 2. The hash. Once the world is rebuilt, `hashWorld` of it must equal `hash`, unless a migration
 *    ran. A migrated save's `hash` was computed by the build that wrote it, over the state it had
 *    then, so after a migration that changes state `hashWorld` covers (or a change to what
 *    `hashWorld` covers) it would disagree with a sound save. The trailer has already vouched for
 *    the bytes, and the schema and the invariants vouch for the shape; the next save writes a fresh
 *    `hash`. A current save someone edited by hand and zipped again passes the trailer but not the
 *    hash, so it gets the same message as damage. `hashWorld` leaves out `meta.created` and the
 *    contents of the log (only its length), so edits to those are not caught.
 * 3. The invariants in `validateWorldInvariants`: values in range, log ids in order, stack ids
 *    that name log entries. They are checked on every load, migrated or not.
 */

type TypedArrayName = "Int16Array" | "Int32Array" | "Uint16Array" | "Uint8Array";

interface EncodedArray {
  $t: TypedArrayName;
  $b64: string;
}

function encodeInt16(array: Int16Array): EncodedArray {
  const bytes = new Uint8Array(array.length * 2);
  for (let i = 0; i < array.length; i++) {
    const value = array[i] as number;
    bytes[2 * i] = value & 0xff;
    bytes[2 * i + 1] = (value >> 8) & 0xff;
  }
  return { $t: "Int16Array", $b64: toBase64(bytes) };
}

function encodeUint8(array: Uint8Array): EncodedArray {
  return { $t: "Uint8Array", $b64: toBase64(array) };
}

function encodeUint16(array: Uint16Array): EncodedArray {
  const bytes = new Uint8Array(array.length * 2);
  for (let i = 0; i < array.length; i++) {
    const value = array[i] as number;
    bytes[2 * i] = value & 0xff;
    bytes[2 * i + 1] = (value >> 8) & 0xff;
  }
  return { $t: "Uint16Array", $b64: toBase64(bytes) };
}

function encodeInt32(array: Int32Array): EncodedArray {
  const bytes = new Uint8Array(array.length * 4);
  for (let i = 0; i < array.length; i++) {
    const value = array[i] as number;
    bytes[4 * i] = value & 0xff;
    bytes[4 * i + 1] = (value >> 8) & 0xff;
    bytes[4 * i + 2] = (value >> 16) & 0xff;
    bytes[4 * i + 3] = (value >> 24) & 0xff;
  }
  return { $t: "Int32Array", $b64: toBase64(bytes) };
}

/** Decodes to exactly `length` values or throws, so a short or long array is caught here. */
function decodeInt16(encoded: EncodedArray, length: number): Int16Array {
  const bytes = fromBase64(encoded.$b64);
  if (bytes.length !== length * 2) throw new SaveError(CORRUPT_MESSAGE);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    // Storing into an Int16Array wraps values above 0x7fff, which restores the sign.
    out[i] = ((bytes[2 * i + 1] as number) << 8) | (bytes[2 * i] as number);
  }
  return out;
}

function decodeUint8(encoded: EncodedArray, length: number): Uint8Array {
  const bytes = fromBase64(encoded.$b64);
  if (bytes.length !== length) throw new SaveError(CORRUPT_MESSAGE);
  return bytes;
}

function decodeUint16(encoded: EncodedArray, length: number): Uint16Array {
  const bytes = fromBase64(encoded.$b64);
  if (bytes.length !== length * 2) throw new SaveError(CORRUPT_MESSAGE);
  const out = new Uint16Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = ((bytes[2 * i + 1] as number) << 8) | (bytes[2 * i] as number);
  }
  return out;
}

function decodeInt32(encoded: EncodedArray, length: number): Int32Array {
  const bytes = fromBase64(encoded.$b64);
  if (bytes.length !== length * 4) throw new SaveError(CORRUPT_MESSAGE);
  const out = new Int32Array(length);
  for (let i = 0; i < length; i++) {
    // The shifts work on signed 32-bit values, which restores the sign.
    out[i] =
      ((bytes[4 * i + 3] as number) << 24) |
      ((bytes[4 * i + 2] as number) << 16) |
      ((bytes[4 * i + 1] as number) << 8) |
      (bytes[4 * i] as number);
  }
  return out;
}

/** Encodes `array[slot]` for each live slot in slot order, packing out the gaps. */
function encodeLiveGuests(g: GuestStore, array: GuestArray, kind: TypedArrayName): EncodedArray {
  const packed = new (array.constructor as new (length: number) => GuestArray)(g.count);
  let n = 0;
  for (let slot = 0; slot < GUEST_CAP; slot++) {
    if (g.live[slot] === 1) packed[n++] = array[slot] as number;
  }
  return kind === "Int32Array"
    ? encodeInt32(packed as Int32Array)
    : kind === "Uint16Array"
      ? encodeUint16(packed as Uint16Array)
      : encodeUint8(packed as Uint8Array);
}

/** Decodes the guest section into a store with the guests in slots `0..count-1`. */
function decodeGuests(doc: z.infer<typeof guestsSchema>): GuestStore {
  const g = createGuestStore();
  const { count } = doc;
  for (const [name, kind] of GUEST_ARRAYS) {
    const encoded = doc[name];
    if (kind === "Int32Array") g[name].set(decodeInt32(encoded, count));
    else if (kind === "Uint16Array") g[name].set(decodeUint16(encoded, count));
    else g[name].set(decodeUint8(encoded, count));
  }
  g.count = count;
  g.nextGuestId = doc.nextGuestId;
  g.live.fill(1, 0, count);
  g.freeCount = GUEST_CAP - count;
  for (let i = 0; i < g.freeCount; i++) g.free[i] = GUEST_CAP - 1 - i;
  return g;
}

const int = z.number().int();
const uint32 = int.min(0).max(0xffffffff);
const dimension = int.min(1).max(MAX_MAP);

const encodedArray = <T extends TypedArrayName>(tag: T) =>
  z.object({ $t: z.literal(tag), $b64: z.string() });

const logEntrySchema = z.object({
  id: int,
  tick: int.min(0),
  client: z.enum(["player", "agent", "replay", "system"]),
  name: z.string(),
  input: z.unknown().optional(),
  // Negative for the `undo` entry of a priced command, which records the refund.
  cost: int,
  undo: z.unknown().optional(),
  undoneBy: int.optional(),
});

const edgeSide = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const rngWords = z.tuple([uint32, uint32, uint32, uint32]);

// Ranges, the order of the ids, and agreement with the content types and the occupant layer are
// the invariants' business.
const tileSchema = z.object({ x: int, y: int }).nullable();
const rideSchema = z.object({
  id: int,
  type: z.string(),
  kind: z.enum(["ride", "stall", "coaster"]),
  x: int,
  y: int,
  rot: edgeSide,
  name: z.string(),
  open: z.boolean(),
  price: int,
  entrance: tileSchema,
  exit: tileSchema,
  service: tileSchema,
  phase: int,
  phaseTicks: int,
  riders: z.array(int),
  queue: z.array(int),
  stats: z.object({
    customers: int,
    income: int,
    runningCost: int,
    monthCustomers: int,
    monthIncome: int,
  }),
});

// Whether the pieces exist, fit together and fit the park is the invariants' business.
const trackSchema = z.object({
  id: int,
  family: z.string(),
  start: z.object({ x: int, y: int, z: int, dir: edgeSide, pitch: int, bank: int }),
  pieces: z.array(z.string()),
  complete: z.boolean(),
  tested: z.boolean(),
  stats: z.null(),
});

// Ranges (a fee of at most $100, a rating of at most 999, counters that are not negative, at most
// 12 months of history) are the invariants' business, so a bad value gets the same message from
// any source.
const parkSchema = z.object({
  name: z.string(),
  open: z.boolean(),
  entryFee: int,
  entrance: z.object({ x: int, y: int, side: edgeSide }).nullable(),
  rating: int,
  guestsInPark: int,
  totalAdmissions: int,
  income: z.object({ entry: int, rides: int, shops: int }),
  expenses: z.object({ running: int, wages: int }),
  monthly: z.object({ entry: int, rides: int, shops: int, running: int, wages: int }),
  history: z.array(
    z.object({
      year: int,
      month: int,
      entry: int,
      rides: int,
      shops: int,
      running: int,
      wages: int,
      net: int,
    }),
  ),
});

// Each array's length, and the values in it, are checked against `count` when it is decoded and by
// the invariants.
const int32s = encodedArray("Int32Array");
const uint8s = encodedArray("Uint8Array");
const guestsSchema = z.object({
  count: int.min(0).max(GUEST_CAP),
  nextGuestId: int.min(1),
  id: int32s,
  x: int32s,
  y: int32s,
  tx: int32s,
  ty: int32s,
  dest: int32s,
  state: uint8s,
  happiness: uint8s,
  energy: uint8s,
  hunger: uint8s,
  thirst: uint8s,
  bathroom: uint8s,
  nausea: uint8s,
  cash: int32s,
  color: uint8s,
  name: encodedArray("Uint16Array"),
  thought: uint8s,
  thoughtTick: int32s,
  sinceAction: int32s,
  lostTicks: int32s,
  ride: int32s,
  intensityPref: uint8s,
  lastRide: int32s,
  queueTicks: int32s,
});

const saveSchema = z.object({
  schemaVersion: int,
  meta: z.object({ name: z.string(), seed: int, created: z.string() }),
  tick: int.min(0),
  terrain: z.object({
    width: dimension,
    height: dimension,
    corners: encodedArray("Int16Array"),
    surface: encodedArray("Uint8Array"),
    water: encodedArray("Uint8Array"),
    path: encodedArray("Uint8Array"),
    occupant: encodedArray("Uint16Array"),
  }),
  finance: z.object({ cash: int, loan: int, monthStart: z.object({ cash: int }) }),
  park: parkSchema,
  guests: guestsSchema,
  rides: z.array(rideSchema),
  tracks: z.array(trackSchema),
  nextRideId: int,
  rng: rngWords,
  rngStreams: z.object({ guests: rngWords }),
  log: z.array(logEntrySchema),
  undoStack: z.array(int),
  redoStack: z.array(int),
  nextId: int.min(1),
  hash: z.string(),
});

/** Fixed key order, and no key at all for an absent `undo` or `undoneBy`. */
function encodeLogEntry(entry: LogEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: entry.id,
    tick: entry.tick,
    client: entry.client,
    name: entry.name,
    input: entry.input,
    cost: entry.cost,
  };
  if (entry.undo !== undefined) out.undo = entry.undo;
  if (entry.undoneBy !== undefined) out.undoneBy = entry.undoneBy;
  return out;
}

/** The guest section: the counters, then each array packed to the live guests, in save order. */
function encodeGuests(g: GuestStore): Record<string, unknown> {
  const out: Record<string, unknown> = { count: g.count, nextGuestId: g.nextGuestId };
  for (const [name, kind] of GUEST_ARRAYS) out[name] = encodeLiveGuests(g, g[name], kind);
  return out;
}

/**
 * Writes a world as a save: gzip of a JSON document, with typed arrays as base64 and the rngs as
 * their four-word states. The log is included with its undo data, so a loaded park can still undo.
 */
export function serializeWorld(world: World): Uint8Array {
  const { meta, terrain, finance } = world;
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    meta: { name: meta.name, seed: meta.seed, created: meta.created },
    tick: world.tick,
    terrain: {
      width: terrain.width,
      height: terrain.height,
      corners: encodeInt16(terrain.corners),
      surface: encodeUint8(terrain.surface),
      water: encodeUint8(terrain.water),
      path: encodeUint8(terrain.path),
      occupant: encodeUint16(terrain.occupant),
    },
    finance: {
      cash: finance.cash,
      loan: finance.loan,
      monthStart: { cash: finance.monthStart.cash },
    },
    park: copyParkState(world.park),
    guests: encodeGuests(world.guests),
    rides: world.rides.map(copyRide),
    tracks: world.tracks.map(copyTrack),
    nextRideId: world.nextRideId,
    rng: [...world.rng.state],
    rngStreams: { guests: [...world.rngStreams.guests.state] },
    log: world.log.map(encodeLogEntry),
    undoStack: world.undoStack,
    redoStack: world.redoStack,
    nextId: world.nextId,
    hash: hashWorld(world),
  };
  // `mtime: 0` leaves the clock out of the gzip header; otherwise fflate stamps the current time.
  return gzipSync(strToU8(JSON.stringify(doc)), { mtime: 0 });
}

/** The little-endian unsigned 32-bit integer at `offset`. */
function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

/**
 * Unzips a save and checks the gzip trailer, which `gunzipSync` ignores: the CRC32 and the length
 * of the unzipped bytes, in the last eight bytes of the file. Throws `SaveError` if the bytes are
 * not gzip or the trailer does not match what came out.
 */
function unzip(bytes: Uint8Array): Uint8Array {
  let payload: Uint8Array;
  try {
    payload = gunzipSync(bytes);
  } catch (error) {
    throw new SaveError(CORRUPT_MESSAGE, { cause: error });
  }
  // `gunzipSync` has refused anything too short to hold a header and a trailer.
  const trailer = bytes.length - 8;
  if (
    readUint32(bytes, trailer) !== crc32(payload) ||
    readUint32(bytes, trailer + 4) !== payload.length >>> 0
  ) {
    throw new SaveError(CORRUPT_MESSAGE);
  }
  return payload;
}

function parseDocument(bytes: Uint8Array): unknown {
  const payload = unzip(bytes);
  try {
    return JSON.parse(strFromU8(payload));
  } catch (error) {
    throw new SaveError(CORRUPT_MESSAGE, { cause: error });
  }
}

/**
 * Reads a save written by `serializeWorld`. Throws `SaveError` if the bytes are not a valid save
 * (including a gzip CRC32 or length that does not match), if it is from a newer schema than this
 * build reads, if an older schema cannot be migrated, if the rebuilt world breaks one of the
 * invariants in `validateWorldInvariants`, or if it does not match the hash stored in the save.
 * Older saves are run through `migrate` first, and for those the stored hash is not compared: it
 * describes the world as the older build saw it.
 */
export function deserializeWorld(bytes: Uint8Array): World {
  const raw = parseDocument(bytes);

  const version = schemaVersionOf(raw);
  if (version > SCHEMA_VERSION) {
    throw new SaveError(
      `Save is from a newer version (schema ${version}, this build reads ${SCHEMA_VERSION})`,
    );
  }

  const checked = saveSchema.safeParse(migrate(raw));
  if (!checked.success) {
    throw new SaveError(`Save file is invalid: ${z.prettifyError(checked.error)}`, {
      cause: checked.error,
    });
  }
  const doc = checked.data;

  const { width, height } = doc.terrain;
  const corners = decodeInt16(doc.terrain.corners, (width + 1) * (height + 1));
  const surface = decodeUint8(doc.terrain.surface, width * height);
  const water = decodeUint8(doc.terrain.water, width * height);
  const path = decodeUint8(doc.terrain.path, width * height);
  const occupant = decodeUint16(doc.terrain.occupant, width * height);

  let rng: Rng;
  let guestRng: Rng;
  try {
    rng = Rng.fromState(doc.rng);
    guestRng = Rng.fromState(doc.rngStreams.guests);
  } catch (error) {
    throw new SaveError(CORRUPT_MESSAGE, { cause: error });
  }
  const guests = decodeGuests(doc.guests);

  const log = doc.log.map((e): LogEntry => {
    const entry: LogEntry = {
      id: e.id,
      tick: e.tick,
      client: e.client,
      name: e.name,
      input: e.input,
      cost: e.cost,
    };
    if (e.undo !== undefined) entry.undo = e.undo;
    if (e.undoneBy !== undefined) entry.undoneBy = e.undoneBy;
    return entry;
  });

  const world: World = {
    meta: {
      schemaVersion: doc.schemaVersion,
      name: doc.meta.name,
      seed: doc.meta.seed,
      created: doc.meta.created,
    },
    tick: doc.tick,
    terrain: { width, height, corners, surface, water, path, occupant },
    finance: {
      cash: doc.finance.cash,
      loan: doc.finance.loan,
      monthStart: { cash: doc.finance.monthStart.cash },
    },
    park: copyParkState(doc.park),
    guests,
    rides: doc.rides.map((ride): RideRecord => copyRide(ride)),
    tracks: doc.tracks.map((track): TrackRecord =>
      copyTrack({ ...track, start: { ...track.start, dir: track.start.dir as Dir } }),
    ),
    nextRideId: doc.nextRideId,
    pathVersion: 0,
    rideVersion: 0,
    rng,
    rngStreams: { guests: guestRng },
    log,
    undoStack: doc.undoStack,
    redoStack: doc.redoStack,
    nextId: doc.nextId,
  };
  const problem = validateWorldInvariants(world);
  if (problem !== null) throw new SaveError(CORRUPT_MESSAGE, { cause: new Error(problem) });
  // The stored hash comes from the build that wrote the save; see the comment at the top.
  const migrated = version < SCHEMA_VERSION;
  if (!migrated && hashWorld(world) !== doc.hash) throw new SaveError(CORRUPT_MESSAGE);
  return world;
}
