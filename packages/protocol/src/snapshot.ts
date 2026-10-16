import { z } from "zod";
import { ProtocolError, SpeedSchema, type Speed } from "./messages.js";

/**
 * Binary snapshot frame, all integers little-endian:
 *
 *   bytes 0..3   magic "CWS1"
 *   bytes 4..7   uint32 length of the header, in bytes
 *   next         the header: UTF-8 JSON, a `SnapshotHeader`
 *   then, only when the header says `hasTerrain`:
 *     corners    int16 per corner, (width + 1) * (height + 1) of them
 *     surface    one byte per tile, width * height
 *     water      one byte per tile, width * height
 */
const MAGIC = [0x43, 0x57, 0x53, 0x31]; // "CWS1"
const PREFIX_BYTES = 8;

export interface SnapshotHeader {
  tick: number;
  speed: Speed;
  /** Integer cents. */
  cash: number;
  /** Integer cents. */
  loan: number;
  /** The game date, already formatted, such as `"March 1, Year 1"`. */
  date: string;
  /** Changes whenever the terrain may have; a client that holds this version holds the terrain. */
  terrainVersion: number;
  hasTerrain: boolean;
  width: number;
  height: number;
}

export interface SnapshotTerrain {
  corners: Int16Array;
  surface: Uint8Array;
  water: Uint8Array;
}

export interface DecodedSnapshot {
  header: SnapshotHeader;
  /** Present exactly when `header.hasTerrain` is true. */
  terrain?: SnapshotTerrain;
}

const SnapshotHeaderSchema = z.object({
  tick: z.number().int().nonnegative(),
  speed: SpeedSchema,
  cash: z.number().int(),
  loan: z.number().int(),
  date: z.string(),
  terrainVersion: z.number().int().nonnegative(),
  hasTerrain: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
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

/**
 * Builds a snapshot frame. `terrain` must be given exactly when `header.hasTerrain` is true, and
 * its arrays must match `header.width` by `header.height`; otherwise this throws `ProtocolError`.
 */
export function encodeSnapshot(header: SnapshotHeader, terrain?: SnapshotTerrain): Uint8Array {
  if (header.hasTerrain !== (terrain !== undefined)) {
    throw new ProtocolError("Snapshot terrain must be given exactly when hasTerrain is true");
  }
  const json = utf8Encode(JSON.stringify(header));
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

  const terrainSize = terrain ? cornerCount * 2 + tiles * 2 : 0;
  const out = new Uint8Array(PREFIX_BYTES + json.length + terrainSize);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, json.length, true);
  out.set(json, PREFIX_BYTES);

  if (terrain) {
    let at = PREFIX_BYTES + json.length;
    for (let i = 0; i < terrain.corners.length; i++, at += 2) {
      view.setInt16(at, terrain.corners[i] as number, true);
    }
    out.set(terrain.surface, at);
    out.set(terrain.water, at + tiles);
  }
  return out;
}

/** Reads a snapshot frame. Throws `ProtocolError` if it is not one, or is cut short or too long. */
export function decodeSnapshot(bytes: Uint8Array): DecodedSnapshot {
  if (bytes.length < PREFIX_BYTES) throw new ProtocolError("Snapshot is too short");
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new ProtocolError("Not a snapshot: bad magic bytes");
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

  const { corners: cornerCount, tiles } = terrainBytes(header.width, header.height);
  const expected = headerEnd + (header.hasTerrain ? cornerCount * 2 + tiles * 2 : 0);
  if (bytes.length !== expected) {
    throw new ProtocolError(`Snapshot length mismatch: expected ${expected}, got ${bytes.length}`);
  }
  if (!header.hasTerrain) return { header };

  const corners = new Int16Array(cornerCount);
  let at = headerEnd;
  for (let i = 0; i < cornerCount; i++, at += 2) corners[i] = view.getInt16(at, true);
  const surface = bytes.slice(at, at + tiles);
  const water = bytes.slice(at + tiles, at + tiles * 2);
  return { header, terrain: { corners, surface, water } };
}
