import { uiStore, useUiStore } from "../../state/uiStore";
import type { BrushSize } from "../../viewport/brush";
import {
  BRUSH_SIZES,
  LEVEL_HEIGHT,
  SURFACES,
  TERRAIN_VERBS,
  WATER_ABOVE,
  optionsOfDefaults,
  verbOfCommand,
  type HeightMode,
  type TerrainOptions,
  type TerrainVerb,
} from "../../viewport/terrainTools";
import { formatCents } from "../format";
import { Kbd, Segmented } from "../kit";
import { Stepper } from "./Stepper";

export interface TerrainTrayProps {
  /** What the last command cost, in cents; negative for an undo's refund; null before any. */
  lastCharge: number | null;
  /** Turns every control off, for a park that can no longer be edited. */
  disabled?: boolean;
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

const VERB_OPTIONS = TERRAIN_VERBS.map(({ verb, label, key }) => ({
  id: verb,
  label,
  shortcut: key,
}));
const BRUSH_OPTIONS = BRUSH_SIZES.map((size) => ({ id: String(size), label: String(size) }));
const SURFACE_OPTIONS = SURFACES.map(({ id, label }) => ({ id: String(id), label }));
const LEVEL_OPTIONS: ReadonlyArray<{ id: HeightMode; label: string }> = [
  { id: "tile", label: "Clicked tile" },
  { id: "height", label: "Set height" },
];

/**
 * The terrain tool's tray: the verb in hand, the brush, whatever the verb needs chosen, and what
 * the last command cost. It reads and writes the placement in the UI store, so a placement the
 * command bar started shows here as it is, and the viewport does what the tray says.
 */
export function TerrainTray({ lastCharge, disabled = false }: TerrainTrayProps) {
  const placement = useUiStore((state) => state.placement);
  const brushSize = useUiStore((state) => state.brushSize);
  const verb = verbOfCommand(placement?.command);
  const info = TERRAIN_VERBS.find((entry) => entry.verb === verb);
  // The options of the placement in hand, with the starting ones for what it does not use.
  const shown = optionsOfDefaults(placement?.defaults ?? {});

  // A verb starts from the options it begins with; a change to one is the verb in hand again with it.
  const change = (patch: Partial<TerrainOptions>) => {
    if (verb !== undefined) uiStore.getState().startTerrain(verb, { ...shown, ...patch });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented<TerrainVerb | "">
          label="Terrain tool"
          options={VERB_OPTIONS}
          value={verb ?? ""}
          onChange={(next) => next !== "" && uiStore.getState().startTerrain(next)}
          disabled={disabled}
        />
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted">Brush</span>
          <Segmented
            label="Brush size"
            options={BRUSH_OPTIONS}
            value={String(brushSize)}
            onChange={(id) => uiStore.getState().setBrushSize(Number(id) as BrushSize)}
            disabled={disabled}
          />
          <Kbd>[</Kbd>
          <Kbd>]</Kbd>
        </div>
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1.5">
        {verb === "water" && (
          <div className="flex items-center gap-2">
            <Stepper
              label="Water level"
              inputLabel="Steps above the ground"
              value={shown.waterAbove}
              min={WATER_ABOVE.min}
              max={WATER_ABOVE.max}
              onChange={(waterAbove) => change({ waterAbove })}
              disabled={disabled}
            />
            <span className="text-xs text-muted">steps above the ground</span>
          </div>
        )}
        {verb === "surface" && (
          <Segmented
            label="Surface"
            options={SURFACE_OPTIONS}
            value={String(shown.surface)}
            onChange={(id) => change({ surface: Number(id) })}
            disabled={disabled}
          />
        )}
        {verb === "level" && (
          <>
            <Segmented<HeightMode>
              label="Level to"
              options={LEVEL_OPTIONS}
              value={shown.heightMode}
              onChange={(heightMode) => change({ heightMode })}
              disabled={disabled}
            />
            {shown.heightMode === "height" && (
              <Stepper
                label="Level height"
                inputLabel="Height"
                value={shown.height}
                min={LEVEL_HEIGHT.min}
                max={LEVEL_HEIGHT.max}
                onChange={(height) => change({ height })}
                disabled={disabled}
              />
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-3 text-sm">
          {info?.hint !== undefined && <span className="text-xs text-muted">{info.hint}</span>}
          <output aria-label="Last charge" className="min-w-44 text-right whitespace-nowrap">
            <Charge cents={lastCharge} />
          </output>
        </div>
      </div>
    </div>
  );
}
