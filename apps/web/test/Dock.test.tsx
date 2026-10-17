import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCK_TOOLS } from "../src/actions/types";
import { Dock } from "../src/ui/Dock";

afterEach(cleanup);

const LABELS = ["Terrain", "Paths", "Rides", "Scenery", "Shops", "Staff", "Park"];

describe("Dock", () => {
  it("has the seven tools of the spec in order, each a button named for its word", () => {
    render(<Dock tool="select" onSelect={() => {}} />);
    const group = screen.getByRole("group", { name: "Tools" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(LABELS);
    expect(buttons.map((b) => b.textContent?.replace(/\d$/, ""))).toEqual(LABELS);
  });

  it("gives each an icon and the key that takes the tool up", () => {
    render(<Dock tool="select" onSelect={() => {}} />);
    LABELS.forEach((label, index) => {
      const button = screen.getByRole("button", { name: label });
      expect(button.querySelector('svg[aria-hidden="true"]'), label).not.toBeNull();
      expect(button.querySelector("kbd")?.textContent, label).toBe(String(index + 1));
      expect(button.getAttribute("aria-keyshortcuts"), label).toBe(String(index + 1));
    });
  });

  it("presses the active tool and no other", () => {
    const { rerender } = render(<Dock tool="ride" onSelect={() => {}} />);
    const pressed = () =>
      screen
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.getAttribute("aria-label"));
    expect(pressed()).toEqual(["Rides"]);
    rerender(<Dock tool="park" onSelect={() => {}} />);
    expect(pressed()).toEqual(["Park"]);
    // Select is no button of the dock: nothing is pressed.
    rerender(<Dock tool="select" onSelect={() => {}} />);
    expect(pressed()).toEqual([]);
    for (const b of screen.getAllByRole("button")) {
      expect(b.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("picks a tool on a click", () => {
    const onSelect = vi.fn();
    render(<Dock tool="select" onSelect={onSelect} />);
    LABELS.forEach((label) => fireEvent.click(screen.getByRole("button", { name: label })));
    expect(onSelect.mock.calls.map(([tool]) => tool)).toEqual([...DOCK_TOOLS]);
  });

  it("goes back to Select when the active tool is clicked again", () => {
    const onSelect = vi.fn();
    render(<Dock tool="shop" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Shops" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("select");
    // Another tool is still picked as itself.
    fireEvent.click(screen.getByRole("button", { name: "Staff" }));
    expect(onSelect).toHaveBeenLastCalledWith("staff");
  });

  it("makes every button at least 32 px to hit", () => {
    render(<Dock tool="select" onSelect={() => {}} />);
    for (const b of screen.getAllByRole("button")) expect(b.className).toContain("hud-button");
  });

  it("can be turned off", () => {
    const onSelect = vi.fn();
    render(<Dock tool="select" onSelect={onSelect} disabled />);
    for (const b of screen.getAllByRole("button")) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "Rides" }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
