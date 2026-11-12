import { inBounds, tileCorners, tileIndex } from "../terrain/terrain.js";
import type { EdgeSide } from "../park/types.js";
import type { Terrain, World } from "../world/types.js";

/** No path on the tile. */
export const PATH_NONE = 0;
/** A footpath, which guests walk along. */
export const PATH_FOOT = 1;
/** A queue, the path that leads up to a ride. */
export const PATH_QUEUE = 2;

/** Largest corner height difference across one tile that a path can still be laid on. */
export const MAX_PATH_SLOPE = 2;

/** The path value on tile (x, y): `PATH_NONE`, `PATH_FOOT`, or `PATH_QUEUE`. None off the map. */
export function pathAt(t: Terrain, x: number, y: number): number {
  if (!inBounds(t, x, y)) return PATH_NONE;
  return t.path[y * t.width + x] as number;
}

/**
 * The reason a path cannot be laid on tile (x, y), or null if it can. Checked in this order: off
 * the map, water, a slope steeper than `MAX_PATH_SLOPE`, the park entrance, and a tile a ride or
 * stall stands on. A ride's entrance, exit, or service tile is not occupied and takes a path.
 */
export function canBuildPath(world: World, x: number, y: number): string | null {
  const t = world.terrain;
  if (!inBounds(t, x, y)) return "Area is outside the park";
  if ((t.water[tileIndex(t, x, y)] as number) > 0) return "Cannot build on water";
  const corners = tileCorners(t, x, y);
  if (Math.max(...corners) - Math.min(...corners) > MAX_PATH_SLOPE) return "Tile is too steep";
  const { entrance } = world.park;
  if (entrance !== null && entrance.x === x && entrance.y === y) return "Tile is the park entrance";
  if ((t.occupant[tileIndex(t, x, y)] as number) !== 0) return "Something is already here";
  return null;
}

/** The path tiles next to (x, y), as [x, y] pairs, in the order north, east, south, west. */
export function neighborsOnPath(t: Terrain, x: number, y: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [nx, ny] of [
    [x, y - 1],
    [x + 1, y],
    [x, y + 1],
    [x - 1, y],
  ] as const) {
    if (pathAt(t, nx, ny) !== PATH_NONE) out.push([nx, ny]);
  }
  return out;
}

/** Whether tile (x, y) is on the outer ring of the map. False off the map. */
export function isEdgeTile(t: Terrain, x: number, y: number): boolean {
  return edgeSide(t, x, y) !== -1;
}

/**
 * Which map edge tile (x, y) is on: 0 north (y = 0), 1 east (x = width - 1), 2 south
 * (y = height - 1), 3 west (x = 0), or -1 if it is not on an edge or not on the map. A corner tile
 * is on two edges and gets the first of them in that order.
 */
export function edgeSide(t: Terrain, x: number, y: number): EdgeSide | -1 {
  if (!inBounds(t, x, y)) return -1;
  if (y === 0) return 0;
  if (x === t.width - 1) return 1;
  if (y === t.height - 1) return 2;
  if (x === 0) return 3;
  return -1;
}
