import { deepFreeze } from "./freeze.js";
import { CoasterFamilySchema, type CoasterFamily, type TrackPiece } from "./schema.js";

// Coaster families: the limits a track must keep, the physics constants a train runs with, the
// train, the cost of each piece and what the renderer draws. Money is in cents. Physics units are
// documented on `CoasterFamilySchema`.

const families: CoasterFamily[] = [
  {
    id: "steel_coaster",
    kind: "coaster",
    name: "Steel Coaster",
    description: "Tubular rails on a round spine: tight turns, steep drops and deep banking.",
    limits: { maxPitch: 2, maxBank: 2, curves: ["small", "large"], lift: true },
    physics: {
      gravity: 134,
      rollingFriction: 2,
      drag: 96,
      liftSpeed: 51,
      brakeSpeed: 26,
      stationSpeed: 26,
      roughness: 10,
    },
    train: { minCars: 2, maxCars: 6, defaultCars: 4, ridersPerCar: 4, carLength: 768 },
    pieceCost: {
      station: 12_000,
      straight: 6_000,
      curve_small: 10_000,
      curve_large: 14_000,
      slope: 8_000,
      bank: 7_000,
      lift: 14_000,
      brake: 12_000,
    },
    runningCostPerPiece: 60,
    defaultPrice: 300,
    supportStyle: "steel_column",
    models: {
      track: "steel_coaster_track",
      car: "steel_coaster_car",
      support: "steel_coaster_support",
    },
  },
  {
    id: "wooden_coaster",
    kind: "coaster",
    name: "Wooden Coaster",
    description: "Flat rails on timber over a lattice of bents: wide turns and a lively ride.",
    limits: { maxPitch: 2, maxBank: 1, curves: ["large"], lift: true },
    physics: {
      gravity: 134,
      rollingFriction: 3,
      drag: 128,
      liftSpeed: 41,
      brakeSpeed: 26,
      stationSpeed: 26,
      roughness: 45,
    },
    train: { minCars: 2, maxCars: 6, defaultCars: 4, ridersPerCar: 4, carLength: 768 },
    pieceCost: {
      station: 10_000,
      straight: 5_000,
      curve_small: 8_000,
      curve_large: 11_000,
      slope: 6_500,
      bank: 6_000,
      lift: 12_000,
      brake: 10_000,
    },
    runningCostPerPiece: 50,
    defaultPrice: 250,
    supportStyle: "wooden_bent",
    models: {
      track: "wooden_coaster_track",
      car: "wooden_coaster_car",
      support: "wooden_coaster_support",
    },
  },
];

export const COASTER_FAMILIES: readonly CoasterFamily[] = Object.freeze(
  families.map((f) => deepFreeze(CoasterFamilySchema.parse(f) as CoasterFamily)),
);

const byId = new Map(COASTER_FAMILIES.map((f) => [f.id, f]));

/** Looks a coaster family up by id; undefined when there is no such family. */
export function familyById(id: string): CoasterFamily | undefined {
  return byId.get(id);
}

/** Why `family` cannot use `piece`, in one plain sentence; null when it can. */
export function familyRefusesPiece(family: CoasterFamily, piece: TrackPiece): string | null {
  const { limits } = family;
  const pitch = Math.max(Math.abs(piece.entry.pitch), Math.abs(piece.exit.pitch));
  const bank = Math.max(Math.abs(piece.entry.bank), Math.abs(piece.exit.bank));
  if (pitch > limits.maxPitch) return `The ${family.name} cannot take slopes that steep.`;
  if (bank > limits.maxBank) {
    return limits.maxBank === 0
      ? `The ${family.name} cannot bank.`
      : `The ${family.name} cannot bank that steeply.`;
  }
  if (piece.kind === "curve_small" && !limits.curves.includes("small")) {
    return `The ${family.name} cannot turn that tightly.`;
  }
  if (piece.kind === "curve_large" && !limits.curves.includes("large")) {
    return `The ${family.name} has no large curves.`;
  }
  if (piece.flags.lift && !limits.lift) return `The ${family.name} has no lift chain.`;
  return null;
}
