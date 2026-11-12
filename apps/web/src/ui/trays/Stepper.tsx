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
  /**
   * True to take a typed number only when the player presses Enter or leaves the field, not on
   * every keystroke: for a value that is a command, so typing "25" is one change and not two.
   */
  commitOnBlur?: boolean;
  /** Takes the buttons over: called with -1 or 1 instead of `onChange(value ± 1)`. */
  onStep?(by: -1 | 1): void;
  /** Whether each button can be pressed, when `onStep` decides that rather than `value`. */
  canDecrease?: boolean;
  canIncrease?: boolean;
  /** How the field shows `value`; by default as a whole number. */
  format?(value: number): string;
  /** What a typed text is as a value, or null if it is none; by default whole numbers only. */
  parse?(text: string): number | null;
}

const wholeNumber = (text: string) => (/^\d+$/.test(text) ? Number(text) : null);

const button = "hud-button min-w-8 rounded-md text-base font-medium text-muted hover:text-ink";

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
  commitOnBlur = false,
  onStep,
  canDecrease = value > min,
  canIncrease = value < max,
  format = String,
  parse = wholeNumber,
}: StepperProps) {
  // What is in the field while it is being typed in: null when it just shows the value.
  const [draft, setDraft] = useState<string | null>(null);
  /** The typed text as a value in range, or null. */
  const taken = (text: string) => {
    const n = parse(text);
    return n !== null && n >= min && n <= max ? n : null;
  };
  const valid = draft === null || taken(draft) !== null;
  const step = (by: -1 | 1) => {
    setDraft(null);
    if (onStep) onStep(by);
    else onChange(Math.min(max, Math.max(min, value + by)));
  };
  const commit = () => {
    const typed = draft === null ? null : taken(draft);
    if (commitOnBlur && typed !== null && typed !== value) onChange(typed);
    setDraft(null);
  };

  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-0.5">
      <button
        type="button"
        aria-label={`Decrease ${label.toLowerCase()}`}
        disabled={disabled || !canDecrease}
        onClick={() => step(-1)}
        className={button}
      >
        −
      </button>
      <input
        type="text"
        inputMode={parse === wholeNumber ? "numeric" : "decimal"}
        aria-label={inputLabel}
        aria-invalid={!valid || undefined}
        disabled={disabled}
        value={draft ?? format(value)}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const typed = taken(text);
          if (!commitOnBlur && typed !== null) onChange(typed);
        }}
        onKeyDown={(event) => {
          if (commitOnBlur && event.key === "Enter") commit();
        }}
        onBlur={commit}
        className="min-h-8 w-11 rounded-lg border border-line-strong bg-fill-strong text-center text-sm text-ink tabular-nums aria-invalid:border-danger disabled:opacity-40"
      />
      <button
        type="button"
        aria-label={`Increase ${label.toLowerCase()}`}
        disabled={disabled || !canIncrease}
        onClick={() => step(1)}
        className={button}
      >
        +
      </button>
    </div>
  );
}
