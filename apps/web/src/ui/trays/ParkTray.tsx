import type { InspectorTab } from "../../actions/types";
import { uiStore } from "../../state/uiStore";

const PANELS: ReadonlyArray<{ tab: InspectorTab; label: string }> = [
  { tab: "overview", label: "Overview" },
  { tab: "finances", label: "Finances" },
  { tab: "timeline", label: "Timeline" },
];

/** The park tool's tray: a button for each park panel, which opens the inspector on its tab. */
export function ParkTray({ disabled = false }: { disabled?: boolean }) {
  return (
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
  );
}
