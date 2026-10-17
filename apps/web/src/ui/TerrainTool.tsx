import type { BrushSize, TerrainToolId } from "../viewport/brush";
import { formatCents } from "./format";

export const TERRAIN_TOOLS: ReadonlyArray<{ id: TerrainToolId; label: string; key: string }> = [
  { id: "raise", label: "Raise", key: "R" },
  { id: "lower", label: "Lower", key: "L" },
  { id: "level", label: "Level", key: "V" },
  { id: "water", label: "Water", key: "W" },
];

export const BRUSH_SIZES: readonly BrushSize[] = [1, 2, 3];

export interface TerrainToolProps {
  tool: TerrainToolId;
  onToolChange(tool: TerrainToolId): void;
  brush: BrushSize;
  onBrushChange(size: BrushSize): void;
  /** What the last command cost, in cents; negative for an undo's refund; null before any. */
  lastCharge: number | null;
}

function Charge({ cents }: { cents: number | null }) {
  if (cents === null) return <span className="text-muted">Click the ground to shape it</span>;
  if (cents < 0) {
    return (
      <span className="text-success tabular-nums">Refunded {formatCents(Math.abs(cents))}</span>
    );
  }
  return <span className="tabular-nums">Charged {formatCents(cents)}</span>;
}

/** The bottom-center terrain bar: tool, brush size and the last charge. */
export function TerrainTool({
  tool,
  onToolChange,
  brush,
  onBrushChange,
  lastCharge,
}: TerrainToolProps) {
  return (
    <div role="toolbar" aria-label="Terrain tools" className="glass flex items-center gap-3 p-1.5">
      <div role="group" aria-label="Tool" className="flex gap-0.5">
        {TERRAIN_TOOLS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={tool === option.id}
            aria-keyshortcuts={option.key}
            onClick={() => onToolChange(option.id)}
            className="hud-button gap-1.5 rounded-lg px-3 text-sm font-medium text-muted aria-pressed:bg-accent aria-pressed:text-white"
          >
            {option.label}
            <kbd className="rounded bg-white/15 px-1 text-[10px] font-normal text-inherit">
              {option.key}
            </kbd>
          </button>
        ))}
      </div>
      <div role="group" aria-label="Brush size" className="flex items-center gap-1">
        <span className="px-1 text-xs text-muted">Brush</span>
        {BRUSH_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            aria-label={`Brush size ${size}`}
            aria-pressed={brush === size}
            onClick={() => onBrushChange(size)}
            className="hud-button min-w-8 rounded-lg text-sm font-medium text-muted aria-pressed:bg-white/15 aria-pressed:text-ink"
          >
            {size}
          </button>
        ))}
      </div>
      <output aria-label="Last charge" className="min-w-48 pr-2 text-sm whitespace-nowrap">
        <Charge cents={lastCharge} />
      </output>
    </div>
  );
}
