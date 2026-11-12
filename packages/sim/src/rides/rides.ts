import {
  rotateOffset,
  rotatedFootprint,
  rotateSide,
  typeById,
  type ContentType,
  type Rot,
} from "@coasterworks/content";
import { MAX_PATH_SLOPE } from "../paths/paths.js";
import { getCorner, tileCorners } from "../terrain/terrain.js";
import { tileHasTrack } from "../track/occupancy.js";
import type { Rect, Terrain, World } from "../world/types.js";
import { MAX_RIDE_ID, RIDE_CAP, RidePhase, type RideRecord, type Tile } from "./types.js";

export const OUTSIDE_PARK = "Area is outside the park";
export const ON_WATER = "Cannot build on water";
export const NOT_FLAT = "Ground is not flat";
export const SOMETHING_HERE = "Something is already here";
export const TOO_MANY_RIDES = "Too many rides";
export const TOO_MANY_BUILT = "Too many rides built";

/** One tile over from a tile on each side: 0 north, 1 east, 2 south, 3 west. */
const SIDE_STEP: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** The footprint of `type` placed with its rotated top-left at (x, y), as a rect of tiles. */
export function footprintRect(type: ContentType, x: number, y: number, rot: Rot): Rect {
  const { w, h } = rotatedFootprint(type.footprint, rot);
  return { x, y, w, h };
}

/**
 * The tiles guests use to reach `type` placed at (x, y) with rotation `rot`: a ride's entrance and
 * exit, or a stall's service tile. All lie just outside the footprint.
 */
export function accessTiles(
  type: ContentType,
  x: number,
  y: number,
  rot: Rot,
): { entrance: Tile | null; exit: Tile | null; service: Tile | null } {
  if (type.kind === "ride") {
    const e = rotateOffset(type.entrance, type.footprint, rot);
    const o = rotateOffset(type.exit, type.footprint, rot);
    return {
      entrance: { x: x + e.x, y: y + e.y },
      exit: { x: x + o.x, y: y + o.y },
      service: null,
    };
  }
  const [dx, dy] = SIDE_STEP[rotateSide(type.front, rot)] as readonly [number, number];
  return { entrance: null, exit: null, service: { x: x + dx, y: y + dy } };
}

/** The entrance, exit and service tiles a ride has, in that order. */
export function rideAccessTiles(ride: Pick<RideRecord, "entrance" | "exit" | "service">): Tile[] {
  const out: Tile[] = [];
  for (const tile of [ride.entrance, ride.exit, ride.service]) if (tile !== null) out.push(tile);
  return out;
}

/**
 * The footprint of a ride in the park, from its content type. Throws for an unknown type. A
 * coaster's is the tile of its first station piece (its track is in `World.tracks`).
 */
export function rideFootprint(ride: RideRecord): Rect {
  if (ride.kind === "coaster") return { x: ride.x, y: ride.y, w: 1, h: 1 };
  const type = typeById(ride.type);
  if (type === undefined) throw new RangeError(`Ride ${ride.id} has unknown type ${ride.type}`);
  return footprintRect(type, ride.x, ride.y, ride.rot);
}

/** Whether the w by h rect at (x, y) is on the map and clear of its outer ring of tiles. */
function insideRing(t: Terrain, x: number, y: number, w: number, h: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  return x >= 1 && y >= 1 && x + w <= t.width - 1 && y + h <= t.height - 1;
}

function isParkEntrance(world: World, x: number, y: number): boolean {
  const { entrance } = world.park;
  return entrance !== null && entrance.x === x && entrance.y === y;
}

/** The reason for an entrance, exit or service tile too steep for the path that must reach it. */
export const ACCESS_TOO_STEEP = "The way in or out is too steep for a path";

/** Flat indexes of every ride's and stall's access tiles: entrances, exits and service tiles. */
export function accessIndexes(world: World): Set<number> {
  const out = new Set<number>();
  for (const ride of world.rides) {
    for (const tile of rideAccessTiles(ride)) out.add(tile.y * world.terrain.width + tile.x);
  }
  return out;
}

/**
 * The reason `type` cannot be placed with its rotated top-left at (x, y), or null if it can.
 * Checked in this order:
 *
 *   1. every footprint tile and the entrance, exit or service tile is on the map and off its outer
 *      ring ("Area is outside the park");
 *   2. no footprint tile has water ("Cannot build on water");
 *   3. every corner of every footprint tile is at the same height ("Ground is not flat");
 *   4. no footprint tile has a path, the park entrance, another ride, or another ride's entrance,
 *      exit or service tile ("Something is already here");
 *   5. the entrance, exit or service tile has no ride on it, no water, and is not the park entrance
 *      ("Something is already here"); it may have a path, which is how guests reach it;
 *   6. no coaster track lies over a footprint tile or the entrance, exit or service tile
 *      ("Something is already here");
 *   7. fewer than `RIDE_CAP` rides and stalls stand ("Too many rides"), and an id is left
 *      ("Too many rides built").
 */
export function canPlaceRide(
  world: World,
  type: ContentType,
  x: number,
  y: number,
  rot: Rot,
): string | null {
  const t = world.terrain;
  const rect = footprintRect(type, x, y, rot);
  const access = rideAccessTiles(accessTiles(type, x, y, rot));

  if (!insideRing(t, rect.x, rect.y, rect.w, rect.h)) return OUTSIDE_PARK;
  for (const tile of access) if (!insideRing(t, tile.x, tile.y, 1, 1)) return OUTSIDE_PARK;

  for (let ty = rect.y; ty < rect.y + rect.h; ty++) {
    for (let tx = rect.x; tx < rect.x + rect.w; tx++) {
      if ((t.water[ty * t.width + tx] as number) > 0) return ON_WATER;
    }
  }

  const height = getCorner(t, rect.x, rect.y);
  for (let cy = rect.y; cy <= rect.y + rect.h; cy++) {
    for (let cx = rect.x; cx <= rect.x + rect.w; cx++) {
      if (getCorner(t, cx, cy) !== height) return NOT_FLAT;
    }
  }

  const reserved = new Set<number>();
  for (const ride of world.rides) {
    for (const tile of rideAccessTiles(ride)) reserved.add(tile.y * t.width + tile.x);
  }
  for (let ty = rect.y; ty < rect.y + rect.h; ty++) {
    for (let tx = rect.x; tx < rect.x + rect.w; tx++) {
      const index = ty * t.width + tx;
      if (
        (t.path[index] as number) !== 0 ||
        (t.occupant[index] as number) !== 0 ||
        reserved.has(index) ||
        isParkEntrance(world, tx, ty)
      ) {
        return SOMETHING_HERE;
      }
    }
  }

  for (const tile of access) {
    const index = tile.y * t.width + tile.x;
    if (
      (t.occupant[index] as number) !== 0 ||
      (t.water[index] as number) > 0 ||
      reserved.has(index) ||
      isParkEntrance(world, tile.x, tile.y)
    ) {
      return SOMETHING_HERE;
    }
  }
  if (world.tracks.length > 0) {
    for (let ty = rect.y; ty < rect.y + rect.h; ty++) {
      for (let tx = rect.x; tx < rect.x + rect.w; tx++) {
        if (tileHasTrack(world, ty * t.width + tx)) return SOMETHING_HERE;
      }
    }
    for (const tile of access) {
      if (tileHasTrack(world, tile.y * t.width + tile.x)) return SOMETHING_HERE;
    }
  }
  // Guests reach a ride by a path on its access tiles, so each must be able to take one.
  for (const tile of access) {
    const corners = tileCorners(t, tile.x, tile.y);
    if (Math.max(...corners) - Math.min(...corners) > MAX_PATH_SLOPE) return ACCESS_TOO_STEEP;
  }

  if (world.rides.length >= RIDE_CAP) return TOO_MANY_RIDES;
  if (world.nextRideId > MAX_RIDE_ID) return TOO_MANY_BUILT;
  return null;
}

/** Writes `value` (a ride id, or 0 to free them) into the occupant layer over `rect`. */
export function fillOccupancy(t: Terrain, rect: Rect, value: number): void {
  for (let ty = rect.y; ty < rect.y + rect.h; ty++) {
    t.occupant.fill(value, ty * t.width + rect.x, ty * t.width + rect.x + rect.w);
  }
}

/**
 * The ride or stall with this id, or undefined. A binary search: `world.rides` is kept in id order
 * (see `addRide`; the save invariants refuse a world whose rides are not).
 */
export function findRide(world: World, id: number): RideRecord | undefined {
  const rides = world.rides;
  let lo = 0;
  let hi = rides.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ride = rides[mid] as RideRecord;
    if (ride.id === id) return ride;
    if (ride.id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** The error for an id with no ride, or null. */
export function checkRideId(world: World, id: number): string | null {
  return findRide(world, id) === undefined ? `No ride with id ${id}` : null;
}

/**
 * The default name for a new ride of `type`: its type name and the smallest positive number no ride
 * in the park is already named with, such as "Carousel 2".
 */
export function defaultRideName(world: World, type: Pick<ContentType, "name">): string {
  const taken = new Set(world.rides.map((ride) => ride.name));
  for (let n = 1; ; n++) {
    const name = `${type.name} ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** A new, closed, idle ride record of `type` at (x, y), with its default name and price. */
export function newRide(
  world: World,
  id: number,
  type: ContentType,
  x: number,
  y: number,
  rot: Rot,
): RideRecord {
  return {
    id,
    type: type.id,
    kind: type.kind,
    x,
    y,
    rot,
    name: defaultRideName(world, type),
    open: false,
    price: type.defaultPrice,
    ...accessTiles(type, x, y, rot),
    phase: RidePhase.IDLE,
    phaseTicks: 0,
    riders: [],
    queue: [],
    stats: { customers: 0, income: 0, runningCost: 0, monthCustomers: 0, monthIncome: 0 },
  };
}

/**
 * Puts a ride into the park: into `world.rides`, in id order, and onto its footprint tiles. A
 * coaster marks no tiles; its track goes into `World.tracks` and the track index.
 */
export function addRide(world: World, ride: RideRecord): void {
  let at = world.rides.length;
  while (at > 0 && (world.rides[at - 1] as RideRecord).id > ride.id) at--;
  world.rides.splice(at, 0, ride);
  if (ride.kind !== "coaster") fillOccupancy(world.terrain, rideFootprint(ride), ride.id);
}

/** Takes a ride out of the park and frees its tiles. Returns the record, or throws if absent. */
export function removeRide(world: World, id: number): RideRecord {
  const at = world.rides.findIndex((ride) => ride.id === id);
  if (at === -1) throw new RangeError(`No ride with id ${id}`);
  const [ride] = world.rides.splice(at, 1) as [RideRecord];
  if (ride.kind !== "coaster") fillOccupancy(world.terrain, rideFootprint(ride), 0);
  return ride;
}
