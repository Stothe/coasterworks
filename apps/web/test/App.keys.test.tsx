import type { Speed, SimClient } from "@coasterworks/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { useHost, type HostState } from "../src/state/useHost";

vi.mock("../src/state/useHost", () => ({ useHost: vi.fn() }));
// No WebGL in jsdom, and these tests are about the keys.
vi.mock("../src/viewport/Viewport", () => ({ Viewport: () => null }));

const setSpeed = vi.fn<(speed: Speed) => Promise<void>>();

function hostAt(speed: Speed, halted: boolean): HostState {
  return {
    status: "ready",
    snapshot: {
      header: {
        tick: 0,
        speed,
        halted,
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
    halted,
    ...(halted ? { haltMessage: "Simulation halted: boom" } : {}),
  };
}

beforeEach(() => {
  setSpeed.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  setSpeed.mockReset();
});

function press(key: string) {
  fireEvent.keyDown(window, { key });
}

describe("speed hotkeys", () => {
  it("pause, speed up and slow down", () => {
    vi.mocked(useHost).mockReturnValue(hostAt(4, false));
    render(<App />);
    press(" ");
    press("+");
    press("-");
    expect(setSpeed.mock.calls.map(([speed]) => speed)).toEqual([0, 8, 4]);
  });

  it("do nothing while the sim is halted, as the speed buttons do not", () => {
    vi.mocked(useHost).mockReturnValue(hostAt(0, true));
    render(<App />);
    press(" ");
    press("+");
    press("=");
    press("-");
    press("_");
    expect(setSpeed).not.toHaveBeenCalled();
  });

  it("work again once Resume has restarted the host", () => {
    vi.mocked(useHost).mockReturnValue(hostAt(0, true));
    const { rerender } = render(<App />);
    press(" ");
    expect(setSpeed).not.toHaveBeenCalled();

    // The real path: Resume asks the host for speed 1, and the host's next snapshot says that it
    // is running and no longer halted.
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(setSpeed.mock.calls).toEqual([[1]]);
    vi.mocked(useHost).mockReturnValue(hostAt(1, false));
    rerender(<App />);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();

    press(" ");
    expect(setSpeed.mock.calls).toEqual([[1], [0]]);
  });
});
