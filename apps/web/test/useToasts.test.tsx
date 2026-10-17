import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOASTS, TOAST_MS, useToasts } from "../src/state/useToasts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const texts = (toasts: ReadonlyArray<{ text: string }>) => toasts.map((toast) => toast.text);

describe("useToasts", () => {
  it("shows a message, and puts it away after three seconds", () => {
    const { result } = renderHook(() => useToasts());
    act(() => void result.current.push("Hello"));
    expect(texts(result.current.toasts)).toEqual(["Hello"]);
    expect(result.current.toasts[0]?.kind).toBe("info");
    act(() => vi.advanceTimersByTime(TOAST_MS - 1));
    expect(result.current.toasts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.toasts).toHaveLength(0);
  });

  it("keeps a sticky message until it is dismissed", () => {
    const { result } = renderHook(() => useToasts());
    let id = 0;
    act(() => {
      id = result.current.push("Stay", { sticky: true, kind: "error" });
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(texts(result.current.toasts)).toEqual(["Stay"]);
    act(() => result.current.dismiss(id));
    expect(result.current.toasts).toHaveLength(0);
  });

  it("keeps at most four messages up, and the oldest is the one dismissed", () => {
    const { result } = renderHook(() => useToasts());
    expect(MAX_TOASTS).toBe(4);
    act(() => {
      for (let n = 1; n <= 5; n++) result.current.push(`Error ${n}`, { kind: "error" });
    });
    expect(texts(result.current.toasts)).toEqual(["Error 2", "Error 3", "Error 4", "Error 5"]);
    act(() => void result.current.push("Error 6", { kind: "error" }));
    expect(texts(result.current.toasts)).toEqual(["Error 3", "Error 4", "Error 5", "Error 6"]);
  });

  it("dismisses the oldest even when it is sticky, and its timer does not take a newer one", () => {
    const { result } = renderHook(() => useToasts());
    act(() => {
      result.current.push("Old", { sticky: true });
      for (let n = 1; n <= 4; n++) result.current.push(`New ${n}`);
    });
    expect(texts(result.current.toasts)).toEqual(["New 1", "New 2", "New 3", "New 4"]);
    act(() => vi.advanceTimersByTime(TOAST_MS));
    expect(result.current.toasts).toHaveLength(0);
  });

  it("changes a message that is up, and gives it its three seconds again", () => {
    const { result } = renderHook(() => useToasts());
    let id = 0;
    const run = vi.fn();
    act(() => {
      id = result.current.push("Agent: Raise terrain");
    });
    act(() => vi.advanceTimersByTime(2000));
    let changed = false;
    act(() => {
      changed = result.current.update(id, {
        text: "Agent: 2 actions",
        action: { label: "Open the Timeline", run },
      });
    });
    expect(changed).toBe(true);
    expect(result.current.toasts[0]).toMatchObject({
      id,
      text: "Agent: 2 actions",
      action: { label: "Open the Timeline" },
    });
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.toasts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.toasts).toHaveLength(0);
  });

  it("drops the button of a message when it is updated without one", () => {
    const { result } = renderHook(() => useToasts());
    let id = 0;
    act(() => {
      id = result.current.push("A", { action: { label: "Go", run: () => {} } });
    });
    act(() => void result.current.update(id, { text: "B" }));
    expect(result.current.toasts[0]).toEqual({ id, text: "B", kind: "info" });
  });

  it("does not bring back a sticky message's timer when it is updated", () => {
    const { result } = renderHook(() => useToasts());
    let id = 0;
    act(() => {
      id = result.current.push("A", { sticky: true });
    });
    act(() => void result.current.update(id, { text: "B" }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(texts(result.current.toasts)).toEqual(["B"]);
  });

  it("says no to updating a message that is gone, and knows what is up", () => {
    const { result } = renderHook(() => useToasts());
    let id = 0;
    act(() => {
      id = result.current.push("A");
    });
    expect(result.current.has(id)).toBe(true);
    act(() => result.current.dismiss(id));
    expect(result.current.has(id)).toBe(false);
    let changed = true;
    act(() => {
      changed = result.current.update(id, { text: "B" });
    });
    expect(changed).toBe(false);
    expect(result.current.toasts).toHaveLength(0);
  });
});
