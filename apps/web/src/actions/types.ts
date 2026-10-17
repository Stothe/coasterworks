import type { DecodedSnapshot, SimClient } from "@coasterworks/protocol";
import type { Category } from "@coasterworks/sim";

/** Where an action comes from: a sim command, a sim query, or the interface itself. */
export type ActionKind = "command" | "query" | "ui";

/**
 * The seven dock tools. Each is named for the command category its tray works on, in dock order,
 * so the key `1` opens the first and `7` the last.
 */
export const DOCK_TOOLS = ["terrain", "path", "ride", "scenery", "shop", "staff", "park"] as const;
export type DockTool = (typeof DOCK_TOOLS)[number];

/**
 * The parts of the inspector: the park's three tabs, and the tile tab, which is the only one a
 * selected tile has.
 */
export type InspectorTab = "overview" | "finances" | "timeline" | "tile";

/** What is selected on the map or in the park. */
export type UiSelection = { kind: "tile"; x: number; y: number } | { kind: "park" } | null;

/**
 * What an action may read of the interface: the part of the UI store `enabled` needs. The store
 * itself may hold more; this is the slice the actions depend on.
 */
export interface UiStore {
  readonly tool: DockTool | "select";
  readonly selection: UiSelection;
  readonly inspectorOpen: boolean;
}

/**
 * What an action may use when it runs or when it is asked if it is enabled. The context lasts as
 * long as the connection and the few facts below do, not as long as a snapshot: the host sends one
 * every 50 ms, so `snapshot` is read from the latest when it is asked for.
 */
export interface ActionContext {
  /** The host's client, or null while there is no connection. */
  client: SimClient | null;
  /**
   * False while there is no connection, before it is made and after it is lost. Then `client` is
   * null, the panels are given no context at all, and only an action marked `offline` is run, by a key.
   */
  connected: boolean;
  /** True while the host has stopped the simulation after a fault. */
  halted: boolean;
  /** The latest snapshot the host sent, or null before the first. Always the latest when read. */
  readonly snapshot: DecodedSnapshot | null;
  ui: UiStore;
}

/** One property of a JSON Schema object, as much of it as the interface reads. */
export interface JsonSchemaProperty {
  type?: string | string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  enum?: unknown[];
  description?: string;
}

/** The JSON Schema of a command's input: an object of properties. */
export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/** One thing the player can do: a sim command, or a change to the interface. */
export interface Action {
  /** A command's name (`terrain_raise`), or `ui.` and a path (`ui.tool.terrain`). */
  id: string;
  title: string;
  description: string;
  category: Category | "ui";
  kind: ActionKind;
  /** Extra words the command bar matches besides the title. */
  keywords: string[];
  /**
   * How the keyboard does it, as the player's own keyboard writes it: `⌘Z` on a Mac, `Ctrl+Z`
   * elsewhere, `Space`, `1`. It is worked out from the keymap each time it is read, so it cannot
   * disagree with the key that does the thing, and absent when no key does.
   */
  readonly shortcut?: string | undefined;
  /** The sim command a command-backed action runs: what a form sends. Absent for a UI action. */
  commandName?: string;
  /** True for an action that exists only for a key to run, and is not listed in the command bar. */
  hidden?: boolean;
  /** `rect` for a command that takes an area of tiles: the player drags out its x, y, w and h. */
  placement?: "rect" | "tile";
  /** The command's input schema, for a form. Absent for a UI action. */
  schema?: JsonSchemaObject;
  run: (ctx: ActionContext, input?: unknown) => Promise<void> | void;
  /** False when the action cannot be done now. Absent means always enabled. */
  enabled?: (ctx: ActionContext) => boolean;
  /**
   * True for an action that only changes the interface, so its key works even after the connection
   * is lost. Every other action needs the sim to answer.
   */
  offline?: boolean;
}

/** One field of a generated form. */
export interface FormField {
  /** The property name, which is the key in the command's input. */
  name: string;
  label: string;
  kind: "integer" | "number" | "boolean" | "string" | "enum";
  min?: number;
  max?: number;
  defaultValue?: unknown;
  /** The choices of an `enum` field, in schema order. */
  options?: Array<{ value: unknown; label: string }>;
  required: boolean;
  description?: string;
  /** True for an amount of money: the sim takes cents, and a form shows dollars. */
  money?: boolean;
}
