import { describe, expect, it } from "vitest";
import {
  ALL_TYPES,
  BANK_ROLL,
  COASTER_FAMILIES,
  CoasterFamilySchema,
  PIECE_KINDS,
  TRACK_PIECES,
  TrackPieceSchema,
  bankRoll,
  familyById,
  familyRefusesPiece,
  pieceById,
  pitchAngle,
  pitchRise,
  typeById,
} from "../src/index.js";

function numbers(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(numbers);
  return [];
}

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

describe("track pieces", () => {
  it("parse with their schema, have unique snake_case ids and are found by id", () => {
    for (const p of TRACK_PIECES) expect(TrackPieceSchema.safeParse(p).success, p.id).toBe(true);
    const ids = TRACK_PIECES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of TRACK_PIECES) {
      expect(p.id).toMatch(SNAKE);
      expect(pieceById(p.id)).toBe(p);
    }
    expect(pieceById("loop")).toBeUndefined();
    expect(Object.isFrozen(TRACK_PIECES)).toBe(true);
    expect(Object.isFrozen(TRACK_PIECES[0]!.exit)).toBe(true);
  });

  it("include the plan's piece set", () => {
    for (const id of [
      "station",
      "straight",
      "brakes",
      "left_small_curve",
      "right_small_curve",
      "left_large_curve",
      "right_large_curve",
      "flat_to_gentle_up",
      "gentle_up",
      "gentle_up_to_flat",
      "gentle_to_steep_up",
      "steep_up",
      "steep_to_gentle_up",
      "flat_to_gentle_down",
      "gentle_down",
      "gentle_down_to_flat",
      "gentle_to_steep_down",
      "steep_down",
      "steep_to_gentle_down",
      "gentle_up_lift",
      "steep_up_lift",
      "flat_to_gentle_up_lift",
      "bank_left_in",
      "bank_left_out",
      "bank_right_in",
      "bank_right_out",
      "bank_left_steepen",
      "bank_right_ease",
      "left_small_curve_banked",
      "right_large_curve_banked",
      "left_large_curve_steep_banked",
      "right_small_curve_steep_banked",
    ]) {
      expect(pieceById(id), id).toBeDefined();
    }
    for (const kind of PIECE_KINDS) {
      expect(
        TRACK_PIECES.some((p) => p.kind === kind),
        kind,
      ).toBe(true);
    }
  });

  it("only change pitch and bank between neighbouring levels", () => {
    for (const p of TRACK_PIECES) {
      expect(Math.abs(p.exit.pitch - p.entry.pitch), p.id).toBeLessThanOrEqual(1);
      expect(Math.abs(p.exit.bank - p.entry.bank), p.id).toBeLessThanOrEqual(1);
    }
    // And every level reachable by a neighbour step has a piece that makes it.
    for (let a = -2; a <= 2; a++) {
      for (const b of [a - 1, a + 1]) {
        if (b < -2 || b > 2) continue;
        expect(
          TRACK_PIECES.some((p) => p.entry.pitch === a && p.exit.pitch === b),
          `pitch ${a}->${b}`,
        ).toBe(true);
        expect(
          TRACK_PIECES.some((p) => p.entry.bank === a && p.exit.bank === b),
          `bank ${a}->${b}`,
        ).toBe(true);
      }
    }
  });

  it("end on whole steps at tile edge centres, with heights matching their pitch", () => {
    for (const p of TRACK_PIECES) {
      const { forward, right } = p.exit;
      // An edge centre is a whole tile along the axis it crosses and a half tile along the other.
      if (p.exit.dDir === 0) {
        expect(forward % 1024, p.id).toBe(0);
        expect(right, p.id).toBe(0);
      } else {
        expect((forward - 512) % 1024, p.id).toBe(0);
        expect((Math.abs(right) - 512) % 1024, p.id).toBe(0);
      }
      if (p.shape === "straight") {
        expect(2 * p.exit.dz, p.id).toBe(
          (pitchRise(p.entry.pitch) + pitchRise(p.exit.pitch)) * (forward / 1024),
        );
      }
    }
  });

  it("set lift, brake and station flags only where they belong", () => {
    for (const p of TRACK_PIECES) {
      if (p.flags.lift) expect(p.entry.pitch > 0 || p.exit.pitch > 0, p.id).toBe(true);
      if (p.flags.brake || p.flags.station) {
        expect(
          [p.entry, p.exit].every((e) => e.pitch === 0 && e.bank === 0),
          p.id,
        ).toBe(true);
      }
    }
    const lifts = TRACK_PIECES.filter((p) => p.flags.lift).map((p) => p.id);
    expect(lifts.length).toBe(6);
    for (const id of lifts) expect(pieceById(id.replace(/_lift$/, "")), id).toBeDefined();
  });

  it("uses integers everywhere", () => {
    for (const p of TRACK_PIECES)
      for (const n of numbers(p)) expect(Number.isInteger(n), p.id).toBe(true);
  });

  it("has pitch and roll angles for every level", () => {
    expect([-2, -1, 0, 1, 2].map(pitchAngle)).toEqual([-512, -302, 0, 302, 512]);
    expect([-2, -1, 0, 1, 2].map(bankRoll)).toEqual([...BANK_ROLL]);
    expect(() => pitchRise(3)).toThrow(RangeError);
    expect(() => bankRoll(-3)).toThrow(RangeError);
  });

  it("rejects bad pieces", () => {
    const straight = pieceById("straight")!;
    const curve = pieceById("right_small_curve")!;
    const ok = (p: object) => TrackPieceSchema.safeParse(p).success;
    expect(ok(straight)).toBe(true);
    expect(ok({ ...straight, id: "Bad" })).toBe(false);
    expect(ok({ ...straight, exit: { ...straight.exit, pitch: 2, dz: 2 } })).toBe(false); // two levels
    expect(ok({ ...straight, exit: { ...straight.exit, pitch: 1, dz: 2 } })).toBe(false); // wrong height
    expect(ok({ ...straight, exit: { ...straight.exit, forward: 1000 } })).toBe(false);
    expect(ok({ ...straight, exit: { ...straight.exit, right: 512 } })).toBe(false);
    expect(ok({ ...straight, kind: "slope" })).toBe(false);
    expect(ok({ ...straight, flags: { ...straight.flags, lift: true }, kind: "lift" })).toBe(false);
    expect(ok({ ...curve, exit: { ...curve.exit, dDir: -1 } })).toBe(false);
    expect(
      ok({ ...curve, entry: { ...curve.entry, bank: -1 }, exit: { ...curve.exit, bank: -1 } }),
    ).toBe(false);
    expect(ok({ ...curve, exit: { ...curve.exit, forward: 2048, right: 2048 } })).toBe(false);
    expect(ok({ ...curve, tiles: [{ f: 1, r: 1, zLo: 0, zHi: 0 }] })).toBe(false);
    expect(ok({ ...curve, length: 1.5 })).toBe(false);
  });
});

describe("coaster families", () => {
  it("parse with their schema and are found by id", () => {
    expect(COASTER_FAMILIES.map((f) => f.id)).toEqual(["steel_coaster", "wooden_coaster"]);
    for (const f of COASTER_FAMILIES) {
      expect(CoasterFamilySchema.safeParse(f).success, f.id).toBe(true);
      expect(familyById(f.id)).toBe(f);
      for (const id of Object.values(f.models)) expect(id).toMatch(SNAKE);
    }
    expect(familyById("carousel")).toBeUndefined();
    // Families are not ride or stall types.
    expect(ALL_TYPES.some((t) => t.id === "steel_coaster")).toBe(false);
    expect(typeById("steel_coaster")).toBeUndefined();
    expect(Object.isFrozen(COASTER_FAMILIES)).toBe(true);
    expect(Object.isFrozen(COASTER_FAMILIES[0]!.pieceCost)).toBe(true);
  });

  it("uses integers everywhere", () => {
    for (const f of COASTER_FAMILIES)
      for (const n of numbers(f)) expect(Number.isInteger(n), f.id).toBe(true);
  });

  it("keeps limits, physics, trains and costs sane", () => {
    for (const f of COASTER_FAMILIES) {
      expect(f.train.minCars).toBe(2);
      expect(f.train.maxCars).toBe(6);
      expect(f.train.defaultCars).toBe(4);
      expect(f.train.ridersPerCar).toBe(4);
      expect(f.physics.gravity).toBeGreaterThan(100);
      expect(f.physics.gravity).toBeLessThan(170);
      expect(f.physics.liftSpeed).toBeGreaterThan(f.physics.brakeSpeed);
      expect(f.physics.rollingFriction).toBeLessThan(f.physics.gravity / 10);
      for (const kind of PIECE_KINDS) {
        expect(f.pieceCost[kind], `${f.id} ${kind}`).toBeGreaterThanOrEqual(2_000);
        expect(f.pieceCost[kind], `${f.id} ${kind}`).toBeLessThanOrEqual(20_000);
      }
      // Lift and brake pieces cost more than plain track.
      expect(f.pieceCost.lift).toBeGreaterThan(f.pieceCost.slope);
      expect(f.pieceCost.brake).toBeGreaterThan(f.pieceCost.straight);
      expect(f.defaultPrice).toBeGreaterThanOrEqual(100);
      expect(f.defaultPrice).toBeLessThanOrEqual(500);
    }
    const steel = familyById("steel_coaster")!;
    const wood = familyById("wooden_coaster")!;
    expect(steel.limits.maxBank).toBe(2); // about 60 degrees
    expect(wood.limits.maxBank).toBe(1); // about 30 degrees
    expect(wood.limits.curves).toEqual(["large"]); // wider curves
    expect(wood.physics.roughness).toBeGreaterThan(steel.physics.roughness);
    expect(wood.physics.rollingFriction).toBeGreaterThan(steel.physics.rollingFriction);
    expect(steel.supportStyle).toBe("steel_column");
    expect(wood.supportStyle).toBe("wooden_bent");
  });

  it("refuses pieces outside a family's limits with a reason", () => {
    const steel = familyById("steel_coaster")!;
    const wood = familyById("wooden_coaster")!;
    for (const p of TRACK_PIECES) expect(familyRefusesPiece(steel, p), p.id).toBeNull();
    expect(familyRefusesPiece(wood, pieceById("right_small_curve")!)).toMatch(/tightly/);
    expect(familyRefusesPiece(wood, pieceById("bank_left_steepen")!)).toMatch(/bank/);
    expect(familyRefusesPiece(wood, pieceById("right_large_curve_steep_banked")!)).toMatch(/bank/);
    expect(familyRefusesPiece(wood, pieceById("right_large_curve_banked")!)).toBeNull();
    expect(familyRefusesPiece(wood, pieceById("steep_up_lift")!)).toBeNull();
    const gentle = { ...steel, limits: { ...steel.limits, maxPitch: 1, lift: false } };
    expect(familyRefusesPiece(gentle, pieceById("gentle_to_steep_down")!)).toMatch(/steep/);
    expect(familyRefusesPiece(gentle, pieceById("gentle_up_lift")!)).toMatch(/lift/);
  });

  it("rejects bad families", () => {
    const base = COASTER_FAMILIES[0]!;
    const ok = (patch: object) => CoasterFamilySchema.safeParse({ ...base, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ id: "Steel" })).toBe(false);
    expect(ok({ limits: { ...base.limits, maxBank: 3 } })).toBe(false);
    expect(ok({ limits: { ...base.limits, curves: ["small", "small"] } })).toBe(false);
    expect(ok({ train: { ...base.train, defaultCars: 7 } })).toBe(false);
    expect(ok({ pieceCost: { ...base.pieceCost, lift: 1.5 } })).toBe(false);
    const { lift: _lift, ...noLift } = base.pieceCost;
    expect(ok({ pieceCost: noLift })).toBe(false);
    expect(ok({ supportStyle: "rope" })).toBe(false);
  });
});
