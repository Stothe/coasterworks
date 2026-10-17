import type { ReactNode } from "react";
import type { DockTool } from "../actions/types";
import type { Tool } from "../state/uiStore";
import {
  ParkIcon,
  PathIcon,
  RideIcon,
  SceneryIcon,
  SelectIcon,
  ShopIcon,
  StaffIcon,
  TerrainIcon,
} from "./icons";
import { Kbd } from "./kit";

/** The tool-less pointer, which the dock offers first: with it in hand a click looks at a tile. */
const SELECT_LABEL = "Select";

/** The dock's tools in the order of its keys, `1` to `7`, with the word and icon of each. */
export const DOCK_ITEMS: ReadonlyArray<{ tool: DockTool; label: string; icon: ReactNode }> = [
  { tool: "terrain", label: "Terrain", icon: <TerrainIcon /> },
  { tool: "path", label: "Paths", icon: <PathIcon /> },
  { tool: "ride", label: "Rides", icon: <RideIcon /> },
  { tool: "scenery", label: "Scenery", icon: <SceneryIcon /> },
  { tool: "shop", label: "Shops", icon: <ShopIcon /> },
  { tool: "staff", label: "Staff", icon: <StaffIcon /> },
  { tool: "park", label: "Park", icon: <ParkIcon /> },
];

const BUTTON =
  "hud-button relative min-w-[4.5rem] flex-col gap-0.5 rounded-lg px-2 pt-1.5 pb-1 text-muted aria-pressed:bg-accent-strong aria-pressed:text-on-accent";

export interface DockProps {
  /** The tool in hand: Select, or one of the seven. */
  tool: Tool;
  onSelect(tool: Tool): void;
  /** Turns every button off, for a park that can no longer be edited. */
  disabled?: boolean;
}

/**
 * The bottom bar: Select, then seven tools. A click picks one, and a click on the one in hand puts
 * it down for Select. The keys `1` to `7` are the app's keymap, and the hints only say so; Select
 * has no key of its own, because Esc puts whatever is in hand down.
 */
export function Dock({ tool, onSelect, disabled = false }: DockProps) {
  return (
    <div
      role="group"
      aria-label="Tools"
      className="glass pointer-events-auto flex items-stretch gap-0.5 p-1.5"
    >
      <button
        type="button"
        aria-label={SELECT_LABEL}
        aria-pressed={tool === "select"}
        aria-keyshortcuts="Escape"
        disabled={disabled}
        onClick={() => onSelect("select")}
        className={BUTTON}
      >
        <SelectIcon />
        <span className="text-xs font-medium">{SELECT_LABEL}</span>
      </button>
      {DOCK_ITEMS.map((item, index) => {
        const active = tool === item.tool;
        return (
          <button
            key={item.tool}
            type="button"
            // The name is the word; the key cap is a hint, not part of it.
            aria-label={item.label}
            aria-pressed={active}
            aria-keyshortcuts={String(index + 1)}
            disabled={disabled}
            onClick={() => onSelect(active ? "select" : item.tool)}
            className={BUTTON}
          >
            {item.icon}
            <span className="text-xs font-medium">{item.label}</span>
            <Kbd className="absolute top-1 right-1">{String(index + 1)}</Kbd>
          </button>
        );
      })}
    </div>
  );
}
