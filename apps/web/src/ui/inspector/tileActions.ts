import type { TerrainData } from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import type { Action } from "../../actions/types";
import { uiStore } from "../../state/uiStore";
import { planPlacement, type ClickMods, type PlacedCommand } from "../../viewport/brush";
import { WATER_ABOVE, optionsOfDefaults } from "../../viewport/terrainTools";
import { formatCents } from "../format";

/**
 * The placement commands in the order the tile's menu and the inspector list them. A placement
 * command the sim has that is not here is listed after these, in the registry's order.
 */
export const TILE_COMMAND_ORDER: readonly string[] = [
  "terrain_raise",
  "terrain_lower",
  "terrain_level",
  "terrain_smooth",
  "terrain_set_water",
  "terrain_set_surface",
];

/** The command Drain is a variant of: Set water, with the level 0. */
const WATER = "terrain_set_water";

/** What is said when a command worked, in front of the tile: `Raised (3, 4)`. */
const DONE: Readonly<Record<string, string>> = {
  terrain_raise: "Raised",
  terrain_lower: "Lowered",
  terrain_level: "Leveled",
  terrain_smooth: "Smoothed",
  terrain_set_water: "Water set on",
  terrain_set_surface: "Surface set on",
};

/** A line that says what the title leaves out, shown as the control's tooltip. */
const HINTS: Readonly<Record<string, string>> = {
  terrain_set_water: `${WATER_ABOVE.default} steps above the lowest corner`,
  terrain_set_surface: "The surface chosen in the Terrain tray, or grass",
};

/** One thing the tile's menu and the inspector can do to a single tile. */
export interface TileEntry {
  /** Unique among the entries: the command, and for the variant of Set water, `Drain` too. */
  id: string;
  /** The button's and the menu item's text: the action's own title, or `Drain`. */
  label: string;
  /** The sim command it runs. */
  command: string;
  /** What is said when it worked: `Raised`, shown with the tile and the charge. */
  done: string;
  /** A line that says what the label leaves out, shown as the control's tooltip. */
  hint?: string;
  /** The modifiers of the click it stands for: Drain is a click of Water with Alt held. */
  mods: ClickMods;
  /** What the command needs besides the area, worked out when it runs. */
  defaults(): Record<string, unknown>;
}

const NO_MODS: ClickMods = { shift: false, alt: false };

/** The surface the Terrain tray has chosen, or grass: what Set surface puts on a tile. */
function trayDefaultSurface(): number {
  return optionsOfDefaults(uiStore.getState().placement?.defaults ?? {}).surface;
}

/**
 * The defaults a command is started with, as a click of its tool with a brush of one would have
 * them: Water fills two steps above the tile's lowest corner, Level goes to that corner, and the
 * surface is the tray's. Any other command takes nothing but the area.
 */
function defaultsOf(command: string): Record<string, unknown> {
  switch (command) {
    case "terrain_set_water":
      return { levelAbove: WATER_ABOVE.default };
    case "terrain_level":
      return { heightMode: "tile" };
    case "terrain_set_surface":
      return { surface: trayDefaultSurface() };
    default:
      return {};
  }
}

function entryOf(action: Action): TileEntry {
  const command = action.commandName ?? action.id;
  const entry: TileEntry = {
    id: command,
    label: action.title,
    command,
    done: DONE[command] ?? action.title,
    mods: NO_MODS,
    defaults: () => defaultsOf(command),
  };
  const hint = HINTS[command];
  if (hint !== undefined) entry.hint = hint;
  return entry;
}

/** Drain: a click of Water with Alt held, which sets the level to 0. */
function drainEntry(): TileEntry {
  return {
    id: `${WATER}:drain`,
    label: "Drain",
    command: WATER,
    done: "Drained",
    mods: { shift: false, alt: true },
    defaults: () => defaultsOf(WATER),
  };
}

/**
 * What can be done to a single tile, drawn from the actions the app has: every action that takes
 * an area of tiles (`placement: "rect"`), in the order of `TILE_COMMAND_ORDER` and then the
 * registry's, with Drain, the variant of Set water, after it. A command the sim adds that takes
 * an area is listed here with no change.
 */
export function tileEntries(actions: readonly Action[]): TileEntry[] {
  const rect = actions.filter((action) => action.placement === "rect");
  const rank = (action: Action) => {
    const at = TILE_COMMAND_ORDER.indexOf(action.commandName ?? action.id);
    return at < 0 ? TILE_COMMAND_ORDER.length : at;
  };
  // Array.prototype.sort is stable, so the commands that are not in the order keep the registry's.
  const ordered = [...rect].sort((a, b) => rank(a) - rank(b));
  return ordered.flatMap((action) =>
    (action.commandName ?? action.id) === WATER
      ? [entryOf(action), drainEntry()]
      : [entryOf(action)],
  );
}

/**
 * The command that does `entry` to tile (`x`, `y`) alone. It is the command a click of the matching
 * terrain tool would send with a brush of one, so the two cannot disagree about what "level" or
 * "water" means: Level goes to the tile's lowest corner, Set water fills to `WATER_ABOVE.default`
 * steps over it, and Drain sets the level to 0.
 */
export function tileCommand(
  entry: TileEntry,
  terrain: TerrainData,
  x: number,
  y: number,
): PlacedCommand | null {
  return planPlacement(
    { command: entry.command, defaults: entry.defaults(), size: 1 },
    entry.mods,
    x,
    y,
    terrain,
  );
}

/** What to say about a command that ran: where, and what it cost or refunded. */
export function tileMessage(entry: TileEntry, x: number, y: number, result: ExecResult): string {
  if (!result.ok) return result.error;
  const where = `${entry.done} (${x}, ${y})`;
  if (result.cost > 0) return `${where}: charged ${formatCents(result.cost)}`;
  if (result.cost < 0) return `${where}: refunded ${formatCents(-result.cost)}`;
  return where;
}

/**
 * Does `entry` to tile (`x`, `y`) with `execute` and says how it went through `notify`. A refusal is
 * an error message; it is not thrown.
 */
export async function runTileEntry(
  entry: TileEntry,
  terrain: TerrainData | null,
  x: number,
  y: number,
  execute: (name: string, input: unknown) => Promise<ExecResult>,
  notify: (text: string, options?: { kind?: "info" | "error" }) => void,
): Promise<void> {
  const command = terrain ? tileCommand(entry, terrain, x, y) : null;
  if (!command) {
    notify("That tile is not on the map", { kind: "error" });
    return;
  }
  const result = await execute(command.name, command.input);
  notify(tileMessage(entry, x, y, result), result.ok ? {} : { kind: "error" });
}
