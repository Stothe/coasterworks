import type { TerrainData } from "@coasterworks/render";
import { DAYS_PER_MONTH, MAX_HEIGHT, TICKS_PER_DAY } from "@coasterworks/sim";
import { DEFAULT_TERRAIN_OPTIONS, WATER_ABOVE } from "./terrainTools";

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

/** What a click asks the sim to do for a placement: the command, and everything it takes. */
export interface PlacedCommand {
  name: string;
  input: Record<string, unknown>;
}

/**
 * What a click on tile (`x`, `y`) asks the sim to do for `placement`: its command with its
 * `defaults`, over the tiles the brush covers, or `null` if the brush is off the map. The area is
 * the player's click and nothing in the defaults can move it.
 *
 * Four terrain commands take something only the click can tell, and read it from the clicked
 * tile's lowest corner. Shift turns Raise into Lower and back. Level goes to that corner
 * (`heightMode` "tile", or no height given) or to the `height` it was given. Water fills to
 * `levelAbove` steps over that corner (two without it, or the `level` the placement gives
 * outright), held to the highest level the sim takes, and drains with Alt. Surface is grass
 * unless it is given one. `levelAbove` and `heightMode` are for this function only, and are left
 * out of the command.
 */
export function planPlacement(
  placement: { command: string; defaults: Record<string, unknown>; size: number },
  mods: ClickMods,
  x: number,
  y: number,
  terrain: TerrainData,
): PlacedCommand | null {
  const rect = brushRect(x, y, placement.size, terrain.width, terrain.height);
  if (!rect) return null;
  const { levelAbove, heightMode, ...given } = placement.defaults;
  const { command } = placement;
  switch (command) {
    case "terrain_raise":
    case "terrain_lower": {
      const raise = (command === "terrain_raise") !== mods.shift;
      return { name: raise ? "terrain_raise" : "terrain_lower", input: { ...given, ...rect } };
    }
    case "terrain_level": {
      const height =
        heightMode !== "tile" && typeof given["height"] === "number"
          ? given["height"]
          : lowestCorner(terrain, x, y);
      return { name: command, input: { ...given, ...rect, height } };
    }
    case "terrain_set_water": {
      const above = typeof levelAbove === "number" ? levelAbove : WATER_ABOVE.default;
      const level =
        typeof levelAbove !== "number" && typeof given["level"] === "number"
          ? given["level"]
          : Math.min(MAX_HEIGHT, lowestCorner(terrain, x, y) + above);
      return { name: command, input: { ...given, ...rect, level: mods.alt ? 0 : level } };
    }
    case "terrain_set_surface":
      return {
        name: command,
        input: { surface: DEFAULT_TERRAIN_OPTIONS.surface, ...given, ...rect },
      };
    default:
      return { name: command, input: { ...given, ...rect } };
  }
}

/** One day-night cycle runs once a month. */
const CYCLE = TICKS_PER_DAY * DAYS_PER_MONTH;
/** Where in the cycle tick 0 falls, so that a new park opens in the morning rather than at night. */
const START_OFFSET = 0.3;

/** Where in the visual day a tick falls, 0 to 1: a whole day-night cycle runs once a month. */
export function timeOfDay(tick: number): number {
  return ((tick + START_OFFSET * CYCLE) % CYCLE) / CYCLE;
}
