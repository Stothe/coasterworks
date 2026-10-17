import type { Speed } from "@coasterworks/protocol";
import { formatCents } from "./format";
import { SpeedControl } from "./SpeedControl";

export interface StatusPillsProps {
  /** Integer cents. */
  cash: number;
  /** The game date, such as `March 1, Year 1`. */
  date: string;
  speed: Speed;
  onSpeedChange(speed: Speed): void;
  /** Turns the speed buttons off, for a simulation that has stopped. */
  speedDisabled?: boolean;
  /** The cash was clicked: show the park's finances. */
  onOpenFinances(): void;
  /** The date was clicked: show the park's overview. */
  onOpenOverview(): void;
}

/** The top-left status bar: cash and date, which open the park's panels, and the speed control. */
export function StatusPills({
  cash,
  date,
  speed,
  onSpeedChange,
  speedDisabled = false,
  onOpenFinances,
  onOpenOverview,
}: StatusPillsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Cash" className="glass flex">
        <button
          type="button"
          aria-label={`Open finances (cash ${formatCents(cash)})`}
          onClick={onOpenFinances}
          className="hud-button gap-2 rounded-[inherit] px-3"
        >
          <span aria-hidden="true">💰</span>
          <b className="text-sm font-semibold tabular-nums">{formatCents(cash)}</b>
        </button>
      </div>
      <div role="group" aria-label="Date" className="glass flex">
        <button
          type="button"
          aria-label={`Open park overview (${date})`}
          onClick={onOpenOverview}
          className="hud-button gap-2 rounded-[inherit] px-3"
        >
          <span aria-hidden="true">📅</span>
          <span className="text-sm">{date}</span>
        </button>
      </div>
      <SpeedControl speed={speed} onChange={onSpeedChange} disabled={speedDisabled} />
    </div>
  );
}
