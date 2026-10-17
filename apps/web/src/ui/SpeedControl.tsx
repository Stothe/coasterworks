import type { Speed } from "@coasterworks/protocol";

const OPTIONS: ReadonlyArray<{ speed: Speed; label: string; text: string }> = [
  { speed: 0, label: "Pause", text: "⏸" },
  { speed: 1, label: "Speed 1x", text: "1x" },
  { speed: 2, label: "Speed 2x", text: "2x" },
  { speed: 4, label: "Speed 4x", text: "4x" },
  { speed: 8, label: "Speed 8x", text: "8x" },
];

export interface SpeedControlProps {
  speed: Speed;
  onChange(speed: Speed): void;
  /** Turns every button off, for a simulation that has stopped. */
  disabled?: boolean;
}

/** Pause and the four play speeds, as one segmented control. */
export function SpeedControl({ speed, onChange, disabled = false }: SpeedControlProps) {
  return (
    <div role="group" aria-label="Game speed" className="glass flex gap-0.5 p-[3px]">
      {OPTIONS.map((option) => (
        <button
          key={option.speed}
          type="button"
          aria-label={option.label}
          aria-pressed={speed === option.speed}
          disabled={disabled}
          onClick={() => onChange(option.speed)}
          className="hud-button min-w-8 rounded-lg px-2 text-xs font-medium text-muted aria-pressed:bg-white/15 aria-pressed:text-ink"
        >
          {option.text}
        </button>
      ))}
    </div>
  );
}
