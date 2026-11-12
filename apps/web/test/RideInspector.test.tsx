import type { QueryResult } from "@coasterworks/protocol";
import type { ExecResult } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RIDE_POLL_MS,
  RideInspector,
  formatRating,
  parseDollars,
  type RideView,
} from "../src/ui/inspector/RideInspector";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const carousel = (over: Partial<RideView> = {}): RideView => ({
  id: 1,
  type: "carousel",
  kind: "ride",
  name: "Carousel 1",
  open: false,
  price: 100,
  phase: 0,
  riders: [],
  queue: [],
  stats: { customers: 40, income: 4000, runningCost: 900, monthCustomers: 12, monthIncome: 1200 },
  content: {
    name: "Carousel",
    cost: 120_000,
    runningCost: 3_000,
    excitement: 420,
    intensity: 180,
    nausea: 120,
  },
  ...over,
});

const OK: ExecResult = { ok: true, id: 1, cost: 0 };

/** A sim with one ride, whose answers follow the commands sent to it. */
function sim(start: RideView = carousel()) {
  let ride: RideView | null = start;
  const query = vi.fn(async (name: string, input: unknown): Promise<QueryResult<unknown>> => {
    const { id } = input as { id: number };
    if (name !== "ride_get") return { ok: false, error: `Unknown query: ${name}` };
    if (!ride || id !== ride.id) return { ok: false, error: `No ride with id ${id}` };
    return { ok: true, result: ride };
  });
  const execute = vi.fn(async (name: string, input: unknown): Promise<ExecResult> => {
    const args = input as { id: number; cents?: number; name?: string };
    if (!ride) return { ok: false, error: `No ride with id ${args.id}` };
    if (name === "ride_open") ride = { ...ride, open: true };
    if (name === "ride_close") ride = { ...ride, open: false };
    if (name === "ride_set_price") ride = { ...ride, price: args.cents ?? 0 };
    if (name === "ride_rename") ride = { ...ride, name: args.name ?? "" };
    if (name === "ride_demolish") ride = null;
    return OK;
  });
  return {
    query,
    execute,
    set: (next: RideView | null) => {
      ride = next;
    },
  };
}

async function shown(s: ReturnType<typeof sim>, notify = vi.fn()) {
  render(<RideInspector id={1} query={s.query} execute={s.execute} notify={notify} />);
  await screen.findByRole("heading", { name: /Carousel|Snack/ });
  return notify;
}
const status = () => screen.getByLabelText("Status").textContent;
const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

describe("RideInspector: header and overview", () => {
  it("names the ride and says it is closed, then open and what it is doing", async () => {
    const s = sim();
    await shown(s);
    expect(s.query).toHaveBeenCalledWith("ride_get", { id: 1 });
    expect(status()).toBe("Closed");
    await click("Open ride");
    expect(s.execute).toHaveBeenCalledWith("ride_open", { id: 1 });
    await screen.findByRole("button", { name: "Close ride" });
    expect(status()).toBe("Open · Idle");
    s.set(carousel({ open: true, phase: 2 }));
    await click("Close ride");
    expect(s.execute).toHaveBeenLastCalledWith("ride_close", { id: 1 });
    await screen.findByRole("button", { name: "Open ride" });
  });

  it("follows the live phase by id, and keeps the asked one when the snapshot has none", async () => {
    const s = sim(carousel({ open: true, phase: 1 }));
    const snapshot = {
      rideStatus: {
        count: 2,
        id: new Int32Array([9, 1]),
        phase: new Uint8Array([0, 2]),
        phaseTicks: new Uint16Array(2),
        riders: new Uint8Array(2),
        queue: new Uint16Array(2),
      },
    };
    const source = { snapshot: snapshot as never };
    const { rerender } = render(
      <RideInspector id={1} query={s.query} execute={s.execute} notify={vi.fn()} source={source} />,
    );
    await screen.findByRole("heading", { name: "Carousel 1" });
    expect(status()).toBe("Open · Running");
    // A snapshot whose status does not have the ride yet: no news, the asked phase stands.
    rerender(
      <RideInspector
        id={1}
        query={s.query}
        execute={s.execute}
        notify={vi.fn()}
        source={{ snapshot: null }}
      />,
    );
    expect(status()).toBe("Open · Loading");
  });

  it("steps the price ten cents from the price last asked for, and takes a typed one on Enter", async () => {
    const s = sim();
    await shown(s);
    const field = screen.getByRole("textbox", { name: "Price in dollars" }) as HTMLInputElement;
    expect(field.value).toBe("1.00");
    // Two quick clicks before the sim's answer: the second goes on from the first.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Increase price" }));
      fireEvent.click(screen.getByRole("button", { name: "Increase price" }));
    });
    expect(s.execute.mock.calls.map(([, input]) => input)).toEqual([
      { id: 1, cents: 110 },
      { id: 1, cents: 120 },
    ]);
    await vi.waitFor(() => expect(field.value).toBe("1.20"));
    fireEvent.change(field, { target: { value: "2.5" } });
    expect(s.execute).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(s.execute).toHaveBeenLastCalledWith("ride_set_price", { id: 1, cents: 250 });
    await vi.waitFor(() => expect(field.value).toBe("2.50"));
  });

  it("keeps stepping from the price last asked for when a poll shows an earlier step", async () => {
    let price = 100;
    const pending: Array<() => void> = [];
    const query = vi.fn(async (): Promise<QueryResult<unknown>> => ({
      ok: true,
      result: carousel({ price }),
    }));
    const execute = vi.fn(
      (_name: string, input: unknown) =>
        new Promise<ExecResult>((resolve) => {
          const { cents } = input as { cents: number };
          pending.push(() => {
            price = cents;
            resolve(OK);
          });
        }),
    );
    render(<RideInspector id={1} query={query} execute={execute} notify={vi.fn()} />);
    await screen.findByRole("heading", { name: "Carousel 1" });
    const up = () => fireEvent.click(screen.getByRole("button", { name: "Increase price" }));
    await act(async () => {
      up();
      up();
    });
    // The first step lands and the poll shows 1.10 while the second is still on its way.
    await act(async () => pending[0]?.());
    const field = screen.getByRole("textbox", { name: "Price in dollars" }) as HTMLInputElement;
    await vi.waitFor(() => expect(field.value).toBe("1.10"));
    await act(async () => up());
    expect(execute.mock.calls.map(([, input]) => input)).toEqual([
      { id: 1, cents: 110 },
      { id: 1, cents: 120 },
      { id: 1, cents: 130 },
    ]);
  });

  it("leaves Escape in the name box to the box: it reverts the draft and does not reach the window", async () => {
    const s = sim();
    await shown(s);
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    try {
      const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
      fireEvent.change(name, { target: { value: "Zoom" } });
      fireEvent.keyDown(name, { key: "Escape" });
      expect(name.value).toBe("Carousel 1");
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
  });

  it("renames on Enter, and leaves a blank name as it was", async () => {
    const s = sim();
    await shown(s);
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.blur(name);
    expect(name.value).toBe("Carousel 1");
    expect(s.execute).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Gallopers" } });
    await act(async () => {
      fireEvent.keyDown(name, { key: "Enter" });
    });
    expect(s.execute).toHaveBeenCalledExactlyOnceWith("ride_rename", {
      id: 1,
      name: "Gallopers",
    });
    expect(await screen.findByRole("heading", { name: "Gallopers" })).toBeTruthy();
  });

  it("asks before it demolishes, says what it refunds, and says when it is gone", async () => {
    const s = sim();
    await shown(s);
    await click("Demolish");
    const confirm = screen.getByRole("group", { name: "Confirm demolish" });
    expect(confirm.textContent).toContain("Demolish?");
    expect(confirm.textContent).toContain("Refunds $600.00");
    await click("No");
    expect(screen.queryByRole("group", { name: "Confirm demolish" })).toBeNull();
    expect(s.execute).not.toHaveBeenCalled();
    await click("Demolish");
    await click("Yes");
    expect(s.execute).toHaveBeenCalledExactlyOnceWith("ride_demolish", { id: 1 });
    expect(await screen.findByText("This has been demolished.")).toBeTruthy();
  });

  it("never demolishes a ride other than the one its confirm was opened for", async () => {
    const s = sim();
    const props = { query: s.query, execute: s.execute, notify: vi.fn() };
    const { rerender } = render(<RideInspector id={1} {...props} />);
    await screen.findByRole("heading", { name: /Carousel/ });
    await click("Demolish");
    const yes = screen.getByRole("button", { name: "Yes" });
    // The selection moves to ride 2 and Yes is pressed in the same act.
    await act(async () => {
      rerender(<RideInspector id={2} {...props} />);
      fireEvent.click(yes);
    });
    // A Yes that lands before the new selection is drawn is still ride 1's confirm: it may
    // demolish 1, never 2.
    expect(s.execute).not.toHaveBeenCalledWith("ride_demolish", { id: 2 });
    expect(screen.queryByRole("group", { name: "Confirm demolish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
    // Coming back to ride 1 does not bring the old confirm back.
    await act(async () => {
      rerender(<RideInspector id={1} {...props} />);
    });
    expect(screen.queryByRole("group", { name: "Confirm demolish" })).toBeNull();
  });

  it("tells a refusal", async () => {
    const s = sim();
    s.execute.mockResolvedValueOnce({ ok: false, error: "Not enough cash" });
    const notify = await shown(s);
    await click("Open ride");
    expect(notify).toHaveBeenCalledWith("Not enough cash", { kind: "error" });
  });

  it("says Open stall and Close stall for a stall", async () => {
    const s = sim(
      carousel({ kind: "stall", name: "Snack Stand 1", type: "snack_stand", content: null }),
    );
    await shown(s);
    expect(screen.getByRole("button", { name: "Open stall" })).toBeTruthy();
    expect(status()).toBe("Closed");
  });
});

describe("RideInspector: stats", () => {
  it("lists customers, income, running cost, queue, riders and the ratings", async () => {
    const s = sim(carousel({ riders: [3, 4], queue: [5, 6, 7] }));
    await shown(s);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Stats" }));
    const rows = (label: string) =>
      Object.fromEntries(
        within(screen.getByLabelText(label))
          .getAllByRole("term")
          .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
      );
    expect(rows("Takings")).toEqual({
      "Customers this month": "12",
      "Customers all time": "40",
      "Income this month": "$12.00",
      "Income all time": "$40.00",
      "Running cost": "$30.00 a month",
      "In the queue": "3",
      Riders: "2",
    });
    expect(rows("Ratings")).toEqual({ Excitement: "4.20", Intensity: "1.80", Nausea: "1.20" });
  });

  it("has no ratings or riders for a stall", async () => {
    const s = sim(carousel({ kind: "stall", name: "Snack Stand 1", type: "snack_stand" }));
    await shown(s);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Stats" }));
    expect(screen.getByLabelText("Takings")).toBeTruthy();
    expect(screen.queryByLabelText("Ratings")).toBeNull();
    expect(screen.queryByText("Riders")).toBeNull();
  });
});

describe("RideInspector: asking after the ride", () => {
  it("asks every second, stops once there is no such ride, and keeps on through other failures", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const query = vi.fn(async (): Promise<QueryResult<unknown>> => {
      calls++;
      if (calls === 2) throw new Error("timed out");
      if (calls === 3) return { ok: false, error: "Simulation halted" };
      if (calls >= 4) return { ok: false, error: "No ride with id 1" };
      return { ok: true, result: carousel() };
    });
    render(<RideInspector id={1} query={query} execute={vi.fn()} notify={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("heading", { name: "Carousel 1" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RIDE_POLL_MS * 2);
    });
    // Neither a failed question nor another refusal is the ride gone.
    expect(screen.getByRole("heading", { name: "Carousel 1" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RIDE_POLL_MS);
    });
    expect(screen.getByText("This has been demolished.")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RIDE_POLL_MS * 5);
    });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("waits without a connection", () => {
    render(<RideInspector id={1} query={null} execute={vi.fn()} notify={vi.fn()} />);
    expect(screen.getByText("Finding the ride")).toBeTruthy();
  });
});

describe("formatRating and parseDollars", () => {
  it("shows a rating as 0.00 to 9.99", () => {
    expect(formatRating(0)).toBe("0.00");
    expect(formatRating(420)).toBe("4.20");
    expect(formatRating(999)).toBe("9.99");
  });

  it("reads dollars as cents, and nothing else", () => {
    expect(parseDollars("2")).toBe(200);
    expect(parseDollars("2.5")).toBe(250);
    expect(parseDollars("$0.05")).toBe(5);
    expect(parseDollars("12.")).toBe(1200);
    expect(parseDollars("1.234")).toBeNull();
    expect(parseDollars("-1")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("")).toBeNull();
  });
});
