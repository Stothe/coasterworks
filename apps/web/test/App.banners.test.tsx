import type { SimClient, Speed } from "@coasterworks/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { useHost, type HostState } from "../src/state/useHost";

vi.mock("../src/state/useHost", () => ({ useHost: vi.fn() }));
// No WebGL in jsdom, and these tests are about what the page says.
vi.mock("../src/viewport/Viewport", () => ({ Viewport: () => null }));

const setSpeed = vi.fn<(speed: Speed) => Promise<void>>();

function host(over: Partial<HostState> = {}): HostState {
  return {
    status: "ready",
    snapshot: {
      header: {
        tick: 0,
        speed: 1,
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
    client: { setSpeed } as unknown as SimClient,
    halted: false,
    ...over,
  };
}

const halted = (over: Partial<HostState> = {}) =>
  host({
    halted: true,
    error: "Simulation halted: boom",
    haltMessage: "Simulation halted: boom",
    ...over,
  });

const disconnected = () =>
  host({ status: "disconnected", client: null, error: "WebSocket closed (code 1006)" });

const LOST = "Lost the connection to the park. Restart Coasterworks.";

beforeEach(() => {
  setSpeed.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  setSpeed.mockReset();
});

function speedButtons(): HTMLButtonElement[] {
  const group = screen.getByRole("group", { name: "Game speed" });
  return within(group).getAllByRole("button");
}

describe("a running park", () => {
  it("shows no banner, and nothing is disabled", () => {
    vi.mocked(useHost).mockReturnValue(host());
    render(<App />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(speedButtons().every((button) => !button.disabled)).toBe(true);
    expect((screen.getByRole("button", { name: /Raise/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("a halted simulation", () => {
  it("shows a banner with the reason, and no toast for it", () => {
    vi.mocked(useHost).mockReturnValue(halted());
    render(<App />);
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Simulation halted: boom");
  });

  it("says only that it halted when the reason has not arrived", () => {
    vi.mocked(useHost).mockReturnValue(host({ halted: true }));
    render(<App />);
    expect(screen.getByRole("alert").textContent).toContain("Simulation halted");
    expect(screen.getByRole("alert").textContent).not.toContain("boom");
  });

  it("keeps the speed buttons disabled, and leaves the tools alone", () => {
    vi.mocked(useHost).mockReturnValue(halted());
    render(<App />);
    expect(speedButtons().every((button) => button.disabled)).toBe(true);
    expect((screen.getByRole("button", { name: /Raise/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("Resume asks the host for speed 1", () => {
    vi.mocked(useHost).mockReturnValue(halted());
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(setSpeed.mock.calls).toEqual([[1]]);
  });

  it("tells the player when Resume fails", async () => {
    setSpeed.mockRejectedValue(new Error("Connection closed"));
    vi.mocked(useHost).mockReturnValue(halted());
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText("Connection closed")).toBeTruthy();
    // The banner is still up.
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("goes away when the host reports it is running again", () => {
    vi.mocked(useHost).mockReturnValue(halted());
    const { rerender } = render(<App />);
    expect(screen.getByRole("alert")).toBeTruthy();
    vi.mocked(useHost).mockReturnValue(host());
    rerender(<App />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(speedButtons().every((button) => !button.disabled)).toBe(true);
  });
});

describe("a lost connection", () => {
  it("shows a banner that says to restart, with no Resume", () => {
    vi.mocked(useHost).mockReturnValue(disconnected());
    render(<App />);
    expect(screen.getByRole("alert").textContent).toBe(LOST);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("disables the speed buttons and the tools", () => {
    vi.mocked(useHost).mockReturnValue(disconnected());
    render(<App />);
    expect(speedButtons().every((button) => button.disabled)).toBe(true);
    const tools = screen.getByRole("toolbar", { name: "Terrain tools" });
    const buttons = within(tools).getAllByRole("button") as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("shows only the connection banner, even if the sim had halted before", () => {
    vi.mocked(useHost).mockReturnValue({ ...disconnected(), halted: true });
    render(<App />);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe(LOST);
  });

  it("makes the hotkeys do nothing", () => {
    vi.mocked(useHost).mockReturnValue(disconnected());
    render(<App />);
    for (const key of [" ", "+", "-", "r", "l"]) fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(setSpeed).not.toHaveBeenCalled();
  });

  it("does not cover the park with the starting-up message", () => {
    vi.mocked(useHost).mockReturnValue(disconnected());
    render(<App />);
    expect(screen.queryByText(/Starting the park/)).toBeNull();
    expect(screen.queryByText(/Could not connect/)).toBeNull();
  });

  it("does not repeat the reason as a toast", () => {
    vi.mocked(useHost).mockReturnValue(disconnected());
    render(<App />);
    expect(screen.queryByText("WebSocket closed (code 1006)")).toBeNull();
  });
});
