import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  GUEST_CAP,
  GuestState,
  LOST_GIVE_UP,
  MAX_HEIGHT,
  MIGRATIONS,
  Rng,
  SCHEMA_VERSION,
  SaveError,
  Sim,
  createSamplePark,
  createWorld,
  deserializeWorld,
  hashWorld,
  migrate,
  serializeWorld,
  type Migration,
  type MonthRecord,
  type World,
} from "../src/index.js";
import { compactGuests, removeGuest, spawnGuest } from "../src/guests/guests.js";
import { GUEST_ARRAYS } from "../src/guests/types.js";
import { fromBase64, toBase64 } from "../src/save/base64.js";
import { validateWorldInvariants } from "../src/save/invariants.js";
import { at, makePark, placeGuest } from "./helpers/guests.js";

const CREATED = "2026-10-16T12:00:00.000Z";

/** A fresh world with a made-up name that has non-ASCII characters in it. */
function freshWorld(width = 12, height = 10): World {
  return createWorld({
    width,
    height,
    seed: 4242,
    name: "Fünpark \u{1F3A2}",
    createdIso: CREATED,
  });
}

/**
 * A world with history: three commands, the last (priced) one undone so redo has an entry and the
 * log holds an `undo` entry with a negative cost, then 500 ticks.
 */
function playedSim(): Sim {
  const sim = new Sim(freshWorld(16, 16));
  expect(sim.execute("terrain_raise", { x: 2, y: 2, w: 4, h: 4, steps: 2 }, "agent").ok).toBe(true);
  expect(sim.execute("finance_take_loan", { amount: 2_000_00 }).ok).toBe(true);
  expect(sim.execute("terrain_set_water", { x: 8, y: 8, w: 3, h: 2, level: 12 }).ok).toBe(true);
  expect(sim.undo().ok).toBe(true);
  expect(sim.world.log.some((entry) => entry.cost < 0)).toBe(true);
  sim.step(500);
  return sim;
}

/** Unzips and parses the JSON document inside a save. */
function readDoc(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(strFromU8(gunzipSync(bytes))) as Record<string, unknown>;
}

function writeDoc(doc: unknown): Uint8Array {
  return gzipSync(strToU8(JSON.stringify(doc)), { mtime: 0 });
}

function expectSaveError(fn: () => unknown, message?: string | RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SaveError);
  if (message !== undefined) expect((caught as SaveError).message).toMatch(message);
}

describe("save round trip", () => {
  it("preserves the hash of a fresh world", () => {
    const world = freshWorld();
    const loaded = deserializeWorld(serializeWorld(world));
    expect(hashWorld(loaded)).toBe(hashWorld(world));
  });

  it("preserves a world after 3 commands and 500 ticks: hash, log length, and everything else", () => {
    const sim = playedSim();
    const world = sim.world;
    expect(world.log.length).toBeGreaterThanOrEqual(4);
    expect(world.tick).toBe(500);

    const loaded = deserializeWorld(serializeWorld(world));
    expect(hashWorld(loaded)).toBe(hashWorld(world));
    expect(loaded.log.length).toBe(world.log.length);
    expect(loaded.log).toStrictEqual(world.log);
    expect(loaded.undoStack).toStrictEqual(world.undoStack);
    expect(loaded.redoStack).toStrictEqual(world.redoStack);
    expect(world.redoStack.length).toBeGreaterThan(0);
    expect(loaded.rng.state).toStrictEqual(world.rng.state);
    expect(loaded.meta).toStrictEqual(world.meta);
    expect(loaded.meta.created).toBe(CREATED);
    expect(loaded.tick).toBe(world.tick);
    expect(loaded.nextId).toBe(world.nextId);
    expect(loaded.finance).toStrictEqual(world.finance);
  });

  it("keeps the undo data in the log, so a loaded world can still undo", () => {
    const sim = playedSim();
    expect(sim.world.log.some((entry) => entry.undo !== undefined)).toBe(true);
    const loaded = new Sim(deserializeWorld(serializeWorld(sim.world)));
    expect(sim.undo().ok).toBe(true);
    expect(loaded.undo().ok).toBe(true);
    expect(loaded.hash()).toBe(sim.hash());
    expect(loaded.redo().ok).toBe(true);
    expect(sim.redo().ok).toBe(true);
    expect(loaded.hash()).toBe(sim.hash());
  });

  it("keeps undoneBy and omits absent optional fields", () => {
    const sim = playedSim();
    // `playedSim` steps the clock directly, which logs nothing; this logs a `sim_advance`.
    expect(sim.execute("sim_advance", { days: 1 }).ok).toBe(true);
    const undone = sim.world.log.filter((entry) => entry.undoneBy !== undefined);
    expect(undone.length).toBeGreaterThan(0);
    const loaded = deserializeWorld(serializeWorld(sim.world));
    // toStrictEqual tells `{ undo: undefined }` from a missing key.
    expect(loaded.log).toStrictEqual(sim.world.log);
    // A loan returns no undo data, and time cannot be undone: neither entry gets an `undo` key.
    for (const name of ["finance_take_loan", "sim_advance"]) {
      const plain = loaded.log.find((entry) => entry.name === name);
      expect(plain, name).toBeDefined();
      expect("undo" in (plain as object), name).toBe(false);
    }
  });

  it("round-trips log entries that have no input, a null undo, or an undoneBy", () => {
    const world = freshWorld(2, 2);
    world.log.push(
      { id: 1, tick: 0, client: "system", name: "a", input: undefined, cost: 0 },
      { id: 2, tick: 3, client: "replay", name: "b", input: [1, { x: null }], cost: 5, undo: null },
      { id: 3, tick: 4, client: "agent", name: "c", input: "s", cost: 0, undo: 0, undoneBy: 4 },
    );
    world.nextId = 4;
    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.log).toStrictEqual(world.log);
    expect(hashWorld(loaded)).toBe(hashWorld(world));
  });

  it("loads a save whose log holds an undone priced command (negative undo cost)", () => {
    const sim = new Sim(freshWorld(8, 8));
    const raised = sim.execute("terrain_raise", { x: 1, y: 1, w: 2, h: 2 });
    expect(raised.ok && raised.cost).toBeGreaterThan(0);
    expect(sim.undo().ok).toBe(true);
    const undoEntry = sim.world.log[1];
    expect(undoEntry?.name).toBe("undo");
    expect(undoEntry?.cost).toBeLessThan(0);

    const loaded = deserializeWorld(serializeWorld(sim.world));
    expect(hashWorld(loaded)).toBe(hashWorld(sim.world));
    expect(loaded.log).toStrictEqual(sim.world.log);
    expect(loaded.log[1]?.cost).toBe(undoEntry?.cost);

    const loadedSim = new Sim(loaded);
    expect(loadedSim.redo().ok).toBe(true);
    expect(sim.redo().ok).toBe(true);
    expect(loadedSim.hash()).toBe(sim.hash());
  });

  it("keeps simulating identically after a load", () => {
    const sim = playedSim();
    const loaded = new Sim(deserializeWorld(serializeWorld(sim.world)));
    for (const s of [sim, loaded]) {
      s.execute("terrain_raise", { x: 0, y: 0, w: 2, h: 2 });
      s.execute("sim_advance", { days: 3 });
      s.step(250);
    }
    expect(loaded.hash()).toBe(sim.hash());
    expect(loaded.world.rng.state).toStrictEqual(sim.world.rng.state);
  });

  it("restores real typed arrays and a working Rng, not views onto the save", () => {
    const world = playedSim().world;
    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.terrain.corners).toBeInstanceOf(Int16Array);
    expect(loaded.terrain.surface).toBeInstanceOf(Uint8Array);
    expect(loaded.terrain.water).toBeInstanceOf(Uint8Array);
    expect(loaded.terrain.path).toBeInstanceOf(Uint8Array);
    expect(loaded.terrain.corners).toStrictEqual(world.terrain.corners);
    expect(loaded.terrain.surface).toStrictEqual(world.terrain.surface);
    expect(loaded.terrain.water).toStrictEqual(world.terrain.water);
    expect(loaded.terrain.path).toStrictEqual(world.terrain.path);
    expect(loaded.terrain.corners.byteOffset).toBe(0);
    expect(loaded.rng).toBeInstanceOf(Rng);
    expect(loaded.rng.next()).toBe(Rng.fromState(world.rng.state).next());
  });

  it("round-trips the lowest and highest corner heights, and every surface and water value", () => {
    const world = freshWorld(3, 2);
    world.terrain.corners.set([0, MAX_HEIGHT, 1, 62, 31, 32, 8, 16, 2, 7, 8, 9]);
    world.terrain.surface.set([0, 1, 2, 3, 4, 0]);
    world.terrain.water.set([0, 1, 2, 31, 62, MAX_HEIGHT]);
    world.terrain.path.set([0, 1, 2, 2, 1, 0]);
    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.terrain.corners).toStrictEqual(world.terrain.corners);
    expect(loaded.terrain.surface).toStrictEqual(world.terrain.surface);
    expect(loaded.terrain.water).toStrictEqual(world.terrain.water);
    expect(loaded.terrain.path).toStrictEqual(world.terrain.path);
  });

  it("round-trips paths and every part of the park state, and restarts pathVersion at 0", () => {
    const sim = new Sim(freshWorld(16, 16));
    for (const [name, input] of [
      ["path_build", { x: 3, y: 1, w: 5, h: 1, kind: "foot" }],
      ["path_build", { x: 3, y: 2, w: 1, h: 4, kind: "queue" }],
      ["path_remove", { x: 5, y: 1, w: 1, h: 1 }],
      ["park_set_entrance", { x: 15, y: 9 }],
      ["park_set_entry_fee", { cents: 12_50 }],
      ["park_rename", { name: "Fünpark \u{1F3A2} II" }],
      ["park_open", {}],
    ] as const) {
      expect(sim.execute(name, input).ok, name).toBe(true);
    }
    const world = sim.world;
    // The counters belong to later tasks; set them by hand so the round trip covers every field.
    world.park.rating = 731;
    world.park.guestsInPark = 12;
    world.park.totalAdmissions = 340;
    world.park.income = { entry: 3_400_00, rides: 56_00, shops: 7_00 };
    world.park.expenses = { running: 80_00, wages: 9_00 };
    world.park.monthly = { entry: 100_00, rides: 20_00, shops: 3_00, running: 40_00, wages: 5_00 };
    world.park.history = [
      {
        year: 1,
        month: 7,
        entry: 90_00,
        rides: 10_00,
        shops: 2_00,
        running: 50_00,
        wages: 8_00,
        net: 44_00,
      },
      { year: 2, month: 0, entry: 1_00, rides: 0, shops: 0, running: 20_00, wages: 0, net: -19_00 },
    ];
    expect(world.pathVersion).toBeGreaterThan(0);

    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.park).toStrictEqual(world.park);
    expect(loaded.park.entrance).toEqual({ x: 15, y: 9, side: 1 });
    expect(loaded.terrain.path).toStrictEqual(world.terrain.path);
    expect(loaded.terrain.path.some((v) => v === 2)).toBe(true);
    expect(hashWorld(loaded)).toBe(hashWorld(world));
    expect(loaded.pathVersion).toBe(0);

    // The undo data for the path commands came along, so a loaded park can still undo one.
    const loadedSim = new Sim(loaded);
    expect(loadedSim.undo().ok).toBe(true);
    expect(sim.undo().ok).toBe(true);
    expect(loadedSim.hash()).toBe(sim.hash());
  });

  it("round-trips the biggest map", () => {
    const world = createWorld({ width: 256, height: 256, seed: 1, name: "big" });
    world.terrain.corners[12345] = 41;
    const loaded = deserializeWorld(serializeWorld(world));
    expect(hashWorld(loaded)).toBe(hashWorld(world));
    expect(loaded.terrain.corners[12345]).toBe(41);
  });

  it("round-trips a negative cash balance, names with quotes, and an empty created time", () => {
    const world = createWorld({ width: 2, height: 2, seed: -5, name: 'a "quoted"\n name\\' });
    world.finance.cash = -1234;
    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.meta).toStrictEqual(world.meta);
    expect(loaded.finance).toStrictEqual(world.finance);
    expect(hashWorld(loaded)).toBe(hashWorld(world));
  });

  it("does not touch the world it serializes", () => {
    const world = playedSim().world;
    const before = hashWorld(world);
    const logBefore = structuredClone(world.log);
    serializeWorld(world);
    expect(hashWorld(world)).toBe(before);
    expect(world.log).toStrictEqual(logBefore);
  });
});

describe("save format", () => {
  it("is deterministic: the same world gives the same bytes, and a loaded world re-saves identically", () => {
    const world = playedSim().world;
    const a = serializeWorld(world);
    const b = serializeWorld(world);
    expect(Array.from(b)).toEqual(Array.from(a));
    const again = serializeWorld(deserializeWorld(a));
    expect(Array.from(again)).toEqual(Array.from(a));
  });

  it("does not put a timestamp in the gzip header", () => {
    const bytes = serializeWorld(freshWorld());
    // Bytes 4..7 of a gzip header are the modification time.
    expect(Array.from(bytes.subarray(0, 8))).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]);
  });

  it("is gzip of a JSON document with the documented shape and key order", () => {
    const world = playedSim().world;
    const doc = readDoc(serializeWorld(world));
    expect(Object.keys(doc)).toEqual([
      "schemaVersion",
      "meta",
      "tick",
      "terrain",
      "finance",
      "park",
      "guests",
      "rng",
      "rngStreams",
      "log",
      "undoStack",
      "redoStack",
      "nextId",
      "hash",
    ]);
    expect(doc.hash).toBe(hashWorld(world));
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.meta).toEqual({ name: world.meta.name, seed: 4242, created: CREATED });
    expect(doc.rng).toEqual([...world.rng.state]);
    expect(doc.log).toEqual(JSON.parse(JSON.stringify(world.log)));
    const terrain = doc.terrain as Record<string, unknown>;
    expect(Object.keys(terrain)).toEqual([
      "width",
      "height",
      "corners",
      "surface",
      "water",
      "path",
    ]);
    expect(terrain.corners).toEqual({ $t: "Int16Array", $b64: expect.any(String) });
    expect(terrain.surface).toEqual({ $t: "Uint8Array", $b64: expect.any(String) });
    expect(terrain.water).toEqual({ $t: "Uint8Array", $b64: expect.any(String) });
    expect(terrain.path).toEqual({ $t: "Uint8Array", $b64: expect.any(String) });
    // The park is plain JSON, in a fixed key order.
    expect(doc.park).toEqual(JSON.parse(JSON.stringify(world.park)));
    expect(Object.keys(doc.park as object)).toEqual([
      "name",
      "open",
      "entryFee",
      "entrance",
      "rating",
      "guestsInPark",
      "totalAdmissions",
      "income",
      "expenses",
      "monthly",
      "history",
    ]);
  });

  it("writes typed array bytes little-endian whatever the host", () => {
    const world = createWorld({ width: 1, height: 1, seed: 1, name: "t" });
    world.terrain.corners.set([0x0102, -2, 0, 255]);
    world.terrain.surface[0] = 3;
    const terrain = readDoc(serializeWorld(world)).terrain as {
      corners: { $b64: string };
      surface: { $b64: string };
    };
    // 0x0102 -> 02 01, -2 -> fe ff, 0 -> 00 00, 255 -> ff 00
    expect(Array.from(fromBase64(terrain.corners.$b64))).toEqual([
      0x02, 0x01, 0xfe, 0xff, 0x00, 0x00, 0xff, 0x00,
    ]);
    expect(Array.from(fromBase64(terrain.surface.$b64))).toEqual([3]);
  });

  it("compresses: a fresh 64x64 world is under 20 KB", () => {
    const bytes = serializeWorld(createWorld({ width: 64, height: 64, seed: 1, name: "size" }));
    expect(bytes.length).toBeLessThan(20 * 1024);
    // The JSON alone is bigger than the save, so gzip is on.
    expect(gunzipSync(bytes).length).toBeGreaterThan(bytes.length);
  });
});

describe("deserializeWorld errors", () => {
  it("throws SaveError for bytes that are not gzip", () => {
    expectSaveError(() => deserializeWorld(new Uint8Array(0)), "Save file is corrupt");
    expectSaveError(() => deserializeWorld(strToU8("hello, not a save")), "Save file is corrupt");
    expectSaveError(() => deserializeWorld(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
  });

  it("throws SaveError for a truncated save", () => {
    const bytes = serializeWorld(playedSim().world);
    expectSaveError(() => deserializeWorld(bytes.subarray(0, 10)), "Save file is corrupt");
    expectSaveError(
      () => deserializeWorld(bytes.subarray(0, bytes.length >> 1)),
      "Save file is corrupt",
    );
  });

  it("throws SaveError when the gzip holds something other than JSON", () => {
    const bytes = gzipSync(strToU8("this is not json {"), { mtime: 0 });
    expectSaveError(() => deserializeWorld(bytes), "Save file is corrupt");
  });

  it("throws SaveError when the JSON has no usable schema version", () => {
    for (const doc of [null, 7, "str", [], {}, { schemaVersion: "1" }, { schemaVersion: 1.5 }]) {
      expectSaveError(() => deserializeWorld(writeDoc(doc)), "Save file is corrupt");
    }
  });

  it("throws the exact newer-version message for schema 5", () => {
    const doc = readDoc(serializeWorld(freshWorld()));
    doc.schemaVersion = 5;
    expect(() => deserializeWorld(writeDoc(doc))).toThrow(SaveError);
    expect(() => deserializeWorld(writeDoc(doc))).toThrow(
      "Save is from a newer version (schema 5, this build reads 4)",
    );
    let caught: unknown;
    try {
      deserializeWorld(writeDoc(doc));
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe(
      "Save is from a newer version (schema 5, this build reads 4)",
    );
    expect((caught as Error).name).toBe("SaveError");
  });

  it("interpolates the versions into the newer-version message", () => {
    expectSaveError(
      () => deserializeWorld(writeDoc({ schemaVersion: 41 })),
      /^Save is from a newer version \(schema 41, this build reads 4\)$/,
    );
  });

  it("reports a newer version before it looks at the shape", () => {
    const doc = { schemaVersion: SCHEMA_VERSION + 1, somethingNew: true };
    expectSaveError(() => deserializeWorld(writeDoc(doc)), "newer version");
  });

  it("throws SaveError, with the reason, when the document has the wrong shape", () => {
    const good = readDoc(serializeWorld(freshWorld()));
    const cases: Record<string, (doc: Record<string, unknown>) => void> = {
      "missing terrain": (doc) => delete doc.terrain,
      "string tick": (doc) => (doc.tick = "5"),
      "fractional tick": (doc) => (doc.tick = 1.5),
      "short rng": (doc) => (doc.rng = [1, 2, 3]),
      "rng word out of range": (doc) => (doc.rng = [1, 2, 3, 2 ** 32]),
      "log is not an array": (doc) => (doc.log = {}),
      "log entry without a name": (doc) =>
        (doc.log = [{ id: 1, tick: 0, client: "player", cost: 0 }]),
      "unknown client": (doc) =>
        (doc.log = [{ id: 1, tick: 0, client: "ghost", name: "x", input: {}, cost: 0 }]),
      "zero width": (doc) => ((doc.terrain as Record<string, unknown>).width = 0),
      "oversized height": (doc) => ((doc.terrain as Record<string, unknown>).height = 257),
      "wrong array tag": (doc) =>
        ((doc.terrain as Record<string, unknown>).corners = {
          $t: "Uint8Array",
          $b64: "AAAA",
        }),
      "array without bytes": (doc) =>
        ((doc.terrain as Record<string, unknown>).surface = { $t: "Uint8Array" }),
      "stack of strings": (doc) => (doc.undoStack = ["a"]),
      "missing path layer": (doc) => delete (doc.terrain as Record<string, unknown>).path,
      "path layer with the wrong tag": (doc) =>
        ((doc.terrain as Record<string, unknown>).path = { $t: "Int16Array", $b64: "AAAA" }),
      "missing park": (doc) => delete doc.park,
      "park without a name": (doc) => delete (doc.park as Record<string, unknown>).name,
      "park that is not an object": (doc) => (doc.park = "open"),
      "open as a number": (doc) => ((doc.park as Record<string, unknown>).open = 1),
      "fractional entry fee": (doc) => ((doc.park as Record<string, unknown>).entryFee = 10.5),
      "entrance with a side of 4": (doc) =>
        ((doc.park as Record<string, unknown>).entrance = { x: 0, y: 0, side: 4 }),
      "entrance without a side": (doc) =>
        ((doc.park as Record<string, unknown>).entrance = { x: 0, y: 0 }),
      "income missing a field": (doc) =>
        ((doc.park as Record<string, unknown>).income = { entry: 0, rides: 0 }),
      "missing hash": (doc) => delete doc.hash,
      "numeric hash": (doc) => (doc.hash = 5),
    };
    for (const [label, damage] of Object.entries(cases)) {
      const doc = structuredClone(good);
      damage(doc);
      expect(() => deserializeWorld(writeDoc(doc)), label).toThrow(SaveError);
      expect(() => deserializeWorld(writeDoc(doc)), label).toThrow(/^Save file is invalid: /);
    }
  });

  it("throws 'Save file is corrupt' when an array has the wrong length", () => {
    const good = readDoc(serializeWorld(freshWorld(4, 3)));
    const tooShort = structuredClone(good);
    (tooShort.terrain as Record<string, unknown>).corners = {
      $t: "Int16Array",
      $b64: toBase64(new Uint8Array(10)),
    };
    expectSaveError(() => deserializeWorld(writeDoc(tooShort)), /^Save file is corrupt$/);

    const oddBytes = structuredClone(good);
    // 5 * 4 corners = 20 values = 40 bytes; 41 bytes is not a whole number of Int16 values.
    (oddBytes.terrain as Record<string, unknown>).corners = {
      $t: "Int16Array",
      $b64: toBase64(new Uint8Array(41)),
    };
    expectSaveError(() => deserializeWorld(writeDoc(oddBytes)), /^Save file is corrupt$/);

    const wrongWater = structuredClone(good);
    (wrongWater.terrain as Record<string, unknown>).water = {
      $t: "Uint8Array",
      $b64: toBase64(new Uint8Array(13)),
    };
    expectSaveError(() => deserializeWorld(writeDoc(wrongWater)), /^Save file is corrupt$/);
  });

  it("throws SaveError for bad base64 inside the document", () => {
    const doc = readDoc(serializeWorld(freshWorld(2, 2)));
    (doc.terrain as Record<string, unknown>).surface = { $t: "Uint8Array", $b64: "!!!!" };
    expectSaveError(() => deserializeWorld(writeDoc(doc)), /^Save file is corrupt/);
  });

  it("throws SaveError for an rng state of all zeros", () => {
    const doc = readDoc(serializeWorld(freshWorld()));
    doc.rng = [0, 0, 0, 0];
    expectSaveError(() => deserializeWorld(writeDoc(doc)), "Save file is corrupt");
  });

  it("never throws anything but SaveError, whatever one flipped byte does", () => {
    const bytes = serializeWorld(createWorld({ width: 3, height: 3, seed: 9, name: "flip" }));
    for (let i = 0; i < bytes.length; i++) {
      const damaged = Uint8Array.from(bytes);
      damaged[i] = (damaged[i] as number) ^ 0xff;
      try {
        deserializeWorld(damaged);
      } catch (error) {
        expect(error).toBeInstanceOf(SaveError);
      }
    }
  });
});

/** Flips the low bit of the first byte of one of the terrain arrays inside a document. */
function tamperTerrain(
  doc: Record<string, unknown>,
  key: "corners" | "surface" | "water" | "path",
): void {
  const terrain = doc.terrain as Record<string, { $b64: string }>;
  const bytes = fromBase64((terrain[key] as { $b64: string }).$b64);
  bytes[0] = (bytes[0] as number) ^ 1;
  (terrain[key] as { $b64: string }).$b64 = toBase64(bytes);
}

describe("save integrity", () => {
  it("loads a document that was unzipped and zipped again unchanged", () => {
    const world = playedSim().world;
    const loaded = deserializeWorld(writeDoc(readDoc(serializeWorld(world))));
    expect(hashWorld(loaded)).toBe(hashWorld(world));
  });

  it("refuses a save whose content was edited after it was written", () => {
    const world = playedSim().world;
    const edits: Record<string, (doc: Record<string, unknown>) => void> = {
      "a corner height": (doc) => tamperTerrain(doc, "corners"),
      "a surface byte": (doc) => tamperTerrain(doc, "surface"),
      "a water byte": (doc) => tamperTerrain(doc, "water"),
      "a path byte": (doc) => tamperTerrain(doc, "path"),
      "the park name": (doc) => ((doc.park as { name: string }).name += "!"),
      "the open flag": (doc) => ((doc.park as { open: boolean }).open = true),
      "the entry fee": (doc) => ((doc.park as { entryFee: number }).entryFee += 1),
      "the entrance": (doc) =>
        ((doc.park as { entrance: unknown }).entrance = { x: 0, y: 0, side: 0 }),
      "the rating": (doc) => ((doc.park as { rating: number }).rating += 1),
      "the admissions": (doc) => ((doc.park as { totalAdmissions: number }).totalAdmissions += 1),
      "monthly wages": (doc) => ((doc.park as { monthly: { wages: number } }).monthly.wages += 1),
      "a month of history": (doc) =>
        ((doc.park as { history: unknown[] }).history = [
          { year: 1, month: 0, entry: 1, rides: 0, shops: 0, running: 0, wages: 0, net: 1 },
        ]),
      cash: (doc) => {
        const finance = doc.finance as { cash: number };
        finance.cash += 1;
      },
      loan: (doc) => {
        const finance = doc.finance as { loan: number };
        finance.loan += 100;
      },
      "month start cash": (doc) => {
        const finance = doc.finance as { monthStart: { cash: number } };
        finance.monthStart.cash += 1;
      },
      tick: (doc) => (doc.tick = (doc.tick as number) + 1),
      "rng state": (doc) => {
        const rng = doc.rng as number[];
        rng[0] = ((rng[0] as number) ^ 1) >>> 0;
      },
      "next id": (doc) => (doc.nextId = (doc.nextId as number) + 1),
      "undo stack": (doc) => (doc.undoStack = []),
      "redo stack": (doc) => (doc.redoStack = [...(doc.redoStack as number[]), 1]),
      name: (doc) => {
        const meta = doc.meta as { name: string };
        meta.name += "!";
      },
      seed: (doc) => {
        const meta = doc.meta as { seed: number };
        meta.seed += 1;
      },
      "log length": (doc) => (doc.log = (doc.log as unknown[]).slice(1)),
    };
    for (const [label, edit] of Object.entries(edits)) {
      const doc = readDoc(serializeWorld(world));
      edit(doc);
      let caught: unknown;
      try {
        deserializeWorld(writeDoc(doc));
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(SaveError);
      expect((caught as SaveError).message, label).toBe("Save file is corrupt");
    }
  });

  it("refuses a save whose stored hash is wrong, even when the content is untouched", () => {
    const doc = readDoc(serializeWorld(playedSim().world));
    doc.hash = "0000000000000000";
    expectSaveError(() => deserializeWorld(writeDoc(doc)), /^Save file is corrupt$/);
    doc.hash = "";
    expectSaveError(() => deserializeWorld(writeDoc(doc)), /^Save file is corrupt$/);
  });

  it("never loads a damaged save as a different world, whatever one flipped byte does", () => {
    const world = createWorld({ width: 3, height: 3, seed: 9, name: "flip" });
    const expected = hashWorld(world);
    const bytes = serializeWorld(world);
    const payload = gunzipSync(bytes);
    // Our own gzip header has no optional fields, so it is 10 bytes; the trailer is the last 8.
    const bodyStart = 10;
    const trailerStart = bytes.length - 8;
    let loadedAnyway = 0;
    let refusedInBody = 0;
    for (const mask of [0x01, 0x80, 0xff]) {
      for (let i = 0; i < bytes.length; i++) {
        const damaged = Uint8Array.from(bytes);
        damaged[i] = (damaged[i] as number) ^ mask;
        const label = `byte ${i} xor ${mask}`;
        let loaded: World | undefined;
        try {
          loaded = deserializeWorld(damaged);
        } catch (error) {
          expect(error, label).toBeInstanceOf(SaveError);
          if (i >= bodyStart && i < trailerStart) refusedInBody++;
        }
        if (loaded !== undefined) {
          expect(hashWorld(loaded), label).toBe(expected);
          loadedAnyway++;
          // The CRC32 and length in the trailer are checked, so no flip there gets through. The
          // header and the deflate body can only load when the unzipped bytes did not change at
          // all, such as a flip in the timestamp or in the padding bits after the last block.
          expect(i, label).toBeLessThan(trailerStart);
          expect(Buffer.compare(gunzipSync(damaged), payload), label).toBe(0);
        }
      }
    }
    // Some flips land where they change nothing, such as the gzip header's OS byte.
    expect(loadedAnyway).toBeGreaterThan(0);
    // Flips in the compressed data that change what it unzips to are refused.
    expect(refusedInBody).toBeGreaterThan(0);
    // Three loads for every byte of the save: about 0.3 s on Linux and 2 to 3 s on a macOS CI
    // runner, and over the default 5 s there when the rest of the suite is busy.
  }, 30_000);

  it("refuses every change to the gzip trailer, though the content is intact", () => {
    const bytes = serializeWorld(playedSim().world);
    const payload = gunzipSync(bytes);
    // The last 8 bytes are the CRC32 of the unzipped bytes, then their length, little-endian.
    for (let i = bytes.length - 8; i < bytes.length; i++) {
      const damaged = Uint8Array.from(bytes);
      damaged[i] = (damaged[i] as number) ^ 0x01;
      // `fflate` ignores the CRC32 and unzips the same document, which the hash would accept.
      if (i < bytes.length - 4) expect(Buffer.compare(gunzipSync(damaged), payload)).toBe(0);
      expectSaveError(() => deserializeWorld(damaged), /^Save file is corrupt$/);
    }
    // A length one too big still unzips to the whole document, so only the length check sees it.
    const longer = Uint8Array.from(bytes);
    new DataView(longer.buffer).setUint32(longer.length - 4, payload.length + 1, true);
    expect(Buffer.compare(gunzipSync(longer), payload)).toBe(0);
    expectSaveError(() => deserializeWorld(longer), /^Save file is corrupt$/);
  });

  it("reads the trailer from the end, so a gzip header with a file name still loads", () => {
    const world = playedSim().world;
    const payload = gunzipSync(serializeWorld(world));
    const named = gzipSync(payload, { mtime: 0, filename: "my.park" });
    expect(named.length).toBeGreaterThan(serializeWorld(world).length);
    expect(hashWorld(deserializeWorld(named))).toBe(hashWorld(world));
  });
});

/** Runs `run` with `step` registered as the migration from schema 0, and always removes it. */
function withMigrationFromZero<T>(step: Migration, run: () => T): T {
  MIGRATIONS[0] = step;
  try {
    return run();
  } finally {
    delete MIGRATIONS[0];
  }
}

/** A schema 0 save: the current document with its version changed, zipped. */
function oldSave(
  world: World,
  edit: (doc: Record<string, unknown>) => void = () => {},
): Uint8Array {
  const doc = readDoc(serializeWorld(world));
  doc.schemaVersion = 0;
  // Schema 0 comes before the path layer and the park state, and before guests and their stream;
  // the migrations from 1 and from 2 add them back.
  delete (doc.terrain as Record<string, unknown>).path;
  delete doc.park;
  delete doc.guests;
  delete doc.rngStreams;
  edit(doc);
  return writeDoc(doc);
}

const addFiveHundredCents: Migration = (old) => {
  const doc = old as { finance: { cash: number } };
  return { ...doc, finance: { ...doc.finance, cash: doc.finance.cash + 500 } };
};

describe("migration and the stored hash", () => {
  it("loads a migrated save whose stored hash no longer matches, and rehashes the world it built", () => {
    const world = playedSim().world;
    const storedHash = hashWorld(world);
    const bytes = oldSave(world);

    const loaded = withMigrationFromZero(addFiveHundredCents, () => deserializeWorld(bytes));

    // The world the migration should have produced, built another way.
    const expected = deserializeWorld(serializeWorld(world));
    expected.finance.cash += 500;
    expect(loaded.finance.cash).toBe(world.finance.cash + 500);
    expect(hashWorld(loaded)).toBe(hashWorld(expected));
    expect(hashWorld(loaded)).not.toBe(storedHash);
    expect(loaded.meta.schemaVersion).toBe(SCHEMA_VERSION);
    // Saved again, it is a current save whose hash is the new one.
    expect(readDoc(serializeWorld(loaded)).hash).toBe(hashWorld(loaded));
    expect(hashWorld(deserializeWorld(serializeWorld(loaded)))).toBe(hashWorld(loaded));
  });

  it("does not compare the stored hash of a migrated save, even a blank one", () => {
    const world = playedSim().world;
    const bytes = oldSave(world, (doc) => (doc.hash = ""));
    const loaded = withMigrationFromZero(
      (old) => old,
      () => deserializeWorld(bytes),
    );
    expect(hashWorld(loaded)).toBe(hashWorld(world));
  });

  it("still compares the stored hash of a save that is already current", () => {
    const doc = readDoc(serializeWorld(playedSim().world));
    (doc.finance as { cash: number }).cash += 500;
    withMigrationFromZero(addFiveHundredCents, () =>
      expectSaveError(() => deserializeWorld(writeDoc(doc)), /^Save file is corrupt$/),
    );
  });

  it("still refuses a migrated save whose gzip trailer is damaged", () => {
    const bytes = oldSave(playedSim().world);
    const damaged = Uint8Array.from(bytes);
    damaged[bytes.length - 8] = (damaged[bytes.length - 8] as number) ^ 0x01;
    withMigrationFromZero(
      (old) => old,
      () => {
        expect(() => deserializeWorld(bytes)).not.toThrow();
        expectSaveError(() => deserializeWorld(damaged), /^Save file is corrupt$/);
      },
    );
  });

  it("still holds a migrated save to the load invariants", () => {
    // Without the hash check, the invariants are what stops a migration that loses the id counter.
    const bytes = oldSave(playedSim().world);
    withMigrationFromZero(
      (old) => ({ ...(old as object), nextId: 1 }),
      () => expectSaveError(() => deserializeWorld(bytes), /^Save file is corrupt$/),
    );
  });
});

/** A finished month for the history, with any figures overridden. */
function month(overrides: Partial<MonthRecord> = {}): MonthRecord {
  return {
    year: 1,
    month: 0,
    entry: 10_00,
    rides: 0,
    shops: 0,
    running: 4_00,
    wages: 0,
    net: 6_00,
    ...overrides,
  };
}

/** Ways to break a world that `playedSim` makes (log ids 1 to 4, `nextId` 5, stacks [1, 2] and [3]). */
const VIOLATIONS: Array<[string, (world: World) => void, RegExp]> = [
  ["a corner above the highest height", (w) => (w.terrain.corners[5] = MAX_HEIGHT + 1), /corner/],
  ["a corner below zero", (w) => (w.terrain.corners[5] = -1), /corner/],
  ["a surface above 4", (w) => (w.terrain.surface[3] = 5), /surface/],
  ["a water level above the highest height", (w) => (w.terrain.water[3] = MAX_HEIGHT + 1), /water/],
  ["a path value above 2", (w) => (w.terrain.path[3] = 3), /path 3/],
  [
    "an entrance off the map",
    (w) => (w.park.entrance = { x: 16, y: 0, side: 0 }),
    /entrance.*outside/,
  ],
  [
    "an entrance off the map edge",
    (w) => (w.park.entrance = { x: 5, y: 5, side: 0 }),
    /not on the map edge/,
  ],
  ["a negative entry fee", (w) => (w.park.entryFee = -1), /entry fee/],
  ["an entry fee above $100", (w) => (w.park.entryFee = 100_01), /entry fee/],
  ["a negative rating", (w) => (w.park.rating = -1), /rating/],
  ["a rating above 999", (w) => (w.park.rating = 1000), /rating/],
  ["negative guests in the park", (w) => (w.park.guestsInPark = -1), /guestsInPark/],
  ["negative admissions", (w) => (w.park.totalAdmissions = -1), /totalAdmissions/],
  ["negative entry income", (w) => (w.park.income.entry = -1), /income\.entry/],
  ["negative wage expenses", (w) => (w.park.expenses.wages = -1), /expenses\.wages/],
  ["negative monthly shop income", (w) => (w.park.monthly.shops = -1), /monthly\.shops/],
  [
    "thirteen months of history",
    (w) => (w.park.history = Array.from({ length: 13 }, (_, i) => month({ month: i % 8 }))),
    /history holds 13 months, more than 12/,
  ],
  ["a history year of 0", (w) => (w.park.history = [month({ year: 0 })]), /history\[0\]\.year/],
  [
    "a history month of 8",
    (w) => (w.park.history = [month(), month({ month: 8 })]),
    /history\[1\]\.month/,
  ],
  [
    "a history month below 0",
    (w) => (w.park.history = [month({ month: -1 })]),
    /history\[0\]\.month/,
  ],
  [
    "negative history income",
    (w) => (w.park.history = [month({ shops: -1 })]),
    /history\[0\]\.shops/,
  ],
  [
    "negative history wages",
    (w) => (w.park.history = [month({ wages: -5 })]),
    /history\[0\]\.wages/,
  ],
  [
    "a log id used twice",
    (w) => ((w.log[1] as { id: number }).id = (w.log[0] as { id: number }).id),
    /log id/,
  ],
  [
    "log ids out of order",
    (w) =>
      w.log.splice(0, 2, w.log[1] as (typeof w.log)[number], w.log[0] as (typeof w.log)[number]),
    /log id/,
  ],
  ["a log id of zero", (w) => ((w.log[0] as { id: number }).id = 0), /log id/],
  ["a log id that is not below nextId", (w) => (w.nextId = 4), /nextId/],
  ["an undo stack id with no log entry", (w) => w.undoStack.push(99), /undo stack/],
  ["a redo stack id with no log entry", (w) => w.redoStack.push(99), /redo stack/],
  [
    "an id in both stacks",
    (w) => w.redoStack.push(w.undoStack[0] as number),
    /both the undo stack and the redo stack/,
  ],
  ["an id twice in one stack", (w) => w.undoStack.push(w.undoStack[0] as number), /more than once/],
];

describe("validateWorldInvariants", () => {
  it("accepts a fresh world, a played one, and the extreme legal values", () => {
    expect(validateWorldInvariants(freshWorld())).toBeNull();
    const played = playedSim().world;
    expect(played.undoStack.length).toBeGreaterThan(0);
    expect(played.redoStack.length).toBeGreaterThan(0);
    expect(validateWorldInvariants(played)).toBeNull();

    const extremes = freshWorld(2, 2);
    extremes.terrain.corners.set([0, MAX_HEIGHT, 0, MAX_HEIGHT, 0, MAX_HEIGHT, 0, MAX_HEIGHT, 0]);
    extremes.terrain.surface.set([0, 4, 0, 4]);
    extremes.terrain.water.set([0, MAX_HEIGHT, 0, MAX_HEIGHT]);
    expect(validateWorldInvariants(extremes)).toBeNull();
  });

  it("accepts an entrance on any edge, a free park, a $100 fee, and the highest rating", () => {
    const world = freshWorld(5, 4);
    for (const [x, y] of [
      [0, 0],
      [4, 0],
      [2, 0],
      [4, 2],
      [2, 3],
      [0, 2],
      [4, 3],
    ] as const) {
      world.park.entrance = { x, y, side: 0 };
      expect(validateWorldInvariants(world), `(${x}, ${y})`).toBeNull();
    }
    world.park.entryFee = 0;
    expect(validateWorldInvariants(world)).toBeNull();
    world.park.entryFee = 100_00;
    world.park.rating = 999;
    expect(validateWorldInvariants(world)).toBeNull();
    world.park.rating = 0;
    world.terrain.path.fill(2);
    expect(validateWorldInvariants(world)).toBeNull();
  });

  it("accepts twelve months of history, a loss, and the last month of a later year", () => {
    const world = freshWorld();
    world.park.history = Array.from({ length: 12 }, (_, i) => month({ year: 2, month: i % 8 }));
    expect(validateWorldInvariants(world)).toBeNull();
    world.park.history = [month({ month: 7, net: -4_00, entry: 0, running: 4_00 })];
    expect(validateWorldInvariants(world)).toBeNull();
  });

  it("refuses a history figure that is not a whole number of cents", () => {
    const world = freshWorld();
    world.park.history = [month({ entry: 1.5 })];
    expect(validateWorldInvariants(world)).toMatch(/history\[0\]\.entry.*whole number/);
    world.park.history = [month(), month({ net: Number.NaN })];
    expect(validateWorldInvariants(world)).toMatch(/history\[1\]\.net/);
  });

  it("allows a stack entry that has no undo data, as a loan does", () => {
    const played = playedSim().world;
    const loan = played.log.find((entry) => entry.name === "finance_take_loan");
    expect(loan).toBeDefined();
    expect("undo" in (loan as object)).toBe(false);
    expect(played.undoStack).toContain(loan?.id);
    expect(validateWorldInvariants(played)).toBeNull();
  });

  it.each(VIOLATIONS)("reports %s", (_label, damage, reason) => {
    const world = playedSim().world;
    expect(validateWorldInvariants(world)).toBeNull();
    damage(world);
    expect(validateWorldInvariants(world)).toMatch(reason);
  });
});

describe("deserializeWorld and the load invariants", () => {
  it.each(VIOLATIONS)(
    "refuses a save with %s, though its hash and gzip are intact",
    (_label, damage, reason) => {
      const world = playedSim().world;
      damage(world);
      // `serializeWorld` hashes the damaged world, so only the invariants can refuse this save.
      const bytes = serializeWorld(world);
      let caught: unknown;
      try {
        deserializeWorld(bytes);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SaveError);
      expect((caught as SaveError).message).toBe("Save file is corrupt");
      expect(((caught as SaveError).cause as Error).message).toMatch(reason);
    },
  );

  it("still loads the largest legal terrain values", () => {
    const world = freshWorld(2, 2);
    world.terrain.corners.fill(MAX_HEIGHT);
    world.terrain.surface.fill(4);
    world.terrain.water.fill(MAX_HEIGHT);
    const loaded = deserializeWorld(serializeWorld(world));
    expect(hashWorld(loaded)).toBe(hashWorld(world));
  });
});

describe("migrate", () => {
  it("is the identity on a current-version document", () => {
    const doc = { schemaVersion: SCHEMA_VERSION, anything: [1, 2, 3] };
    expect(migrate(doc)).toBe(doc);
  });

  it("has a migration for each schema before the current one, and none after", () => {
    expect(Object.keys(MIGRATIONS).map(Number)).toEqual([1, 2, 3]);
    expect(SCHEMA_VERSION).toBe(4);
  });

  it("runs the migration for the document's version and stamps the new schema version", () => {
    const migrations = {
      0: (doc: unknown) => {
        const old = doc as { schemaVersion: number; title: string };
        return { schemaVersion: old.schemaVersion, name: old.title };
      },
      1: (doc: unknown) => doc,
      2: (doc: unknown) => doc,
      3: (doc: unknown) => doc,
    };
    const input = { schemaVersion: 0, title: "Old Park" };
    const out = migrate(input, migrations);
    expect(out).toEqual({ schemaVersion: SCHEMA_VERSION, name: "Old Park" });
    // The caller's document is left as it was.
    expect(input).toEqual({ schemaVersion: 0, title: "Old Park" });
  });

  it("stops at the current schema version and ignores later entries", () => {
    const migrations = {
      0: (doc: unknown) => ({ ...(doc as object), ranZero: true }),
      1: (doc: unknown) => doc,
      2: (doc: unknown) => doc,
      3: (doc: unknown) => doc,
      [SCHEMA_VERSION]: (doc: unknown) => ({ ...(doc as object), ranCurrent: true }),
    };
    const out = migrate({ schemaVersion: 0 }, migrations) as Record<string, unknown>;
    expect(out.ranZero).toBe(true);
    expect(out).not.toHaveProperty("ranCurrent");
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("does not run any migration for a current or newer document", () => {
    const migrations = {
      [SCHEMA_VERSION]: () => {
        throw new Error("must not run");
      },
    };
    const current = { schemaVersion: SCHEMA_VERSION };
    expect(migrate(current, migrations)).toBe(current);
    const newer = { schemaVersion: SCHEMA_VERSION + 1 };
    expect(migrate(newer, migrations)).toBe(newer);
  });

  it("throws SaveError when a version has no migration", () => {
    expectSaveError(() => migrate({ schemaVersion: 0 }), /no migration from schema 0/i);
  });

  it("throws SaveError when the document or its version is unusable", () => {
    for (const doc of [null, undefined, 3, "x", [], {}, { schemaVersion: "1" }]) {
      expectSaveError(() => migrate(doc), "Save file is corrupt");
    }
  });

  it("wraps an error thrown by a migration in a SaveError, keeping the cause", () => {
    const boom = new TypeError("Cannot read properties of undefined (reading 'x')");
    let caught: unknown;
    try {
      migrate(
        { schemaVersion: 0 },
        {
          0: () => {
            throw boom;
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SaveError);
    expect((caught as SaveError).message).toBe("Save file is corrupt");
    expect((caught as SaveError).cause).toBe(boom);
  });

  it("passes a SaveError thrown by a migration through unchanged", () => {
    const own = new SaveError("Park is too old to read");
    let caught: unknown;
    try {
      migrate(
        { schemaVersion: 0 },
        {
          0: () => {
            throw own;
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(own);
  });

  it("throws SaveError when a migration returns something that is not a document", () => {
    expectSaveError(() => migrate({ schemaVersion: 0 }, { 0: () => 5 }), "Save file is corrupt");
  });

  it("is applied by deserializeWorld to older saves", () => {
    // A fake schema-0 save: no migration is registered for it, so loading it is refused.
    const doc = readDoc(serializeWorld(freshWorld()));
    doc.schemaVersion = 0;
    expectSaveError(() => deserializeWorld(writeDoc(doc)), /no migration from schema 0/i);
  });
});

const V1_FIXTURE = fromBase64(
  readFileSync(new URL("./fixtures/sample-v1.park.b64", import.meta.url), "utf8").trim(),
);

/**
 * The `hashWorld` of the schema 1 fixture, as the current build computes it once it is loaded.
 * (Re-pinned for schema 4: the park state the hash covers gained `history`.)
 */
const V1_FIXTURE_LOADED_HASH = "e39894caa776ed75";

describe("schema 1 saves", () => {
  it("has a fixture that really is a schema 1 document, without paths or a park", () => {
    const doc = readDoc(V1_FIXTURE);
    expect(doc.schemaVersion).toBe(1);
    expect(doc).not.toHaveProperty("park");
    expect(doc.terrain as object).not.toHaveProperty("path");
    // The hash it carries is the one the schema 1 build computed, which is not ours.
    expect(doc.hash).toBe("6346222bbd77599f");
  });

  it("loads as the current schema with an empty path layer and a default, closed park", () => {
    const world = deserializeWorld(V1_FIXTURE);
    expect(world.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(world.meta.name).toBe("Leafy Lake");
    expect(world.terrain.width).toBe(64);
    expect(world.terrain.height).toBe(64);
    expect(world.terrain.path).toBeInstanceOf(Uint8Array);
    expect(world.terrain.path).toHaveLength(64 * 64);
    expect(world.terrain.path.every((v) => v === 0)).toBe(true);
    expect(world.park).toStrictEqual({
      name: "Leafy Lake",
      open: false,
      entryFee: 10_00,
      entrance: null,
      rating: 500,
      guestsInPark: 0,
      totalAdmissions: 0,
      income: { entry: 0, rides: 0, shops: 0 },
      expenses: { running: 0, wages: 0 },
      monthly: { entry: 0, rides: 0, shops: 0, running: 0, wages: 0 },
      history: [],
    });
    expect(world.pathVersion).toBe(0);
    // And it came through the schema 2 to 3 step as well: no guests, and a stream for them.
    expect(world.guests.count).toBe(0);
    expect(world.guests.nextGuestId).toBe(1);
    expect(world.rngStreams.guests.state).toEqual(new Rng(world.meta.seed).fork("guests").state);
  });

  it("keeps everything else it had: the terrain, the money, and the log", () => {
    const world = deserializeWorld(V1_FIXTURE);
    expect(world.finance).toStrictEqual({
      cash: 10_000_00,
      loan: 0,
      monthStart: { cash: 10_000_00 },
    });
    expect(world.log).toHaveLength(18);
    expect(world.log.every((entry) => entry.client === "system")).toBe(true);
    expect(world.terrain.water.some((v) => v > 0)).toBe(true);
    expect(world.terrain.surface.includes(3)).toBe(true);
    expect(world.undoStack).toEqual([]);
  });

  it("loads without comparing the schema 1 hash, and hashes to a pinned value", () => {
    const world = deserializeWorld(V1_FIXTURE);
    expect(hashWorld(world)).not.toBe("6346222bbd77599f");
    expect(hashWorld(world)).toBe(V1_FIXTURE_LOADED_HASH);
    // Loading it twice gives the same world.
    expect(hashWorld(deserializeWorld(V1_FIXTURE))).toBe(V1_FIXTURE_LOADED_HASH);
  });

  it("saves again as a current schema, with the new hash, and reloads to the same world", () => {
    const world = deserializeWorld(V1_FIXTURE);
    const resaved = serializeWorld(world);
    const doc = readDoc(resaved);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.hash).toBe(V1_FIXTURE_LOADED_HASH);
    expect(hashWorld(deserializeWorld(resaved))).toBe(V1_FIXTURE_LOADED_HASH);
  });

  it("is a park the player can carry on with: lay a path, place the entrance, open", () => {
    const sim = new Sim(deserializeWorld(V1_FIXTURE));
    expect(sim.execute("park_set_entrance", { x: 32, y: 63 }).ok).toBe(true);
    expect(sim.execute("path_build", { x: 32, y: 55, w: 1, h: 8, kind: "foot" }).ok).toBe(true);
    expect(sim.execute("park_open", {}).ok).toBe(true);
    expect(sim.world.park.open).toBe(true);
  });
});

describe("MIGRATIONS[1]", () => {
  const v1Doc = () => ({
    schemaVersion: 1,
    meta: { name: "Old Park", seed: 3, created: "" },
    terrain: { width: 3, height: 2, corners: { $t: "Int16Array", $b64: "" } },
    rng: [1, 2, 3, 4],
  });

  it("adds a path layer of zeros the size of the map, and a default park named after the world", () => {
    const step = MIGRATIONS[1] as Migration;
    const out = step(v1Doc()) as {
      terrain: Record<string, unknown>;
      park: unknown;
      meta: unknown;
    };
    expect(out.terrain.path).toEqual({ $t: "Uint8Array", $b64: toBase64(new Uint8Array(6)) });
    expect(Array.from(fromBase64((out.terrain.path as { $b64: string }).$b64))).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(out.terrain.width).toBe(3);
    expect(out.park).toEqual({
      name: "Old Park",
      open: false,
      entryFee: 10_00,
      entrance: null,
      rating: 500,
      guestsInPark: 0,
      totalAdmissions: 0,
      income: { entry: 0, rides: 0, shops: 0 },
      expenses: { running: 0, wages: 0 },
      monthly: { entry: 0, rides: 0, shops: 0, running: 0, wages: 0 },
    });
    expect(out.meta).toEqual({ name: "Old Park", seed: 3, created: "" });
  });

  it("leaves the document it was given as it was", () => {
    const doc = v1Doc();
    (MIGRATIONS[1] as Migration)(doc);
    expect(doc).toEqual(v1Doc());
  });

  it("is run by migrate, which carries on through the later steps to the current schema", () => {
    const out = migrate(v1Doc()) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out).toHaveProperty("park");
    expect(out).toHaveProperty("guests");
    expect(out).toHaveProperty("rngStreams");
  });

  it("gives a map with unusable dimensions no path layer, so the schema check says why", () => {
    const doc = readDoc(V1_FIXTURE);
    (doc.terrain as Record<string, unknown>).width = 0;
    expectSaveError(() => deserializeWorld(writeDoc(doc)), /^Save file is invalid: /);
    const huge = readDoc(V1_FIXTURE);
    (huge.terrain as Record<string, unknown>).height = 2 ** 31;
    expectSaveError(() => deserializeWorld(writeDoc(huge)), /^Save file is invalid: /);
  });

  it("refuses a document with no terrain or no meta block as corrupt", () => {
    const step = MIGRATIONS[1] as Migration;
    for (const doc of [null, 5, [], { schemaVersion: 1 }, { schemaVersion: 1, meta: {} }]) {
      expectSaveError(() => migrate(doc), "Save file is corrupt");
    }
    expect(() => step({ meta: {}, terrain: 3 })).toThrow(SaveError);
  });
});

const V2_FIXTURE = fromBase64(
  readFileSync(new URL("./fixtures/sample-v2.park.b64", import.meta.url), "utf8").trim(),
);

/**
 * The `hashWorld` of the schema 2 fixture, as the current build computes it once it is loaded.
 * (Re-pinned for schema 4: the park state the hash covers gained `history`.)
 */
const V2_FIXTURE_LOADED_HASH = "2696e5afec5cba88";

describe("schema 2 saves", () => {
  it("has a fixture that really is a schema 2 document, with a park but no guests", () => {
    const doc = readDoc(V2_FIXTURE);
    expect(doc.schemaVersion).toBe(2);
    expect(doc).toHaveProperty("park");
    expect(doc).not.toHaveProperty("guests");
    expect(doc).not.toHaveProperty("rngStreams");
    // The hash it carries is the one the schema 2 build computed, which is not ours.
    expect(doc.hash).toBe("9fa382566ef94c23");
  });

  it("loads as the current schema with an empty guest store and a stream of its own", () => {
    const world = deserializeWorld(V2_FIXTURE);
    expect(world.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(world.guests.count).toBe(0);
    expect(world.guests.nextGuestId).toBe(1);
    expect(world.guests.fragmented).toBe(false);
    expect(world.guests.freeCount).toBe(GUEST_CAP);
    for (const [name] of GUEST_ARRAYS) {
      expect(world.guests[name], name).toHaveLength(GUEST_CAP);
    }
    // The stream is what a world created from this seed would have had.
    expect(world.rngStreams.guests.state).toEqual(new Rng(7).fork("guests").state);
    expect(world.rngStreams.guests.state).toEqual(world.rng.fork("guests").state);
  });

  it("keeps the park it had: the entrance, the fee, the paths, the log, and the clock", () => {
    const world = deserializeWorld(V2_FIXTURE);
    expect(world.tick).toBe(300);
    expect(world.park).toMatchObject({
      name: "Leafy Lake",
      open: true,
      entryFee: 12_00,
      entrance: { x: 40, y: 63, side: 2 },
      rating: 500,
      guestsInPark: 0,
      totalAdmissions: 0,
    });
    expect(world.terrain.path.filter((v) => v === 1)).toHaveLength(13 + 7);
    expect(world.log).toHaveLength(24);
  });

  it("loads without comparing the schema 2 hash, and hashes to a pinned value", () => {
    const world = deserializeWorld(V2_FIXTURE);
    expect(hashWorld(world)).not.toBe("9fa382566ef94c23");
    expect(hashWorld(world)).toBe(V2_FIXTURE_LOADED_HASH);
    expect(hashWorld(deserializeWorld(V2_FIXTURE))).toBe(V2_FIXTURE_LOADED_HASH);
  });

  it("saves again as the current schema and reloads to the same world", () => {
    const world = deserializeWorld(V2_FIXTURE);
    const resaved = serializeWorld(world);
    const doc = readDoc(resaved);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.hash).toBe(V2_FIXTURE_LOADED_HASH);
    expect(hashWorld(deserializeWorld(resaved))).toBe(V2_FIXTURE_LOADED_HASH);
  });

  it("is a park the guests can come to: it is open, so they arrive and pay", () => {
    const sim = new Sim(deserializeWorld(V2_FIXTURE));
    sim.step(2500);
    expect(sim.world.guests.nextGuestId).toBeGreaterThan(1);
    expect(sim.world.park.totalAdmissions).toBeGreaterThan(0);
    expect(sim.world.park.income.entry).toBe(sim.world.park.totalAdmissions * 12_00);
    expect(sim.world.park.guestsInPark).toBeGreaterThan(0);
  });
});

describe("MIGRATIONS[2]", () => {
  const v2Doc = () => ({ schemaVersion: 2, rng: [1, 2, 3, 4], other: { kept: true } });

  it("adds an empty guest store: no guests, ids from 1, and an empty array for each field", () => {
    const out = (MIGRATIONS[2] as Migration)(v2Doc()) as {
      guests: Record<string, unknown>;
      other: unknown;
    };
    expect(out.other).toEqual({ kept: true });
    // The arrays schema 3 had: `lostTicks` came with schema 4.
    const schema3 = GUEST_ARRAYS.filter(([name]) => name !== "lostTicks");
    expect(Object.keys(out.guests)).toEqual(["count", "nextGuestId", ...schema3.map(([n]) => n)]);
    expect(out.guests.count).toBe(0);
    expect(out.guests.nextGuestId).toBe(1);
    for (const [name, kind] of schema3) {
      expect(out.guests[name], name).toEqual({ $t: kind, $b64: "" });
    }
  });

  it("gives the guests the stream forked off the root generator, as createWorld does", () => {
    const out = (MIGRATIONS[2] as Migration)(v2Doc()) as { rngStreams: { guests: number[] } };
    expect(out.rngStreams.guests).toEqual([...Rng.fromState([1, 2, 3, 4]).fork("guests").state]);
    // The root itself is left alone.
    expect((out as unknown as { rng: number[] }).rng).toEqual([1, 2, 3, 4]);
  });

  it("leaves the document it was given as it was", () => {
    const doc = v2Doc();
    (MIGRATIONS[2] as Migration)(doc);
    expect(doc).toEqual(v2Doc());
  });

  it("is run by migrate, which carries on through the later steps to the current schema", () => {
    const out = migrate({ ...v2Doc(), park: { name: "Old" } }) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out).toHaveProperty("guests");
    expect(out).toHaveProperty("rngStreams");
    expect((out.park as { history: unknown }).history).toEqual([]);
  });

  it("refuses a document with no usable root generator as corrupt", () => {
    const step = MIGRATIONS[2] as Migration;
    for (const doc of [
      null,
      5,
      [],
      { schemaVersion: 2 },
      { schemaVersion: 2, rng: "abc" },
      { schemaVersion: 2, rng: [1, 2, 3] },
      { schemaVersion: 2, rng: [0, 0, 0, 0] },
      { schemaVersion: 2, rng: [1, 2, 3, 2 ** 32] },
    ]) {
      expectSaveError(() => migrate(doc), "Save file is corrupt");
    }
    expect(() => step(null)).toThrow(SaveError);
  });
});

const V3_FIXTURE = fromBase64(
  readFileSync(new URL("./fixtures/sample-v3.park.b64", import.meta.url), "utf8").trim(),
);

/** The `hashWorld` of the schema 3 fixture, as the current build computes it once it is loaded. */
const V3_FIXTURE_LOADED_HASH = "41129abd7995cfb6";

/**
 * Builds the world the schema 3 fixture was saved from, with the current build: the sample park's
 * terrain as it was before the park was laid out on it (`withPark: false`), its entrance, a
 * footpath, a $4.00 fee, and 3,000 ticks open.
 */
function rebuildV3Fixture(): Sim {
  const sim = new Sim(createSamplePark(7, { withPark: false }));
  for (const [name, input] of [
    ["park_set_entrance", { x: 40, y: 63 }],
    ["path_build", { x: 40, y: 50, w: 1, h: 13, kind: "foot" }],
    ["path_build", { x: 40, y: 50, w: 8, h: 1, kind: "foot" }],
    ["park_set_entry_fee", { cents: 4_00 }],
    ["park_rename", { name: "Leafy Lake" }],
    ["park_open", {}],
  ] as const) {
    expect(sim.execute(name, input, "system").ok, name).toBe(true);
  }
  sim.step(3000);
  return sim;
}

describe("schema 3 saves", () => {
  it("has a fixture that really is a schema 3 document: no park history, no lost times", () => {
    const doc = readDoc(V3_FIXTURE);
    expect(doc.schemaVersion).toBe(3);
    expect(doc.park as object).not.toHaveProperty("history");
    const guests = doc.guests as Record<string, unknown>;
    expect(guests).not.toHaveProperty("lostTicks");
    expect(guests).toHaveProperty("sinceAction");
    expect(guests.count).toBe(57);
    // The hash it carries is the one the schema 3 build computed, which is not ours.
    expect(doc.hash).toBe("1c4249a9b14da514");
  });

  it("loads as the current schema with no history and a lost time of zero for every guest", () => {
    const world = deserializeWorld(V3_FIXTURE);
    expect(world.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(world.park.history).toEqual([]);
    expect(world.guests.count).toBe(57);
    expect(world.guests.lostTicks).toHaveLength(GUEST_CAP);
    expect(world.guests.lostTicks.every((v) => v === 0)).toBe(true);
  });

  it("keeps the park, the guests, and the clock it had", () => {
    const world = deserializeWorld(V3_FIXTURE);
    expect(world.tick).toBe(3000);
    expect(world.park).toMatchObject({
      name: "Leafy Lake",
      open: true,
      entryFee: 4_00,
      entrance: { x: 40, y: 63, side: 2 },
      rating: 590,
      guestsInPark: 57,
      totalAdmissions: 57,
      income: { entry: 228_00, rides: 0, shops: 0 },
      monthly: { entry: 228_00, rides: 0, shops: 0, running: 0, wages: 0 },
    });
    // Every guest array came across as it was written.
    const raw = (readDoc(V3_FIXTURE).guests as Record<string, { $b64: string }>)["happiness"];
    expect(Array.from(world.guests.happiness.subarray(0, 57))).toEqual(
      Array.from(fromBase64((raw as { $b64: string }).$b64)),
    );
    expect(world.guests.nextGuestId).toBe(58);
  });

  it("loads without comparing the schema 3 hash, and hashes to a pinned value", () => {
    const world = deserializeWorld(V3_FIXTURE);
    expect(hashWorld(world)).not.toBe("1c4249a9b14da514");
    expect(hashWorld(world)).toBe(V3_FIXTURE_LOADED_HASH);
    expect(hashWorld(deserializeWorld(V3_FIXTURE))).toBe(V3_FIXTURE_LOADED_HASH);
  });

  it("is the very world the current build makes from the same steps", () => {
    // Nothing in those 3,000 ticks differs between the builds, so the migrated save and a park
    // run from scratch have to agree on everything the hash covers.
    expect(hashWorld(rebuildV3Fixture().world)).toBe(V3_FIXTURE_LOADED_HASH);
  });

  it("saves again as the current schema and reloads to the same world", () => {
    const world = deserializeWorld(V3_FIXTURE);
    const resaved = serializeWorld(world);
    const doc = readDoc(resaved);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.hash).toBe(V3_FIXTURE_LOADED_HASH);
    expect((doc.park as { history: unknown }).history).toEqual([]);
    expect(hashWorld(deserializeWorld(resaved))).toBe(V3_FIXTURE_LOADED_HASH);
  });

  it("carries on as the original would: the month turns, then the park closes and empties", () => {
    const loaded = new Sim(deserializeWorld(V3_FIXTURE));
    const original = rebuildV3Fixture();
    loaded.step(12_400 - 3000);
    original.step(12_400 - 3000);
    expect(loaded.hash()).toBe(original.hash());

    const { park } = loaded.world;
    expect(park.history).toHaveLength(1);
    expect(park.history[0]).toMatchObject({ year: 1, month: 0, rides: 0, shops: 0 });
    // What the first month took is in the book; what the second has taken since is not.
    expect((park.history[0] as MonthRecord).entry + park.monthly.entry).toBe(park.income.entry);

    expect(loaded.execute("park_close", {}).ok).toBe(true);
    expect(original.execute("park_close", {}).ok).toBe(true);
    loaded.step(3000);
    original.step(3000);
    expect(loaded.world.guests.count).toBe(0);
    expect(loaded.world.park.guestsInPark).toBe(0);
    expect(loaded.hash()).toBe(original.hash());
  });
});

describe("MIGRATIONS[3]", () => {
  const v3Doc = (count = 3) => ({
    schemaVersion: 3,
    park: { name: "Old", open: true },
    guests: { count, nextGuestId: count + 1 },
    other: { kept: true },
  });

  it("gives the park an empty history", () => {
    const out = (MIGRATIONS[3] as Migration)(v3Doc()) as { park: unknown; other: unknown };
    expect(out.park).toEqual({ name: "Old", open: true, history: [] });
    expect(out.other).toEqual({ kept: true });
  });

  it("gives the guests a lost time of zero each: one 32-bit zero per guest", () => {
    const out = (MIGRATIONS[3] as Migration)(v3Doc(3)) as {
      guests: { count: number; nextGuestId: number; lostTicks: { $t: string; $b64: string } };
    };
    expect(out.guests.count).toBe(3);
    expect(out.guests.nextGuestId).toBe(4);
    expect(out.guests.lostTicks.$t).toBe("Int32Array");
    expect(Array.from(fromBase64(out.guests.lostTicks.$b64))).toEqual(Array(12).fill(0));
    // No guests: an empty array.
    const empty = (MIGRATIONS[3] as Migration)(v3Doc(0)) as { guests: { lostTicks: unknown } };
    expect(empty.guests.lostTicks).toEqual({ $t: "Int32Array", $b64: "" });
    // A full house.
    const full = (MIGRATIONS[3] as Migration)(v3Doc(GUEST_CAP)) as {
      guests: { lostTicks: { $b64: string } };
    };
    expect(fromBase64(full.guests.lostTicks.$b64)).toHaveLength(GUEST_CAP * 4);
  });

  it("leaves the document it was given as it was", () => {
    const doc = v3Doc();
    (MIGRATIONS[3] as Migration)(doc);
    expect(doc).toEqual(v3Doc());
  });

  it("is run by migrate, which stamps schema 4", () => {
    const out = migrate(v3Doc()) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(4);
    expect((out.park as { history: unknown }).history).toEqual([]);
    expect(out.guests).toHaveProperty("lostTicks");
  });

  it("refuses a document with no park, no guest section, or a guest count it cannot use", () => {
    const step = MIGRATIONS[3] as Migration;
    const withCount = (count: unknown) => ({ ...v3Doc(), guests: { count } });
    for (const doc of [
      null,
      5,
      [],
      { schemaVersion: 3 },
      { schemaVersion: 3, park: {} },
      { schemaVersion: 3, guests: { count: 0 } },
      { ...v3Doc(), park: [] },
      { ...v3Doc(), guests: 4 },
      withCount(undefined),
      withCount("2"),
      withCount(1.5),
      withCount(-1),
      withCount(GUEST_CAP + 1),
      withCount(Number.NaN),
    ]) {
      expectSaveError(() => migrate(doc), "Save file is corrupt");
    }
    expect(() => step(null)).toThrow(SaveError);
  });
});

/** Puts `n` guests in the world, with an entrance for them to come from. */
function addGuests(world: World, n: number): void {
  world.park.entrance ??= { x: 5, y: 0, side: 0 };
  for (let i = 0; i < n; i++) spawnGuest(world, world.rngStreams.guests);
}

/** A park with 40 guests who have been walking about for a while, some of whom have left. */
function busyPark(): Sim {
  const sim = makePark({ rating: 500, fee: 1_00 });
  for (let y = 5; y <= 21; y++) placeGuest(sim.world, { x: 8, y }, GuestState.WANDERING, {});
  for (let slot = 0; slot < 17; slot += 4) sim.world.guests.happiness[slot] = 10;
  sim.step(700);
  return sim;
}

describe("guests in a save", () => {
  it("round-trips every guest array, the counters, the stream, and the hash", () => {
    const sim = busyPark();
    const { world } = sim;
    // Lost times, which nobody in a busy park has.
    world.guests.lostTicks[2] = 777;
    world.guests.lostTicks[world.guests.count - 1] = LOST_GIVE_UP - 1;
    expect(world.guests.count).toBeGreaterThan(10);
    expect(world.guests.nextGuestId - 1).toBeGreaterThan(world.guests.count);
    const loaded = deserializeWorld(serializeWorld(world));
    const g = world.guests;
    const l = loaded.guests;
    expect(l.count).toBe(g.count);
    expect(l.nextGuestId).toBe(g.nextGuestId);
    for (const [name] of GUEST_ARRAYS) {
      expect(l[name], name).toHaveLength(GUEST_CAP);
      expect(l[name].subarray(0, g.count), name).toEqual(g[name].subarray(0, g.count));
    }
    expect(loaded.rngStreams.guests.state).toEqual(world.rngStreams.guests.state);
    expect(hashWorld(loaded)).toBe(hashWorld(world));
    expect(loaded.park).toStrictEqual(world.park);
    // The loaded store is ready for more arrivals and for leavers.
    expect(l.fragmented).toBe(false);
    expect(l.freeCount).toBe(GUEST_CAP - g.count);
    expect(Array.from(l.live.subarray(0, g.count)).every((v) => v === 1)).toBe(true);
    expect(l.live.subarray(g.count).every((v) => v === 0)).toBe(true);
    expect(spawnGuest(loaded, loaded.rngStreams.guests)).toBe(g.count);
  });

  it("writes only the live guests, packed, in a fixed key order", () => {
    const { world } = busyPark();
    const doc = readDoc(serializeWorld(world));
    const guests = doc.guests as Record<string, unknown>;
    expect(Object.keys(guests)).toEqual([
      "count",
      "nextGuestId",
      ...GUEST_ARRAYS.map(([name]) => name),
    ]);
    expect(guests.count).toBe(world.guests.count);
    expect(guests.nextGuestId).toBe(world.guests.nextGuestId);
    const width = { Int32Array: 4, Uint16Array: 2, Uint8Array: 1 } as const;
    for (const [name, kind] of GUEST_ARRAYS) {
      const encoded = guests[name] as { $t: string; $b64: string };
      expect(encoded.$t, name).toBe(kind);
      expect(fromBase64(encoded.$b64), name).toHaveLength(world.guests.count * width[kind]);
    }
    expect(doc.rngStreams).toEqual({ guests: [...world.rngStreams.guests.state] });
  });

  it("writes an empty store as empty arrays", () => {
    const doc = readDoc(serializeWorld(freshWorld()));
    const guests = doc.guests as Record<string, { $b64?: string } | number>;
    expect(guests.count).toBe(0);
    expect(guests.nextGuestId).toBe(1);
    for (const [name] of GUEST_ARRAYS)
      expect((guests[name] as { $b64: string }).$b64, name).toBe("");
    expect(deserializeWorld(serializeWorld(freshWorld())).guests.count).toBe(0);
  });

  it("writes 32-bit and 16-bit values little-endian whatever the host", () => {
    const world = freshWorld(10, 10);
    addGuests(world, 1);
    world.guests.cash[0] = -2;
    world.guests.id[0] = 0x01020304;
    world.guests.name[0] = 0x0102;
    world.guests.nextGuestId = 0x01020305;
    const guests = readDoc(serializeWorld(world)).guests as Record<string, { $b64: string }>;
    expect(Array.from(fromBase64((guests.cash as { $b64: string }).$b64))).toEqual([
      0xfe, 0xff, 0xff, 0xff,
    ]);
    expect(Array.from(fromBase64((guests.id as { $b64: string }).$b64))).toEqual([4, 3, 2, 1]);
    expect(Array.from(fromBase64((guests.name as { $b64: string }).$b64))).toEqual([2, 1]);
  });

  it("keeps negative values: a guest in the lane north of the map and one with a negative target", () => {
    const world = freshWorld(10, 10);
    addGuests(world, 1);
    expect(world.guests.y[0]).toBe(-16);
    world.guests.dest[0] = -2;
    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.guests.y[0]).toBe(-16);
    expect(loaded.guests.dest[0]).toBe(-2);
    expect(hashWorld(loaded)).toBe(hashWorld(world));
  });

  it("packs a store with holes into slot order, and loads it into slots 0..count-1", () => {
    const world = freshWorld(10, 10);
    addGuests(world, 6);
    removeGuest(world, 1);
    removeGuest(world, 4);
    expect(world.guests.fragmented).toBe(true);
    const bytesFragmented = serializeWorld(world);

    const compact = freshWorld(10, 10);
    addGuests(compact, 6);
    removeGuest(compact, 1);
    removeGuest(compact, 4);
    compactGuests(compact);
    // The same guests, packed or not, make the same save.
    expect(Array.from(serializeWorld(compact))).toEqual(Array.from(bytesFragmented));

    const loaded = deserializeWorld(bytesFragmented);
    expect(loaded.guests.count).toBe(4);
    expect(Array.from(loaded.guests.id.subarray(0, 5))).toEqual([1, 3, 4, 6, 0]);
    // Saving did not change the world it saved.
    expect(world.guests.fragmented).toBe(true);
    expect(at(world.guests.live, 1)).toBe(0);
  });

  it("keeps the guest stream in step: the draws after a load are the draws that would have come", () => {
    const sim = busyPark();
    const loaded = deserializeWorld(serializeWorld(sim.world));
    const a = Array.from({ length: 5 }, () => sim.world.rngStreams.guests.next());
    const b = Array.from({ length: 5 }, () => loaded.rngStreams.guests.next());
    expect(b).toEqual(a);
  });

  it("is deterministic: the same world gives the same bytes, and a loaded one re-saves identically", () => {
    const { world } = busyPark();
    const a = serializeWorld(world);
    expect(Array.from(serializeWorld(world))).toEqual(Array.from(a));
    expect(Array.from(serializeWorld(deserializeWorld(a)))).toEqual(Array.from(a));
  });

  it("compresses: 2,000 guests save in well under a megabyte", () => {
    const world = freshWorld(64, 64);
    world.park.entrance = { x: 5, y: 0, side: 0 };
    for (let i = 0; i < GUEST_CAP; i++) spawnGuest(world, world.rngStreams.guests);
    const bytes = serializeWorld(world);
    expect(bytes.length).toBeLessThan(500 * 1024);
    expect(hashWorld(deserializeWorld(bytes))).toBe(hashWorld(world));
  });

  it("refuses a guest section that is damaged, missing, or does not add up", () => {
    const good = readDoc(serializeWorld(busyPark().world));
    const guests = (doc: Record<string, unknown>) => doc.guests as Record<string, unknown>;
    const invalid: Record<string, (doc: Record<string, unknown>) => void> = {
      "missing guests": (doc) => delete doc.guests,
      "guests that is not an object": (doc) => (doc.guests = []),
      "no count": (doc) => delete guests(doc).count,
      "fractional count": (doc) => (guests(doc).count = 1.5),
      "negative count": (doc) => (guests(doc).count = -1),
      "count above the cap": (doc) => (guests(doc).count = GUEST_CAP + 1),
      "no id counter": (doc) => delete guests(doc).nextGuestId,
      "id counter of zero": (doc) => (guests(doc).nextGuestId = 0),
      "missing array": (doc) => delete guests(doc).hunger,
      "array with the wrong tag": (doc) => (guests(doc).cash = { $t: "Uint8Array", $b64: "AAAA" }),
      "array without bytes": (doc) => (guests(doc).x = { $t: "Int32Array" }),
      "missing stream block": (doc) => delete doc.rngStreams,
      "missing guest stream": (doc) => (doc.rngStreams = {}),
      "short guest stream": (doc) => (doc.rngStreams = { guests: [1, 2, 3] }),
      "guest stream word out of range": (doc) => (doc.rngStreams = { guests: [1, 2, 3, 2 ** 32] }),
    };
    for (const [label, damage] of Object.entries(invalid)) {
      const doc = structuredClone(good);
      damage(doc);
      expect(() => deserializeWorld(writeDoc(doc)), label).toThrow(/^Save file is invalid: /);
    }

    const corrupt: Record<string, (doc: Record<string, unknown>) => void> = {
      "an array a guest short": (doc) => {
        const encoded = guests(doc).id as { $b64: string };
        encoded.$b64 = toBase64(fromBase64(encoded.$b64).subarray(4));
      },
      "an array a guest long": (doc) => {
        const encoded = guests(doc).happiness as { $b64: string };
        encoded.$b64 = toBase64(new Uint8Array([...fromBase64(encoded.$b64), 7]));
      },
      "a guest stream that is all zero": (doc) => (doc.rngStreams = { guests: [0, 0, 0, 0] }),
    };
    for (const damage of Object.values(corrupt)) {
      const doc = structuredClone(good);
      damage(doc);
      expectSaveError(() => deserializeWorld(writeDoc(doc)), /^Save file is corrupt$/);
    }
  });

  it("refuses a save whose guests were edited by hand, though the gzip is intact", () => {
    const doc = readDoc(serializeWorld(busyPark().world));
    const encoded = (doc.guests as Record<string, { $b64: string }>).cash as { $b64: string };
    const bytes = fromBase64(encoded.$b64);
    bytes[0] = (bytes[0] as number) ^ 1;
    encoded.$b64 = toBase64(bytes);
    expectSaveError(() => deserializeWorld(writeDoc(doc)), /^Save file is corrupt$/);
  });
});

/** Ways to break a world with two guests in it, as `validateWorldInvariants` sees them. */
const GUEST_VIOLATIONS: Array<[string, (world: World) => void, RegExp]> = [
  ["a guest id used twice", (w) => (w.guests.id[1] = at(w.guests.id, 0)), /guest id/],
  ["a guest id of zero", (w) => (w.guests.id[0] = 0), /guest id/],
  ["a guest id that is not below the counter", (w) => (w.guests.nextGuestId = 2), /nextGuestId/],
  ["a guest state above 5", (w) => (w.guests.state[1] = 6), /state/],
  ["a guest colour above 8", (w) => (w.guests.color[1] = 9), /colo/],
  ["a guest name outside the table", (w) => (w.guests.name[0] = 64 * 32), /name/],
  ["a guest thought that does not exist", (w) => (w.guests.thought[1] = 200), /thought/],
  ["negative guest cash", (w) => (w.guests.cash[0] = -1), /cash/],
  ["a guest far east of the map", (w) => (w.guests.x[0] = 12 * 32), /position/],
  ["a guest far south of the map", (w) => (w.guests.y[1] = 14 * 32 + 5), /position/],
  ["a guest far to the west", (w) => (w.guests.x[0] = -33), /position/],
  ["a guest target off the map", (w) => (w.guests.tx[0] = 11), /target/],
  ["a guest target half-set", (w) => ((w.guests.tx[0] = -1), (w.guests.ty[0] = 99)), /target/],
  ["a guest destination off the map", (w) => (w.guests.dest[0] = 10 * 10), /destination/],
  ["a guest destination below the sentinels", (w) => (w.guests.dest[1] = -3), /destination/],
  ["a negative idle time", (w) => (w.guests.sinceAction[0] = -1), /sinceAction/],
  ["a negative thought time", (w) => (w.guests.thoughtTick[1] = -1), /thoughtTick/],
  ["a negative lost time", (w) => (w.guests.lostTicks[0] = -1), /lostTicks/],
];

describe("guest invariants", () => {
  function twoGuests(): World {
    const world = freshWorld(10, 10);
    addGuests(world, 2);
    return world;
  }

  it("accept a world with guests, in the lane or inside, with or without a target", () => {
    const world = twoGuests();
    expect(validateWorldInvariants(world)).toBeNull();
    world.guests.tx[1] = -1;
    world.guests.ty[1] = -1;
    world.guests.dest[1] = -2;
    expect(validateWorldInvariants(world)).toBeNull();
    // One tile outside the map on any side is the entrance lane, and legal.
    for (const [x, y] of [
      [-16, 5 * 32],
      [10 * 32 + 16, 5 * 32],
      [5 * 32, -16],
      [5 * 32, 10 * 32 + 16],
      [-32, 5 * 32],
    ]) {
      world.guests.x[0] = x as number;
      world.guests.y[0] = y as number;
      expect(validateWorldInvariants(world), `${x}, ${y}`).toBeNull();
    }
    // The extreme values.
    world.guests.state[0] = 5;
    world.guests.color[0] = 8;
    world.guests.name[0] = 64 * 32 - 1;
    world.guests.thought[0] = 11;
    world.guests.dest[0] = 10 * 10 - 1;
    expect(validateWorldInvariants(world)).toBeNull();
  });

  it("accept a full store", () => {
    const world = freshWorld(10, 10);
    addGuests(world, GUEST_CAP);
    expect(world.guests.count).toBe(GUEST_CAP);
    expect(validateWorldInvariants(world)).toBeNull();
  });

  it.each(GUEST_VIOLATIONS)("report %s", (_label, damage, reason) => {
    const world = twoGuests();
    damage(world);
    expect(validateWorldInvariants(world)).toMatch(reason);
  });

  it.each(GUEST_VIOLATIONS)(
    "refuse a save with %s, though its hash and gzip are intact",
    (_label, damage, reason) => {
      const world = twoGuests();
      damage(world);
      let caught: unknown;
      try {
        deserializeWorld(serializeWorld(world));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SaveError);
      expect((caught as SaveError).message).toBe("Save file is corrupt");
      expect(((caught as SaveError).cause as Error).message).toMatch(reason);
    },
  );
});

describe("base64", () => {
  it("matches the RFC 4648 test vectors", () => {
    const vectors: Array<[string, string]> = [
      ["", ""],
      ["f", "Zg=="],
      ["fo", "Zm8="],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg=="],
      ["fooba", "Zm9vYmE="],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [text, encoded] of vectors) {
      expect(toBase64(strToU8(text))).toBe(encoded);
      expect(strFromU8(fromBase64(encoded))).toBe(text);
    }
  });

  it("agrees with Node's Buffer on every byte value and on assorted lengths", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (let length = 0; length <= 256; length += length < 20 ? 1 : 37) {
      const bytes = all.subarray(0, length);
      const encoded = toBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      expect(Array.from(fromBase64(encoded))).toEqual(Array.from(bytes));
    }
    // Characters 62 and 63 of the alphabet.
    expect(toBase64(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe("+/+/");
  });

  it("returns a fresh Uint8Array that does not alias its input", () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const decoded = fromBase64(toBase64(bytes));
    decoded[0] = 99;
    expect(bytes[0]).toBe(1);
    expect(decoded).toBeInstanceOf(Uint8Array);
  });

  it("throws SaveError on invalid input", () => {
    const bad = [
      "Zg=", // length not a multiple of 4
      "Zg", // missing padding
      "Z===", // too much padding
      "Zg=a", // padding followed by data
      "=Zg=", // padding at the start
      "Zm9v!A==", // bad character
      "Zm 9v", // whitespace
      "Zm9v\n", // newline
      "Zm9-", // url-safe alphabet is not accepted
      "Zmév", // non-ASCII
      "Zg==Zg==", // padding in the middle
    ];
    for (const text of bad) expectSaveError(() => fromBase64(text), /^Save file is corrupt/);
  });
});
