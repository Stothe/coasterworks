import { RIDE_TYPES, STALL_TYPES } from "@coasterworks/content";
import type { QueryResult } from "@coasterworks/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiStore } from "../src/state/uiStore";
import { RidesTray, ShopsTray, type QueryFn } from "../src/ui/trays/BuildTray";

/** A sim that answers `content_list` as the real one does. */
const query = vi.fn<QueryFn>(async (name, input) => {
  if (name !== "content_list") return { ok: false, error: `Unknown query: ${name}` };
  const kind = (input as { kind?: string }).kind;
  const types = [...RIDE_TYPES, ...STALL_TYPES].filter(
    (t) => kind === undefined || t.kind === kind,
  );
  return { ok: true, result: JSON.parse(JSON.stringify(types)) } as QueryResult<unknown>;
});

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  query.mockClear();
});
afterEach(() => {
  cleanup();
  uiStore.setState(uiStore.getInitialState(), true);
});

async function shown(ui: React.ReactElement) {
  render(ui);
  await act(async () => {});
}
const cards = (list: string) =>
  within(screen.getByRole("list", { name: list }))
    .getAllByRole("button")
    .map((card) => card.querySelector("span")?.textContent);
const chips = () =>
  within(screen.getByRole("group", { name: "Category" }))
    .getAllByRole("button")
    .map((b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? "*" : ""}`);
const placement = () => uiStore.getState().placement;

describe("RidesTray", () => {
  it("asks the sim for its rides and shows the gentle ones first, with cost and footprint", async () => {
    await shown(<RidesTray query={query} lastCharge={null} />);
    expect(query).toHaveBeenCalledExactlyOnceWith("content_list", { kind: "ride" });
    expect(chips()).toEqual(["Gentle*", "Thrill"]);
    expect(cards("Rides")).toEqual(["Carousel", "Big Wheel"]);
    const carousel = screen.getByRole("button", { name: /^Carousel/ });
    expect(carousel.getAttribute("aria-label")).toBe("Carousel, $1,200.00, 3 by 3 tiles");
    expect(within(carousel).getByText("$1,200.00")).toBeTruthy();
    expect(within(carousel).getByText("3 × 3 tiles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Thrill" }));
    expect(cards("Rides")).toEqual(["Swing Tower"]);
  });

  it("puts the ride of a card in hand, unturned, and marks its card", async () => {
    await shown(<RidesTray query={query} lastCharge={null} />);
    expect(screen.getByText("Pick one to place it")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Big Wheel/ }));
    expect(placement()).toEqual({
      command: "ride_build",
      defaults: { type: "big_wheel", rot: 0 },
      size: 1,
    });
    expect(uiStore.getState().tool).toBe("ride");
    const pressed = within(screen.getByRole("list", { name: "Rides" }))
      .getAllByRole("button", { pressed: true })
      .map((b) => b.getAttribute("aria-label"));
    expect(pressed).toEqual(["Big Wheel, $2,800.00, 2 by 4 tiles"]);
  });

  it("turns the ride in hand with its button, and keeps the turn for the next card", async () => {
    await shown(<RidesTray query={query} lastCharge={null} />);
    const rotate = () => screen.getByRole("button", { name: "Rotate" }) as HTMLButtonElement;
    expect(rotate().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Carousel/ }));
    expect(rotate().disabled).toBe(false);
    fireEvent.click(rotate());
    fireEvent.click(rotate());
    expect(placement()?.defaults).toEqual({ type: "carousel", rot: 2 });
    expect(screen.getByLabelText("Turned").textContent).toBe("180°");
    fireEvent.click(screen.getByRole("button", { name: /^Big Wheel/ }));
    expect(placement()?.defaults).toEqual({ type: "big_wheel", rot: 2 });
  });

  it("opens on the category of the ride in hand", async () => {
    act(() => uiStore.getState().startPlacement("ride_build", { type: "swing_tower", rot: 0 }));
    await shown(<RidesTray query={query} lastCharge={null} />);
    expect(chips()).toEqual(["Gentle", "Thrill*"]);
    expect(screen.getByRole("button", { name: /^Swing Tower/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("says why the spot will not do, and what the last build cost", async () => {
    await shown(<RidesTray query={query} lastCharge={120_000} />);
    fireEvent.click(screen.getByRole("button", { name: /^Carousel/ }));
    expect(screen.getByText(/Click the ground to build/)).toBeTruthy();
    expect(screen.getByText("Charged $1,200.00")).toBeTruthy();
    act(() => uiStore.getState().setPlacementCheck({ ok: false, reason: "Ground is not flat" }));
    expect(screen.getByText("Ground is not flat")).toBeTruthy();
    act(() => uiStore.getState().setPlacementCheck({ ok: true, reason: null }));
    expect(screen.queryByText("Ground is not flat")).toBeNull();
  });

  it("says when the list could not be had, and waits without a connection", async () => {
    await shown(<RidesTray query={null} lastCharge={null} />);
    expect(screen.getByText("Loading the rides")).toBeTruthy();
    cleanup();
    await shown(
      <RidesTray query={async () => ({ ok: false, error: "No sim" })} lastCharge={null} />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Could not list the rides: No sim");
  });

  it("is turned off with the rest", async () => {
    await shown(<RidesTray query={query} lastCharge={null} disabled />);
    for (const b of screen.getAllByRole("button"))
      expect((b as HTMLButtonElement).disabled, b.textContent ?? "").toBe(true);
  });
});

describe("ShopsTray", () => {
  it("has Food, Drink and Facilities, and builds stalls", async () => {
    await shown(<ShopsTray query={query} lastCharge={null} />);
    expect(query).toHaveBeenCalledExactlyOnceWith("content_list", { kind: "stall" });
    expect(chips()).toEqual(["Food*", "Drink", "Facilities"]);
    expect(cards("Shops and stalls")).toEqual(["Snack Stand"]);
    fireEvent.click(screen.getByRole("button", { name: "Drink" }));
    expect(cards("Shops and stalls")).toEqual(["Drinks Stand"]);
    fireEvent.click(screen.getByRole("button", { name: "Facilities" }));
    fireEvent.click(screen.getByRole("button", { name: /^Restrooms/ }));
    expect(placement()).toEqual({
      command: "stall_build",
      defaults: { type: "restrooms", rot: 0 },
      size: 1,
    });
    expect(uiStore.getState().tool).toBe("shop");
  });
});
