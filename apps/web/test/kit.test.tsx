import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState, Field, IconButton, Kbd, Panel, Segmented, Tabs } from "../src/ui/kit";

afterEach(cleanup);

describe("Panel", () => {
  it("is a region named by its title, with the actions beside it and the footer below", () => {
    render(
      <Panel title="Finances" actions={<button type="button">Close</button>} footer={<p>Footer</p>}>
        <p>Body</p>
      </Panel>,
    );
    const region = screen.getByRole("region", { name: "Finances" });
    expect(within(region).getByRole("heading", { name: "Finances" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(within(region).getByText("Body")).toBeTruthy();
    expect(within(region).getByText("Footer")).toBeTruthy();
    expect(region.className).toContain("glass");
  });

  it("has no header or footer when it has no title, actions or footer", () => {
    const { container } = render(
      <Panel className="extra">
        <p>Body</p>
      </Panel>,
    );
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector("footer")).toBeNull();
    expect(container.firstElementChild?.className).toContain("extra");
  });

  it("keeps a header for actions alone", () => {
    render(
      <Panel actions={<button type="button">Pin</button>}>
        <p>Body</p>
      </Panel>,
    );
    expect(screen.getByRole("button", { name: "Pin" })).toBeTruthy();
  });
});

describe("Tabs", () => {
  const tabs = [
    { id: "overview", label: "Overview", content: <p>Overview body</p> },
    { id: "finances", label: "Finances", content: <p>Finances body</p> },
  ];

  it("shows a tablist, the selected tab and only its panel", () => {
    render(<Tabs label="Park" tabs={tabs} value="finances" onValueChange={() => {}} />);
    expect(screen.getByRole("tablist", { name: "Park" })).toBeTruthy();
    const overview = screen.getByRole("tab", { name: "Overview" });
    const finances = screen.getByRole("tab", { name: "Finances" });
    expect(overview.getAttribute("aria-selected")).toBe("false");
    expect(finances.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Finances body");
    expect(screen.queryByText("Overview body")).toBeNull();
  });

  it("asks for the tab that was pressed", () => {
    const onValueChange = vi.fn();
    render(<Tabs tabs={tabs} value="finances" onValueChange={onValueChange} />);
    // Radix tabs activate on the press, not the click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Overview" }), { button: 0 });
    expect(onValueChange).toHaveBeenCalledWith("overview");
  });

  it("asks for the next tab on the arrow key", async () => {
    const onValueChange = vi.fn();
    render(<Tabs tabs={tabs} value="overview" onValueChange={onValueChange} />);
    const overview = screen.getByRole("tab", { name: "Overview" });
    act(() => overview.focus());
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    // Focus moves a moment later, and a focused tab is an activated one.
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("finances"));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Finances" }));
  });
});

describe("Segmented", () => {
  const options = [
    { id: "grass", label: "Grass", shortcut: "G" },
    { id: "sand", label: "Sand" },
  ];

  it("is a labelled group of buttons, one pressed", () => {
    render(<Segmented label="Surface" options={options} value="sand" onChange={() => {}} />);
    const group = screen.getByRole("group", { name: "Surface" });
    const grass = within(group).getByRole("button", { name: "Grass" });
    const sand = within(group).getByRole("button", { name: "Sand" });
    expect(grass.getAttribute("aria-pressed")).toBe("false");
    expect(sand.getAttribute("aria-pressed")).toBe("true");
  });

  it("moves the pressed state with the value", () => {
    const { rerender } = render(
      <Segmented label="Surface" options={options} value="sand" onChange={() => {}} />,
    );
    rerender(<Segmented label="Surface" options={options} value="grass" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Grass" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Sand" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("asks for the option that was clicked", () => {
    const onChange = vi.fn();
    render(<Segmented label="Surface" options={options} value="sand" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Grass" }));
    expect(onChange).toHaveBeenCalledWith("grass");
  });

  it("shows a shortcut as a hint without making it part of the name", () => {
    render(<Segmented label="Surface" options={options} value="sand" onChange={() => {}} />);
    const grass = screen.getByRole("button", { name: "Grass" });
    expect(within(grass).getByText("G").tagName).toBe("KBD");
    expect(grass.getAttribute("aria-keyshortcuts")).toBe("G");
    expect(
      screen.getByRole("button", { name: "Sand" }).getAttribute("aria-keyshortcuts"),
    ).toBeNull();
  });

  it("turns every option off when it is disabled", () => {
    const onChange = vi.fn();
    render(
      <Segmented label="Surface" options={options} value="sand" onChange={onChange} disabled />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "Grass" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is at least as big as a hit target", () => {
    render(<Segmented label="Surface" options={options} value="sand" onChange={() => {}} />);
    const sand = screen.getByRole("button", { name: "Sand" });
    expect(sand.className).toContain("hud-button");
  });
});

describe("IconButton", () => {
  it("is a button named by its label", () => {
    const onClick = vi.fn();
    render(<IconButton label="Undo" icon={<span aria-hidden="true">↶</span>} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Undo" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("type")).toBe("button");
  });

  it("is a hit target at least 32px wide and tall", () => {
    render(<IconButton label="Undo" icon="↶" onClick={() => {}} />);
    const { className } = screen.getByRole("button", { name: "Undo" });
    expect(className).toContain("hud-button");
    expect(className).toContain("min-w-8");
  });

  it("is a plain button, not a toggle, unless it is given a pressed state", () => {
    const { rerender } = render(<IconButton label="Grid" icon="#" onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBeNull();
    rerender(<IconButton label="Grid" icon="#" onClick={() => {}} pressed={false} />);
    expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBe("false");
    rerender(<IconButton label="Grid" icon="#" onClick={() => {}} pressed />);
    expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not click when disabled", () => {
    const onClick = vi.fn();
    render(<IconButton label="Redo" icon="↷" onClick={onClick} disabled />);
    const button = screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows its label in a tooltip when focused", async () => {
    render(<IconButton label="Undo" icon="↶" onClick={() => {}} />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("Undo");
  });

  it("shows the tooltip text it is given instead of its label", async () => {
    render(<IconButton label="Assistant" tooltip="Ask for help" icon="?" onClick={() => {}} />);
    act(() => screen.getByRole("button", { name: "Assistant" }).focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Ask for help");
  });

  it("shows a tooltip on a disabled button, from the span around it", async () => {
    render(
      <IconButton label="Assistant" tooltip="Coming soon" icon="?" onClick={() => {}} disabled />,
    );
    const button = screen.getByRole("button", { name: "Assistant" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The disabled button itself hears no pointer; its wrapper does.
    fireEvent.pointerMove(button.parentElement as HTMLElement);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Coming soon");
  });

  it("is not wrapped in a span unless it is disabled", () => {
    render(<IconButton label="Undo" tooltip="Undo it" icon="↶" onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Undo" }).parentElement?.tagName).toBe("DIV");
  });
});

describe("Field", () => {
  it("labels the control it wraps", () => {
    render(
      <Field label="Amount">
        <input type="number" />
      </Field>,
    );
    expect(screen.getByLabelText("Amount")).toBe(screen.getByRole("spinbutton"));
  });

  it("describes the control with its hint", () => {
    render(
      <Field label="Amount" hint="In dollars.">
        <input type="number" />
      </Field>,
    );
    const input = screen.getByLabelText("Amount");
    expect(screen.getByText("In dollars.")).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText("In dollars.").id);
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("announces the error and marks the control invalid", () => {
    render(
      <Field label="Amount" hint="In dollars." error="Too much.">
        <input type="number" />
      </Field>,
    );
    const input = screen.getByLabelText("Amount");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Too much.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toContain(alert.id);
    expect(described).toContain(screen.getByText("In dollars.").id);
  });

  it("keeps the id and description a control already has", () => {
    render(
      <>
        <p id="mine">Mine</p>
        <Field label="Name" hint="Hint.">
          <input id="given" aria-describedby="mine" />
        </Field>
      </>,
    );
    const input = screen.getByLabelText("Name");
    expect(input.id).toBe("given");
    expect((input.getAttribute("aria-describedby") ?? "").split(" ")).toContain("mine");
  });
});

describe("Kbd", () => {
  it("is a kbd element", () => {
    render(<Kbd>⌘K</Kbd>);
    expect(screen.getByText("⌘K").tagName).toBe("KBD");
  });
});

describe("EmptyState", () => {
  it("shows the title and the hint, and hides the icon from assistive technology", () => {
    render(<EmptyState title="No rides yet" hint="Rides arrive in a later release." icon="🎢" />);
    expect(screen.getByText("No rides yet")).toBeTruthy();
    expect(screen.getByText("Rides arrive in a later release.")).toBeTruthy();
    expect(screen.getByText("🎢").getAttribute("aria-hidden")).toBe("true");
  });

  it("works without an icon", () => {
    render(<EmptyState title="Nothing" hint="Try later." />);
    expect(screen.getByText("Nothing")).toBeTruthy();
    expect(screen.getByText("Try later.")).toBeTruthy();
  });
});
