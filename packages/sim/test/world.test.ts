import { describe, expect, it } from "vitest";
import {
  MAX_HEIGHT,
  MAX_MAP,
  Rng,
  SCHEMA_VERSION,
  createWorld,
  hashWorld,
  type World,
} from "../src/index.js";

const base = { width: 8, height: 8, seed: 1, name: "t" };

describe("createWorld", () => {
  it("builds a flat 8x8 world with the documented defaults", () => {
    const w = createWorld(base);
    expect(w.terrain.width).toBe(8);
    expect(w.terrain.height).toBe(8);
    expect(w.terrain.corners.length).toBe(81);
    expect(w.terrain.surface.length).toBe(64);
    expect(w.terrain.water.length).toBe(64);
    expect(w.terrain.corners.every((c) => c === 8)).toBe(true);
    expect(w.terrain.surface.every((s) => s === 0)).toBe(true);
    expect(w.terrain.water.every((v) => v === 0)).toBe(true);
    expect(w.finance).toEqual({ cash: 1_000_000, loan: 0, monthStart: { cash: 1_000_000 } });
    expect(w.tick).toBe(0);
    expect(w.log).toEqual([]);
    expect(w.undoStack).toEqual([]);
    expect(w.redoStack).toEqual([]);
    expect(w.nextId).toBe(1);
  });

  it("records the meta block and never invents a creation time", () => {
    const w = createWorld(base);
    expect(w.meta).toEqual({ schemaVersion: SCHEMA_VERSION, name: "t", seed: 1, created: "" });
    expect(createWorld({ ...base, createdIso: "2026-10-16T12:00:00Z" }).meta.created).toBe(
      "2026-10-16T12:00:00Z",
    );
  });

  it("honours a custom starting cash for both cash and the month-start snapshot", () => {
    const w = createWorld({ ...base, cash: 250_000 });
    expect(w.finance.cash).toBe(250_000);
    expect(w.finance.monthStart.cash).toBe(250_000);
  });

  it("seeds the root rng from meta.seed", () => {
    const w = createWorld({ ...base, seed: 12345 });
    expect(w.rng.state).toEqual(new Rng(12345).state);
  });

  it("supports non-square maps", () => {
    const w = createWorld({ ...base, width: 3, height: 5 });
    expect(w.terrain.corners.length).toBe(4 * 6);
    expect(w.terrain.surface.length).toBe(15);
  });

  it("accepts the largest legal map", () => {
    const w = createWorld({ ...base, width: MAX_MAP, height: MAX_MAP });
    expect(w.terrain.corners.length).toBe((MAX_MAP + 1) * (MAX_MAP + 1));
    expect(MAX_HEIGHT).toBe(63);
  });

  it("rejects out-of-range dimensions", () => {
    expect(() => createWorld({ ...base, width: MAX_MAP + 1 })).toThrow(RangeError);
    expect(() => createWorld({ ...base, height: MAX_MAP + 1 })).toThrow(RangeError);
    expect(() => createWorld({ ...base, width: 0 })).toThrow(RangeError);
    expect(() => createWorld({ ...base, height: -1 })).toThrow(RangeError);
    expect(() => createWorld({ ...base, width: 2.5 })).toThrow(RangeError);
  });

  it("rejects fractional cash", () => {
    expect(() => createWorld({ ...base, cash: 10.5 })).toThrow(RangeError);
  });

  it("rejects a non-integer seed", () => {
    expect(() => createWorld({ ...base, seed: 1.5 })).toThrow(RangeError);
    expect(() => createWorld({ ...base, seed: Number.NaN })).toThrow(RangeError);
  });
});

describe("hashWorld", () => {
  it("is a 16-character lowercase hex string", () => {
    expect(hashWorld(createWorld(base))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is equal for two worlds built from the same seed", () => {
    expect(hashWorld(createWorld(base))).toBe(hashWorld(createWorld(base)));
  });

  it("differs when the seed differs", () => {
    expect(hashWorld(createWorld({ ...base, seed: 2 }))).not.toBe(hashWorld(createWorld(base)));
  });

  it("ignores meta.created", () => {
    const a = createWorld({ ...base, createdIso: "2026-01-01T00:00:00Z" });
    const b = createWorld({ ...base, createdIso: "2030-12-31T23:59:59Z" });
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  describe("changes when any covered state changes", () => {
    const reference = hashWorld(createWorld(base));
    const cases: [string, (w: World) => void][] = [
      ["tick", (w) => void (w.tick = 1)],
      ["a corner height", (w) => void (w.terrain.corners[40] = 9)],
      ["a surface tile", (w) => void (w.terrain.surface[10] = 2)],
      ["a water tile", (w) => void (w.terrain.water[63] = 3)],
      ["cash", (w) => void (w.finance.cash += 1)],
      ["loan", (w) => void (w.finance.loan = 100)],
      ["month-start cash", (w) => void (w.finance.monthStart.cash = 0)],
      ["rng state", (w) => void w.rng.next()],
      [
        "log length",
        (w) =>
          void w.log.push({ id: 1, tick: 0, client: "player", name: "x", input: null, cost: 0 }),
      ],
      ["nextId", (w) => void (w.nextId = 2)],
      ["undo stack", (w) => void w.undoStack.push(1)],
      ["redo stack", (w) => void w.redoStack.push(1)],
      ["meta.name", (w) => void (w.meta.name = "other")],
    ];
    for (const [label, mutate] of cases) {
      it(label, () => {
        const w = createWorld(base);
        mutate(w);
        expect(hashWorld(w)).not.toBe(reference);
      });
    }
  });

  it("tells undo from redo contents apart", () => {
    const a = createWorld(base);
    const b = createWorld(base);
    a.undoStack.push(7);
    b.redoStack.push(7);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });

  it("does not collide between maps whose arrays are all-equal but shaped differently", () => {
    const a = createWorld({ ...base, width: 4, height: 6 });
    const b = createWorld({ ...base, width: 6, height: 4 });
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });
});
