import type { ParkPublic, QueryResult } from "@coasterworks/protocol";
import type { ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiStore } from "../src/state/uiStore";
import { ratingTone, ratingWord, type ParkState } from "../src/state/useParkState";
import { EntranceInspector } from "../src/ui/inspector/EntranceInspector";
import { GUEST_POLL_MS, GuestInspector, type GuestView } from "../src/ui/inspector/GuestInspector";
import { StatusPills } from "../src/ui/StatusPills";
import { Tray } from "../src/ui/Tray";
import { makeSource } from "./snapshotSource";

const OK: ExecResult = { ok: true, id: 1, cost: 0 };

beforeEach(() => uiStore.setState(uiStore.getInitialState(), true));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  uiStore.setState(uiStore.getInitialState(), true);
});

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const pressedIn = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.getAttribute("aria-label"));

describe("PathsTray", () => {
  const renderPaths = () =>
    render(<Tray tool="path" actions={[]} ctx={null} lastCharge={null} onError={vi.fn()} />);

  it("shows the footpath in hand when the dock goes to Paths", () => {
    act(() => uiStore.getState().setTool("path"));
    renderPaths();
    expect(pressedIn("Path tool")).toEqual(["Footpath"]);
    expect(screen.getByText(/Drag over the ground to draw/)).toBeTruthy();
  });

  it("takes up a queue or the remover, one tile at a time", () => {
    act(() => uiStore.getState().setTool("path"));
    renderPaths();
    fireEvent.click(button("Queue"));
    expect(uiStore.getState().placement).toEqual({
      command: "path_build",
      defaults: { kind: "queue" },
      size: 1,
    });
    expect(pressedIn("Path tool")).toEqual(["Queue"]);
    fireEvent.click(button("Remove"));
    expect(uiStore.getState().placement?.command).toBe("path_remove");
    expect(pressedIn("Path tool")).toEqual(["Remove"]);
  });
});

describe("ParkTray: the gate", () => {
  function renderPark(over: Parameters<typeof makeSource>[0] = {}) {
    const execute = vi.fn<(name: string, input: unknown) => Promise<ExecResult>>();
    execute.mockResolvedValue(OK);
    const onError = vi.fn();
    render(
      <Tray
        tool="park"
        actions={[]}
        ctx={null}
        lastCharge={null}
        onError={onError}
        source={makeSource(over)}
        execute={execute}
      />,
    );
    return { execute, onError };
  }
  const park = (over: Partial<ParkPublic> = {}): { park: ParkPublic } => ({
    park: {
      name: "Test Park",
      open: false,
      entryFee: 500,
      entrance: { x: 31, y: 63, side: 2 as const },
      rating: 500,
      guestsInPark: 0,
      totalAdmissions: 0,
      ...over,
    },
  });

  it("puts the entrance in hand to place on a tile", () => {
    renderPark(park({ entrance: null }));
    fireEvent.click(button("Place entrance"));
    expect(uiStore.getState().placement).toEqual({
      command: "park_set_entrance",
      defaults: {},
      size: 1,
    });
    expect(uiStore.getState().tool).toBe("park");
  });

  it("says Move entrance once there is one", () => {
    renderPark(park());
    expect(button("Move entrance")).toBeTruthy();
  });

  it("opens a closed park and closes an open one", () => {
    const closed = renderPark(park());
    fireEvent.click(button("Open park"));
    expect(closed.execute).toHaveBeenCalledWith("park_open", {});
    cleanup();
    const open = renderPark(park({ open: true }));
    fireEvent.click(button("Close park"));
    expect(open.execute).toHaveBeenCalledWith("park_close", {});
  });

  it("cannot open a park without an entrance", () => {
    renderPark(park({ entrance: null }));
    expect((button("Open park") as HTMLButtonElement).disabled).toBe(true);
  });

  it("sets the entry fee in whole dollars, as cents", () => {
    const { execute } = renderPark(park({ entryFee: 500 }));
    expect((screen.getByLabelText("Entry fee in dollars") as HTMLInputElement).value).toBe("5");
    fireEvent.click(button("Increase entry fee"));
    expect(execute).toHaveBeenCalledWith("park_set_entry_fee", { cents: 600 });
  });

  it("tells a refusal", async () => {
    const { execute, onError } = renderPark(park());
    execute.mockResolvedValue({ ok: false, error: "Nope" });
    fireEvent.click(button("Open park"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Nope"));
  });
});

describe("StatusPills: guests and rating", () => {
  const base = {
    cash: 100,
    monthChange: 0,
    date: "March 1, Year 1",
    speed: 1 as const,
    onSpeedChange: vi.fn(),
    onOpenFinances: vi.fn(),
  };

  it("shows the guests in the park and the rating, which open the overview", () => {
    const onOpenOverview = vi.fn();
    render(<StatusPills {...base} onOpenOverview={onOpenOverview} guests={12} rating={640} />);
    expect(screen.getByTestId("guest-count").textContent).toBe("12");
    fireEvent.click(button("Show guests (12 in the park)"));
    fireEvent.click(button("Show park rating (640, good)"));
    expect(onOpenOverview).toHaveBeenCalledTimes(2);
  });

  it("leaves them out until it knows them", () => {
    render(<StatusPills {...base} onOpenOverview={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Guests" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Park rating" })).toBeNull();
  });
});

describe("ratingWord and ratingTone", () => {
  it("names and colors a rating", () => {
    expect([
      ratingWord(900),
      ratingWord(650),
      ratingWord(450),
      ratingWord(250),
      ratingWord(10),
    ]).toEqual(["Excellent", "Good", "Fair", "Poor", "Very poor"]);
    expect([ratingTone(700), ratingTone(450), ratingTone(100)]).toEqual(["good", "plain", "bad"]);
  });
});

describe("GuestInspector", () => {
  const guest = (over: Partial<GuestView> = {}): GuestView => ({
    id: 4,
    name: "Ada Park",
    tile: { x: 3, y: 4 },
    state: "wandering",
    happiness: 200,
    energy: 180,
    hunger: 40,
    thirst: 230,
    bathroom: 10,
    nausea: 0,
    cash: 2500,
    thought: { id: 1, text: "I'm thirsty" },
    ...over,
  });

  it("shows the guest's name, what they are doing, their cash, needs and thought", async () => {
    const query = vi.fn(async (): Promise<QueryResult<unknown>> => ({ ok: true, result: guest() }));
    render(<GuestInspector id={4} query={query} />);
    expect(await screen.findByText("Ada Park")).toBeTruthy();
    expect(query).toHaveBeenCalledWith("guest_get", { id: 4 });
    expect(screen.getByText("Walking around")).toBeTruthy();
    expect(screen.getByText("$25.00")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Thirst" }).getAttribute("aria-valuenow")).toBe("230");
    expect(screen.getAllByRole("meter")).toHaveLength(6);
    expect(screen.getByText("“I'm thirsty”")).toBeTruthy();
  });

  it("asks again every second and keeps the last five thoughts, newest first", async () => {
    vi.useFakeTimers();
    const texts = ["a", "b", "b", "c", "d", "e", "f"];
    let n = 0;
    const query = vi.fn(async (): Promise<QueryResult<unknown>> => ({
      ok: true,
      result: guest({ thought: { id: 1, text: texts[Math.min(n++, texts.length - 1)]! } }),
    }));
    render(<GuestInspector id={4} query={query} />);
    for (let i = 0; i < texts.length; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(GUEST_POLL_MS);
      });
    }
    const listed = within(screen.getByRole("region", { name: "Thoughts" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(listed).toEqual(["“f”", "“e”", "“d”", "“c”", "“b”"]);
  });

  it("says when the guest has left", async () => {
    const query = vi.fn(async (): Promise<QueryResult<unknown>> => ({
      ok: false,
      error: "No guest with id 4",
    }));
    render(<GuestInspector id={4} query={query} />);
    expect(await screen.findByText("This guest has left the park.")).toBeTruthy();
  });
});

describe("EntranceInspector", () => {
  const park: ParkState = {
    open: true,
    entryFee: 500,
    rating: 500,
    guestsInPark: 7,
    totalAdmissions: 20,
    entrance: { x: 31, y: 63 },
  };

  it("shows where the entrance is, the counts, and the gate", () => {
    const execute = vi.fn(async (): Promise<ExecResult> => OK);
    render(<EntranceInspector park={park} execute={execute} notify={vi.fn()} />);
    expect(screen.getByText("(31, 63)")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
    fireEvent.click(button("Close park"));
    expect(execute).toHaveBeenCalledWith("park_close", {});
  });

  it("says so when the park has no entrance", () => {
    render(
      <EntranceInspector park={{ ...park, entrance: null }} execute={vi.fn()} notify={vi.fn()} />,
    );
    expect(screen.getByText("The park has no entrance.")).toBeTruthy();
  });
});
