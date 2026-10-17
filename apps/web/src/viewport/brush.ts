import type { TerrainData } from "@coasterworks/render";
import { DAYS_PER_MONTH, MAX_HEIGHT, TICKS_PER_DAY } from "@coasterworks/sim";

export type TerrainToolId = "raise" | "lower" | "level" | "water";
export type BrushSize = 1 | 2 | 3;

/** A rectangle of tiles, in the shape the terrain commands take. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClickMods {
  shift: boolean;
  alt: boolean;
}

export interface PlannedCommand {
  name: string;
  input: TileRect & { height?: number; level?: number };
}

/**
 * The tiles a brush of `size` covers when centered on tile (`x`, `y`): `x - floor((size - 1) / 2)`
 * across. Over the edge of the map the rectangle shrinks to the part on the map, so a brush there
 * never asks for tiles that do not exist. `null` when none of it is on the map.
 */
export function brushRect(
  x: number,
  y: number,
  size: number,
  mapWidth: number,
  mapHeight: number,
): TileRect | null {
  const reach = Math.floor((size - 1) / 2);
  const x0 = Math.max(0, x - reach);
  const y0 = Math.max(0, y - reach);
  const x1 = Math.min(mapWidth, x - reach + size);
  const y1 = Math.min(mapHeight, y - reach + size);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The height of the lowest of tile (`x`, `y`)'s four corners. */
export function lowestCorner(terrain: TerrainData, x: number, y: number): number {
  const stride = terrain.width + 1;
  const at = (cx: number, cy: number) => terrain.corners[cy * stride + cx] as number;
  return Math.min(at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1));
}

/**
 * What a click with `tool` on tile (`x`, `y`) asks the sim to do, or `null` if the brush is off the
 * map. Shift flips Raise and Lower. Level sets the brush to the clicked tile's lowest corner. Water
 * fills to two steps above it, and Alt drains instead.
 */
export function planCommand(
  tool: TerrainToolId,
  mods: ClickMods,
  x: number,
  y: number,
  size: number,
  terrain: TerrainData,
): PlannedCommand | null {
  const rect = brushRect(x, y, size, terrain.width, terrain.height);
  if (!rect) return null;
  switch (tool) {
    case "raise":
    case "lower": {
      const raise = (tool === "raise") !== mods.shift;
      return { name: raise ? "terrain_raise" : "terrain_lower", input: rect };
    }
    case "level":
      return { name: "terrain_level", input: { ...rect, height: lowestCorner(terrain, x, y) } };
    case "water": {
      const level = mods.alt ? 0 : Math.min(MAX_HEIGHT, lowestCorner(terrain, x, y) + 2);
      return { name: "terrain_set_water", input: { ...rect, level } };
    }
  }
}

const TICKS_PER_MONTH = TICKS_PER_DAY * DAYS_PER_MONTH;

/** Where in the visual day a tick falls, 0 to 1: a whole day-night cycle runs once a month. */
export function timeOfDay(tick: number): number {
  return (tick % TICKS_PER_MONTH) / TICKS_PER_MONTH;
}
