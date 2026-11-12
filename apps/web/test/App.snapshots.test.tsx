import type { SimClient } from "@coasterworks/protocol";
import { createDefaultRegistry } from "@coasterworks/sim";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { buildActions } from "../src/actions/registry";
import type { Action, ActionContext } from "../src/actions/types";
import { uiStore } from "../src/state/uiStore";
import { useHost, type HostState } from "../src/state/useHost";
import type { ViewportProps } from "../src/viewport/Viewport";
import { makeSource, type TestSource } from "./snapshotSource";

vi.mock("../src/state/useHost", () => ({ useHost: vi.fn() }));
// The registry is the real one; it only counts how often the actions are made.
vi.mock("../src/actions/registry", async (original) => {
  const registry = await original<typeof import("../src/actions/registry")>();
  return { ...registry, buildActions: vi.fn(registry.buildActions) };
});
// The parts that take the context are stand-ins that keep what they were given, and count renders.
const seen = vi.hoisted(() => ({
  bar: [] as Array<{ ctx: unknown; actions: unknown }>,
  tray: 0,
  inspector: 0,
  viewport: [] as number[],
  viewportProps: null as unknown,
}));
vi.mock("../src/ui/CommandBar", () => ({
  CommandBar: (props: { ctx: unknown; actions: unknown }) => {
    seen.bar.push({ ctx: props.ctx, actions: props.actions });
    return null;
  },
}));
vi.mock("../src/ui/Tray", () => ({
  Tray: () => {
    seen.tray++;
    return null;
  },
}));
vi.mock("../src/viewport/Viewport", () => ({
  Viewport: (props: { tick: number }) => {
    seen.viewport.push(props.tick);
    seen.viewportProps = props;
    return null;
  },
}));

const catalog = createDefaultRegistry().catalog();

type LiveHost = TestSource & Omit<HostState, "snapshot" | "subscribeSnapshot">;

/**
 * A host whose guests and park are read from its latest snapshot when asked for, as the hook's
 * are. With `snapshot` false it has had none yet.
 */
function liveHost(snapshot = true): LiveHost {
  const feed = makeSource(snapshot ? { cash: 1_000_000, monthStartCash: 1_000_000 } : null);
  const host: LiveHost = Object.assign(feed, {
    status: "ready" as const,
    name: "Queryland",
    terrain: null,
    paths: null,
    rides: null,
    getRideStatus: () => null,
    guests: null,
    park: null,
    events: [],
    client: {
      query: async () => ({ ok: true, result: catalog }),
      setSpeed: async () => {},
      command: async () => ({ ok: true, id: 1, cost: 0 }),
    } as unknown as SimClient,
    halted: false,
  });
  // Defined over the two above, not assigned: an assigned getter is read once and its value kept.
  return Object.defineProperties(host, {
    guests: { get: () => feed.snapshot?.guests ?? null },
    park: { get: () => feed.snapshot?.header.park ?? null },
  });
}

let source: LiveHost;
beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  source = liveHost();
  vi.mocked(useHost).mockReturnValue(source);
  vi.mocked(buildActions).mockClear();
  seen.bar = [];
  seen.tray = 0;
  seen.viewport = [];
  seen.viewportProps = null;
});
afterEach(() => {
  cleanup();
  uiStore.setState(uiStore.getInitialState(), true);
});

async function ready() {
  const view = render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

const cashPill = () => screen.getByRole("button", { name: /^Open finances/ });

describe("the app and the host's snapshots, 50 ms apart", () => {
  it("does not make the actions again, or the context they are given, for a snapshot", async () => {
    await ready();
    const made = vi.mocked(buildActions).mock.calls.length;
    const first = seen.bar.at(-1);
    expect(first?.ctx).not.toBeNull();

    for (let tick = 1; tick <= 20; tick++) {
      act(() => source.push({ tick: tick * 2 }));
    }
    const last = seen.bar.at(-1);
    expect(vi.mocked(buildActions).mock.calls.length).toBe(made);
    expect(last?.ctx).toBe(first?.ctx);
    expect(last?.actions).toBe(first?.actions);
  });

  it("renders neither the bar nor the tray for a snapshot that only moves time on", async () => {
    await ready();
    act(() => uiStore.getState().setTool("ride"));
    const renders = { bar: seen.bar.length, tray: seen.tray };
    for (let tick = 1; tick <= 20; tick++) {
      act(() => source.push({ tick: tick * 2 }));
    }
    expect(seen.bar.length).toBe(renders.bar);
    expect(seen.tray).toBe(renders.tray);
  });

  it("still shows the snapshot where it is shown: the pills, and the time of day of the view", async () => {
    await ready();
    expect(cashPill().textContent).toContain("$10,000.00");
    act(() => source.push({ cash: 1_064_000, tick: 40 }));
    expect(cashPill().textContent).toContain("$10,640.00");
    expect(screen.getByTestId("month-change").textContent).toBe("+$640.00");
    expect(seen.viewport.at(-1)).toBe(40);
  });

  it("gives the actions the latest snapshot through the context, though the context did not change", async () => {
    await ready();
    const ctx = seen.bar.at(-1)?.ctx as ActionContext;
    expect(ctx.snapshot?.header.cash).toBe(1_000_000);
    act(() => source.push({ cash: 900_000 }));
    expect(ctx.snapshot?.header.cash).toBe(900_000);
    expect(seen.bar.at(-1)?.ctx).toBe(ctx);
  });

  it("lets the view read the latest guests and entrance when it asks, with no render for a snapshot", async () => {
    await ready();
    const { getGuests, getEntrance } = seen.viewportProps as ViewportProps;
    expect(getGuests?.()).toBe(source.snapshot?.guests);
    expect(getEntrance?.()).toBeNull();

    const renders = seen.viewport.length;
    const park = source.snapshot?.header.park;
    if (!park) throw new Error("The test's host has no snapshot");
    act(() => source.push({ park: { ...park, entrance: { x: 3, y: 15, side: 2 } } }));
    // Every snapshot brings a section of its own, and the view is handed the new one.
    const section = getGuests?.();
    expect(section).toBe(source.snapshot?.guests);
    act(() => source.push({}));
    expect(getGuests?.()).not.toBe(section);
    expect(getGuests?.()).toBe(source.snapshot?.guests);
    expect(getEntrance?.()).toEqual({ x: 3, y: 15, side: 2 });
    expect(seen.viewport.length).toBe(renders);

    // A render of the app hands the view the same two readers, not new ones.
    act(() => uiStore.getState().setTool("ride"));
    const after = seen.viewportProps as ViewportProps;
    expect(after.getGuests).toBe(getGuests);
    expect(after.getEntrance).toBe(getEntrance);
  });

  it("has no guests and no entrance for the view before the first snapshot", async () => {
    source = liveHost(false);
    vi.mocked(useHost).mockReturnValue(source);
    await ready();
    const { getGuests, getEntrance } = seen.viewportProps as ViewportProps;
    expect(getGuests?.()).toBeNull();
    expect(getEntrance?.()).toBeUndefined();
  });

  it("makes the context again when what the actions read of the interface changes, and for a halt", async () => {
    await ready();
    const before = seen.bar.at(-1)?.ctx;
    act(() => uiStore.getState().setTool("ride"));
    const afterTool = seen.bar.at(-1)?.ctx as ActionContext;
    expect(afterTool).not.toBe(before);
    expect(afterTool.ui.tool).toBe("ride");
  });

  it("reads a halt from the host's state, and turns pause and the speeds off with it", async () => {
    const view = await ready();
    const pause = (): Action | undefined =>
      (seen.bar.at(-1)?.actions as Action[]).find((action) => action.id === "ui.pause");
    expect(pause()?.enabled?.(seen.bar.at(-1)?.ctx as ActionContext)).toBe(true);
    vi.mocked(useHost).mockReturnValue({ ...source, halted: true });
    // A halt is state, not a snapshot: the app is rendered again for it.
    await act(async () => {
      view.rerender(<App />);
    });
    expect(pause()?.enabled?.(seen.bar.at(-1)?.ctx as ActionContext)).toBe(false);
  });
});
