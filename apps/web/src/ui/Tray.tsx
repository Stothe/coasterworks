import type { Action, ActionContext } from "../actions/types";
import type { Tool } from "../state/uiStore";
import { DOCK_ITEMS } from "./Dock";
import { CatalogTray } from "./trays/CatalogTray";
import { ParkTray } from "./trays/ParkTray";
import { TerrainTray } from "./trays/TerrainTray";

export interface TrayProps {
  /** The tool in hand; Select has no tray. */
  tool: Tool;
  /** Every action: the catalog trays list the ones of their category. */
  actions: readonly Action[];
  ctx: ActionContext | null;
  /** What the last command cost, in cents; negative for an undo's refund; null before any. */
  lastCharge: number | null;
  /** Called with the message of an action a tray could not run. */
  onError(message: string): void;
  /** Turns every control off, for a park that can no longer be edited. */
  disabled?: boolean;
}

/** The panel above the dock for the tool in hand: nothing for Select. */
export function Tray({ tool, actions, ctx, lastCharge, onError, disabled = false }: TrayProps) {
  if (tool === "select") return null;
  const label = DOCK_ITEMS.find((item) => item.tool === tool)?.label ?? tool;
  return (
    <section aria-label={`${label} tray`} className="glass max-w-[calc(100vw-2rem)] p-2.5">
      {tool === "terrain" ? (
        <TerrainTray lastCharge={lastCharge} disabled={disabled} />
      ) : tool === "park" ? (
        <ParkTray disabled={disabled} />
      ) : (
        <CatalogTray
          tool={tool}
          actions={actions}
          ctx={ctx}
          onError={onError}
          disabled={disabled}
        />
      )}
    </section>
  );
}
