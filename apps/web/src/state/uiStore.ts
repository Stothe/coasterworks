import { createStore, useStore } from "zustand";
import {
  DOCK_TOOLS,
  type Action,
  type DockTool,
  type InspectorTab,
  type UiSelection,
} from "../actions/types";
import type { BrushSize } from "../viewport/brush";
import {
  optionsOfDefaults,
  terrainPlacement,
  verbOfCommand,
  type TerrainOptions,
  type TerrainVerb,
} from "../viewport/terrainTools";

/** What the player has in hand: one of the dock's tools, or nothing but the pointer. */
export type Tool = DockTool | "select";

/** A command being placed on the map, click after click, until the player puts it down. */
export interface Placement {
  command: string;
  /** What the command needs besides the area; the area comes from where the player clicks. */
  defaults: Record<string, unknown>;
  /** The side of the square of tiles each click covers. */
  size: BrushSize;
}

export interface InspectorState {
  open: boolean;
  tab: InspectorTab;
}

/** The interface's own state: tools, selection and what is open. The sim's state is not here. */
export interface UiState {
  tool: Tool;
  placement: Placement | null;
  /** The size of the brush the next placement starts with. */
  brushSize: BrushSize;
  selection: UiSelection;
  inspector: InspectorState;
  commandBarOpen: boolean;
  /** The action whose form the command bar is showing, or null while it shows the list. */
  formAction: Action | null;
  helpOpen: boolean;

  setTool(tool: Tool): void;
  /**
   * Starts placing `command`, and puts the dock on the tool its name starts with (`terrain_raise`
   * is a terrain command). `size` is the brush; without it, the last one chosen.
   */
  startPlacement(command: string, defaults: Record<string, unknown>, size?: BrushSize): void;
  /**
   * Takes up a terrain verb (Raise, Water, ...): starts its placement, which puts the dock on
   * Terrain. `options` are what the verb is started with. Without them, a verb already in hand
   * keeps the options it has (taking up Water again is not a reset), and any other verb starts
   * from the tray's starting ones.
   */
  startTerrain(verb: TerrainVerb, options?: TerrainOptions): void;
  /** Sets the brush size, for the placement in progress and for the next one. */
  setBrushSize(size: BrushSize): void;
  select(selection: UiSelection): void;
  /**
   * Opens the inspector on `tab`. A park tab (Overview, Finances, Timeline) is the park's, so it
   * selects the park; the tile tab shows whatever tile is selected.
   */
  openInspector(tab: InspectorTab): void;
  /** Selects tile (`x`, `y`) and opens the inspector on it: the one inspector moves to the tile. */
  inspectTile(x: number, y: number): void;
  closeInspector(): void;
  openCommandBar(): void;
  closeCommandBar(): void;
  /** Shows the form of `action` in the command bar, opening the bar if it is shut. */
  openForm(action: Action): void;
  /** Goes back from the form to the bar's list. */
  closeForm(): void;
  toggleHelp(): void;
  /**
   * Esc. It closes the topmost thing that is open, one at a time: help, then a form (back to the
   * list), then the command bar. With none of those open it puts the tool down: no placement, and
   * the tool is Select. With the tool already down it closes the inspector. The selection stays.
   */
  cancel(): void;
}

/** The dock tool a command belongs to, from the category its name starts with. */
function dockToolOf(command: string): DockTool | undefined {
  return DOCK_TOOLS.find((tool) => command.startsWith(`${tool}_`));
}

/** Raise, the terrain tool in hand when the park opens and when the dock goes back to Terrain. */
function raise(size: BrushSize): Placement {
  return { ...terrainPlacement("raise"), size };
}

/** The plain store, for code outside React and for tests. */
export const uiStore = createStore<UiState>()((set, get) => ({
  tool: "terrain",
  placement: raise(1),
  brushSize: 1,
  selection: null,
  inspector: { open: false, tab: "overview" },
  commandBarOpen: false,
  formAction: null,
  helpOpen: false,

  setTool: (tool) =>
    set((state) => {
      // The same tool keeps what is in hand. Another puts it down, and Terrain always has
      // something in hand: a click would otherwise do nothing under a tray with no verb chosen.
      if (tool === state.tool) return state;
      return { tool, placement: tool === "terrain" ? raise(state.brushSize) : null };
    }),
  startPlacement: (command, defaults, size) =>
    set((state) => ({
      tool: dockToolOf(command) ?? state.tool,
      placement: { command, defaults: { ...defaults }, size: size ?? state.brushSize },
      brushSize: size ?? state.brushSize,
      // The player picked it from the bar, which has done its work.
      commandBarOpen: false,
      formAction: null,
    })),
  startTerrain: (verb, options) => {
    const { placement } = get();
    const inHand = placement !== null && verbOfCommand(placement.command) === verb;
    const kept = options ?? (inHand ? optionsOfDefaults(placement.defaults) : undefined);
    const { command, defaults } = terrainPlacement(verb, kept);
    get().startPlacement(command, defaults);
  },
  setBrushSize: (size) =>
    set((state) => ({
      brushSize: size,
      placement: state.placement && { ...state.placement, size },
    })),
  select: (selection) => set({ selection }),
  openInspector: (tab) =>
    set((state) => ({
      inspector: { open: true, tab },
      selection: tab === "tile" ? state.selection : { kind: "park" },
    })),
  inspectTile: (x, y) =>
    set({ selection: { kind: "tile", x, y }, inspector: { open: true, tab: "tile" } }),
  closeInspector: () => set((state) => ({ inspector: { ...state.inspector, open: false } })),
  openCommandBar: () => set({ commandBarOpen: true, formAction: null }),
  closeCommandBar: () => set({ commandBarOpen: false, formAction: null }),
  openForm: (action) => set({ formAction: action, commandBarOpen: true }),
  closeForm: () => set({ formAction: null }),
  toggleHelp: () => set((state) => ({ helpOpen: !state.helpOpen })),
  cancel: () =>
    set((state) => {
      if (state.helpOpen) return { helpOpen: false };
      if (state.formAction) return { formAction: null };
      if (state.commandBarOpen) return { commandBarOpen: false };
      // Nothing in hand and the inspector up: there is nothing left but the inspector to put away.
      if (state.tool === "select" && state.placement === null && state.inspector.open) {
        return { inspector: { ...state.inspector, open: false } };
      }
      return { placement: null, tool: "select" };
    }),
}));

/** The store as a React hook: `useUiStore((state) => state.tool)` re-renders when `tool` changes. */
export function useUiStore<T>(selector: (state: UiState) => T): T {
  return useStore(uiStore, selector);
}
