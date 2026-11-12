import { PATH_QUEUE } from "../paths/paths.js";
import type { World } from "../world/types.js";
import type { RideRecord } from "./types.js";

/** Guests that stand on one queue tile. */
export const QUEUE_PER_TILE = 4;

/** The queue tiles of one ride, as worked out from the paths. Runtime only. */
export interface QueueInfo {
  /**
   * Flat tile indexes, front first: the ride's entrance tile, then every queue path tile joined to
   * it edge to edge, ordered by steps from the entrance and then by index.
   */
  tiles: number[];
  /** Steps from the entrance for each tile in `tiles`, by flat index. */
  dist: Map<number, number>;
  /** Most guests the queue holds: `max(1, queue path tiles) * QUEUE_PER_TILE`. */
  capacity: number;
}

/**
 * Every ride's queue tiles, kept on the world and thrown away whenever the paths or the rides
 * change. Runtime only: never saved or hashed, rebuilt from the paths on demand.
 */
export interface QueueCache {
  pathVersion: number;
  rideVersion: number;
  byRide: Map<number, QueueInfo>;
}

const STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Finds a ride's queue: a breadth-first walk from its entrance tile over queue path tiles only.
 * The entrance tile counts as the front whatever path it holds (or none). A stall has no queue and
 * gets an empty list with room for one tile of guests.
 */
function buildQueue(world: World, ride: RideRecord): QueueInfo {
  const dist = new Map<number, number>();
  const entrance = ride.entrance;
  const { width, height, path } = world.terrain;
  if (entrance === null) return { tiles: [], dist, capacity: QUEUE_PER_TILE };

  const start = entrance.y * width + entrance.x;
  const order: number[] = [start];
  dist.set(start, 0);
  for (let head = 0; head < order.length; head++) {
    const index = order[head] as number;
    const y = Math.floor(index / width);
    const x = index - y * width;
    const next = (dist.get(index) as number) + 1;
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (dist.has(n) || path[n] !== PATH_QUEUE) continue;
      dist.set(n, next);
      order.push(n);
    }
  }
  const tiles = order.sort((a, b) => (dist.get(a) as number) - (dist.get(b) as number) || a - b);
  let queuePaths = 0;
  for (const index of tiles) if (path[index] === PATH_QUEUE) queuePaths++;
  return { tiles, dist, capacity: Math.max(1, queuePaths) * QUEUE_PER_TILE };
}

/** The queue tiles of `ride`, from the world's cache (built or rebuilt as needed). */
export function queueInfo(world: World, ride: RideRecord): QueueInfo {
  let cache = world.queues;
  if (
    cache === undefined ||
    cache.pathVersion !== world.pathVersion ||
    cache.rideVersion !== world.rideVersion
  ) {
    cache = { pathVersion: world.pathVersion, rideVersion: world.rideVersion, byRide: new Map() };
    world.queues = cache;
  }
  let info = cache.byRide.get(ride.id);
  if (info === undefined) {
    info = buildQueue(world, ride);
    cache.byRide.set(ride.id, info);
  }
  return info;
}

/** Most guests `ride`'s queue holds. */
export function queueCapacity(world: World, ride: RideRecord): number {
  return queueInfo(world, ride).capacity;
}
