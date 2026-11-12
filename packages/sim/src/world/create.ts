import { createGuestStore } from "../guests/guests.js";
import { createParkState } from "../park/types.js";
import { Rng } from "../rng.js";
import { MAX_MAP, SCHEMA_VERSION, type World } from "./types.js";

/** Corner height of a freshly created, flat world. */
const FLAT_HEIGHT = 8;

/** Starting cash in cents: $10,000. */
const DEFAULT_CASH = 10_000_00;

export interface CreateWorldOptions {
  width: number;
  height: number;
  seed: number;
  name: string;
  /** Starting cash in integer cents. Defaults to 10_000_00. */
  cash?: number;
  /** ISO creation time, stored as given. The sim never generates or reads it; defaults to "". */
  createdIso?: string;
}

function checkDimension(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MAP) {
    throw new RangeError(`World ${label} must be an integer from 1 to ${MAX_MAP}, got ${value}`);
  }
}

/**
 * Creates an empty park: flat grass at corner height 8, no water, no paths, no rides, a closed park with no
 * entrance, no guests, nothing logged.
 */
export function createWorld(opts: CreateWorldOptions): World {
  checkDimension("width", opts.width);
  checkDimension("height", opts.height);
  if (!Number.isInteger(opts.seed)) {
    throw new RangeError(`World seed must be an integer, got ${opts.seed}`);
  }
  const cash = opts.cash ?? DEFAULT_CASH;
  if (!Number.isInteger(cash)) {
    throw new RangeError(`World cash must be an integer number of cents, got ${cash}`);
  }

  const { width, height } = opts;
  const rng = new Rng(opts.seed);
  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      name: opts.name,
      seed: opts.seed,
      created: opts.createdIso ?? "",
    },
    tick: 0,
    terrain: {
      width,
      height,
      corners: new Int16Array((width + 1) * (height + 1)).fill(FLAT_HEIGHT),
      surface: new Uint8Array(width * height),
      water: new Uint8Array(width * height),
      path: new Uint8Array(width * height),
      occupant: new Uint16Array(width * height),
    },
    finance: { cash, loan: 0, monthStart: { cash } },
    park: createParkState(opts.name),
    guests: createGuestStore(),
    rides: [],
    nextRideId: 1,
    pathVersion: 0,
    rideVersion: 0,
    rng,
    // Forked straight after seeding, while the root generator is still untouched.
    rngStreams: { guests: rng.fork("guests") },
    log: [],
    undoStack: [],
    redoStack: [],
    nextId: 1,
  };
}
