import { z } from "zod";
import type { CatalogEntry, CommandDef, QueryDef } from "./define.js";

/** Two or more lowercase words joined by underscores, such as `build_path`. */
const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/**
 * Names the MCP server gives its own file tools. A registry command or query must not take one, or
 * its tool would clash with the built-in when file tools are on.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["save_write", "save_load"]);

/** The commands and queries a world can be driven with. */
export class Registry {
  // `any` because a registry holds definitions with many different input and undo types.
  private readonly commandDefs = new Map<string, CommandDef<any, any>>();
  private readonly queryDefs = new Map<string, QueryDef<any, any>>();

  /**
   * Throws if the name is malformed, reserved for an MCP built-in tool, or taken (by a command or a
   * query), or the input is not an object schema.
   */
  register(def: CommandDef<any, any>): void {
    this.check(def);
    this.commandDefs.set(def.name, def);
  }

  /** Throws under the same conditions as `register`. */
  registerQuery(def: QueryDef<any, any>): void {
    this.check(def);
    this.queryDefs.set(def.name, def);
  }

  command(name: string): CommandDef | undefined {
    return this.commandDefs.get(name);
  }

  query(name: string): QueryDef | undefined {
    return this.queryDefs.get(name);
  }

  /** Commands in registration order. */
  commands(): CommandDef[] {
    return [...this.commandDefs.values()];
  }

  /** Queries in registration order. */
  queries(): QueryDef[] {
    return [...this.queryDefs.values()];
  }

  /** Every command, then every query, each in registration order. */
  catalog(): CatalogEntry[] {
    const entry = (
      def: CommandDef | QueryDef,
      undoable: boolean,
      kind: CatalogEntry["kind"],
    ): CatalogEntry => ({
      name: def.name,
      description: def.description,
      category: def.category,
      // `input` describes what callers send, so a defaulted field is optional.
      inputSchema: z.toJSONSchema(def.input, { io: "input" }),
      undoable,
      kind,
    });
    return [
      ...this.commands().map((def) => entry(def, def.undoable, "command")),
      ...this.queries().map((def) => entry(def, false, "query")),
    ];
  }

  private check(def: CommandDef<any, any> | QueryDef<any, any>): void {
    if (!NAME_PATTERN.test(def.name)) {
      throw new Error(
        `Invalid name "${def.name}": use lowercase words joined by underscores, such as build_path`,
      );
    }
    if (RESERVED_NAMES.has(def.name)) {
      throw new Error(`Name is reserved for MCP built-in tools: ${def.name}`);
    }
    if (this.commandDefs.has(def.name) || this.queryDefs.has(def.name)) {
      throw new Error(`"${def.name}" is already registered`);
    }
    if (!(def.input instanceof z.ZodObject)) {
      throw new TypeError(`"${def.name}" input must be an object schema (z.object)`);
    }
  }
}
