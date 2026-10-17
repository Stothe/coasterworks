import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusPills } from "../src/ui/StatusPills";
import { formatCents, formatChange } from "../src/ui/format";

afterEach(cleanup);

const noop = () => {};

describe("StatusPills", () => {
  it("shows the cash in dollars and the date", () => {
    render(
      <StatusPills
        cash={1_000_000}
        monthChange={0}
        date="March 1, Year 1"
        speed={1}
        onSpeedChange={noop}
        onOpenFinances={noop}
        onOpenOverview={noop}
      />,
    );
    expect(screen.getByText("$10,000.00")).toBeTruthy();
    expect(screen.getByText("March 1, Year 1")).toBeTruthy();
  });

  it("labels the cash and the date for assistive technology", () => {
    render(
      <StatusPills
        cash={1_000_000}
        monthChange={0}
        date="March 1, Year 1"
        speed={1}
        onSpeedChange={noop}
        onOpenFinances={noop}
        onOpenOverview={noop}
      />,
    );
    expect(screen.getByLabelText("Cash").textContent).toContain("$10,000.00");
    expect(screen.getByLabelText("Date").textContent).toContain("March 1, Year 1");
  });

  it("marks the pause button pressed only when the speed is 0", () => {
    const { rerender } = render(
      <StatusPills
        cash={0}
        monthChange={0}
        date="March 1, Year 1"
        speed={0}
        onSpeedChange={noop}
        onOpenFinances={noop}
        onOpenOverview={noop}
      />,
    );
    const pause = () => screen.getByRole("button", { name: "Pause" });
    expect(pause().getAttribute("aria-pressed")).toBe("true");
    for (const name of ["Speed 1x", "Speed 2x", "Speed 4x", "Speed 8x"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false");
    }

    rerender(
      <StatusPills
        cash={0}
        monthChange={0}
        date="March 1, Year 1"
        speed={4}
        onSpeedChange={noop}
        onOpenFinances={noop}
        onOpenOverview={noop}
      />,
    );
    expect(pause().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Speed 4x" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Speed 1x" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("asks for the speed that was clicked", () => {
    const onSpeedChange = vi.fn();
    render(
      <StatusPills
        cash={0}
        monthChange={0}
        date="March 1, Year 1"
        speed={1}
        onSpeedChange={onSpeedChange}
        onOpenFinances={noop}
        onOpenOverview={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Speed 8x" }));
    fireEvent.click(screen.getByRole("button", { name: "Speed 2x" }));
    expect(onSpeedChange.mock.calls).toEqual([[0], [8], [2]]);
  });

  it("groups the speed buttons under a label", () => {
    render(
      <StatusPills
        cash={0}
        monthChange={0}
        date="March 1, Year 1"
        speed={1}
        onSpeedChange={noop}
        onOpenFinances={noop}
        onOpenOverview={noop}
      />,
    );
    const group = screen.getByRole("group", { name: "Game speed" });
    expect(within(group).getAllByRole("button")).toHaveLength(5);
  });

  it("disables the speed buttons when asked, for a halted simulation", () => {
    const onSpeedChange = vi.fn();
    render(
      <StatusPills
        cash={0}
        monthChange={0}
        date="March 1, Year 1"
        speed={0}
        onSpeedChange={onSpeedChange}
        onOpenFinances={noop}
        onOpenOverview={noop}
        speedDisabled
      />,
    );
    const button = screen.getByRole("button", { name: "Speed 1x" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    act(() => {
      fireEvent.click(button);
    });
    expect(onSpeedChange).not.toHaveBeenCalled();
  });
});

describe("StatusPills: the cash and the date open the inspector", () => {
  it("makes the cash a button that opens Finances, named for what it does and what it shows", () => {
    const onOpenFinances = vi.fn();
    render(
      <StatusPills
        cash={1_000_000}
        monthChange={0}
        date="March 1, Year 1"
        speed={1}
        onSpeedChange={noop}
        onOpenFinances={onOpenFinances}
        onOpenOverview={noop}
      />,
    );
    const button = screen.getByRole("button", { name: "Open finances (cash $10,000.00)" });
    expect(button.textContent).toContain("$10,000.00");
    fireEvent.click(button);
    expect(onOpenFinances).toHaveBeenCalledTimes(1);
  });

  it("makes the date a button that opens the park overview", () => {
    const onOpenOverview = vi.fn();
    const onOpenFinances = vi.fn();
    render(
      <StatusPills
        cash={0}
        monthChange={0}
        date="April 10, Year 1"
        speed={1}
        onSpeedChange={noop}
        onOpenFinances={onOpenFinances}
        onOpenOverview={onOpenOverview}
      />,
    );
    const button = screen.getByRole("button", { name: "Open park overview (April 10, Year 1)" });
    expect(button.textContent).toContain("April 10, Year 1");
    fireEvent.click(button);
    expect(onOpenOverview).toHaveBeenCalledTimes(1);
    expect(onOpenFinances).not.toHaveBeenCalled();
  });

  it("keeps the Cash and Date groups, and gives each button a full-size target", () => {
    render(
      <StatusPills
        cash={0}
        monthChange={0}
        date="March 1, Year 1"
        speed={1}
        onSpeedChange={noop}
        onOpenFinances={noop}
        onOpenOverview={noop}
      />,
    );
    for (const group of ["Cash", "Date"]) {
      const button = within(screen.getByRole("group", { name: group })).getByRole("button");
      expect(button.className).toContain("hud-button");
      expect((button as HTMLButtonElement).type).toBe("button");
    }
  });

  it("names the cash of a debt with its sign", () => {
    render(
      <StatusPills
        cash={-12_345}
        monthChange={0}
        date="March 1, Year 1"
        speed={1}
        onSpeedChange={noop}
        onOpenFinances={noop}
        onOpenOverview={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Open finances (cash -$123.45)" })).toBeTruthy();
  });
});

describe("the month's change", () => {
  function pills(monthChange: number, cash = 1_000_000) {
    return (
      <StatusPills
        cash={cash}
        monthChange={monthChange}
        date="March 1, Year 1"
        speed={1}
        onSpeedChange={noop}
        onOpenFinances={noop}
        onOpenOverview={noop}
      />
    );
  }

  it("shows a gain beside the cash in green", () => {
    render(pills(64_000));
    const change = screen.getByTestId("month-change");
    expect(change.textContent).toBe("+$640.00");
    expect(change.className).toContain("text-success");
    expect(screen.getByLabelText("Cash").textContent).toBe("💰$10,000.00+$640.00");
  });

  it("shows a loss with a true minus sign, in red", () => {
    render(pills(-12_000));
    const change = screen.getByTestId("month-change");
    expect(change.textContent).toBe("\u2212$120.00");
    expect(change.className).toContain("text-danger");
  });

  it("shows nothing for a month that has not moved the cash", () => {
    render(pills(0));
    expect(screen.queryByTestId("month-change")).toBeNull();
    expect(screen.getByRole("button", { name: "Open finances (cash $10,000.00)" })).toBeTruthy();
  });

  it("says it in the button's name too", () => {
    const { rerender } = render(pills(64_000));
    expect(
      screen.getByRole("button", { name: "Open finances (cash $10,000.00, this month +$640.00)" }),
    ).toBeTruthy();
    rerender(pills(-12_000));
    expect(
      screen.getByRole("button", {
        name: "Open finances (cash $10,000.00, this month \u2212$120.00)",
      }),
    ).toBeTruthy();
  });
});

describe("formatChange", () => {
  it("signs a gain with a plus and a loss with a minus sign, and leaves none bare", () => {
    expect(formatChange(64_000)).toBe("+$640.00");
    expect(formatChange(-12_000)).toBe("\u2212$120.00");
    expect(formatChange(0)).toBe("$0.00");
    expect(formatChange(-1_234_567)).toBe("\u2212$12,345.67");
    expect(formatChange(1)).toBe("+$0.01");
  });
});

describe("formatCents", () => {
  it("writes cents as dollars with thousands separators and two decimals", () => {
    expect(formatCents(1_000_000)).toBe("$10,000.00");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(450_00)).toBe("$450.00");
    expect(formatCents(123_456_789)).toBe("$1,234,567.89");
    expect(formatCents(100_000_00)).toBe("$100,000.00");
    expect(formatCents(999)).toBe("$9.99");
  });

  it("puts the sign of a debt before the dollar sign", () => {
    expect(formatCents(-350)).toBe("-$3.50");
    expect(formatCents(-1_234_567)).toBe("-$12,345.67");
  });
});
