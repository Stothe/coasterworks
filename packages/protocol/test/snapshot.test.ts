import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  decodeSnapshot,
  encodeSnapshot,
  type SnapshotHeader,
  type SnapshotTerrain,
} from "../src/index.js";

const WIDTH = 3;
const HEIGHT = 2;

function header(over: Partial<SnapshotHeader> = {}): SnapshotHeader {
  return {
    tick: 1234,
    speed: 4,
    halted: false,
    cash: 1_000_000,
    loan: 500_000,
    date: "March 4, Year 1",
    terrainVersion: 7,
    hasTerrain: true,
    width: WIDTH,
    height: HEIGHT,
    ...over,
  };
}

function terrain(): SnapshotTerrain {
  const corners = new Int16Array((WIDTH + 1) * (HEIGHT + 1));
  corners.forEach((_, i) => {
    corners[i] = i;
  });
  corners[0] = 63; // the highest a corner can be
  corners[5] = 0x0102;
  corners[6] = 0x7fff;
  const surface = Uint8Array.from([0, 1, 2, 3, 4, 0]);
  const water = Uint8Array.from([0, 0, 12, 0, 0, 12]);
  return { corners, surface, water };
}

/** A snapshot frame around the given header text, with no bytes after it. */
function frameWithHeader(json: string): Uint8Array {
  const body = Uint8Array.from(json, (char) => char.charCodeAt(0));
  const out = new Uint8Array(8 + body.length);
  out.set([0x43, 0x57, 0x53, 0x31]);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

describe("snapshot encoding", () => {
  it("round-trips the header and the terrain", () => {
    const original = terrain();
    const decoded = decodeSnapshot(encodeSnapshot(header(), original));
    expect(decoded.header).toEqual(header());
    expect(decoded.terrain?.corners).toEqual(original.corners);
    expect(decoded.terrain?.surface).toEqual(original.surface);
    expect(decoded.terrain?.water).toEqual(original.water);
    expect(decoded.terrain?.corners[0]).toBe(63);
    expect(decoded.terrain?.water[2]).toBe(12);
  });

  it("returns real typed arrays of the right sizes", () => {
    const decoded = decodeSnapshot(encodeSnapshot(header(), terrain()));
    expect(decoded.terrain?.corners).toBeInstanceOf(Int16Array);
    expect(decoded.terrain?.corners).toHaveLength((WIDTH + 1) * (HEIGHT + 1));
    expect(decoded.terrain?.surface).toBeInstanceOf(Uint8Array);
    expect(decoded.terrain?.surface).toHaveLength(WIDTH * HEIGHT);
    expect(decoded.terrain?.water).toHaveLength(WIDTH * HEIGHT);
  });

  it("writes the layout the format promises, little-endian", () => {
    const bytes = encodeSnapshot(header(), terrain());
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x43, 0x57, 0x53, 0x31]);
    const headerLength = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
    expect(JSON.parse(String.fromCharCode(...bytes.subarray(8, 8 + headerLength)))).toEqual(
      header(),
    );
    const corners = 8 + headerLength;
    expect(bytes.length).toBe(corners + 2 * 12 + 6 + 6);
    // Corner 0 is 63, corner 5 is 0x0102: low byte first.
    expect(Array.from(bytes.subarray(corners, corners + 2))).toEqual([63, 0]);
    expect(Array.from(bytes.subarray(corners + 10, corners + 12))).toEqual([0x02, 0x01]);
    expect(Array.from(bytes.subarray(corners + 12, corners + 14))).toEqual([0xff, 0x7f]);
  });

  it("omits the terrain when the header says there is none", () => {
    const bytes = encodeSnapshot(header({ hasTerrain: false }));
    const decoded = decodeSnapshot(bytes);
    expect(decoded.header.hasTerrain).toBe(false);
    expect(decoded).not.toHaveProperty("terrain");
    const headerLength = bytes[4]! | (bytes[5]! << 8);
    expect(bytes.length).toBe(8 + headerLength);
  });

  it("round-trips a header with text outside ASCII", () => {
    const date = "Märch 4 € \u{1f3a2}, Year 1";
    const decoded = decodeSnapshot(encodeSnapshot(header({ date, hasTerrain: false })));
    expect(decoded.header.date).toBe(date);
  });

  it("reads a snapshot from a view into a larger buffer", () => {
    const bytes = encodeSnapshot(header(), terrain());
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 5);
    const decoded = decodeSnapshot(padded.subarray(5, 5 + bytes.length));
    expect(decoded.terrain?.corners).toEqual(terrain().corners);
  });

  it("does not share memory with the bytes it was decoded from", () => {
    const bytes = encodeSnapshot(header(), terrain());
    const decoded = decodeSnapshot(bytes);
    bytes.fill(0);
    expect(decoded.terrain?.surface).toEqual(terrain().surface);
    expect(decoded.terrain?.corners[0]).toBe(63);
  });

  it("copies out of a Node Buffer, whose slice is a view", () => {
    const encoded = Buffer.from(encodeSnapshot(header(), terrain()));
    const decoded = decodeSnapshot(encoded);
    encoded.fill(0);
    expect(decoded.terrain?.corners).toEqual(terrain().corners);
    expect(decoded.terrain?.surface).toEqual(terrain().surface);
    expect(decoded.terrain?.water).toEqual(terrain().water);
    // Plain typed arrays too, not Buffers that happen to hold the right bytes.
    expect(Buffer.isBuffer(decoded.terrain?.surface)).toBe(false);
    expect(Buffer.isBuffer(decoded.terrain?.water)).toBe(false);
  });

  it("refuses to encode terrain that disagrees with the header", () => {
    expect(() => encodeSnapshot(header({ hasTerrain: true }))).toThrow(ProtocolError);
    expect(() => encodeSnapshot(header({ hasTerrain: false }), terrain())).toThrow(ProtocolError);
    expect(() => encodeSnapshot(header({ width: WIDTH + 1 }), terrain())).toThrow(ProtocolError);
  });
});

describe("snapshot decoding", () => {
  it("throws ProtocolError on bad magic", () => {
    const bytes = encodeSnapshot(header(), terrain());
    bytes[3] = 0x32; // "CWS2"
    expect(() => decodeSnapshot(bytes)).toThrow(ProtocolError);
    expect(() => decodeSnapshot(bytes)).toThrow(/magic/);
  });

  it("throws ProtocolError on truncated bytes", () => {
    const bytes = encodeSnapshot(header(), terrain());
    expect(() => decodeSnapshot(bytes.subarray(0, 3))).toThrow(ProtocolError);
    expect(() => decodeSnapshot(bytes.subarray(0, 12))).toThrow(ProtocolError);
    expect(() => decodeSnapshot(bytes.subarray(0, bytes.length - 1))).toThrow(/length mismatch/);
  });

  it("carries halted, true or false", () => {
    for (const halted of [true, false]) {
      const decoded = decodeSnapshot(encodeSnapshot(header({ halted, speed: 0 }), terrain()));
      expect(decoded.header.halted).toBe(halted);
      const plain = decodeSnapshot(encodeSnapshot(header({ halted, hasTerrain: false })));
      expect(plain.header.halted).toBe(halted);
    }
  });

  it("throws ProtocolError on extra bytes", () => {
    const bytes = encodeSnapshot(header(), terrain());
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(() => decodeSnapshot(longer)).toThrow(/length mismatch/);
    const plain = encodeSnapshot(header({ hasTerrain: false }));
    const extra = new Uint8Array(plain.length + 1);
    extra.set(plain);
    expect(() => decodeSnapshot(extra)).toThrow(ProtocolError);
  });

  it("throws ProtocolError when the header length points past the end", () => {
    const bytes = encodeSnapshot(header({ hasTerrain: false }));
    new DataView(bytes.buffer).setUint32(4, 0xffffffff, true);
    expect(() => decodeSnapshot(bytes)).toThrow(ProtocolError);
  });

  it("throws ProtocolError when the header is not valid JSON or not a header", () => {
    expect(() => decodeSnapshot(frameWithHeader("{nope"))).toThrow(ProtocolError);
    expect(() => decodeSnapshot(frameWithHeader('{"tick":1}'))).toThrow(/header is invalid/);
    const { halted: _halted, ...withoutHalted } = header();
    expect(() => decodeSnapshot(frameWithHeader(JSON.stringify(withoutHalted)))).toThrow(
      /header is invalid/,
    );
    expect(() =>
      decodeSnapshot(frameWithHeader(JSON.stringify(header({ speed: 3 as never })))),
    ).toThrow(ProtocolError);
  });

  it("throws ProtocolError when the header is not valid UTF-8", () => {
    const good = encodeSnapshot(header({ hasTerrain: false, date: "ab" }));
    const at = good.indexOf(0x61); // the "a" in the date
    for (const bad of [[0xff], [0xc3], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
      const broken = new Uint8Array(good.length + bad.length - 1);
      broken.set(good.subarray(0, at));
      broken.set(bad, at);
      broken.set(good.subarray(at + 1), at + bad.length);
      new DataView(broken.buffer).setUint32(4, broken.length - 8, true);
      expect(() => decodeSnapshot(broken)).toThrow(ProtocolError);
    }
  });

  it("does not allocate what a lying header claims", () => {
    const lie = frameWithHeader(
      JSON.stringify(header({ hasTerrain: true, width: 65_535, height: 65_535 })),
    );
    expect(() => decodeSnapshot(lie)).toThrow(/length mismatch/);
  });
});
