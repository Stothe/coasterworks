import type { Sim, World } from "../../src/index.js";
import { GuestState } from "../../src/guests/types.js";
import type { RideRecord } from "../../src/rides/types.js";
import { makePark, placeGuest, run, type ParkOptions, type Placement } from "./guests.js";

/**
 * Where `makeRidePark` puts its carousel: a 3 by 3 footprint at (4, 5) to (6, 7), turned 0, so its
 * entrance is (5, 8) below the middle of the south side and its exit (7, 6) beside the east side.
 */
export const CAROUSEL = { x: 4, y: 5 };
export const RIDE_ENTRANCE = { x: 5, y: 8 };
export const RIDE_EXIT = { x: 7, y: 6 };

/**
 * The queue of `makeRidePark`, front first: the entrance tile, then a line of queue path that
 * turns east and meets the main footpath (x = 8) at (8, 10).
 */
export const QUEUE_LINE = [
  { x: 5, y: 8 },
  { x: 5, y: 9 },
  { x: 5, y: 10 },
  { x: 6, y: 10 },
  { x: 7, y: 10 },
];

/** A tile of the main footpath next to where the queue meets it. */
export const JOIN_TILE = { x: 8, y: 10 };

export interface RideParkOptions extends ParkOptions {
  /** Whether to open the carousel. Defaults to true. */
  openRide?: boolean;
  /** Lay the queue line. Defaults to true; without it the entrance tile is a footpath tile. */
  queue?: boolean;
}

/**
 * `makePark` (16 by 24, entrance (8, 23), footpath along x = 8 from y = 4 to 22) with a carousel
 * (id 1) west of the footpath, a footpath tile on its exit joining the main path, and a queue of
 * five tiles from its entrance to the main path. Built with player commands.
 */
export function makeRidePark(options: RideParkOptions = {}): Sim {
  const sim = makePark(options);
  run(sim, "ride_build", { type: "carousel", x: CAROUSEL.x, y: CAROUSEL.y, rot: 0 });
  run(sim, "path_build_tiles", { tiles: [RIDE_EXIT], kind: "foot" });
  if (options.queue ?? true) {
    run(sim, "path_build_tiles", { tiles: QUEUE_LINE, kind: "queue" });
  } else {
    run(sim, "path_build_tiles", {
      tiles: [RIDE_ENTRANCE, { x: 6, y: 8 }, { x: 7, y: 8 }],
      kind: "foot",
    });
  }
  if (options.openRide ?? true) run(sim, "ride_open", { id: 1 });
  return sim;
}

/** The ride with `id`, which the test knows exists. */
export function rideOf(world: World, id = 1): RideRecord {
  const ride = world.rides.find((r) => r.id === id);
  if (ride === undefined) throw new Error(`no ride ${id}`);
  return ride;
}

/** A wandering guest standing on `tile` (by default on the main path where the queue meets it). */
export function wanderer(world: World, tile = JOIN_TILE, patch: Placement = {}): number {
  return placeGuest(world, tile, GuestState.WANDERING, { sinceAction: 0, ...patch });
}

/** The tile a guest stands on. */
export function tileOf(world: World, slot: number): { x: number; y: number } {
  return {
    x: (world.guests.x[slot] as number) >> 5,
    y: (world.guests.y[slot] as number) >> 5,
  };
}
