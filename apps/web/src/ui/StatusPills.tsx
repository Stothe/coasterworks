import type { Speed } from "@coasterworks/protocol";
import { ratingTone, ratingWord } from "../state/useParkState";
import { formatCents, formatChange } from "./format";
import { SpeedControl } from "./SpeedControl";

export interface StatusPillsProps {
  /** Integer cents. */
  cash: number;
  /** Integer cents: what the month has done to the cash so far. Shown beside it unless it is nothing. */
  monthChange: number;
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
  /** Guests in the park now; the guests pill is left out without it. */
  guests?: number;
  /** The park rating, 0 to 999; the rating pill is left out without it. */
  rating?: number;
  /** Rides and stalls standing; the rides pill is left out unless both are given. */
  rides?: number;
  stalls?: number;
}

/** What the rides pill says to assistive technology: `2 rides and 3 stalls`. */
export function ridesLabel(rides: number, stalls: number): string {
  return `${rides} ${rides === 1 ? "ride" : "rides"} and ${stalls} ${stalls === 1 ? "stall" : "stalls"}`;
}

const DOT: Record<ReturnType<typeof ratingTone>, string> = {
  good: "bg-success",
  bad: "bg-danger",
  plain: "bg-muted",
};

/**
 * The top-left status bar: cash with the month's change beside it, and the date, which open the
 * park's panels, and the speed control.
 */
export function StatusPills({
  cash,
  monthChange,
  date,
  speed,
  onSpeedChange,
  speedDisabled = false,
  onOpenFinances,
  onOpenOverview,
  guests,
  rating,
  rides,
  stalls,
}: StatusPillsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Cash" className="glass flex">
        <button
          type="button"
          aria-label={`Open finances (cash ${formatCents(cash)}${
            monthChange === 0 ? "" : `, this month ${formatChange(monthChange)}`
          })`}
          onClick={onOpenFinances}
          className="hud-button gap-2 rounded-[inherit] px-3"
        >
          <span aria-hidden="true">💰</span>
          <b className="text-sm font-semibold tabular-nums">{formatCents(cash)}</b>
          {monthChange !== 0 && (
            <span
              data-testid="month-change"
              className={`text-xs tabular-nums ${monthChange > 0 ? "text-success" : "text-danger"}`}
            >
              {formatChange(monthChange)}
            </span>
          )}
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
      {guests !== undefined && (
        <div role="group" aria-label="Guests" className="glass flex">
          <button
            type="button"
            aria-label={`Show guests (${guests} in the park)`}
            onClick={onOpenOverview}
            className="hud-button gap-2 rounded-[inherit] px-3"
          >
            <span aria-hidden="true">🧍</span>
            <span data-testid="guest-count" className="text-sm tabular-nums">
              {guests}
            </span>
          </button>
        </div>
      )}
      {rides !== undefined && stalls !== undefined && (
        <div role="group" aria-label="Rides and stalls" className="glass flex">
          <button
            type="button"
            aria-label={ridesLabel(rides, stalls)}
            onClick={onOpenOverview}
            className="hud-button gap-2 rounded-[inherit] px-3"
          >
            <span aria-hidden="true">🎡</span>
            <span data-testid="ride-count" className="text-sm tabular-nums">
              {rides} · {stalls}
            </span>
          </button>
        </div>
      )}
      {rating !== undefined && (
        <div role="group" aria-label="Park rating" className="glass flex">
          <button
            type="button"
            aria-label={`Show park rating (${rating}, ${ratingWord(rating).toLowerCase()})`}
            onClick={onOpenOverview}
            className="hud-button gap-2 rounded-[inherit] px-3"
          >
            <span
              aria-hidden="true"
              className={`inline-block size-2 rounded-full ${DOT[ratingTone(rating)]}`}
            />
            <span className="text-sm tabular-nums">{rating}</span>
          </button>
        </div>
      )}
      <SpeedControl speed={speed} onChange={onSpeedChange} disabled={speedDisabled} />
    </div>
  );
}
