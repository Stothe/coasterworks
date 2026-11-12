import { ENTRANCE_COST, type ExecResult } from "@coasterworks/sim";
import type { InspectorTab } from "../../actions/types";
import { uiStore, useUiStore } from "../../state/uiStore";
import { useParkState } from "../../state/useParkState";
import type { SnapshotSource } from "../../state/useSnapshot";
import { formatCents } from "../format";
import { ParkControls } from "../park/ParkControls";

const PANELS: ReadonlyArray<{ tab: InspectorTab; label: string }> = [
  { tab: "overview", label: "Overview" },
  { tab: "finances", label: "Finances" },
  { tab: "timeline", label: "Timeline" },
];

export interface ParkTrayProps {
  /** Where the park's gate is read from. */
  source: SnapshotSource;
  execute(name: string, input: unknown): Promise<ExecResult>;
  onError(message: string): void;
  disabled?: boolean;
}

/**
 * The park tool's tray: the gate (place the entrance, open or close, the entry fee) and a button for
 * each park panel, which opens the inspector on its tab.
 */
export function ParkTray({ source, execute, onError, disabled = false }: ParkTrayProps) {
  const park = useParkState(source);
  const placing = useUiStore((state) => state.placement?.command === "park_set_entrance");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          aria-pressed={placing}
          disabled={disabled}
          onClick={() => uiStore.getState().startPlacement("park_set_entrance", {})}
          className="hud-button rounded-lg bg-fill px-4 text-sm font-medium text-muted hover:text-ink aria-pressed:bg-fill-active aria-pressed:text-ink"
        >
          {park?.entrance ? "Move entrance" : "Place entrance"}
        </button>
        {placing && (
          <span className="text-xs text-muted">
            Click a tile on the edge of the park · {formatCents(ENTRANCE_COST)}
          </span>
        )}
        {park && (
          <ParkControls park={park} execute={execute} onError={onError} disabled={disabled} />
        )}
      </div>
      <div role="group" aria-label="Park panels" className="flex gap-1">
        {PANELS.map(({ tab, label }) => (
          <button
            key={tab}
            type="button"
            disabled={disabled}
            onClick={() => uiStore.getState().openInspector(tab)}
            className="hud-button rounded-lg bg-fill px-4 text-sm font-medium text-muted hover:text-ink"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
