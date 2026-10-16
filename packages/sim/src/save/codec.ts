import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { z } from "zod";
import { Rng } from "../rng.js";
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
 *     terrain: { width, height, corners, surface, water },
 *     finance, rng: [w0, w1, w2, w3], log, undoStack, redoStack, nextId, hash }
 *
 * Each terrain array is `{ "$t": "Int16Array" | "Uint8Array", "$b64": "<base64>" }`, holding the
 * array's values as little-endian bytes. `fflate` does the gzip so the same code runs in Node and
 * in browsers. Keys are written in a fixed order and the gzip header carries no timestamp, so
 * saving the same world twice gives the same bytes.
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

type TypedArrayName = "Int16Array" | "Uint8Array";

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
  }),
  finance: z.object({ cash: int, loan: int, monthStart: z.object({ cash: int }) }),
  rng: z.tuple([uint32, uint32, uint32, uint32]),
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

/**
 * Writes a world as a save: gzip of a JSON document, with typed arrays as base64 and the rng as its
 * four-word state. The log is included with its undo data, so a loaded park can still undo.
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
    },
    finance: {
      cash: finance.cash,
      loan: finance.loan,
      monthStart: { cash: finance.monthStart.cash },
    },
    rng: [...world.rng.state],
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

  let rng: Rng;
  try {
    rng = Rng.fromState(doc.rng);
  } catch (error) {
    throw new SaveError(CORRUPT_MESSAGE, { cause: error });
  }

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
    terrain: { width, height, corners, surface, water },
    finance: {
      cash: doc.finance.cash,
      loan: doc.finance.loan,
      monthStart: { cash: doc.finance.monthStart.cash },
    },
    rng,
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
