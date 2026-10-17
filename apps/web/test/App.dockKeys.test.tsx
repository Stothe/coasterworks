import type { SimClient, Speed } from "@coasterworks/protocol";
import type { SceneHandle } from "@coasterworks/render";
import { createDefaultRegistry } from "@coasterworks/sim";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { DOCK_TOOLS } from "../src/actions/types";
import { uiStore } from "../src/state/uiStore";
import { useHost, type HostState } from "../src/state/useHost";

vi.mock("../src/state/useHost", () => ({ useHost: vi.fn() }));

// Unlike the other App tests, this one mounts the real Viewport, and with it the real
// `attachControls`, which listens for keys on the window too. Only the WebGL scene is a stub, and
// the desktop shell's event is captured instead of listened for.
const stage = vi.hoisted(() => ({
  scene: null as SceneHandle | null,
  shell: [] as Array<() => void>,
}));
vi.mock("@coasterworks/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@coasterworks/render")>();
  return {
    ...actual,
    createScene: (): SceneHandle => {
      const scene: SceneHandle = {
        rig: new actual.CameraRig(),
        setTerrain() {},
        updateTerrain() {},
        setTimeOfDay() {},
        render() {},
        resize() {},
        pickAt: () => null,
        highlightTile() {},
        dispose() {},
      };
      stage.scene = scene;
      return scene;
    },
  };
});
vi.mock("../src/host/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/host/shell")>()),
  onShellEvent: (_name: string, handler: () => void) => {
    stage.shell.push(handler);
    return () => {};
  },
}));

const catalog = createDefaultRegistry().catalog();

function host(): HostState {
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
    client: {
      query: async () => ({ ok: true, result: catalog }),
      setSpeed: async () => {},
    } as unknown as SimClient,
    halted: false,
  };
}

beforeEach(() => {
  uiStore.setState(uiStore.getInitialState(), true);
  stage.scene = null;
  stage.shell = [];
  vi.mocked(useHost).mockReturnValue(host());
});
afterEach(() => {
  cleanup();
  uiStore.setState(uiStore.getInitialState(), true);
});

/** Renders the app with its real viewport and gives the camera rig its scene made. */
async function mount() {
  render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const scene = stage.scene;
  if (!scene) throw new Error("The viewport did not make a scene");
  return scene.rig;
}

/** Presses a key where a real one lands, on the page, and says whether anything took it. */
const press = (key: string, mods: KeyboardEventInit = {}) =>
  !fireEvent.keyDown(document.body, { key, ...mods });

describe("the keys with the real viewport", () => {
  it("1 to 7 choose the dock tools, once, and leave the camera where it is", async () => {
    const rig = await mount();
    const setClassic = vi.spyOn(rig, "setClassic");
    const yaw = rig.yaw;
    DOCK_TOOLS.forEach((tool, index) => {
      expect(press(String(index + 1)), tool).toBe(true);
      expect(uiStore.getState().tool).toBe(tool);
    });
    expect(setClassic).not.toHaveBeenCalled();
    expect(rig.yaw).toBe(yaw);
  });

  it("Home goes round the four classic angles, one a press and each once", async () => {
    const rig = await mount();
    const setClassic = vi.spyOn(rig, "setClassic");
    for (const angle of [0, 1, 2, 3, 0, 1]) {
      expect(press("Home")).toBe(true);
      expect(setClassic).toHaveBeenLastCalledWith(angle);
      expect(rig.yaw).toBeCloseTo(Math.PI / 4 + (angle * Math.PI) / 2, 10);
    }
    expect(setClassic).toHaveBeenCalledTimes(6);
  });

  it("the Classic view action and the desktop menu item step the same cycle as Home", async () => {
    const rig = await mount();
    const setClassic = vi.spyOn(rig, "setClassic");
    press("Home");
    expect(stage.shell).toHaveLength(1);
    act(() => stage.shell[0]?.());
    press("Home");
    expect(setClassic.mock.calls.map(([angle]) => angle)).toEqual([0, 1, 2]);

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByPlaceholderText("Type a command…"), {
      target: { value: "classic view" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Classic view/ }));
    expect(setClassic.mock.calls.map(([angle]) => angle)).toEqual([0, 1, 2, 3]);
  });

  it("leaves q and e to the viewport, which takes them", async () => {
    const rig = await mount();
    // With Terrain in hand, so that a key which took another tool would show.
    press("1");
    const yaw = rig.yaw;
    expect(press("e")).toBe(true);
    expect(rig.yaw).toBe(yaw);
    expect(uiStore.getState().tool).toBe("terrain");
  });
});
