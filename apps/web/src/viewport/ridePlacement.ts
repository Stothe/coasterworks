import { rotatedFootprint, typeById, type Rot } from "@coasterworks/content";
import type { TileRect } from "./brush";

/** The two commands that put a ride or a stall on the map, each placed click after click. */
export const BUILD_COMMANDS: ReadonlySet<string> = new Set(["ride_build", "stall_build"]);

/** True for a placement that builds a ride or a stall: it has a type and a turn, not a brush. */
export function isBuildCommand(command: string | undefined): boolean {
  return command !== undefined && BUILD_COMMANDS.has(command);
}

/** The turn a placement's defaults hold, 0 to 3; anything else is no turn. */
export function rotOf(defaults: Record<string, unknown>): Rot {
  const rot = defaults["rot"];
  return rot === 1 || rot === 2 || rot === 3 ? rot : 0;
}

/** The next quarter turn clockwise. */
export function nextRot(rot: Rot): Rot {
  return ((rot + 1) % 4) as Rot;
}

/**
 * The tiles a ride or stall of `type` turned `rot` covers when the pointer is on tile (`x`, `y`):
 * its turned footprint, centred on that tile the way a brush is (`x - floor((w - 1) / 2)` across).
 * `x` and `y` of the answer are its top-left tile, what `ride_build` and `stall_build` take. The
 * rectangle may reach off the map; the sim says so. Null for a type the content does not have.
 */
export function footprintAt(type: string, rot: Rot, x: number, y: number): TileRect | null {
  const content = typeById(type);
  if (!content) return null;
  const { w, h } = rotatedFootprint(content.footprint, rot);
  return { x: x - Math.floor((w - 1) / 2), y: y - Math.floor((h - 1) / 2), w, h };
}

/** What the sim answers to `ride_check`. */
export interface RideCheck {
  ok: boolean;
  reason: string | null;
}

/** True for an answer shaped like `ride_check`'s. */
export function isRideCheck(value: unknown): value is RideCheck {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["ok"] === "boolean" && (v["reason"] === null || typeof v["reason"] === "string");
}

/** What a build off the top or left edge is refused with, before the sim is asked. */
export const OFF_THE_MAP = "Area is outside the park";
