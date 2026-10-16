/** Ticks the simulation runs each real-time second at 1x speed. */
export const TICKS_PER_SECOND = 40;
/** Ticks in one game day. */
export const TICKS_PER_DAY = 400;
/** Days in every month. */
export const DAYS_PER_MONTH = 31;
/** Months in a year. The year starts in March. */
export const MONTHS_PER_YEAR = 8;
export const MONTH_NAMES = [
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
] as const;

const TICKS_PER_MONTH = TICKS_PER_DAY * DAYS_PER_MONTH;

/** A moment on the game calendar. Tick 0 is the start of March 1, Year 1. */
export interface GameDate {
  /** Counted from 1. */
  year: number;
  /** Index into `MONTH_NAMES`, 0 to 7. */
  month: number;
  /** Day of the month, 1 to 31. */
  day: number;
  /** Ticks since the day began, 0 to 399. */
  tickOfDay: number;
}

/** The calendar date of a tick. Throws if `tick` is not a non-negative integer. */
export function dateOf(tick: number): GameDate {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new RangeError(`Tick must be a non-negative integer, got ${tick}`);
  }
  const dayIndex = Math.floor(tick / TICKS_PER_DAY);
  const monthIndex = Math.floor(dayIndex / DAYS_PER_MONTH);
  return {
    year: Math.floor(monthIndex / MONTHS_PER_YEAR) + 1,
    month: monthIndex % MONTHS_PER_YEAR,
    day: (dayIndex % DAYS_PER_MONTH) + 1,
    tickOfDay: tick % TICKS_PER_DAY,
  };
}

/** True on the first tick of every month after the first. Tick 0 is the start of the game, not a month start. */
export function isMonthStart(tick: number): boolean {
  return tick > 0 && tick % TICKS_PER_MONTH === 0;
}

/** Formats a date such as `"March 1, Year 1"`. */
export function formatDate(date: GameDate): string {
  const month = MONTH_NAMES[date.month];
  if (month === undefined) throw new RangeError(`Month must be 0 to 7, got ${date.month}`);
  return `${month} ${date.day}, Year ${date.year}`;
}
