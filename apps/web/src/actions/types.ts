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

/** The parts of the inspector an action can open. */
export type InspectorTab = "overview" | "finances";

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

/** What an action may use when it runs or when it is asked if it is enabled. */
export interface ActionContext {
  client: SimClient;
  snapshot: DecodedSnapshot | null;
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
  /** How the keyboard does it, as shown to the player: `⌘Z`, `Space`, `1`. */
  shortcut?: string;
  /** `rect` for a command that takes an area of tiles: the player drags out its x, y, w and h. */
  placement?: "rect" | "tile";
  /** The command's input schema, for a form. Absent for a UI action. */
  schema?: JsonSchemaObject;
  run: (ctx: ActionContext, input?: unknown) => Promise<void> | void;
  /** False when the action cannot be done now. Absent means always enabled. */
  enabled?: (ctx: ActionContext) => boolean;
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
