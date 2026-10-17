import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  decodeSnapshot,
  encodeSnapshot,
  type GuestSection,
  type ParkPublic,
  type SnapshotHeader,
  type SnapshotParts,
  type SnapshotTerrain,
} from "../src/index.js";

const WIDTH = 3;
const HEIGHT = 2;

function park(over: Partial<ParkPublic> = {}): ParkPublic {
  return {
    name: "Test Park",
    open: true,
    entryFee: 1_000,
    entrance: { x: 1, y: 0, side: 0 },
    rating: 612,
    guestsInPark: 3,
    totalAdmissions: 17,
    ...over,
  };
}

function header(over: Partial<SnapshotHeader> = {}): SnapshotHeader {
  return {
    tick: 1234,
    speed: 4,
    halted: false,
    cash: 1_000_000,
    loan: 500_000,
    monthStartCash: 900_000,
    date: "March 4, Year 1",
    terrainVersion: 7,
    hasTerrain: true,
    pathVersion: 5,
    hasPaths: false,
    guestCount: 0,
    width: WIDTH,
    height: HEIGHT,
    park: park(),
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

function paths(): Uint8Array {
  return Uint8Array.from([0, 1, 2, 0, 1, 1]);
}

function noGuests(): GuestSection {
  return {
    count: 0,
    id: new Int32Array(0),
    x: new Int32Array(0),
    y: new Int32Array(0),
    state: new Uint8Array(0),
    color: new Uint8Array(0),
    happiness: new Uint8Array(0),
  };
}

/** Three guests with values that tell the byte order and the sign apart. */
function threeGuests(): GuestSection {
  return {
    count: 3,
    id: Int32Array.from([1, 0x01020304, 2_000_000_000]),
    // A guest in the lane outside the map is at a negative position.
    x: Int32Array.from([-16, 80, 0x00010203]),
    y: Int32Array.from([112, -16, 0x7fffffff]),
    state: Uint8Array.from([0, 2, 5]),
    color: Uint8Array.from([8, 0, 3]),
    happiness: Uint8Array.from([255, 17, 0]),
  };
}

/** `count` guests whose values all differ, to catch an array written or read in the wrong place. */
function manyGuests(count: number): GuestSection {
  const guests = noGuests();
  guests.count = count;
  guests.id = new Int32Array(count);
  guests.x = new Int32Array(count);
  guests.y = new Int32Array(count);
  guests.state = new Uint8Array(count);
  guests.color = new Uint8Array(count);
  guests.happiness = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    guests.id[i] = i + 1;
    guests.x[i] = (i * 37) % 8192;
    guests.y[i] = -((i * 91) % 8192);
    guests.state[i] = i % 6;
    guests.color[i] = i % 9;
    guests.happiness[i] = (i * 7) % 256;
  }
  return guests;
}

function parts(over: Partial<SnapshotParts> = {}): SnapshotParts {
  return { terrain: terrain(), guests: noGuests(), ...over };
}

/** A snapshot frame around the given header text, with no bytes after it. */
function frameWithHeader(json: string, magic = [0x43, 0x57, 0x53, 0x32]): Uint8Array {
  const body = Uint8Array.from(json, (char) => char.charCodeAt(0));
  const out = new Uint8Array(8 + body.length);
  out.set(magic);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function headerLengthOf(bytes: Uint8Array): number {
  return bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
}

describe("snapshot encoding", () => {
  it("round-trips the header and the terrain", () => {
    const original = terrain();
    const decoded = decodeSnapshot(encodeSnapshot(header(), parts({ terrain: original })));
    expect(decoded.header).toEqual(header());
    expect(decoded.terrain?.corners).toEqual(original.corners);
    expect(decoded.terrain?.surface).toEqual(original.surface);
    expect(decoded.terrain?.water).toEqual(original.water);
    expect(decoded.terrain?.corners[0]).toBe(63);
    expect(decoded.terrain?.water[2]).toBe(12);
  });

  it("round-trips terrain, paths and three guests together", () => {
    const original = threeGuests();
    const frame = encodeSnapshot(
      header({ hasPaths: true, guestCount: 3 }),
      parts({ paths: paths(), guests: original }),
    );
    const decoded = decodeSnapshot(frame);
    expect(decoded.header).toEqual(header({ hasPaths: true, guestCount: 3 }));
    expect(decoded.terrain).toEqual(terrain());
    expect(decoded.paths).toEqual(paths());
    expect(decoded.guests).toEqual(original);
    expect(decoded.guests.count).toBe(3);
    expect(decoded.guests.id[1]).toBe(0x01020304);
    expect(decoded.guests.x[0]).toBe(-16);
    expect(decoded.guests.y[2]).toBe(0x7fffffff);
  });

  it("round-trips paths and guests without terrain", () => {
    const decoded = decodeSnapshot(
      encodeSnapshot(header({ hasTerrain: false, hasPaths: true, guestCount: 3 }), {
        paths: paths(),
        guests: threeGuests(),
      }),
    );
    expect(decoded).not.toHaveProperty("terrain");
    expect(decoded.paths).toEqual(paths());
    expect(decoded.guests).toEqual(threeGuests());
  });

  it("round-trips guests without terrain or paths", () => {
    const decoded = decodeSnapshot(
      encodeSnapshot(header({ hasTerrain: false, guestCount: 3 }), { guests: threeGuests() }),
    );
    expect(decoded).not.toHaveProperty("terrain");
    expect(decoded).not.toHaveProperty("paths");
    expect(decoded.guests).toEqual(threeGuests());
  });

  it("encodes a world with no guests as an empty guest section", () => {
    const bytes = encodeSnapshot(header({ hasTerrain: false }), { guests: noGuests() });
    const decoded = decodeSnapshot(bytes);
    expect(decoded.guests.count).toBe(0);
    for (const array of [
      decoded.guests.id,
      decoded.guests.x,
      decoded.guests.y,
      decoded.guests.state,
      decoded.guests.color,
      decoded.guests.happiness,
    ]) {
      expect(array).toHaveLength(0);
    }
    // Nothing follows the header: an empty section takes no bytes.
    expect(bytes.length).toBe(8 + headerLengthOf(bytes));
    expect(decoded.guests.id).toBeInstanceOf(Int32Array);
    expect(decoded.guests.state).toBeInstanceOf(Uint8Array);
  });

  it("round-trips a full park of 2,000 guests in about 30 KB", () => {
    const original = manyGuests(2000);
    const bytes = encodeSnapshot(header({ hasTerrain: false, guestCount: 2000 }), {
      guests: original,
    });
    expect(bytes.length - 8 - headerLengthOf(bytes)).toBe(2000 * 15);
    const decoded = decodeSnapshot(bytes);
    expect(decoded.guests.count).toBe(2000);
    expect(decoded.guests.id).toEqual(original.id);
    expect(decoded.guests.x).toEqual(original.x);
    expect(decoded.guests.y).toEqual(original.y);
    expect(decoded.guests.state).toEqual(original.state);
    expect(decoded.guests.color).toEqual(original.color);
    expect(decoded.guests.happiness).toEqual(original.happiness);
    expect(decoded.guests.id[1999]).toBe(2000);
    expect(decoded.guests.y[1999]).toBe(-((1999 * 91) % 8192));
  });

  it("carries the park, including a missing entrance", () => {
    const placed = decodeSnapshot(encodeSnapshot(header(), parts()));
    expect(placed.header.park).toEqual(park());
    const none = park({ entrance: null, open: false, name: "Märk's Park \u{1f3a2}" });
    const decoded = decodeSnapshot(encodeSnapshot(header({ park: none }), parts()));
    expect(decoded.header.park).toEqual(none);
    expect(decoded.header.park.entrance).toBeNull();
  });

  it("carries the cash the month began with, with and without terrain", () => {
    const withTerrain = decodeSnapshot(encodeSnapshot(header({ monthStartCash: -1_250 }), parts()));
    expect(withTerrain.header.monthStartCash).toBe(-1_250);
    const plain = decodeSnapshot(
      encodeSnapshot(header({ hasTerrain: false }), { guests: noGuests() }),
    );
    expect(plain.header.monthStartCash).toBe(900_000);
  });

  it("returns real typed arrays of the right sizes", () => {
    const decoded = decodeSnapshot(
      encodeSnapshot(
        header({ hasPaths: true, guestCount: 3 }),
        parts({ paths: paths(), guests: threeGuests() }),
      ),
    );
    expect(decoded.terrain?.corners).toBeInstanceOf(Int16Array);
    expect(decoded.terrain?.corners).toHaveLength((WIDTH + 1) * (HEIGHT + 1));
    expect(decoded.terrain?.surface).toBeInstanceOf(Uint8Array);
    expect(decoded.terrain?.surface).toHaveLength(WIDTH * HEIGHT);
    expect(decoded.terrain?.water).toHaveLength(WIDTH * HEIGHT);
    expect(decoded.paths).toBeInstanceOf(Uint8Array);
    expect(decoded.paths).toHaveLength(WIDTH * HEIGHT);
    expect(decoded.guests.id).toBeInstanceOf(Int32Array);
    expect(decoded.guests.x).toBeInstanceOf(Int32Array);
    expect(decoded.guests.y).toBeInstanceOf(Int32Array);
    expect(decoded.guests.state).toBeInstanceOf(Uint8Array);
    expect(decoded.guests.color).toBeInstanceOf(Uint8Array);
    expect(decoded.guests.happiness).toBeInstanceOf(Uint8Array);
    for (const array of [decoded.guests.id, decoded.guests.x, decoded.guests.y]) {
      expect(array).toHaveLength(3);
    }
  });

  it("writes the layout the format promises, little-endian", () => {
    const bytes = encodeSnapshot(
      header({ hasPaths: true, guestCount: 3 }),
      parts({ paths: paths(), guests: threeGuests() }),
    );
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x43, 0x57, 0x53, 0x32]);
    const headerLength = headerLengthOf(bytes);
    expect(JSON.parse(String.fromCharCode(...bytes.subarray(8, 8 + headerLength)))).toEqual(
      header({ hasPaths: true, guestCount: 3 }),
    );
    const corners = 8 + headerLength;
    const pathsAt = corners + 2 * 12 + 6 + 6;
    const guestsAt = pathsAt + 6;
    expect(bytes.length).toBe(guestsAt + 3 * 15);
    // Corner 0 is 63, corner 5 is 0x0102: low byte first.
    expect(Array.from(bytes.subarray(corners, corners + 2))).toEqual([63, 0]);
    expect(Array.from(bytes.subarray(corners + 10, corners + 12))).toEqual([0x02, 0x01]);
    expect(Array.from(bytes.subarray(corners + 12, corners + 14))).toEqual([0xff, 0x7f]);
    // The paths come after the terrain, one byte a tile.
    expect(Array.from(bytes.subarray(pathsAt, guestsAt))).toEqual([0, 1, 2, 0, 1, 1]);
    // Then the ids: 1, 0x01020304 and 2,000,000,000 (0x77359400), four bytes each, low first.
    expect(Array.from(bytes.subarray(guestsAt, guestsAt + 12))).toEqual([
      1, 0, 0, 0, 0x04, 0x03, 0x02, 0x01, 0x00, 0x94, 0x35, 0x77,
    ]);
    // Then x, which starts with -16 as a two's complement int32.
    expect(Array.from(bytes.subarray(guestsAt + 12, guestsAt + 16))).toEqual([
      0xf0, 0xff, 0xff, 0xff,
    ]);
    // Then y, which ends with 0x7fffffff.
    expect(Array.from(bytes.subarray(guestsAt + 32, guestsAt + 36))).toEqual([
      0xff, 0xff, 0xff, 0x7f,
    ]);
    // Then one byte a guest for state, color and happiness, in that order.
    expect(Array.from(bytes.subarray(guestsAt + 36))).toEqual([0, 2, 5, 8, 0, 3, 255, 17, 0]);
  });

  it("omits the terrain and paths when the header says there are none", () => {
    const bytes = encodeSnapshot(header({ hasTerrain: false }), { guests: noGuests() });
    const decoded = decodeSnapshot(bytes);
    expect(decoded.header.hasTerrain).toBe(false);
    expect(decoded.header.hasPaths).toBe(false);
    expect(decoded).not.toHaveProperty("terrain");
    expect(decoded).not.toHaveProperty("paths");
    expect(bytes.length).toBe(8 + headerLengthOf(bytes));
  });

  it("round-trips a header with text outside ASCII", () => {
    const date = "Märch 4 € \u{1f3a2}, Year 1";
    const decoded = decodeSnapshot(
      encodeSnapshot(header({ date, hasTerrain: false }), { guests: noGuests() }),
    );
    expect(decoded.header.date).toBe(date);
  });

  it("reads a snapshot from a view into a larger buffer", () => {
    const bytes = encodeSnapshot(
      header({ hasPaths: true, guestCount: 3 }),
      parts({ paths: paths(), guests: threeGuests() }),
    );
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 5);
    const decoded = decodeSnapshot(padded.subarray(5, 5 + bytes.length));
    expect(decoded.terrain?.corners).toEqual(terrain().corners);
    expect(decoded.paths).toEqual(paths());
    expect(decoded.guests).toEqual(threeGuests());
  });

  it("does not share memory with the bytes it was decoded from", () => {
    const bytes = encodeSnapshot(
      header({ hasPaths: true, guestCount: 3 }),
      parts({ paths: paths(), guests: threeGuests() }),
    );
    const decoded = decodeSnapshot(bytes);
    bytes.fill(0);
    expect(decoded.terrain?.surface).toEqual(terrain().surface);
    expect(decoded.terrain?.corners[0]).toBe(63);
    expect(decoded.paths).toEqual(paths());
    expect(decoded.guests).toEqual(threeGuests());
  });

  it("copies out of a Node Buffer, whose slice is a view", () => {
    const encoded = Buffer.from(
      encodeSnapshot(
        header({ hasPaths: true, guestCount: 3 }),
        parts({ paths: paths(), guests: threeGuests() }),
      ),
    );
    const decoded = decodeSnapshot(encoded);
    encoded.fill(0);
    expect(decoded.terrain?.corners).toEqual(terrain().corners);
    expect(decoded.terrain?.surface).toEqual(terrain().surface);
    expect(decoded.terrain?.water).toEqual(terrain().water);
    expect(decoded.paths).toEqual(paths());
    expect(decoded.guests).toEqual(threeGuests());
    // Plain typed arrays too, not Buffers that happen to hold the right bytes.
    expect(Buffer.isBuffer(decoded.terrain?.surface)).toBe(false);
    expect(Buffer.isBuffer(decoded.terrain?.water)).toBe(false);
    expect(Buffer.isBuffer(decoded.paths)).toBe(false);
    expect(Buffer.isBuffer(decoded.guests.state)).toBe(false);
    expect(Buffer.isBuffer(decoded.guests.color)).toBe(false);
    expect(Buffer.isBuffer(decoded.guests.happiness)).toBe(false);
  });

  it("refuses to encode terrain that disagrees with the header", () => {
    expect(() => encodeSnapshot(header({ hasTerrain: true }), { guests: noGuests() })).toThrow(
      ProtocolError,
    );
    expect(() => encodeSnapshot(header({ hasTerrain: false }), parts())).toThrow(ProtocolError);
    expect(() => encodeSnapshot(header({ width: WIDTH + 1 }), parts())).toThrow(ProtocolError);
  });

  it("refuses to encode paths that disagree with the header", () => {
    expect(() => encodeSnapshot(header({ hasPaths: true }), parts())).toThrow(
      /paths must be given/,
    );
    expect(() => encodeSnapshot(header({ hasPaths: false }), parts({ paths: paths() }))).toThrow(
      /paths must be given/,
    );
    expect(() =>
      encodeSnapshot(
        header({ hasPaths: true }),
        parts({ paths: new Uint8Array(WIDTH * HEIGHT + 1) }),
      ),
    ).toThrow(ProtocolError);
  });

  it("refuses to encode guests that disagree with the header", () => {
    // A header that counts guests the parts do not hold, and the other way round.
    expect(() => encodeSnapshot(header({ guestCount: 3 }), parts())).toThrow(/guestCount/);
    expect(() =>
      encodeSnapshot(header({ guestCount: 0 }), parts({ guests: threeGuests() })),
    ).toThrow(ProtocolError);
    // Any one array of the wrong length.
    for (const name of ["id", "x", "y", "state", "color", "happiness"] as const) {
      const guests = threeGuests();
      const arrays = guests as unknown as Record<string, Int32Array | Uint8Array>;
      arrays[name] = (arrays[name] as Int32Array | Uint8Array).subarray(0, 2);
      expect(() => encodeSnapshot(header({ guestCount: 3 }), parts({ guests }))).toThrow(
        ProtocolError,
      );
    }
    // A count that says one thing while the arrays say another.
    const liar = { ...threeGuests(), count: 2 };
    expect(() => encodeSnapshot(header({ guestCount: 3 }), parts({ guests: liar }))).toThrow(
      ProtocolError,
    );
  });
});

describe("snapshot decoding", () => {
  it("throws ProtocolError on bad magic", () => {
    const bytes = encodeSnapshot(header(), parts());
    bytes[0] = 0x58; // "XWS2"
    expect(() => decodeSnapshot(bytes)).toThrow(ProtocolError);
    expect(() => decodeSnapshot(bytes)).toThrow(/magic/);
    const letter = encodeSnapshot(header(), parts());
    letter[3] = 0x78; // "CWSx": not a version at all
    expect(() => decodeSnapshot(letter)).toThrow(/magic/);
  });

  it("refuses a v1 frame as an unsupported version", () => {
    const v1 = encodeSnapshot(header(), parts());
    v1[3] = 0x31; // "CWS1"
    expect(() => decodeSnapshot(v1)).toThrow(ProtocolError);
    expect(() => decodeSnapshot(v1)).toThrow("Unsupported snapshot version");
    // A real v1 frame has a v1 header and no sections after it, and is refused all the same.
    const header1 = JSON.stringify({
      tick: 0,
      speed: 1,
      halted: false,
      cash: 0,
      loan: 0,
      monthStartCash: 0,
      date: "March 1, Year 1",
      terrainVersion: 0,
      hasTerrain: false,
      width: 16,
      height: 16,
    });
    expect(() => decodeSnapshot(frameWithHeader(header1, [0x43, 0x57, 0x53, 0x31]))).toThrow(
      new ProtocolError("Unsupported snapshot version"),
    );
    // So is a version that has not been written yet.
    const v3 = encodeSnapshot(header(), parts());
    v3[3] = 0x33;
    expect(() => decodeSnapshot(v3)).toThrow("Unsupported snapshot version");
  });

  it("throws ProtocolError on truncated bytes", () => {
    const bytes = encodeSnapshot(header(), parts());
    expect(() => decodeSnapshot(bytes.subarray(0, 3))).toThrow(ProtocolError);
    expect(() => decodeSnapshot(bytes.subarray(0, 12))).toThrow(ProtocolError);
    expect(() => decodeSnapshot(bytes.subarray(0, bytes.length - 1))).toThrow(/length mismatch/);
  });

  it("throws ProtocolError on a truncated guest section", () => {
    const bytes = encodeSnapshot(
      header({ hasPaths: true, guestCount: 3 }),
      parts({ paths: paths(), guests: threeGuests() }),
    );
    // One byte short, a whole guest short (15 bytes), and every cut in between and beyond that
    // lands inside the guest section, the paths or the terrain.
    for (const cut of [1, 2, 3, 4, 14, 15, 16, 30, 45, 46, 47, 60]) {
      expect(() => decodeSnapshot(bytes.subarray(0, bytes.length - cut))).toThrow(
        /length mismatch/,
      );
    }
    // Cut off exactly where the guests begin, so only the paths and terrain survive.
    const guestsAt = bytes.length - 3 * 15;
    expect(() => decodeSnapshot(bytes.subarray(0, guestsAt))).toThrow(/length mismatch/);
    // Cut off exactly where the paths begin: the header's counts are not met.
    expect(() => decodeSnapshot(bytes.subarray(0, guestsAt - WIDTH * HEIGHT))).toThrow(
      /length mismatch/,
    );
  });

  it("throws ProtocolError when the guest count in the header and the guests in the body disagree", () => {
    const bytes = encodeSnapshot(header({ hasTerrain: false, guestCount: 3 }), {
      guests: threeGuests(),
    });
    // The body holds three guests; a header that says two, or four, does not describe it.
    for (const guestCount of [0, 2, 4]) {
      const json = JSON.stringify(header({ hasTerrain: false, guestCount }));
      const body = bytes.subarray(8 + headerLengthOf(bytes));
      const frame = new Uint8Array(8 + json.length + body.length);
      frame.set(frameWithHeader(json));
      frame.set(body, 8 + json.length);
      expect(() => decodeSnapshot(frame)).toThrow(/length mismatch/);
    }
  });

  it("carries halted, true or false", () => {
    for (const halted of [true, false]) {
      const decoded = decodeSnapshot(encodeSnapshot(header({ halted, speed: 0 }), parts()));
      expect(decoded.header.halted).toBe(halted);
      const plain = decodeSnapshot(
        encodeSnapshot(header({ halted, hasTerrain: false }), { guests: noGuests() }),
      );
      expect(plain.header.halted).toBe(halted);
    }
  });

  it("throws ProtocolError on extra bytes", () => {
    const bytes = encodeSnapshot(header(), parts());
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(() => decodeSnapshot(longer)).toThrow(/length mismatch/);
    const plain = encodeSnapshot(header({ hasTerrain: false }), { guests: noGuests() });
    const extra = new Uint8Array(plain.length + 1);
    extra.set(plain);
    expect(() => decodeSnapshot(extra)).toThrow(ProtocolError);
    const withGuests = encodeSnapshot(header({ hasTerrain: false, guestCount: 3 }), {
      guests: threeGuests(),
    });
    const guestsAndOne = new Uint8Array(withGuests.length + 1);
    guestsAndOne.set(withGuests);
    expect(() => decodeSnapshot(guestsAndOne)).toThrow(/length mismatch/);
  });

  it("throws ProtocolError when the header length points past the end", () => {
    const bytes = encodeSnapshot(header({ hasTerrain: false }), { guests: noGuests() });
    new DataView(bytes.buffer).setUint32(4, 0xffffffff, true);
    expect(() => decodeSnapshot(bytes)).toThrow(ProtocolError);
  });

  it("throws ProtocolError when the header is not valid JSON or not a header", () => {
    expect(() => decodeSnapshot(frameWithHeader("{nope"))).toThrow(ProtocolError);
    expect(() => decodeSnapshot(frameWithHeader('{"tick":1}'))).toThrow(/header is invalid/);
    for (const key of [
      "halted",
      "monthStartCash",
      "pathVersion",
      "hasPaths",
      "guestCount",
      "park",
    ] as const) {
      const without: Partial<SnapshotHeader> = header();
      delete without[key];
      expect(() => decodeSnapshot(frameWithHeader(JSON.stringify(without)))).toThrow(
        /header is invalid/,
      );
    }
    expect(() =>
      decodeSnapshot(frameWithHeader(JSON.stringify(header({ monthStartCash: 1.5 })))),
    ).toThrow(ProtocolError);
    expect(() =>
      decodeSnapshot(frameWithHeader(JSON.stringify(header({ speed: 3 as never })))),
    ).toThrow(ProtocolError);
    expect(() =>
      decodeSnapshot(frameWithHeader(JSON.stringify(header({ guestCount: -1 })))),
    ).toThrow(/header is invalid/);
    expect(() =>
      decodeSnapshot(frameWithHeader(JSON.stringify(header({ guestCount: 1.5 })))),
    ).toThrow(/header is invalid/);
    expect(() =>
      decodeSnapshot(
        frameWithHeader(
          JSON.stringify(header({ park: park({ entrance: { x: 0, y: 0, side: 4 as never } }) })),
        ),
      ),
    ).toThrow(/header is invalid/);
    expect(() =>
      decodeSnapshot(
        frameWithHeader(JSON.stringify(header({ park: { ...park(), open: 1 } as never }))),
      ),
    ).toThrow(/header is invalid/);
  });

  it("throws ProtocolError when the header is not valid UTF-8", () => {
    const good = encodeSnapshot(header({ hasTerrain: false, date: "ab" }), { guests: noGuests() });
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
    const guestLie = frameWithHeader(
      JSON.stringify(header({ hasTerrain: false, guestCount: 2_000_000_000 })),
    );
    expect(() => decodeSnapshot(guestLie)).toThrow(/length mismatch/);
    const pathLie = frameWithHeader(
      JSON.stringify(header({ hasTerrain: false, hasPaths: true, width: 65_535, height: 65_535 })),
    );
    expect(() => decodeSnapshot(pathLie)).toThrow(/length mismatch/);
  });
});
