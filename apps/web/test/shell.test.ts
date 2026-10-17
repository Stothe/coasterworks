import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLASSIC_VIEW_EVENT, onShellEvent } from "../src/host/shell";

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

/** What Tauri's `listen` hands to its callback. */
const fire = (callIndex = 0) => (listen.mock.calls[callIndex]?.[1] as (event: unknown) => void)({});

/** Lets the dynamic import and the `listen` promise settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  listen.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onShellEvent", () => {
  it("names the event the shell's View > Classic View sends", () => {
    expect(CLASSIC_VIEW_EVENT).toBe("coasterworks://classic-view");
  });

  it("does nothing in a plain browser, which has no Tauri to listen to", async () => {
    const handler = vi.fn();
    const stop = onShellEvent(CLASSIC_VIEW_EVENT, handler);
    await settle();
    expect(listen).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it("listens for the event under Tauri and calls the handler when it arrives", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    listen.mockResolvedValue(vi.fn());
    const handler = vi.fn();
    onShellEvent(CLASSIC_VIEW_EVENT, handler);
    await settle();
    expect(listen).toHaveBeenCalledWith(CLASSIC_VIEW_EVENT, expect.any(Function));
    expect(handler).not.toHaveBeenCalled();
    fire();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stops listening when asked to", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const stop = onShellEvent(CLASSIC_VIEW_EVENT, vi.fn());
    await settle();
    expect(unlisten).not.toHaveBeenCalled();
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("stops at once if asked to before the listener is in place", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const handler = vi.fn();
    const stop = onShellEvent(CLASSIC_VIEW_EVENT, handler);
    stop();
    await settle();
    expect(unlisten).toHaveBeenCalledTimes(1);
    if (listen.mock.calls.length > 0) fire();
    expect(handler).not.toHaveBeenCalled();
  });

  it("survives Tauri refusing the listener", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    listen.mockRejectedValue(new Error("not allowed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = onShellEvent(CLASSIC_VIEW_EVENT, vi.fn());
    await settle();
    expect(() => stop()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
