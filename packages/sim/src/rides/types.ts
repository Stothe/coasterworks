import type { Rot } from "@coasterworks/content";

/** Most rides and stalls a park can hold at once. */
export const RIDE_CAP = 255;

/** Highest ride id: ids are stored in `Terrain.occupant`, a Uint16Array where 0 means free. */
export const MAX_RIDE_ID = 0xffff;

/** Highest ride or stall price, in cents: $20.00. */
export const MAX_RIDE_PRICE = 20_00;

/** Longest ride name, in characters. */
export const MAX_RIDE_NAME = 40;

/** What a ride is doing: idle, loading, running, or unloading. */
export const RidePhase = { IDLE: 0, LOADING: 1, RUNNING: 2, UNLOADING: 3 } as const;

/** Highest `RidePhase` value. */
export const MAX_RIDE_PHASE = 3;

/** A tile on the map. */
export interface Tile {
  x: number;
  y: number;
}

/** What a ride or stall has done, for its stats panel. Money is in cents. */
export interface RideStats {
  customers: number;
  income: number;
  runningCost: number;
  monthCustomers: number;
  monthIncome: number;
}

/**
 * A ride or stall in the park. Plain JSON, so it is saved, hashed and kept in undo data as it is.
 *
 * `x`, `y` is the top-left tile of the footprint as rotated by `rot`. The tiles guests use are
 * worked out from the content type when it is built and stored here, so later code needs no content
 * lookup to find them: a ride has an `entrance` and an `exit` (and no `service`), a stall a
 * `service` tile (and no `entrance` or `exit`).
 */
export interface RideRecord {
  id: number;
  /** The content type's id, such as `carousel`. */
  type: string;
  kind: "ride" | "stall";
  x: number;
  y: number;
  rot: Rot;
  name: string;
  open: boolean;
  /** Cents per ride or per item. */
  price: number;
  entrance: Tile | null;
  exit: Tile | null;
  service: Tile | null;
  /** A `RidePhase` value. */
  phase: number;
  phaseTicks: number;
  /** Ids of the guests on the ride. */
  riders: number[];
  /** Ids of the guests queuing, front first. */
  queue: number[];
  stats: RideStats;
}

function copyTile(tile: Tile | null): Tile | null {
  return tile === null ? null : { x: tile.x, y: tile.y };
}

/** A deep copy of a ride record, with its keys in a fixed order (so its JSON is stable). */
export function copyRide(ride: RideRecord): RideRecord {
  return {
    id: ride.id,
    type: ride.type,
    kind: ride.kind,
    x: ride.x,
    y: ride.y,
    rot: ride.rot,
    name: ride.name,
    open: ride.open,
    price: ride.price,
    entrance: copyTile(ride.entrance),
    exit: copyTile(ride.exit),
    service: copyTile(ride.service),
    phase: ride.phase,
    phaseTicks: ride.phaseTicks,
    riders: [...ride.riders],
    queue: [...ride.queue],
    stats: {
      customers: ride.stats.customers,
      income: ride.stats.income,
      runningCost: ride.stats.runningCost,
      monthCustomers: ride.stats.monthCustomers,
      monthIncome: ride.stats.monthIncome,
    },
  };
}
