import { z } from "zod";
import { forEachCornerInRect, inBounds, tileBase } from "../terrain/terrain.js";
import { MAX_HEIGHT, type Rect, type World } from "../world/types.js";
import { defineCommand } from "./define.js";

/** Cost in cents of each corner a raise, lower, level, or smooth changes. */
export const RAISE_COST_PER_CORNER = 50_00;
/** Cost in cents of each tile whose surface changes. */
export const SURFACE_COST_PER_TILE = 10_00;
/** Cost in cents of each tile whose water level changes. */
export const WATER_COST_PER_TILE = 20_00;

/** A rectangle of tiles on the map. Whether it fits on this map is up to `validate`. */
export const rectSchema = z.object({
  x: z.int().min(0),
  y: z.int().min(0),
  w: z.int().min(1),
  h: z.int().min(1),
});

const heightSchema = z.int().min(0).max(MAX_HEIGHT);

const OUTSIDE_PARK = "Area is outside the park";

function checkRect(world: World, rect: Rect): string | null {
  return inBounds(world.terrain, rect.x, rect.y, rect.w, rect.h) ? null : OUTSIDE_PARK;
}

// Height commands -----------------------------------------------------------------------------

/** One corner a height command will change: its index, its height now, and its height after. */
type HeightChange = readonly [index: number, from: number, to: number];

/** What a height command saves so it can be undone: each changed corner and its previous height. */
interface HeightUndo {
  corners: Array<[index: number, previous: number]>;
}

/**
 * Lists the corners of `rect` whose height `target` would change, without changing any. `target`
 * is given each corner's current height and returns the height it should have. The rect must be
 * on the map.
 */
function planHeights(
  world: World,
  rect: Rect,
  target: (cx: number, cy: number, current: number) => number,
): HeightChange[] {
  const { corners } = world.terrain;
  const changes: HeightChange[] = [];
  forEachCornerInRect(world.terrain, rect, (cx, cy, index) => {
    const from = corners[index] as number;
    const to = target(cx, cy, from);
    if (to !== from) changes.push([index, from, to]);
  });
  return changes;
}

function applyHeights(world: World, changes: HeightChange[]): HeightUndo {
  const { corners } = world.terrain;
  return {
    corners: changes.map(([index, from, to]) => {
      corners[index] = to;
      return [index, from];
    }),
  };
}

function revertHeights(world: World, undo: HeightUndo): void {
  const { corners } = world.terrain;
  for (const [index, previous] of undo.corners) corners[index] = previous;
}

function heightCost(changes: HeightChange[]): number {
  return changes.length * RAISE_COST_PER_CORNER;
}

/** `current` moved by `delta`, held to 0..MAX_HEIGHT. */
function stepped(current: number, delta: number): number {
  return Math.min(MAX_HEIGHT, Math.max(0, current + delta));
}

const stepsSchema = rectSchema.extend({ steps: z.int().min(1).max(8).default(1) });

const planRaise = (world: World, input: { steps: number } & Rect) =>
  planHeights(world, input, (_cx, _cy, h) => stepped(h, input.steps));

export const terrainRaise = defineCommand({
  name: "terrain_raise",
  description:
    "Raises every corner in a rectangle of tiles by a number of steps (default 1), up to the maximum height. Costs $50 for each corner that changes.",
  category: "terrain",
  input: stepsSchema,
  undoable: true,
  cost: (world, input) => heightCost(planRaise(world, input)),
  validate: checkRect,
  apply: (world, input) => applyHeights(world, planRaise(world, input)),
  revert: (world, _input, undo) => revertHeights(world, undo),
});

const planLower = (world: World, input: { steps: number } & Rect) =>
  planHeights(world, input, (_cx, _cy, h) => stepped(h, -input.steps));

export const terrainLower = defineCommand({
  name: "terrain_lower",
  description:
    "Lowers every corner in a rectangle of tiles by a number of steps (default 1), down to zero. Costs $50 for each corner that changes.",
  category: "terrain",
  input: stepsSchema,
  undoable: true,
  cost: (world, input) => heightCost(planLower(world, input)),
  validate: checkRect,
  apply: (world, input) => applyHeights(world, planLower(world, input)),
  revert: (world, _input, undo) => revertHeights(world, undo),
});

const planLevel = (world: World, input: { height: number } & Rect) =>
  planHeights(world, input, () => input.height);

export const terrainLevel = defineCommand({
  name: "terrain_level",
  description:
    "Sets every corner in a rectangle of tiles to one height (0 to 63). Costs $50 for each corner that changes.",
  category: "terrain",
  input: rectSchema.extend({ height: heightSchema }),
  undoable: true,
  cost: (world, input) => heightCost(planLevel(world, input)),
  validate: checkRect,
  apply: (world, input) => applyHeights(world, planLevel(world, input)),
  revert: (world, _input, undo) => revertHeights(world, undo),
});

/**
 * The rounded mean height of corner (cx, cy) and its neighbors, the up to 8 corners around it that
 * are on the map. Reads `world.terrain.corners` only, so call it before any corner changes.
 */
function smoothedHeight(world: World, cx: number, cy: number): number {
  const { width, height, corners } = world.terrain;
  let sum = 0;
  let count = 0;
  for (let ny = Math.max(0, cy - 1); ny <= Math.min(height, cy + 1); ny++) {
    for (let nx = Math.max(0, cx - 1); nx <= Math.min(width, cx + 1); nx++) {
      sum += corners[ny * (width + 1) + nx] as number;
      count++;
    }
  }
  return Math.round(sum / count);
}

// planHeights collects every change before applyHeights writes any, so each average is taken from
// the heights before the pass, not from corners the pass has already moved.
const planSmooth = (world: World, rect: Rect) =>
  planHeights(world, rect, (cx, cy) => smoothedHeight(world, cx, cy));

export const terrainSmooth = defineCommand({
  name: "terrain_smooth",
  description:
    "Sets each corner in a rectangle of tiles to the rounded average height of itself and its neighbors, in one pass. Costs $50 for each corner that changes.",
  category: "terrain",
  input: rectSchema,
  undoable: true,
  cost: (world, input) => heightCost(planSmooth(world, input)),
  validate: checkRect,
  apply: (world, input) => applyHeights(world, planSmooth(world, input)),
  revert: (world, _input, undo) => revertHeights(world, undo),
});

// Tile commands -------------------------------------------------------------------------------

/** What a tile command saves so it can be undone: each changed tile and its previous value. */
interface TileUndo {
  tiles: Array<[index: number, previous: number]>;
}

/** Calls `fn(x, y, index)` for each tile of `rect`, row by row. The rect must be on the map. */
function forEachTileInRect(
  world: World,
  rect: Rect,
  fn: (x: number, y: number, index: number) => void,
): void {
  const { width } = world.terrain;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) fn(x, y, y * width + x);
  }
}

/** The indexes of the tiles of `rect` where `layer` differs from `value`. */
function tilesToChange(world: World, rect: Rect, layer: Uint8Array, value: number): number[] {
  const indexes: number[] = [];
  forEachTileInRect(world, rect, (_x, _y, index) => {
    if (layer[index] !== value) indexes.push(index);
  });
  return indexes;
}

function setTiles(layer: Uint8Array, indexes: number[], value: number): TileUndo {
  return {
    tiles: indexes.map((index) => {
      const previous = layer[index] as number;
      layer[index] = value;
      return [index, previous];
    }),
  };
}

function revertTiles(layer: Uint8Array, undo: TileUndo): void {
  for (const [index, previous] of undo.tiles) layer[index] = previous;
}

export const terrainSetSurface = defineCommand({
  name: "terrain_set_surface",
  description:
    "Sets the ground surface of every tile in a rectangle: 0 grass, 1 sand, 2 dirt, 3 rock, 4 snow. Costs $10 for each tile that changes.",
  category: "terrain",
  input: rectSchema.extend({ surface: z.int().min(0).max(4) }),
  undoable: true,
  cost: (world, input) =>
    tilesToChange(world, input, world.terrain.surface, input.surface).length *
    SURFACE_COST_PER_TILE,
  validate: checkRect,
  apply: (world, input) =>
    setTiles(
      world.terrain.surface,
      tilesToChange(world, input, world.terrain.surface, input.surface),
      input.surface,
    ),
  revert: (world, _input, undo) => revertTiles(world.terrain.surface, undo),
});

export const terrainSetWater = defineCommand({
  name: "terrain_set_water",
  description:
    "Sets the water level of every tile in a rectangle (0 to 63). A level above 0 must be higher than the lowest corner of every tile; level 0 drains the tiles. Costs $20 for each tile that changes.",
  category: "terrain",
  input: rectSchema.extend({ level: heightSchema }),
  undoable: true,
  cost: (world, input) =>
    tilesToChange(world, input, world.terrain.water, input.level).length * WATER_COST_PER_TILE,
  validate: (world, input) => {
    const outside = checkRect(world, input);
    if (outside !== null) return outside;
    if (input.level === 0) return null;
    let aboveGround = true;
    forEachTileInRect(world, input, (x, y) => {
      if (input.level <= tileBase(world.terrain, x, y)) aboveGround = false;
    });
    return aboveGround ? null : "Water must be above the ground";
  },
  apply: (world, input) =>
    setTiles(
      world.terrain.water,
      tilesToChange(world, input, world.terrain.water, input.level),
      input.level,
    ),
  revert: (world, _input, undo) => revertTiles(world.terrain.water, undo),
});
