import type { SimClient } from "@coasterworks/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useParkStatus, type ParkStatus } from "../src/state/useParkStatus";

const park = (cash: number, over: Partial<ParkStatus> = {}): ParkStatus => ({
  name: "Queryland",
  tick: 0,
  date: "March 1, Year 1",
  year: 1,
  month: 0,
  day: 1,
  cash,
  monthStartCash: 1_000_000,
  loan: 0,
  guests: 0,
  rating: 0,
  width: 16,
  height: 16,
  ...over,
});

type Answer = { ok: true; result: ParkStatus } | { ok: false; error: string };
const query = vi.fn<(name: string, input: unknown) => Promise<Answer>>();
const client = { query } as unknown as SimClient;

beforeEach(() => {
  vi.useFakeTimers();
  query.mockResolvedValue({ ok: true, result: park(1_000_000) });
});
afterEach(() => {
  cleanup();
  query.mockReset();
  vi.useRealTimers();
});

/** Lets the promises the hook is waiting on settle. */
const settle = () => act(async () => {});
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("useParkStatus", () => {
  it("asks for park_status at once and returns the answer", async () => {
    const { result } = renderHook(() => useParkStatus(client, { active: true }));
    expect(result.current.status).toBeNull();
    await settle();
    expect(query).toHaveBeenCalledWith("park_status", {});
    expect(result.current.status?.cash).toBe(1_000_000);
    expect(result.current.status?.monthStartCash).toBe(1_000_000);
  });

  it("asks again every second while active, and not in between", async () => {
    const { result } = renderHook(() => useParkStatus(client, { active: true }));
    await settle();
    expect(query).toHaveBeenCalledTimes(1);
    await wait(999);
    expect(query).toHaveBeenCalledTimes(1);

    query.mockResolvedValue({ ok: true, result: park(950_000) });
    await wait(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.current.status?.cash).toBe(950_000);
    await wait(3000);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("does not ask at all while inactive, or without a client", async () => {
    const { rerender } = renderHook(({ client, active }) => useParkStatus(client, { active }), {
      initialProps: { client: client as SimClient | null, active: false },
    });
    await wait(5000);
    expect(query).not.toHaveBeenCalled();

    rerender({ client: null, active: true });
    await wait(5000);
    expect(query).not.toHaveBeenCalled();
  });

  it("stops asking when it goes inactive, and asks at once when it comes back", async () => {
    const { rerender } = renderHook(({ active }) => useParkStatus(client, { active }), {
      initialProps: { active: true },
    });
    await settle();
    await wait(1000);
    expect(query).toHaveBeenCalledTimes(2);

    rerender({ active: false });
    await wait(5000);
    expect(query).toHaveBeenCalledTimes(2);

    rerender({ active: true });
    await settle();
    expect(query).toHaveBeenCalledTimes(3);
    await wait(1000);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("clears its timer when the component goes", async () => {
    const { unmount } = renderHook(() => useParkStatus(client, { active: true }));
    await settle();
    unmount();
    await wait(5000);
    expect(query).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks once more when something happens, and starts the second over", async () => {
    const { result, rerender } = renderHook(
      ({ after }) => useParkStatus(client, { active: true, after }),
      { initialProps: { after: 4 } },
    );
    await settle();
    expect(query).toHaveBeenCalledTimes(1);

    await wait(600);
    query.mockResolvedValue({ ok: true, result: park(900_000) });
    rerender({ after: 5 });
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.current.status?.cash).toBe(900_000);

    // The interval began again with the event: nothing at 600 ms + 400 ms, the next at a second.
    await wait(999);
    expect(query).toHaveBeenCalledTimes(2);
    await wait(1);
    expect(query).toHaveBeenCalledTimes(3);

    // The same value again is not an event.
    rerender({ after: 5 });
    await settle();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("refresh() asks now, for a caller that has just changed the park", async () => {
    const { result } = renderHook(() => useParkStatus(client, { active: true }));
    await settle();
    query.mockResolvedValue({ ok: true, result: park(1_500_000, { loan: 500_000 }) });
    act(() => result.current.refresh());
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.current.status).toMatchObject({ cash: 1_500_000, loan: 500_000 });
  });

  it("keeps what it had when the sim refuses or the connection fails, and tries again", async () => {
    const { result } = renderHook(() => useParkStatus(client, { active: true }));
    await settle();

    query.mockResolvedValueOnce({ ok: false, error: "no" });
    await wait(1000);
    expect(result.current.status?.cash).toBe(1_000_000);

    query.mockRejectedValueOnce(new Error("closed"));
    await wait(1000);
    expect(result.current.status?.cash).toBe(1_000_000);

    query.mockResolvedValue({ ok: true, result: park(1_100_000) });
    await wait(1000);
    expect(result.current.status?.cash).toBe(1_100_000);
  });

  it("ignores an answer that is not a park status, such as another sim's shape", async () => {
    query.mockResolvedValue({ ok: true, result: [] as unknown as ParkStatus });
    const { result } = renderHook(() => useParkStatus(client, { active: true }));
    await settle();
    expect(result.current.status).toBeNull();

    query.mockResolvedValue({
      ok: true,
      result: { ...park(1), monthStartCash: undefined } as unknown as ParkStatus,
    });
    await wait(1000);
    expect(result.current.status).toBeNull();
  });

  it("does not let a slow old answer overwrite a newer one", async () => {
    let finishOld: (answer: Answer) => void = () => {};
    query.mockImplementationOnce(() => new Promise<Answer>((resolve) => (finishOld = resolve)));
    const { result } = renderHook(() => useParkStatus(client, { active: true }));
    // The first answer is still on its way when the next query goes out and comes back.
    query.mockResolvedValue({ ok: true, result: park(800_000) });
    await wait(1000);
    expect(result.current.status?.cash).toBe(800_000);

    await act(async () => finishOld({ ok: true, result: park(1_000_000) }));
    expect(result.current.status?.cash).toBe(800_000);
  });

  it("ignores an answer that arrives after the component has gone", async () => {
    let finish: (answer: Answer) => void = () => {};
    query.mockImplementationOnce(() => new Promise<Answer>((resolve) => (finish = resolve)));
    const { result, unmount } = renderHook(() => useParkStatus(client, { active: true }));
    unmount();
    await act(async () => finish({ ok: true, result: park(1) }));
    expect(result.current.status).toBeNull();
  });
});
