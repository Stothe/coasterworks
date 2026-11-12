import { PATH_COST } from "@coasterworks/sim";
import { uiStore, useUiStore } from "../../state/uiStore";
import { formatCents } from "../format";
import { Segmented } from "../kit";

type PathTool = "foot" | "queue" | "remove";

const TOOLS: ReadonlyArray<{ id: PathTool; label: string }> = [
  { id: "foot", label: "Footpath" },
  { id: "queue", label: "Queue" },
  { id: "remove", label: "Remove" },
];

/** Which of the tray's tools a placement is, or "" for none of them. */
function toolOf(placement: { command: string; defaults: Record<string, unknown> } | null) {
  if (placement?.command === "path_remove") return "remove";
  if (placement?.command === "path_build")
    return placement.defaults["kind"] === "queue" ? "queue" : "foot";
  return "";
}

export interface PathsTrayProps {
  /** What the last command cost, in cents; negative for an undo's refund; null before any. */
  lastCharge: number | null;
  disabled?: boolean;
}

/**
 * The path tool's tray: Footpath, Queue or Remove, drawn by dragging over the ground one tile wide,
 * and what the last drag cost.
 */
export function PathsTray({ lastCharge, disabled = false }: PathsTrayProps) {
  const placement = useUiStore((state) => state.placement);
  const tool = toolOf(placement);
  const choose = (next: PathTool | "") => {
    if (next === "") return;
    const store = uiStore.getState();
    if (next === "remove") store.startPlacement("path_remove", {});
    else store.startPlacement("path_build", { kind: next });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Segmented<PathTool | "">
        label="Path tool"
        options={TOOLS}
        value={tool}
        onChange={choose}
        disabled={disabled}
      />
      <span className="text-xs text-muted">
        Drag over the ground to draw · {formatCents(PATH_COST)} a tile · Esc puts the tool down
      </span>
      {lastCharge !== null && (
        <span className={`ml-auto text-sm tabular-nums ${lastCharge < 0 ? "text-success" : ""}`}>
          {lastCharge < 0
            ? `Refunded ${formatCents(Math.abs(lastCharge))}`
            : `Charged ${formatCents(lastCharge)}`}
        </span>
      )}
    </div>
  );
}
