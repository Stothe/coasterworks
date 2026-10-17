import type { Speed } from "@coasterworks/protocol";
import type { CatalogEntry, ExecResult } from "@coasterworks/sim";
import { RECT_KEYS, defaultsFromSchema, humanize, isRectSchema } from "./schema";
import {
  DOCK_TOOLS,
  type Action,
  type DockTool,
  type InspectorTab,
  type JsonSchemaObject,
} from "./types";

/** What the interface can do, handed to the actions so they can do it. */
export interface UiHandlers {
  pause(): void;
  setSpeed(speed: Speed): void;
  /** One step faster (`1`) or slower (`-1`) along the play speeds. */
  stepSpeed(direction: 1 | -1): void;
  undo(): void;
  redo(): void;
  classicView(): void;
  setTool(tool: DockTool): void;
  openInspector(tab: InspectorTab): void;
  help(): void;
  /** Opens the command bar. */
  commandBar(): void;
  /** Closes what is open, or else puts the tool down (Esc). */
  cancel(): void;
}

/**
 * What actions need from the app. The app owns the UI store and the connection; the actions only
 * call these. Keep the object stable between renders, or the actions are rebuilt each time.
 */
export interface UiActionDeps {
  /** Starts placing a command on the map. The player picks the area; `defaults` fill the rest. */
  startPlacement(command: string, defaults: Record<string, unknown>): void;
  /** Opens the form for an action that needs more than a click. */
  openForm(action: Action): void;
  /**
   * Runs a command. It reports a failure to the player itself, so an action need not look at the
   * result.
   */
  execute(name: string, input: unknown): Promise<ExecResult>;
  ui: UiHandlers;
}

/**
 * Titles that read better than the command's name set in sentence case. The rest are the name
 * with its underscores turned into spaces: `park_close_gates` is "Park close gates".
 */
const TITLES: Readonly<Record<string, string>> = {
  terrain_raise: "Raise terrain",
  terrain_lower: "Lower terrain",
  terrain_level: "Level terrain",
  terrain_smooth: "Smooth terrain",
  terrain_set_water: "Set water",
  terrain_set_surface: "Set surface",
  finance_take_loan: "Take loan",
  finance_repay_loan: "Repay loan",
  sim_advance: "Advance time",
};

/** The title of a command: a friendly one if it has one, else its name in sentence case. */
export function humanizeName(name: string): string {
  return TITLES[name] ?? humanize(name);
}

function hasProperties(schema: JsonSchemaObject): boolean {
  return Object.keys(schema.properties ?? {}).length > 0;
}

function commandAction(entry: CatalogEntry, deps: UiActionDeps): Action {
  // The catalog's schema is JSON; this is the part of it the interface reads.
  const schema = entry.inputSchema as JsonSchemaObject;
  const action: Action = {
    id: entry.name,
    title: humanizeName(entry.name),
    description: entry.description,
    category: entry.category,
    kind: "command",
    commandName: entry.name,
    keywords: [...new Set([...entry.name.split("_"), entry.category])],
    schema,
    run: () => {},
  };

  if (isRectSchema(schema)) {
    // The player drags out the rectangle; everything else the command needs comes with the tool.
    const defaults = defaultsFromSchema(schema);
    for (const key of RECT_KEYS) delete defaults[key];
    action.placement = "rect";
    action.run = () => deps.startPlacement(entry.name, { ...defaults });
  } else if (hasProperties(schema)) {
    action.run = () => deps.openForm(action);
  } else {
    action.run = async () => {
      await deps.execute(entry.name, {});
    };
  }
  return action;
}

/** `ui.speed.4` and the like. */
const SPEEDS = [1, 2, 4, 8] as const satisfies readonly Speed[];

const TOOL_TITLES: Readonly<Record<DockTool, string>> = {
  terrain: "Terrain tools",
  path: "Path tools",
  ride: "Ride tools",
  scenery: "Scenery tools",
  shop: "Shop tools",
  staff: "Staff tools",
  park: "Park tools",
};

function uiAction(
  id: string,
  title: string,
  description: string,
  keywords: string[],
  run: () => void,
  shortcut?: string,
  hidden = false,
): Action {
  const action: Action = { id, title, description, category: "ui", kind: "ui", keywords, run };
  if (shortcut !== undefined) action.shortcut = shortcut;
  if (hidden) action.hidden = true;
  return action;
}

function uiActions({ ui }: UiActionDeps): Action[] {
  return [
    uiAction(
      "ui.pause",
      "Pause",
      "Pause or resume the simulation.",
      ["pause", "resume", "stop", "play"],
      () => ui.pause(),
      "Space",
    ),
    ...SPEEDS.map((speed) =>
      uiAction(
        `ui.speed.${speed}`,
        `Speed ${speed}x`,
        `Run the simulation at ${speed}x speed.`,
        ["speed", "faster", "slower", `${speed}x`],
        () => ui.setSpeed(speed),
      ),
    ),
    uiAction(
      "ui.speed.up",
      "Speed up",
      "Step the simulation one speed faster.",
      ["speed", "faster", "increase", "plus"],
      () => ui.stepSpeed(1),
      "+",
    ),
    uiAction(
      "ui.speed.down",
      "Slow down",
      "Step the simulation one speed slower.",
      ["speed", "slower", "decrease", "minus"],
      () => ui.stepSpeed(-1),
      "-",
    ),
    uiAction(
      "ui.undo",
      "Undo",
      "Undo the last command.",
      ["undo", "revert", "back"],
      () => ui.undo(),
      "⌘Z",
    ),
    uiAction(
      "ui.redo",
      "Redo",
      "Redo the command that was undone.",
      ["redo", "again"],
      () => ui.redo(),
      "⇧⌘Z",
    ),
    uiAction(
      "ui.classicView",
      "Classic view",
      "Snap the camera to a classic isometric angle; again for the next of the four.",
      ["camera", "view", "reset", "home", "isometric"],
      () => ui.classicView(),
      "Home",
    ),
    ...DOCK_TOOLS.map((tool, index) =>
      uiAction(
        `ui.tool.${tool}`,
        TOOL_TITLES[tool],
        `Switch to the ${tool} tools.`,
        ["tool", "tools", "dock", tool],
        () => ui.setTool(tool),
        String(index + 1),
      ),
    ),
    uiAction(
      "ui.inspector.park",
      "Park overview",
      "Open the park inspector.",
      ["park", "inspector", "overview", "status", "info"],
      () => ui.openInspector("overview"),
    ),
    uiAction(
      "ui.help",
      "Keyboard shortcuts",
      "Show the keyboard shortcuts.",
      ["help", "keys", "keyboard", "shortcuts"],
      () => ui.help(),
      "?",
    ),
    // The next two are for keys: the bar does not list them.
    uiAction(
      "ui.commandBar",
      "Command bar",
      "Open the command bar.",
      ["command", "bar", "search", "palette"],
      () => ui.commandBar(),
      undefined,
      true,
    ),
    uiAction(
      "ui.cancel",
      "Cancel",
      "Close what is open, or put the tool down.",
      ["cancel", "escape", "close"],
      () => ui.cancel(),
      "Esc",
      true,
    ),
  ];
}

/**
 * Every action the player can take, from the sim's catalog and the interface. A command becomes
 * the kind of action its input calls for: a rectangle of tiles is placed on the map, any other
 * input opens a form, and no input at all runs at once. Queries are not actions; nothing about
 * them is for the player to do. Interface actions do not depend on the catalog, so they are there
 * even with an empty one.
 */
export function buildActions(catalog: readonly CatalogEntry[], deps: UiActionDeps): Action[] {
  return [
    ...catalog
      .filter((entry) => entry.kind === "command")
      .map((entry) => commandAction(entry, deps)),
    ...uiActions(deps),
  ];
}
