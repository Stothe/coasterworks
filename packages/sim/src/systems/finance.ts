import { MONTHS_PER_YEAR, isMonthStart } from "../time.js";
import type { World } from "../world/types.js";
import type { System } from "./types.js";

/** Most the park can owe, in cents: $50,000. */
export const LOAN_MAX = 50_000_00;

/** Interest a loan of `loan` cents costs for one month: 10% a year, rounded down to a cent. */
function monthlyInterest(loan: number): number {
  return Math.floor((loan * 10) / 100 / MONTHS_PER_YEAR);
}

/**
 * Charges a month of loan interest at the start of each month, then records the cash left as the
 * month's starting balance. Cash may go negative.
 */
export const financeSystem: System = {
  name: "finance",
  tick(world) {
    if (!isMonthStart(world.tick)) return;
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
