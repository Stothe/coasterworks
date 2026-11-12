import { MAX_ENTRY_FEE, type ExecResult } from "@coasterworks/sim";
import type { ParkState } from "../../state/useParkState";
import { Stepper } from "../trays/Stepper";

/** The most an entry fee can be, in whole dollars, as the sim allows. */
export const MAX_FEE_DOLLARS = Math.floor(MAX_ENTRY_FEE / 100);

export interface ParkControlsProps {
  park: ParkState;
  /** Runs a sim command; a refusal is a result, not a throw. */
  execute(name: string, input: unknown): Promise<ExecResult>;
  /** Shows why a command was refused. */
  onError(message: string): void;
  disabled?: boolean;
}

/**
 * The park's gate: an Open/Close button and the entry fee, in whole dollars. Both are sim commands,
 * so what they show is what the next snapshot says, not what was asked for.
 */
export function ParkControls({ park, execute, onError, disabled = false }: ParkControlsProps) {
  const run = (name: string, input: unknown) => {
    void execute(name, input).then((result) => {
      if (!result.ok) onError(result.error);
    });
  };
  const noEntrance = park.entrance === null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <button
        type="button"
        disabled={disabled || (!park.open && noEntrance)}
        title={!park.open && noEntrance ? "Place an entrance first" : undefined}
        onClick={() => run(park.open ? "park_close" : "park_open", {})}
        className={`hud-button rounded-lg px-4 text-sm font-medium ${
          park.open ? "bg-fill text-ink" : "bg-accent-strong text-on-accent"
        }`}
      >
        {park.open ? "Close park" : "Open park"}
      </button>
      <span className="text-xs text-muted" aria-live="polite">
        {park.open ? "Open to guests" : "Closed"}
      </span>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted">Entry fee $</span>
        <Stepper
          label="Entry fee"
          inputLabel="Entry fee in dollars"
          // Whole dollars shown; a fee an agent set in cents steps from what it is.
          value={Math.floor(park.entryFee / 100)}
          min={0}
          max={MAX_FEE_DOLLARS}
          commitOnBlur
          onChange={(dollars) => run("park_set_entry_fee", { cents: dollars * 100 })}
          onStep={(by) =>
            run("park_set_entry_fee", {
              cents: Math.min(MAX_ENTRY_FEE, Math.max(0, park.entryFee + by * 100)),
            })
          }
          canDecrease={park.entryFee > 0}
          canIncrease={park.entryFee < MAX_ENTRY_FEE}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
