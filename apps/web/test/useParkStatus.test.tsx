import type { SimClient } from "@coasterworks/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_DEBOUNCE_MS,
  PARK_STATUS_MS,
  useParkStatus,
  type ParkStatus,
} from "../src/state/useParkStatus";

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

  it("clears its timers when the component goes, the wait after an event too", async () => {
    const { rerender, unmount } = renderHook(
      ({ after }) => useParkStatus(client, { active: true, after }),
      { initialProps: { after: 1 } },
    );
    await settle();
    rerender({ after: 2 });
    // The interval, and the wait that the event began.
    expect(vi.getTimerCount()).toBe(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await wait(5000);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not ask for an event once it has gone inactive", async () => {
    const { rerender } = renderHook(
      ({ active, after }) => useParkStatus(client, { active, after }),
      { initialProps: { active: true, after: 1 } },
    );
    await settle();
    rerender({ active: true, after: 2 });
    rerender({ active: false, after: 2 });
    expect(vi.getTimerCount()).toBe(0);
    await wait(5000);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not ask for an event that came while it was inactive, but asks at once when it is back", async () => {
    const { rerender } = renderHook(
      ({ active, after }) => useParkStatus(client, { active, after }),
      { initialProps: { active: false, after: 1 } },
    );
    rerender({ active: false, after: 2 });
    await wait(1000);
    expect(query).not.toHaveBeenCalled();
    rerender({ active: true, after: 2 });
    await settle();
    expect(query).toHaveBeenCalledTimes(1);
    // That event is already answered by the question that came with being active.
    await wait(EVENT_DEBOUNCE_MS + 50);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("asks once more a moment after something happens, not at that instant", async () => {
    const { result, rerender } = renderHook(
      ({ after }) => useParkStatus(client, { active: true, after }),
      { initialProps: { after: 4 } },
    );
    await settle();
    expect(query).toHaveBeenCalledTimes(1);

    await wait(300);
    query.mockResolvedValue({ ok: true, result: park(900_000) });
    rerender({ after: 5 });
    await settle();
    expect(query).toHaveBeenCalledTimes(1);
    await wait(EVENT_DEBOUNCE_MS - 1);
    expect(query).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.current.status?.cash).toBe(900_000);

    // The second keeps its own beat: the interval began when the panel did, and the event did
    // not move it.
    await wait(PARK_STATUS_MS - 300 - EVENT_DEBOUNCE_MS - 1);
    expect(query).toHaveBeenCalledTimes(2);
    await wait(1);
    expect(query).toHaveBeenCalledTimes(3);

    // The same value again is not an event.
    rerender({ after: 5 });
    await wait(EVENT_DEBOUNCE_MS * 2);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("answers a burst of events with one question once it has paused, and shows the answer", async () => {
    const { result, rerender } = renderHook(
      ({ after }) => useParkStatus(client, { active: true, after }),
      { initialProps: { after: 0 } },
    );
    await settle();
    expect(query).toHaveBeenCalledTimes(1);
    query.mockResolvedValue({ ok: true, result: park(640_000) });

    // Ten events in 45 ms, each a new id.
    for (let id = 1; id <= 10; id++) {
      rerender({ after: id });
      await wait(5);
    }
    // Nothing has gone out while the burst lasted, nor a moment after ...
    expect(query).toHaveBeenCalledTimes(1);
    await wait(EVENT_DEBOUNCE_MS - 6);
    expect(query).toHaveBeenCalledTimes(1);
    // ... and exactly one goes out once it has paused for the whole wait.
    await wait(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.current.status?.cash).toBe(640_000);
    await wait(EVENT_DEBOUNCE_MS * 3);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps waiting while events keep coming, so a long burst is still one question", async () => {
    const { rerender } = renderHook(({ after }) => useParkStatus(client, { active: true, after }), {
      initialProps: { after: 0 },
    });
    await settle();
    // An event every 150 ms, which is inside the wait each time: 600 ms of them.
    for (let id = 1; id <= 4; id++) {
      await wait(150);
      rerender({ after: id });
    }
    expect(query).toHaveBeenCalledTimes(1);
    await wait(EVENT_DEBOUNCE_MS);
    expect(query).toHaveBeenCalledTimes(2);
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

  it("has one question out at a time, and the one that comes back is shown, not thrown away", async () => {
    let finishFirst: (answer: Answer) => void = () => {};
    let finishSecond: (answer: Answer) => void = () => {};
    query
      .mockImplementationOnce(() => new Promise<Answer>((resolve) => (finishFirst = resolve)))
      .mockImplementationOnce(() => new Promise<Answer>((resolve) => (finishSecond = resolve)));
    const { result } = renderHook(() => useParkStatus(client, { active: true }));
    expect(query).toHaveBeenCalledTimes(1);

    // The second's beat comes while the first is still out: it waits, it is not sent as well.
    await wait(PARK_STATUS_MS);
    expect(query).toHaveBeenCalledTimes(1);

    // The first comes back and is shown; the question that was wanted meanwhile goes out.
    await act(async () => finishFirst({ ok: true, result: park(800_000) }));
    expect(result.current.status?.cash).toBe(800_000);
    expect(query).toHaveBeenCalledTimes(2);

    await act(async () => finishSecond({ ok: true, result: park(700_000) }));
    expect(result.current.status?.cash).toBe(700_000);
  });

  it("makes any number of questions wanted while one is out into one more", async () => {
    let finish: (answer: Answer) => void = () => {};
    query.mockImplementationOnce(() => new Promise<Answer>((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useParkStatus(client, { active: true }));
    for (let i = 0; i < 6; i++) act(() => result.current.refresh());
    expect(query).toHaveBeenCalledTimes(1);

    query.mockResolvedValue({ ok: true, result: park(555_000) });
    await act(async () => finish({ ok: true, result: park(800_000) }));
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.current.status?.cash).toBe(555_000);
    // And nothing more is owed.
    await wait(PARK_STATUS_MS - 1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("goes on after a question that failed while others were wanted", async () => {
    let fail: (error: Error) => void = () => {};
    query.mockImplementationOnce(() => new Promise<Answer>((_, reject) => (fail = reject)));
    const { result } = renderHook(() => useParkStatus(client, { active: true }));
    act(() => result.current.refresh());
    expect(query).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error("closed")));
    // The wanted one went out, and the one after that is not blocked.
    expect(query).toHaveBeenCalledTimes(2);
    await wait(PARK_STATUS_MS);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("asks nothing more after the component has gone, even for a question that was wanted", async () => {
    let finish: (answer: Answer) => void = () => {};
    query.mockImplementationOnce(() => new Promise<Answer>((resolve) => (finish = resolve)));
    const { result, unmount } = renderHook(() => useParkStatus(client, { active: true }));
    act(() => result.current.refresh());
    expect(query).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => finish({ ok: true, result: park(1) }));
    await wait(5000);
    // The one that was wanted is not sent for nobody, and the interval is gone.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("starts clean for another client, whatever the old one's question is doing", async () => {
    // The first client's question never comes back, as when its connection has gone.
    query.mockImplementationOnce(() => new Promise<Answer>(() => {}));
    const other = vi.fn<(name: string, input: unknown) => Promise<Answer>>(async () => ({
      ok: true,
      result: park(123_000),
    }));
    const { result, rerender } = renderHook(
      ({ client }) => useParkStatus(client, { active: true }),
      { initialProps: { client } },
    );
    rerender({ client: { query: other } as unknown as SimClient });
    await settle();
    expect(other).toHaveBeenCalledTimes(1);
    expect(result.current.status?.cash).toBe(123_000);
  });
});
