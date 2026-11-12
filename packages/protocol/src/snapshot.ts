import { z } from "zod";
import { ProtocolError, SpeedSchema, type Speed } from "./messages.js";

/**
 * Binary snapshot frame, version 2, all integers little-endian:
 *
 *   bytes 0..3   magic "CWS2"
 *   bytes 4..7   uint32 length of the header, in bytes
 *   next         the header: UTF-8 JSON, a `SnapshotHeader`
 *   then, only when the header says `hasTerrain`:
 *     corners    int16 per corner, (width + 1) * (height + 1) of them
 *     surface    one byte per tile, width * height
 *     water      one byte per tile, width * height
 *   then, only when the header says `hasPaths`:
 *     paths      one byte per tile, width * height
 *   then, always, the guests: `guestCount` of each, one array after another
 *     id         int32 per guest
 *     x          int32 per guest, in 1/32 of a tile
 *     y          int32 per guest, in 1/32 of a tile
 *     state      one byte per guest
 *     color      one byte per guest
 *     happiness  one byte per guest
 *
 * A v1 frame (magic "CWS1") has no guests or paths and is refused.
 */
const MAGIC = [0x43, 0x57, 0x53, 0x32]; // "CWS2"
const PREFIX_BYTES = 8;
/** Bytes one guest takes across the six guest arrays: three int32s and three bytes. */
const GUEST_BYTES = 3 * 4 + 3;

const EdgeSideSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

/** The park as every client sees it: what the sim keeps in `World.park` that a screen needs. */
export const ParkPublicSchema = z.object({
  name: z.string(),
  open: z.boolean(),
  /** Integer cents. */
  entryFee: z.number().int().nonnegative(),
  /** The entrance tile and the map edge it faces (0 north, 1 east, 2 south, 3 west), or null. */
  entrance: z.object({ x: z.number().int(), y: z.number().int(), side: EdgeSideSchema }).nullable(),
  /** 0 to 999. */
  rating: z.number().int().nonnegative(),
  guestsInPark: z.number().int().nonnegative(),
  totalAdmissions: z.number().int().nonnegative(),
});
export type ParkPublic = z.infer<typeof ParkPublicSchema>;

export interface SnapshotHeader {
  tick: number;
  speed: Speed;
  /** True while the host has the sim stopped after a fault; a `speed` above 0 resumes it. */
  halted: boolean;
  /** Integer cents. */
  cash: number;
  /** Integer cents. */
  loan: number;
  /** Integer cents: the cash when the month began, so `cash - monthStartCash` is the month's change. */
  monthStartCash: number;
  /** The game date, already formatted, such as `"March 1, Year 1"`. */
  date: string;
  /** Changes whenever the terrain may have; a client that holds this version holds the terrain. */
  terrainVersion: number;
  hasTerrain: boolean;
  /** Changes whenever the path layer or the entrance may have; see `terrainVersion`. */
  pathVersion: number;
  hasPaths: boolean;
  /** How many guests the guest section holds. */
  guestCount: number;
  width: number;
  height: number;
  park: ParkPublic;
}

export interface SnapshotTerrain {
  corners: Int16Array;
  surface: Uint8Array;
  water: Uint8Array;
}

/**
 * The guests in a snapshot as parallel arrays, one entry per guest in the same order. Every array
 * is `count` long. Positions are in 1/32 of a tile, as in the sim: the tile a guest is on is
 * `x >> 5` by `y >> 5`.
 */
export interface GuestSection {
  count: number;
  id: Int32Array;
  x: Int32Array;
  y: Int32Array;
  /** The sim's `GuestState`. */
  state: Uint8Array;
  /** Index into the renderer's palette, 0 to 8. */
  color: Uint8Array;
  happiness: Uint8Array;
}

/** What goes into a snapshot frame besides its header. */
export interface SnapshotParts {
  /** Given exactly when `header.hasTerrain` is true. */
  terrain?: SnapshotTerrain;
  /** Given exactly when `header.hasPaths` is true: one byte per tile, `width * height`. */
  paths?: Uint8Array;
  guests: GuestSection;
}

export interface DecodedSnapshot {
  header: SnapshotHeader;
  /** Present exactly when `header.hasTerrain` is true. */
  terrain?: SnapshotTerrain;
  /** Present exactly when `header.hasPaths` is true. */
  paths?: Uint8Array;
  /** Always present; `header.guestCount` long, and empty when there are no guests. */
  guests: GuestSection;
}

const SnapshotHeaderSchema = z.object({
  tick: z.number().int().nonnegative(),
  speed: SpeedSchema,
  halted: z.boolean(),
  cash: z.number().int(),
  loan: z.number().int(),
  monthStartCash: z.number().int(),
  date: z.string(),
  terrainVersion: z.number().int().nonnegative(),
  hasTerrain: z.boolean(),
  pathVersion: z.number().int().nonnegative(),
  hasPaths: z.boolean(),
  guestCount: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  park: ParkPublicSchema,
});

/**
 * Encodes a string as UTF-8, matching what `TextEncoder` produces (lone surrogates become
 * U+FFFD). Written by hand because `src` is compiled without Node or DOM globals.
 */
function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let codePoint = text.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** Decodes UTF-8, throwing `ProtocolError` on a malformed or overlong sequence. */
function utf8Decode(bytes: Uint8Array): string {
  const bad = () => new ProtocolError("Snapshot header is not valid UTF-8");
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i] as number;
    let extra: number;
    let codePoint: number;
    let min: number;
    if (lead < 0x80) {
      extra = 0;
      codePoint = lead;
      min = 0;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      extra = 1;
      codePoint = lead & 0x1f;
      min = 0x80;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      extra = 2;
      codePoint = lead & 0x0f;
      min = 0x800;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      extra = 3;
      codePoint = lead & 0x07;
      min = 0x10000;
    } else {
      throw bad();
    }
    if (i + extra >= bytes.length) throw bad();
    for (let k = 1; k <= extra; k++) {
      const next = bytes[i + k] as number;
      if ((next & 0xc0) !== 0x80) throw bad();
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint < min || codePoint > 0x10ffff) throw bad();
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw bad();
    out += String.fromCodePoint(codePoint);
    i += extra + 1;
  }
  return out;
}

function terrainBytes(width: number, height: number): { corners: number; tiles: number } {
  return { corners: (width + 1) * (height + 1), tiles: width * height };
}

/** Writes `values` as little-endian int32s at `at`, and returns where the next section begins. */
function writeInt32s(view: DataView, at: number, values: Int32Array): number {
  for (let i = 0; i < values.length; i++, at += 4) view.setInt32(at, values[i] as number, true);
  return at;
}

function readInt32s(view: DataView, at: number, count: number): Int32Array {
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++, at += 4) out[i] = view.getInt32(at, true);
  return out;
}

/**
 * Builds a snapshot frame. `parts.terrain` must be given exactly when `header.hasTerrain` is true,
 * `parts.paths` exactly when `header.hasPaths` is, and every array must match the header's size
 * (`width` by `height` for the map, `guestCount` for the guests); otherwise this throws
 * `ProtocolError`.
 */
export function encodeSnapshot(header: SnapshotHeader, parts: SnapshotParts): Uint8Array {
  const { terrain, paths, guests } = parts;
  if (header.hasTerrain !== (terrain !== undefined)) {
    throw new ProtocolError("Snapshot terrain must be given exactly when hasTerrain is true");
  }
  if (header.hasPaths !== (paths !== undefined)) {
    throw new ProtocolError("Snapshot paths must be given exactly when hasPaths is true");
  }
  const { corners: cornerCount, tiles } = terrainBytes(header.width, header.height);
  if (terrain) {
    if (
      terrain.corners.length !== cornerCount ||
      terrain.surface.length !== tiles ||
      terrain.water.length !== tiles
    ) {
      throw new ProtocolError("Snapshot terrain does not match the header's width and height");
    }
  }
  if (paths && paths.length !== tiles) {
    throw new ProtocolError("Snapshot paths do not match the header's width and height");
  }
  const count = header.guestCount;
  if (
    guests.count !== count ||
    guests.id.length !== count ||
    guests.x.length !== count ||
    guests.y.length !== count ||
    guests.state.length !== count ||
    guests.color.length !== count ||
    guests.happiness.length !== count
  ) {
    throw new ProtocolError("Snapshot guests do not match the header's guestCount");
  }

  const json = utf8Encode(JSON.stringify(header));
  const terrainSize = terrain ? cornerCount * 2 + tiles * 2 : 0;
  const pathsSize = paths ? tiles : 0;
  const out = new Uint8Array(
    PREFIX_BYTES + json.length + terrainSize + pathsSize + count * GUEST_BYTES,
  );
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, json.length, true);
  out.set(json, PREFIX_BYTES);

  let at = PREFIX_BYTES + json.length;
  if (terrain) {
    for (let i = 0; i < terrain.corners.length; i++, at += 2) {
      view.setInt16(at, terrain.corners[i] as number, true);
    }
    out.set(terrain.surface, at);
    out.set(terrain.water, at + tiles);
    at += tiles * 2;
  }
  if (paths) {
    out.set(paths, at);
    at += tiles;
  }
  at = writeInt32s(view, at, guests.id);
  at = writeInt32s(view, at, guests.x);
  at = writeInt32s(view, at, guests.y);
  out.set(guests.state, at);
  out.set(guests.color, at + count);
  out.set(guests.happiness, at + count * 2);
  return out;
}

/**
 * Reads a snapshot frame. Throws `ProtocolError` if it is not one, is a version this code does
 * not read, or is cut short or too long for what its header says it holds.
 */
export function decodeSnapshot(bytes: Uint8Array): DecodedSnapshot {
  if (bytes.length < PREFIX_BYTES) throw new ProtocolError("Snapshot is too short");
  for (let i = 0; i < MAGIC.length - 1; i++) {
    if (bytes[i] !== MAGIC[i]) throw new ProtocolError("Not a snapshot: bad magic bytes");
  }
  const version = bytes[MAGIC.length - 1] as number;
  if (version !== MAGIC[MAGIC.length - 1]) {
    // "CWS" and a digit is a snapshot of another version, such as the v1 a stale host sends.
    throw new ProtocolError(
      version >= 0x30 && version <= 0x39
        ? "Unsupported snapshot version"
        : "Not a snapshot: bad magic bytes",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4, true);
  const headerEnd = PREFIX_BYTES + headerLength;
  if (headerEnd > bytes.length) throw new ProtocolError("Snapshot header is cut short");

  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(bytes.subarray(PREFIX_BYTES, headerEnd)));
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("Snapshot header is not valid JSON");
  }
  const parsed = SnapshotHeaderSchema.safeParse(raw);
  if (!parsed.success) throw new ProtocolError("Snapshot header is invalid");
  const header = parsed.data;

  // Every section's size comes from the header, and the whole frame must be exactly that long.
  // Nothing is allocated before this, so a header that lies cannot make the decoder allocate.
  const { corners: cornerCount, tiles } = terrainBytes(header.width, header.height);
  const count = header.guestCount;
  const expected =
    headerEnd +
    (header.hasTerrain ? cornerCount * 2 + tiles * 2 : 0) +
    (header.hasPaths ? tiles : 0) +
    count * GUEST_BYTES;
  if (bytes.length !== expected) {
    throw new ProtocolError(`Snapshot length mismatch: expected ${expected}, got ${bytes.length}`);
  }

  // Bytes are copied out, never viewed: `slice` would not copy on a Node `Buffer`.
  let at = headerEnd;
  let terrain: SnapshotTerrain | undefined;
  if (header.hasTerrain) {
    const corners = new Int16Array(cornerCount);
    for (let i = 0; i < cornerCount; i++, at += 2) corners[i] = view.getInt16(at, true);
    const surface = new Uint8Array(bytes.subarray(at, at + tiles));
    const water = new Uint8Array(bytes.subarray(at + tiles, at + tiles * 2));
    at += tiles * 2;
    terrain = { corners, surface, water };
  }
  let paths: Uint8Array | undefined;
  if (header.hasPaths) {
    paths = new Uint8Array(bytes.subarray(at, at + tiles));
    at += tiles;
  }
  const guests: GuestSection = {
    count,
    id: readInt32s(view, at, count),
    x: readInt32s(view, at + count * 4, count),
    y: readInt32s(view, at + count * 8, count),
    state: new Uint8Array(bytes.subarray(at + count * 12, at + count * 13)),
    color: new Uint8Array(bytes.subarray(at + count * 13, at + count * 14)),
    happiness: new Uint8Array(bytes.subarray(at + count * 14, at + count * 15)),
  };
  const decoded: DecodedSnapshot = { header, guests };
  if (terrain) decoded.terrain = terrain;
  if (paths) decoded.paths = paths;
  return decoded;
}
