import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PIXEL_RATIO_KEY, SHOW_FPS_KEY, settingsStore } from "../src/state/settings";
import { TopRight, type TopRightProps } from "../src/ui/TopRight";

beforeEach(() => {
  localStorage.clear();
  settingsStore.setState(settingsStore.getInitialState(), true);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  settingsStore.setState(settingsStore.getInitialState(), true);
});

function mount(over: Partial<TopRightProps> = {}) {
  const props: TopRightProps = {
    unread: 0,
    onOpenNotifications: vi.fn(),
    onOpenSearch: vi.fn(),
    ...over,
  };
  render(<TopRight {...props} />);
  return props;
}

describe("TopRight: the buttons", () => {
  it("has the Assistant, Notifications, search and Settings, in that order", () => {
    mount();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Assistant",
      "Notifications",
      "Open command bar",
      "Settings",
    ]);
  });

  it("names the cluster, so that a screen reader and a test can find it", () => {
    mount();
    const group = screen.getByRole("group", { name: "Quick actions" });
    expect(within(group).getAllByRole("button")).toHaveLength(4);
  });

  it("has an Assistant that is disabled, and says it is coming soon", async () => {
    mount();
    const assistant = screen.getByRole("button", { name: "Assistant" }) as HTMLButtonElement;
    expect(assistant.disabled).toBe(true);
    // A disabled button hears no pointer: the tooltip belongs to the span around it.
    fireEvent.pointerMove(assistant.parentElement as HTMLElement);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Coming soon");
  });

  it("opens the command bar from the search button", () => {
    const props = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open command bar" }));
    expect(props.onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it("turns search off while disabled, as when the connection is lost", () => {
    mount({ disabled: true });
    expect(
      (screen.getByRole("button", { name: "Open command bar" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Notifications" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("makes every button at least 32px", () => {
    mount();
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("hud-button");
      expect(button.className).toContain("min-w-8");
    }
  });
});

describe("TopRight: notifications", () => {
  it("shows no count with nothing unread", () => {
    mount({ unread: 0 });
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByTestId("unread-count")).toBeNull();
  });

  it("shows the unread count, and says it in the button's name", () => {
    mount({ unread: 3 });
    const bell = screen.getByRole("button", { name: "Notifications (3 unread)" });
    expect(within(bell).getByTestId("unread-count").textContent).toBe("3");
  });

  it("shows 9+ for more than nine", () => {
    mount({ unread: 14 });
    expect(screen.getByTestId("unread-count").textContent).toBe("9+");
    expect(screen.getByRole("button", { name: "Notifications (14 unread)" })).toBeTruthy();
  });

  it("opens the notifications when clicked", () => {
    const props = mount({ unread: 2 });
    fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
    expect(props.onOpenNotifications).toHaveBeenCalledTimes(1);
  });
});

describe("TopRight: settings", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const panel = () => screen.getByRole("dialog", { name: "Settings" });

  it("opens a small panel with the pixel ratio cap and Show FPS", () => {
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    const group = within(panel()).getByRole("group", { name: "Pixel ratio cap" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["1", "1.5", "2"]);
    expect(within(panel()).getByRole("checkbox", { name: "Show FPS" })).toBeTruthy();
  });

  it("starts at the cap of 2", () => {
    mount();
    open();
    expect(within(panel()).getByRole("button", { name: "2" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("stores the pixel ratio cap in localStorage when it is chosen", () => {
    mount();
    open();
    fireEvent.click(within(panel()).getByRole("button", { name: "1.5" }));
    expect(localStorage.getItem(PIXEL_RATIO_KEY)).toBe("1.5");
    expect(settingsStore.getState().pixelRatioCap).toBe(1.5);
    expect(within(panel()).getByRole("button", { name: "1.5" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(within(panel()).getByRole("button", { name: "1" }));
    expect(localStorage.getItem(PIXEL_RATIO_KEY)).toBe("1");
  });

  it("says the cap applies when the park is next loaded", () => {
    mount();
    open();
    expect(within(panel()).getByText(/next time the park loads/i)).toBeTruthy();
  });

  it("turns Show FPS on and off", () => {
    mount();
    open();
    const box = within(panel()).getByRole("checkbox", { name: "Show FPS" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(settingsStore.getState().showFps).toBe(true);
    expect(localStorage.getItem(SHOW_FPS_KEY)).toBe("true");
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(settingsStore.getState().showFps).toBe(false);
  });

  it("closes on Escape", () => {
    mount();
    open();
    act(() => {
      fireEvent.keyDown(panel(), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes when the Settings button is pressed again", () => {
    mount();
    open();
    open();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
