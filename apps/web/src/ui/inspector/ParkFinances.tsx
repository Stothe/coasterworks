import type { ExecResult } from "@coasterworks/sim";
import { useState } from "react";
import type { Action, ActionContext } from "../../actions/types";
import type { ParkInfo } from "../../state/useParkInfo";
import { ActionForm } from "../ActionForm";
import { formatCents, formatChange } from "../format";
import { Row, Rows } from "./Rows";

export interface ParkFinancesProps {
  /** The park's money as of the latest snapshot, or null before the first. */
  info: ParkInfo | null;
  /** Every action: the loan forms are the ones that run the finance commands. */
  actions: readonly Action[];
  /** What an action may use. Null before the connection is made: nothing can run yet. */
  ctx: ActionContext | null;
  /** Runs a sim command. It resolves with the sim's answer; a refusal is a result, not a throw. */
  execute(name: string, input: unknown): Promise<ExecResult>;
  /** Shows a message to the player. */
  notify(text: string): void;
}

/** Put the field down when Escape is pressed in it: there is no panel to go back from. */
const leaveField = () => {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement) focused.blur();
};

/** The two loan forms, each under a word that says which is which: both ask for an amount. */
const LOANS = [
  { command: "finance_take_loan", heading: "Borrow", done: "Loan taken" },
  { command: "finance_repay_loan", heading: "Pay back", done: "Loan repaid" },
] as const;

/**
 * The inspector's finances tab: cash, loan and what the month has done to the cash, from the
 * latest snapshot, with a form to take a loan and one to pay it back. The forms are the sim's own
 * commands drawn from its schemas, so their bounds are the sim's. A loan that goes through shows
 * in the next snapshot, which the host sends at once.
 */
export function ParkFinances({ info, actions, ctx, execute, notify }: ParkFinancesProps) {
  // A form that went through starts again empty: a new key is a new form.
  const [sent, setSent] = useState<Readonly<Record<string, number>>>({});
  const change = info ? info.cash - info.monthStartCash : 0;

  return (
    <div className="flex flex-col gap-4">
      {info ? (
        <Rows label="Finances">
          <Row label="Cash">{formatCents(info.cash)}</Row>
          <Row label="Loan">{formatCents(info.loan)}</Row>
          <Row label="This month" tone={change >= 0 ? "good" : "bad"}>
            {formatChange(change)}
          </Row>
        </Rows>
      ) : (
        <p className="text-sm text-muted">Loading the books</p>
      )}
      {ctx &&
        LOANS.map(({ command, heading, done }) => {
          const action = actions.find((candidate) => candidate.commandName === command);
          if (!action) return null;
          return (
            <div key={command} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted">{heading}</h3>
              <ActionForm
                key={sent[command] ?? 0}
                action={action}
                ctx={ctx}
                execute={execute}
                inline
                onCancel={leaveField}
                onDone={() => {
                  setSent((current) => ({ ...current, [command]: (current[command] ?? 0) + 1 }));
                  notify(done);
                }}
              />
            </div>
          );
        })}
    </div>
  );
}
