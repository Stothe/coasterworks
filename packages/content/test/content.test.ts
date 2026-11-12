import { describe, expect, it } from "vitest";
import {
  ALL_TYPES,
  RIDE_TYPES,
  RideTypeSchema,
  STALL_TYPES,
  StallTypeSchema,
  rotateOffset,
  rotateSide,
  rotatedFootprint,
  typeById,
  type Rot,
  type Side,
} from "../src/index.js";

const ROTS: Rot[] = [0, 1, 2, 3];

function edgeAdjacentOutside(o: { x: number; y: number }, f: { w: number; h: number }): boolean {
  const insideX = o.x >= 0 && o.x < f.w;
  const insideY = o.y >= 0 && o.y < f.h;
  if (insideX && insideY) return false;
  const dx = o.x < 0 ? -o.x : o.x >= f.w ? o.x - f.w + 1 : 0;
  const dy = o.y < 0 ? -o.y : o.y >= f.h ? o.y - f.h + 1 : 0;
  return dx + dy === 1;
}

function numbers(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(numbers);
  return [];
}

describe("content data", () => {
  it("parses every ride and stall with its schema", () => {
    for (const r of RIDE_TYPES) expect(RideTypeSchema.safeParse(r).success, r.id).toBe(true);
    for (const s of STALL_TYPES) expect(StallTypeSchema.safeParse(s).success, s.id).toBe(true);
    expect(RIDE_TYPES.length).toBe(3);
    expect(STALL_TYPES.length).toBe(3);
  });

  it("has unique snake_case ids and finds them by id", () => {
    const ids = ALL_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    for (const t of ALL_TYPES) expect(typeById(t.id)).toBe(t);
    expect(typeById("nope")).toBeUndefined();
  });

  it("freezes the arrays", () => {
    expect(Object.isFrozen(RIDE_TYPES)).toBe(true);
    expect(Object.isFrozen(STALL_TYPES)).toBe(true);
    expect(Object.isFrozen(ALL_TYPES)).toBe(true);
  });

  it("uses integers everywhere", () => {
    for (const t of ALL_TYPES)
      for (const n of numbers(t)) expect(Number.isInteger(n), t.id).toBe(true);
  });

  it("keeps costs, running costs and prices in range", () => {
    for (const r of RIDE_TYPES) {
      expect(r.cost).toBeGreaterThanOrEqual(80_000);
      expect(r.cost).toBeLessThanOrEqual(400_000);
      expect(r.cycleTicks).toBeGreaterThanOrEqual(300);
      expect(r.cycleTicks).toBeLessThanOrEqual(900);
      expect(r.defaultPrice).toBeGreaterThanOrEqual(100);
      expect(r.defaultPrice).toBeLessThanOrEqual(300);
    }
    for (const s of STALL_TYPES) {
      expect(s.cost).toBeGreaterThanOrEqual(30_000);
      expect(s.cost).toBeLessThanOrEqual(60_000);
    }
    for (const t of ALL_TYPES) {
      expect(t.runningCost).toBeGreaterThanOrEqual(2_000);
      expect(t.runningCost).toBeLessThanOrEqual(8_000);
    }
  });

  it("places ride entrances and exits outside the footprint, edge-adjacent and distinct", () => {
    for (const r of RIDE_TYPES) {
      expect(edgeAdjacentOutside(r.entrance, r.footprint), `${r.id} entrance`).toBe(true);
      expect(edgeAdjacentOutside(r.exit, r.footprint), `${r.id} exit`).toBe(true);
      expect(r.entrance).not.toEqual(r.exit);
    }
  });

  it("rejects bad data", () => {
    const base = RIDE_TYPES[0]!;
    const bad = (patch: object) => RideTypeSchema.safeParse({ ...base, ...patch }).success;
    expect(bad({})).toBe(true);
    expect(bad({ id: "Bad-Id" })).toBe(false);
    expect(bad({ entrance: { x: 1, y: 1 } })).toBe(false); // inside
    expect(bad({ entrance: { x: 3, y: 3 } })).toBe(false); // diagonal
    expect(bad({ exit: base.entrance })).toBe(false); // same tile
    expect(bad({ cost: 1.5 })).toBe(false);
    expect(bad({ excitement: 1000 })).toBe(false);
    expect(bad({ footprint: { w: 0, h: 3 } })).toBe(false);
    const stall = STALL_TYPES[0]!;
    expect(StallTypeSchema.safeParse({ ...stall, footprint: { w: 2, h: 1 } }).success).toBe(false);
    expect(StallTypeSchema.safeParse({ ...stall, front: 4 }).success).toBe(false);
  });
});

describe("rotation", () => {
  it("returns to the start after four quarter turns", () => {
    for (const r of RIDE_TYPES) {
      for (const o of [r.entrance, r.exit]) {
        let cur = o;
        let fp = r.footprint;
        for (let i = 0; i < 4; i++) {
          cur = rotateOffset(cur, fp, 1);
          fp = rotatedFootprint(fp, 1);
        }
        expect(cur).toEqual(o);
        expect(fp).toEqual(r.footprint);
      }
    }
  });

  it("keeps entrance and exit outside and edge-adjacent at every rotation", () => {
    for (const r of RIDE_TYPES) {
      for (const rot of ROTS) {
        const fp = rotatedFootprint(r.footprint, rot);
        const e = rotateOffset(r.entrance, r.footprint, rot);
        const x = rotateOffset(r.exit, r.footprint, rot);
        expect(edgeAdjacentOutside(e, fp), `${r.id} entrance rot ${rot}`).toBe(true);
        expect(edgeAdjacentOutside(x, fp), `${r.id} exit rot ${rot}`).toBe(true);
        expect(e).not.toEqual(x);
      }
    }
  });

  it("agrees with composing single quarter turns", () => {
    const fp = { w: 2, h: 4 };
    const o = { x: -1, y: 2 };
    let cur = o;
    let cfp = fp;
    for (const rot of ROTS) {
      expect(rotateOffset(o, fp, rot)).toEqual(cur);
      expect(rotatedFootprint(fp, rot)).toEqual(cfp);
      cur = rotateOffset(cur, cfp, 1);
      cfp = rotatedFootprint(cfp, 1);
    }
  });

  it("carries a south entrance clockwise to west, north, then east", () => {
    // 3x3, entrance below the middle: south -> west -> north -> east.
    const fp = { w: 3, h: 3 };
    const south = { x: 1, y: 3 };
    expect(rotateOffset(south, fp, 1)).toEqual({ x: -1, y: 1 });
    expect(rotateOffset(south, fp, 2)).toEqual({ x: 1, y: -1 });
    expect(rotateOffset(south, fp, 3)).toEqual({ x: 3, y: 1 });
  });

  it("rotates footprints and sides", () => {
    expect(rotatedFootprint({ w: 2, h: 4 }, 0)).toEqual({ w: 2, h: 4 });
    expect(rotatedFootprint({ w: 2, h: 4 }, 1)).toEqual({ w: 4, h: 2 });
    expect(rotatedFootprint({ w: 2, h: 4 }, 2)).toEqual({ w: 2, h: 4 });
    expect(rotatedFootprint({ w: 2, h: 4 }, 3)).toEqual({ w: 4, h: 2 });
    expect(rotateSide(0, 1)).toBe(1); // north -> east
    expect(rotateSide(2, 1)).toBe(3); // south -> west
    expect(rotateSide(3, 1)).toBe(0); // west -> north
    for (const side of [0, 1, 2, 3] as Side[]) {
      expect(rotateSide(side, 0)).toBe(side);
      expect(rotateSide(side, 2)).toBe(((side + 2) % 4) as Side);
      let s = side;
      for (let i = 0; i < 4; i++) s = rotateSide(s, 1);
      expect(s).toBe(side);
    }
  });
});

describe("content data guards", () => {
  it("is frozen all the way down", () => {
    for (const type of ALL_TYPES) {
      expect(Object.isFrozen(type)).toBe(true);
      expect(Object.isFrozen(type.footprint)).toBe(true);
    }
  });

  it("refuses a model that is not the id, and a default price above $20", () => {
    const ride = RIDE_TYPES[0]!;
    expect(RideTypeSchema.safeParse({ ...ride, model: "other" }).success).toBe(false);
    expect(RideTypeSchema.safeParse({ ...ride, defaultPrice: 20_01 }).success).toBe(false);
    const stall = STALL_TYPES[0]!;
    expect(StallTypeSchema.safeParse({ ...stall, model: "other" }).success).toBe(false);
  });
});
