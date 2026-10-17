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
const query = vi.fn(async (name: string) =>
  name === "park_status"
    ? {
        ok: true,
        result: {
          name: "Queryland",
          tick: 0,
          date: "March 1, Year 1",
          year: 1,
          month: 0,
          day: 1,
          cash: 1_000_000,
          monthStartCash: 1_000_000,
          loan: 0,
          guests: 0,
          rating: 0,
          width: 16,
          height: 16,
        },
      }
    : { ok: true, result: catalog },
);

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

  it("counts an error the host reports", async () => {
    const view = await ready();
    await hostSays(view, { error: "Something broke" });
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
    const toast = screen.getByRole("button", { name: "Jump to Raise terrain" });
    expect(toast.textContent).toContain("Agent: Raise terrain");
    fireEvent.click(toast);
    expect(viewport.focusTile).toHaveBeenCalledWith(5, 6, 2, 2);
    expect(screen.queryByRole("button", { name: "Jump to Raise terrain" })).toBeNull();
  });

  it("is plain text when the command has no area", async () => {
    const view = await ready();
    await hostSays(view, {
      events: [event(1, { client: "agent", name: "finance_take_loan", input: { amount: 100 } })],
    });
    expect(screen.getByText("Agent: Take loan")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Jump to/ })).toBeNull();
  });

  it("is not shown for the player's own commands", async () => {
    const view = await ready();
    await hostSays(view, { events: [event(1, { client: "player" })] });
    expect(screen.queryByText(/^Agent:/)).toBeNull();
  });

  it("leaves an error plain", async () => {
    const view = await ready();
    await hostSays(view, { error: "Something broke" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Something broke");
    expect(within(alert).queryByRole("button", { name: /^Jump to/ })).toBeNull();
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
    press("?");
    press("Escape");
    expect(store().tool).toBe("terrain");
    expect(store().placement).not.toBeNull();
  });
});
