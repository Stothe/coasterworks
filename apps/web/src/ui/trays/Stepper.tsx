import { useState } from "react";

export interface StepperProps {
  /** Names the group, and the two buttons: "Decrease {label}" and "Increase {label}". */
  label: string;
  /** Names the field the number is typed in. */
  inputLabel: string;
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
  disabled?: boolean;
}

const button =
  "hud-button min-w-8 rounded-md text-base font-medium text-muted hover:text-ink aria-pressed:bg-white/15";

/**
 * A whole number to step with two buttons or type, held to `min` to `max`. What is typed is only
 * taken once it is a number in range, and the field shows the last number that was until the
 * player leaves it.
 */
export function Stepper({
  label,
  inputLabel,
  value,
  min,
  max,
  onChange,
  disabled = false,
}: StepperProps) {
  // What is in the field while it is being typed in: null when it just shows the value.
  const [draft, setDraft] = useState<string | null>(null);
  const valid =
    draft === null || (/^\d+$/.test(draft) && Number(draft) >= min && Number(draft) <= max);

  const step = (by: number) => {
    setDraft(null);
    onChange(Math.min(max, Math.max(min, value + by)));
  };

  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-0.5">
      <button
        type="button"
        aria-label={`Decrease ${label.toLowerCase()}`}
        disabled={disabled || value <= min}
        onClick={() => step(-1)}
        className={button}
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        aria-label={inputLabel}
        aria-invalid={!valid || undefined}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          if (/^\d+$/.test(text) && Number(text) >= min && Number(text) <= max) {
            onChange(Number(text));
          }
        }}
        onBlur={() => setDraft(null)}
        className="min-h-8 w-11 rounded-md border border-white/15 bg-white/10 text-center text-sm text-ink tabular-nums outline-none focus-visible:border-accent aria-invalid:border-red-400 disabled:opacity-40"
      />
      <button
        type="button"
        aria-label={`Increase ${label.toLowerCase()}`}
        disabled={disabled || value >= max}
        onClick={() => step(1)}
        className={button}
      >
        +
      </button>
    </div>
  );
}
