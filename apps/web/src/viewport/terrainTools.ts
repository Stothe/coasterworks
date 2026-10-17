import { MAX_HEIGHT } from "@coasterworks/sim";
import type { BrushSize } from "./brush";

/** The sizes of brush the tray offers. */
export const BRUSH_SIZES: readonly BrushSize[] = [1, 2, 3];

/** What a terrain tool does to the ground, as the tray offers it. */
export type TerrainVerb = "raise" | "lower" | "level" | "smooth" | "water" | "surface";

export interface TerrainVerbInfo {
  verb: TerrainVerb;
  /** The sim command a click runs. */
  command: string;
  label: string;
  /** The key that takes the verb up, as it is printed on a key cap. */
  key: string;
  /** What a modifier key does with it, shown in the tray. */
  hint?: string;
}

/** The tray's verbs, in its order. */
export const TERRAIN_VERBS: readonly TerrainVerbInfo[] = [
  { verb: "raise", command: "terrain_raise", label: "Raise", key: "R", hint: "Shift lowers" },
  { verb: "lower", command: "terrain_lower", label: "Lower", key: "L", hint: "Shift raises" },
  { verb: "level", command: "terrain_level", label: "Level", key: "V" },
  { verb: "smooth", command: "terrain_smooth", label: "Smooth", key: "M" },
  { verb: "water", command: "terrain_set_water", label: "Water", key: "W", hint: "Alt drains" },
  { verb: "surface", command: "terrain_set_surface", label: "Surface", key: "U" },
];

/** The verb a command is, or undefined for a command that is not one of the tray's. */
export function verbOfCommand(command: string | undefined): TerrainVerb | undefined {
  return TERRAIN_VERBS.find((info) => info.command === command)?.verb;
}

/** The ground surfaces, numbered as `terrain_set_surface` takes them. */
export const SURFACES: ReadonlyArray<{ id: number; label: string }> = [
  { id: 0, label: "Grass" },
  { id: 1, label: "Sand" },
  { id: 2, label: "Dirt" },
  { id: 3, label: "Rock" },
  { id: 4, label: "Snow" },
];

/** How many steps above the clicked ground a water click fills to, and how many the tray allows. */
export const WATER_ABOVE = { min: 1, max: 8, default: 2 } as const;
/** The heights a Level click can go to, and where the tray starts. */
export const LEVEL_HEIGHT = { min: 0, max: MAX_HEIGHT, default: 8 } as const;

/**
 * How a Level click picks its height: `tile` is the clicked tile's lowest corner, and `height` is
 * one the player chose.
 */
export type HeightMode = "tile" | "height";

/** What the tray lets the player choose for the verbs that take more than a click. */
export interface TerrainOptions {
  /** Water fills to this many steps above the clicked tile's lowest corner. */
  waterAbove: number;
  surface: number;
  heightMode: HeightMode;
  /** The height a Level click goes to in `height` mode. */
  height: number;
}

export const DEFAULT_TERRAIN_OPTIONS: TerrainOptions = {
  waterAbove: WATER_ABOVE.default,
  surface: 0,
  heightMode: "tile",
  height: LEVEL_HEIGHT.default,
};

/**
 * The command and defaults that put `verb` in the player's hand with `options`. The defaults carry
 * what a click cannot know until it lands: Water's `levelAbove` and Level's `heightMode` are read
 * by `planPlacement`, which works out the level or height from the clicked tile and leaves them
 * out of the command it sends.
 */
export function terrainPlacement(
  verb: TerrainVerb,
  options: TerrainOptions = DEFAULT_TERRAIN_OPTIONS,
): { command: string; defaults: Record<string, unknown> } {
  const command = TERRAIN_VERBS.find((info) => info.verb === verb)?.command ?? "";
  switch (verb) {
    case "level":
      return { command, defaults: { heightMode: options.heightMode, height: options.height } };
    case "water":
      return { command, defaults: { levelAbove: options.waterAbove } };
    case "surface":
      return { command, defaults: { surface: options.surface } };
    default:
      return { command, defaults: {} };
  }
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * The options a placement's defaults stand for, with the starting ones for any it does not give.
 * A Level placement with a height and no mode is in `height` mode, which is how a click reads it.
 */
export function optionsOfDefaults(defaults: Readonly<Record<string, unknown>>): TerrainOptions {
  const height = numberOr(defaults["height"], DEFAULT_TERRAIN_OPTIONS.height);
  const mode: HeightMode =
    defaults["heightMode"] === "tile" || defaults["heightMode"] === "height"
      ? defaults["heightMode"]
      : typeof defaults["height"] === "number"
        ? "height"
        : "tile";
  return {
    waterAbove: numberOr(defaults["levelAbove"], DEFAULT_TERRAIN_OPTIONS.waterAbove),
    surface: numberOr(defaults["surface"], DEFAULT_TERRAIN_OPTIONS.surface),
    heightMode: mode,
    height,
  };
}
