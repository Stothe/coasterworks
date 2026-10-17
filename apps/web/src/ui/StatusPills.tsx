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
}

/** The top-left status bar: cash, date and the speed control. */
export function StatusPills({
  cash,
  date,
  speed,
  onSpeedChange,
  speedDisabled = false,
}: StatusPillsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Cash" className="glass flex min-h-8 items-center gap-2 px-3">
        <span aria-hidden="true">💰</span>
        <b className="text-sm font-semibold tabular-nums">{formatCents(cash)}</b>
      </div>
      <div role="group" aria-label="Date" className="glass flex min-h-8 items-center gap-2 px-3">
        <span aria-hidden="true">📅</span>
        <span className="text-sm">{date}</span>
      </div>
      <SpeedControl speed={speed} onChange={onSpeedChange} disabled={speedDisabled} />
    </div>
  );
}
