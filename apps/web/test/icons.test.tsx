import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ParkIcon,
  PathIcon,
  RideIcon,
  SceneryIcon,
  SelectIcon,
  ShopIcon,
  StaffIcon,
  TerrainIcon,
} from "../src/ui/icons";

afterEach(cleanup);

const icons = {
  TerrainIcon,
  PathIcon,
  RideIcon,
  SceneryIcon,
  ShopIcon,
  StaffIcon,
  ParkIcon,
  SelectIcon,
};

describe("icons", () => {
  for (const [name, Icon] of Object.entries(icons)) {
    it(`${name} is a 24 px line drawing in the text colour, hidden from assistive technology`, () => {
      const { container } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg?.getAttribute("width")).toBe("24");
      expect(svg?.getAttribute("height")).toBe("24");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg?.getAttribute("fill")).toBe("none");
      expect(svg?.getAttribute("stroke")).toBe("currentColor");
      expect(svg?.getAttribute("stroke-width")).toBe("1.75");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("focusable")).toBe("false");
      // Something is drawn.
      expect(svg?.children.length).toBeGreaterThan(0);
    });
  }

  it("draws each one differently", () => {
    const drawings = Object.values(icons).map((Icon) => {
      const { container, unmount } = render(<Icon />);
      const html = container.innerHTML;
      unmount();
      return html;
    });
    expect(new Set(drawings).size).toBe(drawings.length);
  });

  it("takes a class, for sizing and colour by the caller", () => {
    const { container } = render(<TerrainIcon className="text-accent" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toBe("text-accent");
  });
});
