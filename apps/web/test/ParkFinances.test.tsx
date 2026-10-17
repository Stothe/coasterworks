import type { SimClient } from "@coasterworks/protocol";
import { createDefaultRegistry, type ExecResult } from "@coasterworks/sim";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildActions, type UiActionDeps } from "../src/actions/registry";
import type { ActionContext } from "../src/actions/types";
import type { ParkStatus } from "../src/state/useParkStatus";
import { ParkFinances } from "../src/ui/inspector/ParkFinances";
import { ParkOverview } from "../src/ui/inspector/ParkOverview";

afterEach(cleanup);

const noop = vi.fn();
const deps: UiActionDeps = {
  startPlacement: noop,
  openForm: noop,
  execute: noop,
  ui: {
    pause: noop,
    setSpeed: noop,
    stepSpeed: noop,
    undo: noop,
    redo: noop,
    classicView: noop,
    setTool: noop,
    openInspector: noop,
    help: noop,
    commandBar: noop,
    cancel: noop,
    terrain: noop,
    brush: noop,
  },
};
const actions = buildActions(createDefaultRegistry().catalog(), deps);
const ctx: ActionContext = {
  client: {} as SimClient,
  snapshot: null,
  ui: { tool: "select", selection: { kind: "park" }, inspectorOpen: true },
};

const park = (over: Partial<ParkStatus> = {}): ParkStatus => ({
  name: "Queryland",
  tick: 0,
  date: "March 1, Year 1",
  year: 1,
  month: 0,
  day: 1,
  cash: 1_000_000,
  monthStartCash: 1_000_000,
  loan: 0,
  guests: 0,
  rating: 0,
  width: 16,
  height: 16,
  ...over,
});

const OK: ExecResult = { ok: true, id: 1, cost: 0 };

function setup(
  status: ParkStatus | null = park({ loan: 500_000 }),
  result: ExecResult = OK,
  extra: { actions?: typeof actions; ctx?: ActionContext | null } = {},
) {
  const execute = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>(async () => result);
  const notify = vi.fn();
  const onChanged = vi.fn();
  const view = render(
    <ParkFinances
      status={status}
      actions={extra.actions ?? actions}
      ctx={extra.ctx === undefined ? ctx : extra.ctx}
      execute={execute}
      notify={notify}
      onChanged={onChanged}
    />,
  );
  return { execute, notify, onChanged, ...view };
}

const form = (name: string) => screen.getByRole("form", { name });
const amount = (name: string) => within(form(name)).getByLabelText("Amount") as HTMLInputElement;
const submit = (name: string) => fireEvent.click(within(form(name)).getByRole("button", { name }));
/** The value beside a label in the list of facts. */
const fact = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;

describe("ParkFinances: the numbers", () => {
  it("shows the cash and the loan in dollars", () => {
    setup(park({ cash: 1_234_567, loan: 500_000 }));
    expect(fact("Cash").textContent).toBe("$12,345.67");
    expect(fact("Loan").textContent).toBe("$5,000.00");
  });

  it("shows the month's change in green when the cash is up", () => {
    setup(park({ cash: 1_050_000, monthStartCash: 1_000_000 }));
    expect(fact("This month").textContent).toBe("+$500.00");
    expect(fact("This month").className).toContain("text-success");
  });

  it("shows it in red when the cash is down, with the minus sign", () => {
    setup(park({ cash: 993_750, monthStartCash: 1_000_000 }));
    expect(fact("This month").textContent).toBe("-$62.50");
    expect(fact("This month").className).not.toContain("text-success");
    expect(fact("This month").className).toContain("text-danger");
  });

  it("shows no change as $0.00, in green: not a loss", () => {
    setup(park({ cash: 1_000_000, monthStartCash: 1_000_000 }));
    expect(fact("This month").textContent).toBe("$0.00");
    expect(fact("This month").className).toContain("text-success");
  });

  it("follows a new status", () => {
    const view = setup(park({ cash: 1_000_000 }));
    expect(fact("Cash").textContent).toBe("$10,000.00");
    view.rerender(
      <ParkFinances
        status={park({ cash: 800_000 })}
        actions={actions}
        ctx={ctx}
        execute={view.execute}
        notify={view.notify}
        onChanged={view.onChanged}
      />,
    );
    expect(fact("Cash").textContent).toBe("$8,000.00");
    expect(fact("This month").textContent).toBe("-$2,000.00");
  });

  it("says it is loading before the first status, and still offers the loan forms", () => {
    setup(null);
    expect(screen.getByText("Loading the books")).toBeTruthy();
    expect(screen.queryByText("Cash")).toBeNull();
    expect(form("Take loan")).toBeTruthy();
  });
});

describe("ParkFinances: the loan forms", () => {
  it("has a Take loan form and a Repay loan form, found by the commands they run", () => {
    setup();
    expect(form("Take loan")).toBeTruthy();
    expect(form("Repay loan")).toBeTruthy();
  });

  it("puts a word over each, since both ask for an amount: Borrow, then Pay back", () => {
    setup();
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["Borrow", "Pay back"]);
    // Each heading sits directly above its own form.
    expect(screen.getByText("Borrow").nextElementSibling).toBe(form("Take loan"));
    expect(screen.getByText("Pay back").nextElementSibling).toBe(form("Repay loan"));
  });

  it("submitting Repay sends finance_repay_loan with the amount in cents", async () => {
    const { execute } = setup();
    fireEvent.change(amount("Repay loan"), { target: { value: "125.50" } });
    submit("Repay loan");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("finance_repay_loan", { amount: 12_550 });
  });

  it("submitting Take sends finance_take_loan", async () => {
    const { execute } = setup();
    fireEvent.change(amount("Take loan"), { target: { value: "1000" } });
    submit("Take loan");
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("finance_take_loan", { amount: 100_000 });
  });

  it("asks for a fresh status after a loan went through, and says so", async () => {
    const { onChanged, notify } = setup();
    fireEvent.change(amount("Repay loan"), { target: { value: "100" } });
    submit("Repay loan");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith("Loan repaid");

    fireEvent.change(amount("Take loan"), { target: { value: "100" } });
    submit("Take loan");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(notify).toHaveBeenLastCalledWith("Loan taken");
  });

  it("empties the amount once the loan went through, so a second click is not the same loan again", async () => {
    const { onChanged } = setup();
    fireEvent.change(amount("Take loan"), { target: { value: "100" } });
    submit("Take loan");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(amount("Take loan").value).toBe("");
  });

  it("shows a refusal under the form and asks for nothing", async () => {
    const { onChanged, notify } = setup(park({ loan: 0 }), {
      ok: false,
      error: "You only owe $0.00",
    });
    fireEvent.change(amount("Repay loan"), { target: { value: "5" } });
    submit("Repay loan");
    expect((await within(form("Repay loan")).findByRole("alert")).textContent).toBe(
      "You only owe $0.00",
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(amount("Repay loan").value).toBe("5");
  });

  it("checks an amount before sending it", () => {
    const { execute } = setup();
    fireEvent.change(amount("Take loan"), { target: { value: "0" } });
    submit("Take loan");
    expect(execute).not.toHaveBeenCalled();
    expect(within(form("Take loan")).getByRole("alert")).toBeTruthy();
  });

  it("does not take the focus when the tab opens, so keys go where the player put them", () => {
    setup();
    expect(document.activeElement).toBe(document.body);
  });

  it("has no Back buttons: the forms are part of the page", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("Escape in an amount leaves the field, and does not run anything", () => {
    const { execute } = setup();
    amount("Take loan").focus();
    expect(document.activeElement).toBe(amount("Take loan"));
    fireEvent.keyDown(amount("Take loan"), { key: "Escape" });
    expect(document.activeElement).not.toBe(amount("Take loan"));
    expect(execute).not.toHaveBeenCalled();
  });

  it("has no forms before the sim's commands have arrived, or without a connection", () => {
    setup(park(), OK, { actions: [] });
    expect(screen.queryByRole("form")).toBeNull();
    cleanup();
    setup(park(), OK, { ctx: null });
    expect(screen.queryByRole("form")).toBeNull();
    // The numbers are there all the same.
    expect(fact("Cash")).toBeTruthy();
  });
});

describe("ParkOverview", () => {
  it("shows the park's name, the date, the cash and the loan", () => {
    render(<ParkOverview status={park({ name: "Queryland", loan: 500_000, cash: 1_500_000 })} />);
    expect(fact("Park").textContent).toBe("Queryland");
    expect(fact("Date").textContent).toBe("March 1, Year 1");
    expect(fact("Cash").textContent).toBe("$15,000.00");
    expect(fact("Loan").textContent).toBe("$5,000.00");
  });

  it("holds the places of guests and the rating, which come later", () => {
    render(<ParkOverview status={park()} />);
    expect(fact("Guests").textContent).toBe("Coming with guests");
    expect(fact("Park rating").textContent).toBe("Coming with guests");
  });

  it("says it is loading before the first status", () => {
    render(<ParkOverview status={null} />);
    expect(screen.getByText("Loading the park")).toBeTruthy();
  });
});
