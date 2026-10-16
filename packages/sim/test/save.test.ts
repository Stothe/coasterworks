import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  Rng,
  SCHEMA_VERSION,
  SaveError,
  Sim,
  createWorld,
  deserializeWorld,
  hashWorld,
  migrate,
  serializeWorld,
  type World,
} from "../src/index.js";
import { fromBase64, toBase64 } from "../src/save/base64.js";

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
    expect(loaded.terrain.corners).toStrictEqual(world.terrain.corners);
    expect(loaded.terrain.surface).toStrictEqual(world.terrain.surface);
    expect(loaded.terrain.water).toStrictEqual(world.terrain.water);
    expect(loaded.terrain.corners.byteOffset).toBe(0);
    expect(loaded.rng).toBeInstanceOf(Rng);
    expect(loaded.rng.next()).toBe(Rng.fromState(world.rng.state).next());
  });

  it("round-trips negative and extreme corner heights and every surface value", () => {
    const world = freshWorld(3, 2);
    world.terrain.corners.set([-1, -32768, 32767, 0, 255, 256, -256, 0x0102, -2, 7, 8, 9]);
    world.terrain.surface.set([0, 1, 2, 3, 4, 255]);
    world.terrain.water.set([0, 1, 2, 3, 4, 255]);
    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.terrain.corners).toStrictEqual(world.terrain.corners);
    expect(loaded.terrain.surface).toStrictEqual(world.terrain.surface);
    expect(loaded.terrain.water).toStrictEqual(world.terrain.water);
  });

  it("round-trips the biggest map", () => {
    const world = createWorld({ width: 256, height: 256, seed: 1, name: "big" });
    world.terrain.corners[12345] = -77;
    const loaded = deserializeWorld(serializeWorld(world));
    expect(hashWorld(loaded)).toBe(hashWorld(world));
    expect(loaded.terrain.corners[12345]).toBe(-77);
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
      "rng",
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
    expect(Object.keys(terrain)).toEqual(["width", "height", "corners", "surface", "water"]);
    expect(terrain.corners).toEqual({ $t: "Int16Array", $b64: expect.any(String) });
    expect(terrain.surface).toEqual({ $t: "Uint8Array", $b64: expect.any(String) });
    expect(terrain.water).toEqual({ $t: "Uint8Array", $b64: expect.any(String) });
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

  it("throws the exact newer-version message for schema 2", () => {
    const doc = readDoc(serializeWorld(freshWorld()));
    doc.schemaVersion = 2;
    expect(() => deserializeWorld(writeDoc(doc))).toThrow(SaveError);
    expect(() => deserializeWorld(writeDoc(doc))).toThrow(
      "Save is from a newer version (schema 2, this build reads 1)",
    );
    let caught: unknown;
    try {
      deserializeWorld(writeDoc(doc));
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe(
      "Save is from a newer version (schema 2, this build reads 1)",
    );
    expect((caught as Error).name).toBe("SaveError");
  });

  it("interpolates the versions into the newer-version message", () => {
    expectSaveError(
      () => deserializeWorld(writeDoc({ schemaVersion: 41 })),
      /^Save is from a newer version \(schema 41, this build reads 1\)$/,
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
function tamperTerrain(doc: Record<string, unknown>, key: "corners" | "surface" | "water"): void {
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
    let loadedAnyway = 0;
    for (const mask of [0x01, 0x80, 0xff]) {
      for (let i = 0; i < bytes.length; i++) {
        const damaged = Uint8Array.from(bytes);
        damaged[i] = (damaged[i] as number) ^ mask;
        let loaded: World | undefined;
        try {
          loaded = deserializeWorld(damaged);
        } catch (error) {
          expect(error).toBeInstanceOf(SaveError);
        }
        if (loaded !== undefined) {
          expect(hashWorld(loaded), `byte ${i} xor ${mask}`).toBe(expected);
          loadedAnyway++;
        }
      }
    }
    // Some flips land where they change nothing, such as the gzip header's OS byte.
    expect(loadedAnyway).toBeGreaterThan(0);
  });
});

describe("migrate", () => {
  it("is the identity on a current-version document", () => {
    const doc = { schemaVersion: SCHEMA_VERSION, anything: [1, 2, 3] };
    expect(migrate(doc)).toBe(doc);
  });

  it("starts with an empty migration table, since only schema 1 exists", () => {
    expect(MIGRATIONS).toEqual({});
  });

  it("runs the migration for the document's version and stamps the new schema version", () => {
    const migrations = {
      0: (doc: unknown) => {
        const old = doc as { schemaVersion: number; title: string };
        return { schemaVersion: old.schemaVersion, name: old.title };
      },
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
