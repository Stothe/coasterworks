import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toast, type ToastItem } from "../src/ui/Toast";

afterEach(cleanup);

describe("Toast", () => {
  it("shows a plain message as text in a status, and an error as an alert", () => {
    const toasts: ToastItem[] = [
      { id: 1, text: "Loan taken", kind: "info" },
      { id: 2, text: "Not enough cash", kind: "error" },
    ];
    render(<Toast toasts={toasts} onDismiss={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Loan taken");
    expect(screen.getByRole("alert").textContent).toContain("Not enough cash");
    // Neither is a button but for its dismiss.
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Dismiss",
      "Dismiss",
    ]);
  });

  it("makes a message with an action a button that runs it and goes away", () => {
    const run = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Toast
        toasts={[
          {
            id: 7,
            text: "Agent: 6 actions",
            kind: "info",
            action: { label: "Open the Timeline", run },
          },
        ]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Agent: 6 actions/ }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(7);
  });

  it("names that button with the words it shows first, and then what it does", () => {
    render(
      <Toast
        toasts={[
          {
            id: 1,
            text: "Agent: Raise terrain",
            kind: "info",
            action: { label: "Jump to the area", run: () => {} },
          },
        ]}
        onDismiss={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: /^Agent: Raise terrain/ });
    // A voice-control user who says what they see ("click Agent: Raise terrain") finds it.
    expect(button.getAttribute("aria-label")).toBe("Agent: Raise terrain. Jump to the area");
    expect(button.getAttribute("aria-label")).toContain(button.textContent);
  });

  it("dismisses a message from its own button", () => {
    const onDismiss = vi.fn();
    render(<Toast toasts={[{ id: 3, text: "Hi", kind: "info" }]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledWith(3);
  });
});
