import { typeById } from "@coasterworks/content";
import { HISTORY_MONTHS, monthNet } from "../park/types.js";
import { DAYS_PER_MONTH, MONTHS_PER_YEAR, TICKS_PER_DAY, dateOf, isMonthStart } from "../time.js";
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
  for (const ride of world.rides) {
    ride.stats.monthCustomers = 0;
    ride.stats.monthIncome = 0;
  }
}

/**
 * The share of a month's running cost `cost` that falls on day `day` (0 for the first day of the
 * month): the days' shares are whole cents and add up to exactly `cost` over a month.
 */
export function dailyRunningCost(cost: number, day: number): number {
  return (
    Math.floor((cost * (day + 1)) / DAYS_PER_MONTH) - Math.floor((cost * day) / DAYS_PER_MONTH)
  );
}

/**
 * At the end of each day, charges every ride and stall (open or closed) its share of its type's
 * monthly running cost, out of the cash and into `park.expenses.running`, `park.monthly.running`
 * and the ride's stats. Called on the first tick of a day, so `world.tick - 1` is in the day being
 * charged, and the last day of a month is charged to that month before it is closed.
 */
function chargeRunningCosts(world: World): void {
  const day = dateOf(world.tick - 1).day - 1;
  const { park, finance } = world;
  for (const ride of world.rides) {
    const type = typeById(ride.type);
    if (type === undefined) continue;
    const charge = dailyRunningCost(type.runningCost, day);
    finance.cash -= charge;
    park.expenses.running += charge;
    park.monthly.running += charge;
    ride.stats.runningCost += charge;
  }
}

/**
 * At the start of each day: charges the day that has just ended its running costs. At the start of
 * each month, after that: moves the finished month's takings into the park's history and clears
 * them (and each ride's month stats), charges a month of loan interest, then records the cash left
 * as the new month's starting balance. Cash may go negative. Runs before the rides and guests do,
 * so a fee paid on the first tick of a month belongs to the new one.
 */
export const financeSystem: System = {
  name: "finance",
  tick(world) {
    if (world.tick > 0 && world.tick % TICKS_PER_DAY === 0) chargeRunningCosts(world);
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
