import type { EventMessage, LogEntryPublic, SimClient, Speed } from "@coasterworks/protocol";
import { createDefaultRegistry } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useImperativeHandle, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { settingsStore } from "../src/state/settings";
import { uiStore } from "../src/state/uiStore";
import { useHost, type HostState } from "../src/state/useHost";
import type { ViewportHandle } from "../src/viewport/Viewport";

vi.mock("../src/state/useHost", () => ({ useHost: vi.fn() }));
// No WebGL in jsdom. The viewport is a handle to the camera and nothing else.
const viewport = vi.hoisted(() => ({ focusTile: vi.fn() }));
vi.mock("../src/viewport/Viewport", () => ({
  Viewport: ({ ref }: { ref?: Ref<ViewportHandle> }) => {
    useImperativeHandle(ref, () => ({ focusTile: viewport.focusTile }));
    return null;
  },
}));

const catalog = createDefaultRegistry().catalog();
const query = vi.fn(async () => ({ ok: true, result: catalog }));

function event(id: number, over: Partial<LogEntryPublic> = {}): EventMessage {
  return {
    t: "event",
    kind: "log",
    entry: {
      id,
      tick: 0,
      client: "player",
      name: "terrain_raise",
      input: { x: 2, y: 3, w: 4, h: 5 },
      cost: 200,
      ...over,
    },
  };
}

function host(over: Partial<HostState> = {}): HostState {
  return {
    status: "ready",
    snapshot: {
      header: {
        tick: 0,
        speed: 1 as Speed,
        halted: false,
        cash: 1_000_000,
        loan: 0,
        monthStartCash: 1_000_000,
        date: "March 1, Year 1",
        terrainVersion: 0,
        hasTerrain: false,
        width: 16,
        height: 16,
      },
    },
    terrain: null,
    events: [],
    client: { query, setSpeed: vi.fn(), command: vi.fn() } as unknown as SimClient,
    halted: false,
    ...over,
  };
}

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  settingsStore.setState(settingsStore.getInitialState(), true);
  vi.mocked(useHost).mockReturnValue(host());
});
afterEach(() => {
  cleanup();
  viewport.focusTile.mockReset();
  query.mockClear();
  uiStore.setState(uiStore.getInitialState(), true);
});

const store = () => uiStore.getState();

/** Renders the app, with the sim's commands arrived. */
async function ready() {
  const view = render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

/** The host now reports `events`, as it does after each one arrives. */
async function hostSays(view: { rerender(ui: React.ReactNode): void }, over: Partial<HostState>) {
  vi.mocked(useHost).mockReturnValue(host(over));
  await act(async () => {
    view.rerender(<App />);
  });
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const count = () => screen.queryByTestId("unread-count")?.textContent ?? null;
const inspector = () => screen.queryByRole("complementary", { name: "Inspector" });
const AGENT_RECT_2 = event(7, { client: "agent", input: { x: 5, y: 6, w: 2, h: 2 } });

describe("the bell", () => {
  it("has no count at first", async () => {
    await ready();
    expect(count()).toBeNull();
  });

  it("counts an event from an agent, and not one from the player", async () => {
    const view = await ready();
    await hostSays(view, { events: [event(1, { client: "player" })] });
    expect(count()).toBeNull();
    await hostSays(view, { events: [event(1), event(2, { client: "agent" })] });
    expect(count()).toBe("1");
    await hostSays(view, {
      events: [event(1), event(2, { client: "agent" }), event(3, { client: "agent" })],
    });
    expect(count()).toBe("2");
  });

  it("does not count the same agent event again when the host repeats it", async () => {
    const view = await ready();
    const agent = event(2, { client: "agent" });
    await hostSays(view, { events: [agent] });
    await hostSays(view, { events: [{ ...agent, entry: { ...agent.entry, cost: 1 } }] });
    expect(count()).toBe("1");
  });

  it("does not count an error the host reports: the Timeline never lists one", async () => {
    const view = await ready();
    await hostSays(view, { error: "Something broke" });
    expect(count()).toBeNull();
    // It is told as a message all the same.
    expect(screen.getByRole("alert").textContent).toContain("Something broke");
    // And an agent's command beside it is still the only thing the bell counts.
    await hostSays(view, { error: "Something broke", events: [event(1, { client: "agent" })] });
    expect(count()).toBe("1");
  });

  it("does not count what was in the log when the page joined, however many agent commands", async () => {
    vi.mocked(useHost).mockReturnValue(
      host({
        events: [
          event(1, { client: "agent" }),
          event(2, { client: "agent" }),
          event(3, { client: "player" }),
        ],
        historyThrough: 3,
      }),
    );
    const view = await ready();
    expect(count()).toBeNull();
    // What comes after it is news.
    await hostSays(view, {
      events: [
        event(1, { client: "agent" }),
        event(2, { client: "agent" }),
        event(3),
        event(4, { client: "agent" }),
      ],
      historyThrough: 3,
    });
    expect(count()).toBe("1");
  });

  it("opens the inspector on the Timeline, with the park selected, and clears the count", async () => {
    const view = await ready();
    act(() => store().inspectTile(3, 3));
    await hostSays(view, { events: [event(1, { client: "agent" })] });
    expect(count()).toBe("1");

    fireEvent.click(bell());
    expect(store().inspector).toEqual({ open: true, tab: "timeline" });
    expect(store().selection).toEqual({ kind: "park" });
    expect(count()).toBeNull();
    const panel = inspector() as HTMLElement;
    expect(within(panel).getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await within(panel).findByText("Raise terrain")).toBeTruthy();
    expect(within(panel).getByText("Agent")).toBeTruthy();
  });

  it("counts again from zero after it was opened", async () => {
    const view = await ready();
    await hostSays(view, { events: [event(1, { client: "agent" })] });
    fireEvent.click(bell());
    expect(count()).toBeNull();
    await hostSays(view, {
      events: [event(1, { client: "agent" }), event(2, { client: "agent" })],
    });
    expect(count()).toBe("1");
  });
});

describe("the timeline tab", () => {
  it("lists what happened, newest first, with who did it", async () => {
    const view = await ready();
    await hostSays(view, {
      events: [
        event(1, { name: "terrain_lower" }),
        event(2, { name: "terrain_raise", client: "agent" }),
      ],
    });
    fireEvent.click(bell());
    const panel = inspector() as HTMLElement;
    const items = await within(panel).findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Raise terrain"),
      expect.stringContaining("Lower terrain"),
    ]);
    expect(within(items[0] as HTMLElement).getByText("Agent")).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText("You")).toBeTruthy();
  });

  it("says nothing has happened in a new park", async () => {
    await ready();
    act(() => store().openInspector("timeline"));
    expect(await screen.findByText("Nothing has happened yet.")).toBeTruthy();
  });

  it("lists what was in the log before the page joined, and marks what an undo took back", async () => {
    vi.mocked(useHost).mockReturnValue(
      host({
        events: [
          event(1, { name: "terrain_raise" }),
          event(2, { name: "terrain_lower", client: "agent" }),
          event(3, { name: "undo", input: { target: 2 }, cost: -200 }),
        ],
        historyThrough: 3,
      }),
    );
    await ready();
    act(() => store().openInspector("timeline"));
    const items = within(inspector() as HTMLElement).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-undone"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(items[0]?.textContent).toContain("Undid Lower terrain");
    expect(items[1]?.textContent).toContain("Lower terrain");
  });

  it("focuses the camera on the area of the entry that is clicked", async () => {
    const view = await ready();
    await hostSays(view, { events: [event(1, { input: { x: 7, y: 8, w: 2, h: 3 } })] });
    fireEvent.click(bell());
    fireEvent.click(await screen.findByRole("button", { name: /Raise terrain/ }));
    expect(viewport.focusTile).toHaveBeenCalledWith(7, 8, 2, 3);
  });
});

describe("the toast of an agent's command", () => {
  const AGENT_RECT = event(1, { client: "agent", input: { x: 5, y: 6, w: 2, h: 2 } });

  it("jumps to the area it changed when clicked, and is gone", async () => {
    const view = await ready();
    await hostSays(view, { events: [AGENT_RECT] });
    const toast = screen.getByRole("button", { name: /^Agent: Raise terrain/ });
    expect(toast.textContent).toContain("Agent: Raise terrain");
    fireEvent.click(toast);
    expect(viewport.focusTile).toHaveBeenCalledWith(5, 6, 2, 2);
    expect(screen.queryByRole("button", { name: /^Agent: Raise terrain/ })).toBeNull();
  });

  it("has an accessible name that holds the words it shows", async () => {
    const view = await ready();
    await hostSays(view, { events: [AGENT_RECT] });
    const toast = screen.getByRole("button", { name: /Agent: Raise terrain/ });
    const name = toast.getAttribute("aria-label") ?? "";
    expect(name).toContain(toast.textContent ?? "never");
    expect(name).toContain("Agent:");
  });

  it("opens the Timeline when the command has no area to go to", async () => {
    const view = await ready();
    await hostSays(view, {
      events: [event(1, { client: "agent", name: "finance_take_loan", input: { amount: 100 } })],
    });
    const toast = screen.getByRole("button", { name: /^Agent: Take loan/ });
    expect(toast.textContent).toBe("Agent: Take loan");
    fireEvent.click(toast);
    expect(store().inspector).toEqual({ open: true, tab: "timeline" });
    expect(store().selection).toEqual({ kind: "park" });
    expect(viewport.focusTile).not.toHaveBeenCalled();
  });

  it("is not shown for the player's own commands", async () => {
    const view = await ready();
    await hostSays(view, { events: [event(1, { client: "player" })] });
    expect(screen.queryByText(/^Agent:/)).toBeNull();
  });

  it("is not shown for what was in the log when the page joined", async () => {
    vi.mocked(useHost).mockReturnValue(
      host({
        events: [event(1, { client: "agent" }), event(2, { client: "agent" })],
        historyThrough: 2,
      }),
    );
    await ready();
    expect(screen.queryByText(/^Agent:/)).toBeNull();
  });

  it("leaves an error plain", async () => {
    const view = await ready();
    await hostSays(view, { error: "Something broke" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Something broke");
    // Its only button is the one that dismisses it.
    expect(
      within(alert)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Dismiss"]);
  });

  describe("a burst of commands", () => {
    const burst = (count: number, first = 1) =>
      Array.from({ length: count }, (_, i) =>
        event(first + i, { client: "agent", input: { x: i, y: i, w: 1, h: 1 } }),
      );
    const agentToasts = () => screen.queryAllByText(/^Agent:/);

    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 }));
    afterEach(() => vi.useRealTimers());

    it("is one message that counts them: 6 agent events within a second are Agent: 6 actions", async () => {
      const view = await ready();
      await hostSays(view, { events: burst(6) });
      expect(agentToasts().map((toast) => toast.textContent)).toEqual(["Agent: 6 actions"]);
    });

    it("counts them up as they arrive, in the one message, and not past the second", async () => {
      const view = await ready();
      for (let n = 1; n <= 6; n++) {
        vi.setSystemTime(1_000_000 + n * 100);
        await hostSays(view, { events: burst(n) });
      }
      expect(agentToasts().map((toast) => toast.textContent)).toEqual(["Agent: 6 actions"]);

      // A second after the first, the next command begins another message.
      vi.setSystemTime(1_000_000 + 1100);
      await hostSays(view, { events: burst(7) });
      expect(agentToasts().map((toast) => toast.textContent)).toEqual([
        "Agent: 6 actions",
        "Agent: Raise terrain",
      ]);
    });

    it("opens the Timeline when pressed, and jumps to the area when there is only the one", async () => {
      const view = await ready();
      await hostSays(view, { events: burst(6) });
      fireEvent.click(screen.getByRole("button", { name: /^Agent: 6 actions/ }));
      expect(store().inspector).toEqual({ open: true, tab: "timeline" });
      expect(viewport.focusTile).not.toHaveBeenCalled();

      vi.setSystemTime(1_000_000 + 5000);
      await hostSays(view, { events: [...burst(6), AGENT_RECT_2] });
      fireEvent.click(screen.getByRole("button", { name: /^Agent: Raise terrain/ }));
      expect(viewport.focusTile).toHaveBeenCalledWith(5, 6, 2, 2);
    });

    it("counts only the agent's: the player's commands in the burst are not told", async () => {
      const view = await ready();
      await hostSays(view, {
        events: [event(1, { client: "agent" }), event(2), event(3, { client: "agent" })],
      });
      expect(agentToasts().map((toast) => toast.textContent)).toEqual(["Agent: 2 actions"]);
    });

    it("keeps at most four messages up, the oldest dismissed", async () => {
      const view = await ready();
      for (let n = 1; n <= 5; n++) {
        await hostSays(view, { error: `Failure ${n}` });
      }
      expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
        "Failure 2✕",
        "Failure 3✕",
        "Failure 4✕",
        "Failure 5✕",
      ]);
    });
  });
});

describe("the keyboard map", () => {
  const press = (key: string) => fireEvent.keyDown(window, { key });
  const overlay = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });

  it("opens with ?, lists the command bar, and closes with Escape", async () => {
    await ready();
    expect(overlay()).toBeNull();
    press("?");
    expect(within(overlay() as HTMLElement).getByText("Command bar")).toBeTruthy();
    press("Escape");
    expect(overlay()).toBeNull();
  });

  it("closes with ? a second time, and with a click outside", async () => {
    await ready();
    press("?");
    expect(overlay()).not.toBeNull();
    press("?");
    expect(overlay()).toBeNull();
    press("?");
    fireEvent.click(screen.getByTestId("help-backdrop"));
    expect(overlay()).toBeNull();
  });

  it("leaves the tool in hand when Escape closes it", async () => {
    await ready();
    act(() => store().setTool("terrain"));
    press("?");
    press("Escape");
    expect(store().tool).toBe("terrain");
    expect(store().placement).not.toBeNull();
  });
});
