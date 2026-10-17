import type { SimClient } from "@coasterworks/protocol";
import { createDefaultRegistry, type ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildActions, type UiActionDeps } from "../src/actions/registry";
import type { Action, ActionContext, JsonSchemaProperty } from "../src/actions/types";
import { ActionForm } from "../src/ui/ActionForm";

afterEach(cleanup);

const ctx = {
  client: {} as SimClient,
  snapshot: null,
  ui: { tool: "select", selection: null, inspectorOpen: false },
} satisfies ActionContext;

const deps: UiActionDeps = {
  startPlacement: vi.fn(),
  openForm: vi.fn(),
  execute: vi.fn(),
  ui: {
    pause: vi.fn(),
    setSpeed: vi.fn(),
    stepSpeed: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    classicView: vi.fn(),
    setTool: vi.fn(),
    openInspector: vi.fn(),
    help: vi.fn(),
    commandBar: vi.fn(),
    cancel: vi.fn(),
    terrain: vi.fn(),
    brush: vi.fn(),
  },
};

const real = buildActions(createDefaultRegistry().catalog(), deps);
function realAction(id: string): Action {
  const action = real.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`No action ${id}`);
  return action;
}

/** A command the sim does not have, with the given input properties. */
function fake(
  properties: Record<string, JsonSchemaProperty>,
  required: string[] = [],
  name = "park_adjust",
): Action {
  return {
    id: name,
    commandName: name,
    title: "Adjust park",
    description: "Adjusts the park.",
    category: "park",
    kind: "command",
    keywords: ["park"],
    schema: { type: "object", properties, required },
    run: () => {},
  };
}

const OK: ExecResult = { ok: true, id: 7, cost: 0 };

function setup(action: Action, result: ExecResult | Promise<ExecResult> = OK) {
  const execute = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>(async () => result);
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    <ActionForm action={action} ctx={ctx} execute={execute} onDone={onDone} onCancel={onCancel} />,
  );
  return { execute, onDone, onCancel };
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: /^(Take loan|Adjust park)/ }));

describe("ActionForm: the fields", () => {
  it("draws one labeled control per field, in the schema's order", () => {
    setup(
      fake(
        {
          count: { type: "integer", minimum: 1, maximum: 9 },
          ratio: { type: "number" },
          note: { type: "string", description: "Shown to the guests." },
          open: { type: "boolean" },
          mode: { enum: ["slow", "fast"] },
        },
        ["count"],
      ),
    );
    expect(screen.getByRole("spinbutton", { name: "Count" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Ratio" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Note" })).toBeTruthy();
    expect(screen.getByText("Shown to the guests.")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Open" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Mode" })).toBeTruthy();
  });

  it("gives the loan an integer amount in dollars", () => {
    setup(realAction("finance_take_loan"));
    const amount = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Amount" });
    expect(amount.type).toBe("number");
    expect(amount.step).toBe("0.01");
    expect(amount.value).toBe("");
  });

  it("puts the first field in focus", () => {
    setup(fake({ count: { type: "integer" }, note: { type: "string" } }));
    expect(document.activeElement).toBe(screen.getByLabelText("Count"));
  });

  it("starts each field at its default, and a money default in dollars", () => {
    setup(
      fake({
        count: { type: "integer", default: 4 },
        fee: { type: "integer", description: "The fee, in cents.", default: 12_345 },
        open: { type: "boolean", default: true },
        mode: { enum: ["slow", "fast"], default: "fast" },
      }),
    );
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Count" }).value).toBe("4");
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Fee" }).value).toBe("123.45");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Open" }).checked).toBe(true);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Mode" }).value).toBe("fast");
  });

  it("labels the submit button with the action's title", () => {
    setup(realAction("finance_take_loan"));
    expect(screen.getByRole("button", { name: "Take loan" })).toBeTruthy();
  });

  it("says when the action needs the full UI instead of drawing a form", () => {
    setup(fake({ tiles: { type: "array", items: { type: "integer" } } as JsonSchemaProperty }));
    expect(screen.getByText("This action needs the full UI")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Adjust park" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
  });
});

describe("ActionForm: submitting", () => {
  it("sends the loan amount in cents", async () => {
    const { execute, onDone } = setup(realAction("finance_take_loan"));
    type("Amount", "500");
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("finance_take_loan", { amount: 50_000 });
    expect(onDone).toHaveBeenCalledWith(OK);
  });

  it("rounds dollars and cents to whole cents", async () => {
    const { execute } = setup(realAction("finance_take_loan"));
    type("Amount", "1234.56");
    submit();
    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(execute).toHaveBeenCalledWith("finance_take_loan", { amount: 123_456 });
  });

  it("submits on Enter, which is a submit of the form", async () => {
    const { execute } = setup(realAction("finance_take_loan"));
    type("Amount", "500");
    fireEvent.submit(screen.getByRole("form", { name: "Take loan" }));
    await waitFor(() => expect(execute).toHaveBeenCalled());
  });

  it("sends the other kinds of field as what they are", async () => {
    const { execute } = setup(
      fake({
        count: { type: "integer" },
        ratio: { type: "number" },
        note: { type: "string" },
        open: { type: "boolean" },
        level: { enum: [1, 2, 3] },
        mode: { enum: ["slow", "fast"] },
      }),
    );
    type("Count", "3");
    type("Ratio", "0.5");
    type("Note", "hello");
    fireEvent.click(screen.getByRole("checkbox", { name: "Open" }));
    type("Level", "2");
    type("Mode", "fast");
    submit();
    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(execute).toHaveBeenCalledWith("park_adjust", {
      count: 3,
      ratio: 0.5,
      note: "hello",
      open: true,
      level: 2,
      mode: "fast",
    });
  });

  it("leaves out an optional field the player left empty", async () => {
    const { execute } = setup(fake({ count: { type: "integer" }, note: { type: "string" } }));
    type("Count", "3");
    submit();
    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(execute).toHaveBeenCalledWith("park_adjust", { count: 3 });
  });

  it("runs the command by its name, not the action's id", async () => {
    const action = { ...fake({ count: { type: "integer" } }), id: "something.else" };
    const { execute } = setup(action);
    type("Count", "1");
    submit();
    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(execute.mock.calls[0]?.[0]).toBe("park_adjust");
  });

  it("keeps the submit button off while the command runs, so it runs once", async () => {
    let finish: (result: ExecResult) => void = () => {};
    const pending = new Promise<ExecResult>((resolve) => (finish = resolve));
    const { execute, onDone } = setup(realAction("finance_take_loan"), pending);
    type("Amount", "500");
    submit();
    submit();
    expect(execute).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Take loan" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => finish(OK));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("ActionForm: checking the input", () => {
  it("refuses a number below the minimum, with the range, and does not run the command", async () => {
    const { execute, onDone } = setup(
      fake({ count: { type: "integer", minimum: 100, maximum: 5_000_000 } }, ["count"]),
    );
    type("Count", "50");
    submit();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Must be between 100 and 5,000,000",
    );
    expect(screen.getByLabelText("Count").getAttribute("aria-invalid")).toBe("true");
    expect(execute).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("refuses a number above the maximum", async () => {
    const { execute } = setup(fake({ count: { type: "integer", minimum: 1, maximum: 9 } }));
    type("Count", "10");
    submit();
    expect((await screen.findByRole("alert")).textContent).toBe("Must be between 1 and 9");
    expect(execute).not.toHaveBeenCalled();
  });

  it("says 'at least' or 'at most' when there is only one bound", async () => {
    setup(fake({ low: { type: "integer", minimum: 3 }, high: { type: "integer", maximum: 5 } }));
    type("Low", "1");
    type("High", "6");
    submit();
    const messages = (await screen.findAllByRole("alert")).map((el) => el.textContent);
    expect(messages).toEqual(["Must be at least 3", "Must be at most 5"]);
  });

  it("gives the range of a money field in dollars", async () => {
    const { execute } = setup(realAction("finance_take_loan"));
    // 50 cents is under the $1.00 the sim takes at least.
    type("Amount", "0.5");
    submit();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Must be between $1.00 and $50,000.00",
    );
    expect(execute).not.toHaveBeenCalled();
    type("Amount", "50001");
    submit();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Must be between $1.00 and $50,000.00"),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("asks for a required field left empty, and for a whole number where one is needed", async () => {
    const { execute } = setup(
      fake({ count: { type: "integer" }, note: { type: "string" } }, ["count", "note"]),
    );
    submit();
    expect((await screen.findAllByRole("alert")).map((el) => el.textContent)).toEqual([
      "Required",
      "Required",
    ]);
    type("Count", "2.5");
    type("Note", "x");
    submit();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Must be a whole number"),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("clears the message once the value is good", async () => {
    const { execute } = setup(fake({ count: { type: "integer", minimum: 5 } }));
    type("Count", "1");
    submit();
    await screen.findByRole("alert");
    type("Count", "7");
    expect(screen.queryByRole("alert")).toBeNull();
    submit();
    await waitFor(() => expect(execute).toHaveBeenCalledWith("park_adjust", { count: 7 }));
  });

  it("shows a message for a field when it loses focus, not before", () => {
    setup(fake({ count: { type: "integer", minimum: 5 } }));
    type("Count", "1");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(screen.getByLabelText("Count"));
    expect(screen.getByRole("alert").textContent).toBe("Must be at least 5");
  });
});

describe("ActionForm: the answer", () => {
  it("shows the sim's error inline, keeps what was typed, and lets the player try again", async () => {
    const { onDone } = setup(realAction("finance_take_loan"), {
      ok: false,
      error: "Loan limit is $50000.00",
    });
    type("Amount", "500");
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Loan limit is $50000.00");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Amount" }).value).toBe("500");
    expect((screen.getByRole("button", { name: "Take loan" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("shows the reason when the command could not be sent at all", async () => {
    const execute = vi.fn(async (): Promise<ExecResult> => {
      throw new Error("Connection closed");
    });
    const onDone = vi.fn();
    render(
      <ActionForm
        action={realAction("finance_take_loan")}
        ctx={ctx}
        execute={execute}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    type("Amount", "500");
    submit();
    expect((await screen.findByRole("alert")).textContent).toBe("Connection closed");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("clears an old error when the player submits again", async () => {
    const answers: ExecResult[] = [{ ok: false, error: "Nope" }, OK];
    const execute = vi.fn(async () => answers.shift() ?? OK);
    const onDone = vi.fn();
    render(
      <ActionForm
        action={realAction("finance_take_loan")}
        ctx={ctx}
        execute={execute}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    type("Amount", "500");
    submit();
    await screen.findByText("Nope");
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.queryByText("Nope")).toBeNull();
  });
});

describe("ActionForm: leaving", () => {
  it("cancels on Escape", () => {
    const { onCancel, execute } = setup(realAction("finance_take_loan"));
    fireEvent.keyDown(screen.getByLabelText("Amount"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not cancel again for an Escape something above it already handled", () => {
    const { onCancel } = setup(realAction("finance_take_loan"));
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    screen.getByLabelText("Amount").dispatchEvent(event);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels from the Back button", () => {
    const { onCancel } = setup(realAction("finance_take_loan"));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the submit off for an action that is not enabled now", () => {
    const action = { ...realAction("finance_take_loan"), enabled: () => false };
    setup(action);
    expect((screen.getByRole("button", { name: "Take loan" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("ActionForm: inline", () => {
  /** A form that sits in a panel with other things, as the inspector's loan forms do. */
  function inline(action: Action) {
    const execute = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>(async () => OK);
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(
      <ActionForm
        action={action}
        ctx={ctx}
        execute={execute}
        onDone={onDone}
        onCancel={onCancel}
        inline
      />,
    );
    return { execute, onDone, onCancel };
  }

  it("does not take the focus when it appears, so two of them do not fight over it", () => {
    inline(realAction("finance_take_loan"));
    expect(document.activeElement).not.toBe(screen.getByLabelText("Amount"));
    expect(document.activeElement).toBe(document.body);
  });

  it("has no Back button, only the action's own", () => {
    inline(realAction("finance_take_loan"));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Take loan" })).toBeTruthy();
  });

  it("still sends the command, and still cancels on Escape", async () => {
    const { execute, onDone, onCancel } = inline(realAction("finance_take_loan"));
    type("Amount", "50");
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith("finance_take_loan", { amount: 5000 });
    fireEvent.keyDown(screen.getByLabelText("Amount"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
