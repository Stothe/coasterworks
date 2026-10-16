import type { z } from "zod";
import type { World } from "../world/types.js";
import type { Registry } from "./registry.js";

export type Category =
  "terrain" | "path" | "ride" | "scenery" | "shop" | "staff" | "park" | "finance" | "sim" | "save";

/**
 * The schema of a command or query input. It must be an object schema so the MCP server can read
 * its `shape`; the registry rejects anything else. `I` is the parsed type.
 */
export type InputSchema<I> = z.ZodObject<any, any> & z.ZodType<I>;

/**
 * A mutation of the world. Every change to a park, from the UI, the CLI, an agent, or a replay,
 * is a command run through `executeCommand`.
 *
 * `apply` returns the data `revert` needs to undo it. That data is saved in the log, so it must be
 * plain JSON and must not point into the world. `revert` must restore exactly what `apply` changed.
 */
export interface CommandDef<I = unknown, U = unknown> {
  /** Lowercase words joined by underscores, such as `build_path`. */
  name: string;
  description: string;
  category: Category;
  input: InputSchema<I>;
  undoable: boolean;
  /** Cost in integer cents, charged when the command runs. Defaults to 0. */
  cost?: (world: World, input: I) => number;
  /** A reason the command cannot run now, or null if it can. */
  validate: (world: World, input: I) => string | null;
  /** Changes the world and returns the data `revert` needs. */
  apply: (world: World, input: I) => U;
  revert: (world: World, input: I, undo: U) => void;
  /** A reason the command cannot be undone now, or null if it can. */
  validateRevert?: (world: World, input: I, undo: U) => string | null;
}

/** Declares a command. This returns `def` unchanged; it exists so `I` and `U` are inferred. */
export function defineCommand<I, U>(def: CommandDef<I, U>): CommandDef<I, U> {
  return def;
}

/** A read of the world. A query never changes it and is never logged. */
export interface QueryDef<I = unknown, R = unknown> {
  name: string;
  description: string;
  category: Category;
  input: InputSchema<I>;
  run: (world: World, input: I) => R;
}

export interface CatalogEntry {
  name: string;
  description: string;
  category: Category;
  /** JSON Schema of the input object. */
  inputSchema: Record<string, unknown>;
  undoable: boolean;
  kind: "command" | "query";
}

export type ParseResult<I> = { ok: true; data: I } | { ok: false; error: string };

/** Parses `raw` with `schema`. An error reads `<path> <message>` per issue, joined by `; `. */
export function parseInput<I>(schema: z.ZodType<I>, raw: unknown): ParseResult<I> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const error = parsed.error.issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join(".")} ${issue.message}`,
    )
    .join("; ");
  return { ok: false, error };
}

/** Parses the input and runs the named query. */
export function runQuery(
  world: World,
  registry: Registry,
  name: string,
  rawInput: unknown,
): { ok: true; result: unknown } | { ok: false; error: string } {
  const def = registry.query(name);
  if (!def) return { ok: false, error: `Unknown query: ${name}` };
  const parsed = parseInput(def.input, rawInput);
  if (!parsed.ok) return parsed;
  return { ok: true, result: def.run(world, parsed.data) };
}
