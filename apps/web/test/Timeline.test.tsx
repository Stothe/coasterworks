import type { EventMessage, LogEntryPublic } from "@coasterworks/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/ui/Timeline";

afterEach(cleanup);

function event(id: number, over: Partial<LogEntryPublic> = {}): EventMessage {
  return {
    t: "event",
    kind: "log",
    entry: {
      id,
      tick: 0,
      client: "player",
      name: "terrain_raise",
      input: { x: 1, y: 2, w: 3, h: 4 },
      cost: 200,
      ...over,
    },
  };
}

const rows = () => screen.getAllByRole("listitem");

describe("Timeline", () => {
  it("says so when nothing has happened", () => {
    render(<Timeline events={[]} onFocus={() => {}} />);
    expect(screen.getByText("Nothing has happened yet.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("lists the newest entry first", () => {
    render(
      <Timeline
        events={[
          event(1, { name: "terrain_lower" }),
          event(2, { name: "terrain_raise" }),
          event(3, { name: "terrain_level" }),
        ]}
        onFocus={() => {}}
      />,
    );
    expect(rows().map((row) => within(row).getByText(/terrain$/).textContent)).toEqual([
      "Level terrain",
      "Raise terrain",
      "Lower terrain",
    ]);
  });

  it("shows each entry once, though an event arrived twice", () => {
    render(<Timeline events={[event(1), event(1, { cost: 500 }), event(2)]} onFocus={() => {}} />);
    expect(rows()).toHaveLength(2);
  });

  it("shows the title, who did it, and the date of its tick", () => {
    // 0 is the park's first day; a day is 1,440 ticks.
    render(<Timeline events={[event(1, { tick: 0 })]} onFocus={() => {}} />);
    const row = rows()[0] as HTMLElement;
    expect(within(row).getByText("Raise terrain")).toBeTruthy();
    expect(within(row).getByText("You")).toBeTruthy();
    expect(within(row).getByText("March 1, Year 1")).toBeTruthy();
  });

  it("badges an agent's entry as the Agent", () => {
    render(<Timeline events={[event(1, { client: "agent" })]} onFocus={() => {}} />);
    expect(within(rows()[0] as HTMLElement).getByText("Agent")).toBeTruthy();
  });

  it("says what a command charged, and what an undo refunded", () => {
    render(
      <Timeline
        events={[
          event(1, { cost: 1250 }),
          event(2, { name: "undo", input: { target: 1 }, cost: -1250 }),
          event(3, { name: "terrain_set_surface", cost: 0 }),
        ]}
        onFocus={() => {}}
      />,
    );
    const [free, refund, charge] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(charge).getByText("Charged $12.50")).toBeTruthy();
    expect(within(refund).getByText("Refunded $12.50")).toBeTruthy();
    expect(within(free).queryByText(/Charged|Refunded/)).toBeNull();
  });

  it("strikes through an undone entry, and not the undo that undid it", () => {
    render(
      <Timeline
        events={[event(1), event(2, { name: "undo", input: { target: 1 }, cost: -200 })]}
        onFocus={() => {}}
      />,
    );
    const [marker, undone] = rows() as [HTMLElement, HTMLElement];
    expect(undone.getAttribute("data-undone")).toBe("true");
    expect(within(undone).getByText("Raise terrain").className).toContain("line-through");
    expect(within(undone).getByText("(undone)")).toBeTruthy();
    expect(marker.getAttribute("data-undone")).toBe("false");
    expect(within(marker).getByText("Undid Raise terrain").className).not.toContain("line-through");
  });

  it("takes the strike-through away when a redo brings the entry back", () => {
    render(
      <Timeline
        events={[
          event(1),
          event(2, { name: "undo", input: { target: 1 }, cost: -200 }),
          event(3, { name: "redo", input: { target: 1 } }),
        ]}
        onFocus={() => {}}
      />,
    );
    expect(screen.getByText("Raise terrain").className).not.toContain("line-through");
    expect(screen.queryByText("(undone)")).toBeNull();
  });

  it("focuses the camera on the area of an entry that has one", () => {
    const onFocus = vi.fn();
    render(
      <Timeline events={[event(1, { input: { x: 4, y: 5, w: 2, h: 3 } })]} onFocus={onFocus} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Raise terrain/ }));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith({ x: 4, y: 5, w: 2, h: 3 });
  });

  it("is no button for an entry without an area", () => {
    const onFocus = vi.fn();
    render(
      <Timeline
        events={[event(1, { name: "finance_take_loan", input: { amount: 1 } })]}
        onFocus={onFocus}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Take loan")).toBeTruthy();
    expect(onFocus).not.toHaveBeenCalled();
  });
});
