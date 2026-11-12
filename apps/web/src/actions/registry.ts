import { RIDE_TYPES, STALL_TYPES } from "@coasterworks/content";
import type { Speed } from "@coasterworks/protocol";
import type { CatalogEntry, ExecResult } from "@coasterworks/sim";
import { shortcutOf } from "../state/keys";
import { TERRAIN_VERBS, type TerrainVerb } from "../viewport/terrainTools";
import { RECT_KEYS, defaultsFromSchema, humanize, isRectSchema } from "./schema";
import {
  DOCK_TOOLS,
  type Action,
  type ActionContext,
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
  /** Takes up a terrain verb: starts its placement, which puts the dock on Terrain. */
  terrain(verb: TerrainVerb): void;
  /** One brush size larger (`1`) or smaller (`-1`), stopping at the ends. */
  brush(direction: 1 | -1): void;
  /** Turns the ride or stall in hand a quarter turn clockwise. */
  rotate(): void;
  /** True while a ride or stall is in hand, which is when there is something to turn. */
  canRotate(): boolean;
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
  path_build: "Build path",
  path_remove: "Remove path",
  park_set_entrance: "Place entrance",
  park_set_entry_fee: "Set entry fee",
  park_open: "Open park",
  park_close: "Close park",
  ride_build: "Build ride",
  stall_build: "Build shop or stall",
  ride_open: "Open ride",
  ride_close: "Close ride",
  ride_set_price: "Set ride price",
  ride_rename: "Rename ride",
  ride_demolish: "Demolish ride",
  finance_take_loan: "Take loan",
  finance_repay_loan: "Repay loan",
  sim_advance: "Advance time",
};

/**
 * What a placement starts with for a command whose input has a choice the schema gives no default
 * for: a path tool from the bar lays footpath unless the Paths tray says otherwise.
 */
const PLACEMENT_DEFAULTS: Readonly<Record<string, Record<string, unknown>>> = {
  path_build: { kind: "foot" },
};

/**
 * The type a build from the bar puts in hand: the first the content has of its kind. The tray then
 * shows its card among the others, for the player to pick another.
 */
const FIRST_TYPE: Readonly<Record<string, string | undefined>> = {
  ride_build: RIDE_TYPES[0]?.id,
  stall_build: STALL_TYPES[0]?.id,
};

/** True for an input that is one tile and nothing else: integer `x` and `y`. */
function isTileSchema(schema: JsonSchemaObject): boolean {
  const properties = schema.properties ?? {};
  const keys = Object.keys(properties);
  return (
    keys.length === 2 && properties["x"]?.type === "integer" && properties["y"]?.type === "integer"
  );
}

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

  const firstType = FIRST_TYPE[entry.name];
  if (firstType !== undefined) {
    // A ride or stall is placed like the trays place it: in hand, turned with R, clicked down.
    action.placement = "tile";
    action.run = () => deps.startPlacement(entry.name, { type: firstType, rot: 0 });
  } else if (isRectSchema(schema)) {
    // The player drags out the rectangle; everything else the command needs comes with the tool.
    const defaults = { ...defaultsFromSchema(schema), ...PLACEMENT_DEFAULTS[entry.name] };
    for (const key of RECT_KEYS) delete defaults[key];
    action.placement = "rect";
    action.run = () => deps.startPlacement(entry.name, { ...defaults });
  } else if (isTileSchema(schema)) {
    // A command of one tile (the park entrance) is placed by a click on it.
    action.placement = "tile";
    action.run = () => deps.startPlacement(entry.name, {});
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

/** What an interface action says about itself besides its words. */
interface UiOptions {
  /** Left out of the command bar's list. */
  hidden?: true;
  enabled?: (ctx: ActionContext) => boolean;
  /** Works without a connection: it only changes the interface. */
  offline?: true;
}

function uiAction(
  id: string,
  title: string,
  description: string,
  keywords: string[],
  run: () => void,
  { hidden, enabled, offline }: UiOptions = {},
): Action {
  const action: Action = {
    id,
    title,
    description,
    category: "ui",
    kind: "ui",
    keywords,
    run,
    // From the keymap each time it is read, in the writing of the keyboard in use.
    get shortcut() {
      return shortcutOf(id);
    },
  };
  if (hidden) action.hidden = true;
  if (enabled) action.enabled = enabled;
  if (offline) action.offline = true;
  return action;
}

/** The speed controls need a sim that is there and running: a halted one waits for Resume. */
const running = (ctx: ActionContext) => ctx.connected && !ctx.halted;

function uiActions({ ui }: UiActionDeps): Action[] {
  return [
    uiAction(
      "ui.pause",
      "Pause",
      "Pause or resume the simulation.",
      ["pause", "resume", "stop", "play"],
      () => ui.pause(),
      { enabled: running },
    ),
    ...SPEEDS.map((speed) =>
      uiAction(
        `ui.speed.${speed}`,
        `Speed ${speed}x`,
        `Run the simulation at ${speed}x speed.`,
        ["speed", "faster", "slower", `${speed}x`],
        () => ui.setSpeed(speed),
        { enabled: running },
      ),
    ),
    uiAction(
      "ui.speed.up",
      "Speed up",
      "Step the simulation one speed faster.",
      ["speed", "faster", "increase", "plus"],
      () => ui.stepSpeed(1),
      { enabled: running },
    ),
    uiAction(
      "ui.speed.down",
      "Slow down",
      "Step the simulation one speed slower.",
      ["speed", "slower", "decrease", "minus"],
      () => ui.stepSpeed(-1),
      { enabled: running },
    ),
    uiAction("ui.undo", "Undo", "Undo the last command.", ["undo", "revert", "back"], () =>
      ui.undo(),
    ),
    uiAction("ui.redo", "Redo", "Redo the command that was undone.", ["redo", "again"], () =>
      ui.redo(),
    ),
    uiAction(
      "ui.classicView",
      "Classic view",
      "Snap the camera to a classic isometric angle; again for the next of the four.",
      ["camera", "view", "reset", "home", "isometric"],
      () => ui.classicView(),
      { offline: true },
    ),
    ...DOCK_TOOLS.map((tool) =>
      uiAction(
        `ui.tool.${tool}`,
        TOOL_TITLES[tool],
        `Switch to the ${tool} tools.`,
        ["tool", "tools", "dock", tool],
        () => ui.setTool(tool),
      ),
    ),
    // The keys of the terrain tray. The bar lists the sim's own terrain commands, which do the
    // same, so these are for the keyboard.
    ...TERRAIN_VERBS.map(({ verb, label }) =>
      uiAction(
        `ui.terrain.${verb}`,
        `${label} tool`,
        `Take up the ${label.toLowerCase()} terrain tool.`,
        ["terrain", "tool", verb],
        () => ui.terrain(verb),
        { hidden: true },
      ),
    ),
    uiAction(
      "ui.brush.smaller",
      "Smaller brush",
      "Make the terrain brush one size smaller.",
      ["brush", "size", "smaller"],
      () => ui.brush(-1),
      { hidden: true },
    ),
    uiAction(
      "ui.brush.larger",
      "Larger brush",
      "Make the terrain brush one size larger.",
      ["brush", "size", "larger"],
      () => ui.brush(1),
      { hidden: true },
    ),
    uiAction(
      "ui.rotate",
      "Rotate",
      "Turn the ride or stall being placed a quarter turn.",
      ["rotate", "turn", "ride", "stall", "shop"],
      () => ui.rotate(),
      { hidden: true, enabled: () => ui.canRotate(), offline: true },
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
      { offline: true },
    ),
    // The next two are for keys: the bar does not list them.
    uiAction(
      "ui.commandBar",
      "Command bar",
      "Open the command bar.",
      ["command", "bar", "search", "palette"],
      () => ui.commandBar(),
      { hidden: true },
    ),
    uiAction(
      "ui.cancel",
      "Cancel",
      "Close what is open, or put the tool down.",
      ["cancel", "escape", "close"],
      () => ui.cancel(),
      { hidden: true, offline: true },
    ),
  ];
}

/**
 * Commands and queries whose input is a list of tiles: what a drag of the path tool sends and asks.
 * Nothing in the command bar or a form could ask for one, so they are not actions.
 */
export const TILE_LIST_ENTRIES: ReadonlySet<string> = new Set([
  "path_build_tiles",
  "path_remove_tiles",
  "path_check_tiles",
]);

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
      .filter((entry) => entry.kind === "command" && !TILE_LIST_ENTRIES.has(entry.name))
      .map((entry) => commandAction(entry, deps)),
    ...uiActions(deps),
  ];
}
