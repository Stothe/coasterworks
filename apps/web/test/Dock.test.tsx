import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCK_TOOLS } from "../src/actions/types";
import { Dock } from "../src/ui/Dock";

afterEach(cleanup);

const LABELS = ["Terrain", "Paths", "Rides", "Scenery", "Shops", "Staff", "Park"];
const ALL = ["Select", ...LABELS];

describe("Dock", () => {
  it("has Select first and then the seven tools of the spec in order, each a button named for its word", () => {
    render(<Dock tool="select" onSelect={() => {}} />);
    const group = screen.getByRole("group", { name: "Tools" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(ALL);
    expect(buttons.map((b) => b.textContent?.replace(/\d$/, ""))).toEqual(ALL);
  });

  it("gives Select the pointer icon and Esc, which is the key that gets to it, and no number", () => {
    render(<Dock tool="select" onSelect={() => {}} />);
    const select = screen.getByRole("button", { name: "Select" });
    expect(select.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(select.querySelector("kbd")).toBeNull();
    expect(select.getAttribute("aria-keyshortcuts")).toBe("Escape");
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
    // With nothing in hand Select is the one pressed, and no tool is.
    rerender(<Dock tool="select" onSelect={() => {}} />);
    expect(pressed()).toEqual(["Select"]);
    for (const b of screen.getAllByRole("button")) {
      expect(b.getAttribute("aria-pressed")).toBe(
        b.getAttribute("aria-label") === "Select" ? "true" : "false",
      );
    }
  });

  it("presses Select when the tool is Select, as the park opens", () => {
    render(<Dock tool="select" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Terrain" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("puts the tool down for Select when Select is clicked", () => {
    const onSelect = vi.fn();
    render(<Dock tool="ride" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("select");
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
