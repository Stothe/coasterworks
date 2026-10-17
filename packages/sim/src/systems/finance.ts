import { HISTORY_MONTHS, monthNet } from "../park/types.js";
import { MONTHS_PER_YEAR, dateOf, isMonthStart } from "../time.js";
import type { World } from "../world/types.js";
import type { System } from "./types.js";

/** Most the park can owe, in cents: $50,000. */
export const LOAN_MAX = 50_000_00;

/** Interest a loan of `loan` cents costs for one month: 10% a year, rounded down to a cent. */
function monthlyInterest(loan: number): number {
  return Math.floor((loan * 10) / 100 / MONTHS_PER_YEAR);
}

/**
 * Closes the books on the month that has just ended: its takings go on the end of `park.history`
 * (the oldest month falls off past `HISTORY_MONTHS`), stamped with the month they belong to, and
 * `park.monthly` starts again from zero. Called on the first tick of a month, so `world.tick - 1`
 * is the last tick of the month being closed.
 */
function closeMonth(world: World): void {
  const { park } = world;
  const { monthly } = park;
  const ended = dateOf(world.tick - 1);
  park.history.push({
    year: ended.year,
    month: ended.month,
    entry: monthly.entry,
    rides: monthly.rides,
    shops: monthly.shops,
    running: monthly.running,
    wages: monthly.wages,
    net: monthNet(monthly),
  });
  while (park.history.length > HISTORY_MONTHS) park.history.shift();
  monthly.entry = 0;
  monthly.rides = 0;
  monthly.shops = 0;
  monthly.running = 0;
  monthly.wages = 0;
}

/**
 * At the start of each month: moves the finished month's takings into the park's history and
 * clears them, charges a month of loan interest, then records the cash left as the new month's
 * starting balance. Cash may go negative. Runs before the guests do, so a fee paid on the first
 * tick of a month belongs to the new one.
 */
export const financeSystem: System = {
  name: "finance",
  tick(world) {
    if (!isMonthStart(world.tick)) return;
    closeMonth(world);
    const { finance } = world;
    finance.cash -= monthlyInterest(finance.loan);
    finance.monthStart.cash = finance.cash;
  },
};

/** Adds `amount` cents to the loan and to the cash. The caller checks the loan limit. */
export function takeLoan(world: World, amount: number): void {
  world.finance.loan += amount;
  world.finance.cash += amount;
}

/** Takes `amount` cents off the loan and out of the cash. The caller checks both are enough. */
export function repayLoan(world: World, amount: number): void {
  world.finance.loan -= amount;
  world.finance.cash -= amount;
}
