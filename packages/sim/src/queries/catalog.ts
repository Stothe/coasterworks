import { z } from "zod";
import { defineQuery, type CatalogEntry, type QueryDef } from "../commands/define.js";
import type { Registry } from "../commands/registry.js";

/**
 * Lists everything `registry` can do. A client builds its menus, command bar, and forms from this
 * instead of knowing the commands itself, so a command added to the sim shows up with no client
 * change.
 *
 * A query is only given the world, so this one is built around the registry it lists. Register it
 * on that same registry, last or not; the list is read when the query runs, so it holds itself and
 * everything registered after it.
 */
export function catalogListQuery(
  registry: Registry,
): QueryDef<Record<string, never>, CatalogEntry[]> {
  return defineQuery({
    name: "catalog_list",
    description:
      "Lists every command and query: name, description, category, kind, whether a command can be undone, and the JSON Schema of its input.",
    category: "sim",
    input: z.object({}),
    // `catalog` builds fresh plain objects each time, so the result is JSON and safe to hand out.
    run: () => registry.catalog(),
  });
}
