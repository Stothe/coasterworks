import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusPills } from "../src/ui/StatusPills";
import { formatCents } from "../src/ui/format";

afterEach(cleanup);

const noop = () => {};

describe("StatusPills", () => {
  it("shows the cash in dollars and the date", () => {
    render(<StatusPills cash={1_000_000} date="March 1, Year 1" speed={1} onSpeedChange={noop} />);
    expect(screen.getByText("$10,000.00")).toBeTruthy();
    expect(screen.getByText("March 1, Year 1")).toBeTruthy();
  });

  it("labels the cash and the date for assistive technology", () => {
    render(<StatusPills cash={1_000_000} date="March 1, Year 1" speed={1} onSpeedChange={noop} />);
    expect(screen.getByLabelText("Cash").textContent).toContain("$10,000.00");
    expect(screen.getByLabelText("Date").textContent).toContain("March 1, Year 1");
  });

  it("marks the pause button pressed only when the speed is 0", () => {
    const { rerender } = render(
      <StatusPills cash={0} date="March 1, Year 1" speed={0} onSpeedChange={noop} />,
    );
    const pause = () => screen.getByRole("button", { name: "Pause" });
    expect(pause().getAttribute("aria-pressed")).toBe("true");
    for (const name of ["Speed 1x", "Speed 2x", "Speed 4x", "Speed 8x"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false");
    }

    rerender(<StatusPills cash={0} date="March 1, Year 1" speed={4} onSpeedChange={noop} />);
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
    render(<StatusPills cash={0} date="March 1, Year 1" speed={1} onSpeedChange={onSpeedChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Speed 8x" }));
    fireEvent.click(screen.getByRole("button", { name: "Speed 2x" }));
    expect(onSpeedChange.mock.calls).toEqual([[0], [8], [2]]);
  });

  it("groups the speed buttons under a label", () => {
    render(<StatusPills cash={0} date="March 1, Year 1" speed={1} onSpeedChange={noop} />);
    const group = screen.getByRole("group", { name: "Game speed" });
    expect(within(group).getAllByRole("button")).toHaveLength(5);
  });

  it("disables the speed buttons when asked, for a halted simulation", () => {
    const onSpeedChange = vi.fn();
    render(
      <StatusPills
        cash={0}
        date="March 1, Year 1"
        speed={0}
        onSpeedChange={onSpeedChange}
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
