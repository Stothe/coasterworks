import { z } from "zod";
import { PATH_FOOT, PATH_NONE, PATH_QUEUE, canBuildPath } from "../paths/paths.js";
import { inBounds } from "../terrain/terrain.js";
import type { Rect, World } from "../world/types.js";
import { defineCommand } from "./define.js";
import {
  OUTSIDE_PARK,
  checkRect,
  forEachTileInRect,
  rectSchema,
  revertTiles,
  setTiles,
  tilesToChange,
  type TileUndo,
} from "./terrain.js";

/** Cost in cents of each tile a path build changes: $10. */
export const PATH_COST = 10_00;

const PATH_VALUES = { foot: PATH_FOOT, queue: PATH_QUEUE } as const;

/** The first reason a path cannot go on every tile of `rect`, or null if it can. */
function checkPathRect(world: World, rect: Rect): string | null {
  const outside = checkRect(world, rect);
  if (outside !== null) return outside;
  let reason: string | null = null;
  forEachTileInRect(world, rect, (x, y) => {
    if (reason === null) reason = canBuildPath(world, x, y);
  });
  return reason;
}

export const pathBuild = defineCommand({
  name: "path_build",
  description:
    "Lays a footpath (`foot`) or a queue (`queue`) on every tile of a rectangle, replacing a path of the other kind. Costs $10 for each tile that changes. The whole rectangle is refused if any tile is off the map, on water, on a slope steeper than 2 steps across the tile, or the park entrance.",
  category: "path",
  input: rectSchema.extend({ kind: z.enum(["foot", "queue"]) }),
  undoable: true,
  cost: (world, input) =>
    tilesToChange(world, input, world.terrain.path, PATH_VALUES[input.kind]).length * PATH_COST,
  validate: checkPathRect,
  apply: (world, input) => {
    const undo = setTiles(
      world.terrain.path,
      tilesToChange(world, input, world.terrain.path, PATH_VALUES[input.kind]),
      PATH_VALUES[input.kind],
    );
    world.pathVersion++;
    return undo;
  },
  revert: (world, _input, undo: TileUndo) => {
    revertTiles(world.terrain.path, undo);
    world.pathVersion++;
  },
});

export const pathRemove = defineCommand({
  name: "path_remove",
  description:
    "Removes the paths and queues from every tile of a rectangle. Tiles with no path are left alone. Free, and nothing is refunded.",
  category: "path",
  input: rectSchema,
  undoable: true,
  validate: checkRect,
  apply: (world, input) => {
    const undo = setTiles(
      world.terrain.path,
      tilesToChange(world, input, world.terrain.path, PATH_NONE),
      PATH_NONE,
    );
    world.pathVersion++;
    return undo;
  },
  revert: (world, _input, undo: TileUndo) => {
    revertTiles(world.terrain.path, undo);
    world.pathVersion++;
  },
});

// Tile lists ------------------------------------------------------------------------------------

/** Most tiles one tile-list path command takes: a long drag across a 256 map and back. */
export const MAX_PATH_TILES = 1024;

const tileListSchema = z
  .array(z.object({ x: z.int().min(0), y: z.int().min(0) }))
  .min(1)
  .max(MAX_PATH_TILES);

type TileList = Array<{ x: number; y: number }>;

/**
 * The flat indexes of `tiles` where `layer` differs from `value`, each once, in the order given. A
 * tile listed twice is changed once, so the undo data holds each tile's true previous value. The
 * tiles must be on the map.
 */
function listToChange(world: World, tiles: TileList, layer: Uint8Array, value: number): number[] {
  const { width } = world.terrain;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const { x, y } of tiles) {
    const index = y * width + x;
    if (seen.has(index)) continue;
    seen.add(index);
    if (layer[index] !== value) out.push(index);
  }
  return out;
}

/** The first tile of `tiles` off the map, as a reason, or null if all are on it. */
function checkTilesOnMap(world: World, tiles: TileList): string | null {
  for (const { x, y } of tiles) {
    if (!inBounds(world.terrain, x, y)) return `${OUTSIDE_PARK} at (${x}, ${y})`;
  }
  return null;
}

export const pathBuildTiles = defineCommand({
  name: "path_build_tiles",
  description:
    "Lays a footpath (`foot`) or a queue (`queue`) on each tile of a list, as one command: one charge and one undo step for the whole stroke (what dragging the path tool sends). Costs $10 for each tile that changes. The whole list is refused, naming the first tile, if any tile could not take a path (off the map, water, too steep, the entrance); `path_check_tiles` says which tiles those are beforehand. A tile listed twice counts once.",
  category: "path",
  input: z.object({ tiles: tileListSchema, kind: z.enum(["foot", "queue"]) }),
  undoable: true,
  cost: (world, input) =>
    listToChange(world, input.tiles, world.terrain.path, PATH_VALUES[input.kind]).length *
    PATH_COST,
  validate: (world, input) => {
    for (const { x, y } of input.tiles) {
      const reason = canBuildPath(world, x, y);
      if (reason !== null) return `${reason} at (${x}, ${y})`;
    }
    return null;
  },
  apply: (world, input) => {
    const value = PATH_VALUES[input.kind];
    const undo = setTiles(
      world.terrain.path,
      listToChange(world, input.tiles, world.terrain.path, value),
      value,
    );
    world.pathVersion++;
    return undo;
  },
  revert: (world, _input, undo: TileUndo) => {
    revertTiles(world.terrain.path, undo);
    world.pathVersion++;
  },
});

export const pathRemoveTiles = defineCommand({
  name: "path_remove_tiles",
  description:
    "Removes the paths and queues from each tile of a list, as one command and one undo step. Tiles with no path are left alone. Free, and nothing is refunded. Refused if any tile is off the map.",
  category: "path",
  input: z.object({ tiles: tileListSchema }),
  undoable: true,
  validate: (world, input) => checkTilesOnMap(world, input.tiles),
  apply: (world, input) => {
    const undo = setTiles(
      world.terrain.path,
      listToChange(world, input.tiles, world.terrain.path, PATH_NONE),
      PATH_NONE,
    );
    world.pathVersion++;
    return undo;
  },
  revert: (world, _input, undo: TileUndo) => {
    revertTiles(world.terrain.path, undo);
    world.pathVersion++;
  },
});
