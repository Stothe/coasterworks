import { z } from "zod";
import { PATH_FOOT, PATH_NONE, PATH_QUEUE, canBuildPath } from "../paths/paths.js";
import type { Rect, World } from "../world/types.js";
import { defineCommand } from "./define.js";
import {
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
