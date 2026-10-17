import type { TerrainData } from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { planPlacement, type PlacedCommand } from "../../viewport/brush";
import { WATER_ABOVE } from "../../viewport/terrainTools";
import { formatCents } from "../format";

/** What the inspector's buttons and the tile's context menu can do to one tile. */
export type TileActionId = "raise" | "lower" | "level" | "water" | "drain";

export interface TileAction {
  id: TileActionId;
  /** The button's and the menu item's text. */
  label: string;
  /** What is said when it worked: `Raised`, shown with the tile and the charge. */
  done: string;
}

/** The five, in the order both places list them. */
export const TILE_ACTIONS: readonly TileAction[] = [
  { id: "raise", label: "Raise here", done: "Raised" },
  { id: "lower", label: "Lower here", done: "Lowered" },
  { id: "level", label: "Level here", done: "Leveled" },
  { id: "water", label: "Set water", done: "Water set on" },
  { id: "drain", label: "Drain", done: "Drained" },
];

/**
 * The command that does `id` to tile (`x`, `y`) alone. It is the command a click of the matching
 * terrain tool would send with a brush of one, so the two cannot disagree about what "level" or
 * "water" means: Level goes to the tile's lowest corner, Set water fills to
 * `WATER_ABOVE.default` steps over it, and Drain sets the level to 0.
 */
export function tileCommand(
  id: TileActionId,
  terrain: TerrainData,
  x: number,
  y: number,
): PlacedCommand | null {
  const none = { shift: false, alt: false };
  const one = (command: string, defaults: Record<string, unknown> = {}) => ({
    command,
    defaults,
    size: 1,
  });
  switch (id) {
    case "raise":
      return planPlacement(one("terrain_raise"), none, x, y, terrain);
    case "lower":
      return planPlacement(one("terrain_lower"), none, x, y, terrain);
    case "level":
      return planPlacement(one("terrain_level", { heightMode: "tile" }), none, x, y, terrain);
    case "water":
      return planPlacement(
        one("terrain_set_water", { levelAbove: WATER_ABOVE.default }),
        none,
        x,
        y,
        terrain,
      );
    case "drain":
      return planPlacement(
        one("terrain_set_water", { levelAbove: WATER_ABOVE.default }),
        { shift: false, alt: true },
        x,
        y,
        terrain,
      );
  }
}

/** What to say about a command that ran: where, and what it cost or refunded. */
export function tileMessage(action: TileAction, x: number, y: number, result: ExecResult): string {
  if (!result.ok) return result.error;
  const where = `${action.done} (${x}, ${y})`;
  if (result.cost > 0) return `${where}: charged ${formatCents(result.cost)}`;
  if (result.cost < 0) return `${where}: refunded ${formatCents(-result.cost)}`;
  return where;
}

/**
 * Does `id` to tile (`x`, `y`) with `execute` and says how it went through `notify`. A refusal is
 * an error message; it is not thrown.
 */
export async function runTileAction(
  id: TileActionId,
  terrain: TerrainData | null,
  x: number,
  y: number,
  execute: (name: string, input: unknown) => Promise<ExecResult>,
  notify: (text: string, options?: { kind?: "info" | "error" }) => void,
): Promise<void> {
  const action = TILE_ACTIONS.find((candidate) => candidate.id === id);
  if (!action) return;
  const command = terrain ? tileCommand(id, terrain, x, y) : null;
  if (!command) {
    notify("That tile is not on the map", { kind: "error" });
    return;
  }
  const result = await execute(command.name, command.input);
  notify(tileMessage(action, x, y, result), result.ok ? {} : { kind: "error" });
}
