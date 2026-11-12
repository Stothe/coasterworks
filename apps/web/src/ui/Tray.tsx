import type { ExecResult } from "@coasterworks/sim";
import { useMemo } from "react";
import type { Action, ActionContext } from "../actions/types";
import type { SnapshotSource } from "../state/useSnapshot";
import type { Tool } from "../state/uiStore";
import { DOCK_ITEMS } from "./Dock";
import { RidesTray, ShopsTray, type QueryFn } from "./trays/BuildTray";
import { CatalogTray } from "./trays/CatalogTray";
import { ParkTray } from "./trays/ParkTray";
import { PathsTray } from "./trays/PathsTray";
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
  /** Where the park tray reads the park's gate. Without it the park tray shows only its panels. */
  source?: SnapshotSource;
  /** Runs a sim command, for the park tray's gate. */
  execute?(name: string, input: unknown): Promise<ExecResult>;
  /** Turns every control off, for a park that can no longer be edited. */
  disabled?: boolean;
}

/** The panel above the dock for the tool in hand: nothing for Select. */
const NO_SOURCE: SnapshotSource = { snapshot: null };
const NOT_CONNECTED = async (): Promise<ExecResult> => ({
  ok: false,
  error: "Not connected to the park",
});

export function Tray({
  tool,
  actions,
  ctx,
  lastCharge,
  onError,
  source = NO_SOURCE,
  execute = NOT_CONNECTED,
  disabled = false,
}: TrayProps) {
  const client = ctx?.client ?? null;
  const query = useMemo<QueryFn | null>(
    () => (client ? (name, input) => client.query(name, input) : null),
    [client],
  );
  if (tool === "select") return null;
  const label = DOCK_ITEMS.find((item) => item.tool === tool)?.label ?? tool;
  return (
    <section
      aria-label={`${label} tray`}
      className="glass pointer-events-auto max-w-full animate-enter p-2.5"
    >
      {tool === "terrain" ? (
        <TerrainTray lastCharge={lastCharge} disabled={disabled} />
      ) : tool === "path" ? (
        <PathsTray lastCharge={lastCharge} disabled={disabled} />
      ) : tool === "ride" ? (
        <RidesTray query={query} lastCharge={lastCharge} disabled={disabled} />
      ) : tool === "shop" ? (
        <ShopsTray query={query} lastCharge={lastCharge} disabled={disabled} />
      ) : tool === "park" ? (
        <ParkTray source={source} execute={execute} onError={onError} disabled={disabled} />
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
