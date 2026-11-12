import { z } from "zod";
import { defineQuery } from "../commands/define.js";
import { MAX_PATH_TILES, PATH_COST } from "../commands/path.js";
import { OUTSIDE_PARK } from "../commands/terrain.js";
import { PATH_FOOT, PATH_NONE, PATH_QUEUE, canBuildPath } from "../paths/paths.js";
import { inBounds } from "../terrain/terrain.js";

const VALUES = { foot: PATH_FOOT, queue: PATH_QUEUE, remove: PATH_NONE } as const;

/**
 * Which tiles of a list a path build (or removal) would refuse and why, and how many it would
 * change: what a drag of the path tool asks before it sends one `path_build_tiles` with the rest.
 */
export const pathCheckTiles = defineQuery({
  name: "path_check_tiles",
  description:
    "Checks a list of tiles for `path_build_tiles` (kind `foot` or `queue`) or `path_remove_tiles` (kind `remove`) without changing anything. Returns `refused`, each tile that could not take it with the reason, in the order given, and `changes`, how many of the rest it would change (a tile listed twice counts once), and `cost` in cents.",
  category: "path",
  input: z.object({
    tiles: z
      .array(z.object({ x: z.int().min(0), y: z.int().min(0) }))
      .min(1)
      .max(MAX_PATH_TILES),
    kind: z.enum(["foot", "queue", "remove"]),
  }),
  run: (world, { tiles, kind }) => {
    const t = world.terrain;
    const value = VALUES[kind];
    const refused: Array<{ x: number; y: number; reason: string }> = [];
    const seen = new Set<number>();
    let changes = 0;
    for (const { x, y } of tiles) {
      const reason = !inBounds(t, x, y)
        ? OUTSIDE_PARK
        : kind === "remove"
          ? null
          : canBuildPath(world, x, y);
      if (reason !== null) {
        refused.push({ x, y, reason });
        continue;
      }
      const index = y * t.width + x;
      if (seen.has(index)) continue;
      seen.add(index);
      if (t.path[index] !== value) changes++;
    }
    return { refused, changes, cost: kind === "remove" ? 0 : changes * PATH_COST };
  },
});
