import { z } from "zod";
import { LOAN_MAX, repayLoan, takeLoan } from "../systems/finance.js";
import { defineCommand } from "./define.js";
import { formatMoney } from "./execute.js";

/** Borrows money. The cash arrives at once; the loan costs interest every month. */
export const financeTakeLoan = defineCommand({
  name: "finance_take_loan",
  description: `Borrows money. Interest is 10% a year, charged monthly. The most the park can owe is ${formatMoney(LOAN_MAX)}. Amount is in cents.`,
  category: "finance",
  input: z.object({ amount: z.int().min(100).max(LOAN_MAX) }),
  undoable: true,
  // The money moves in `apply`, not through `cost`, so the loan itself costs nothing.
  validate: (world, { amount }) =>
    world.finance.loan + amount > LOAN_MAX ? `Loan limit is ${formatMoney(LOAN_MAX)}` : null,
  apply: (world, { amount }) => {
    takeLoan(world, amount);
  },
  revert: (world, { amount }) => {
    repayLoan(world, amount);
  },
  validateRevert: (world, { amount }) =>
    world.finance.cash < amount ? "Not enough cash to undo this loan" : null,
});

/** Pays back part or all of the loan out of the cash. */
export const financeRepayLoan = defineCommand({
  name: "finance_repay_loan",
  description: "Pays back part or all of the loan out of the cash on hand. Amount is in cents.",
  category: "finance",
  input: z.object({ amount: z.int().min(1) }),
  undoable: true,
  validate: (world, { amount }) => {
    if (amount > world.finance.loan) return `You only owe ${formatMoney(world.finance.loan)}`;
    if (amount > world.finance.cash) return "Not enough cash to repay";
    return null;
  },
  apply: (world, { amount }) => {
    repayLoan(world, amount);
  },
  revert: (world, { amount }) => {
    takeLoan(world, amount);
  },
});
