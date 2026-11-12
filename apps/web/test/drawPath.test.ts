import { describe, expect, it } from "vitest";
import { PathStroke, skippedMessage, tilesBetween } from "../src/viewport/drawPath";

const adjacent = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;

describe("tilesBetween", () => {
  it("is nothing for the same tile", () => {
    expect(tilesBetween({ x: 3, y: 3 }, { x: 3, y: 3 })).toEqual([]);
  });

  it("runs straight along a row or a column, the end included and the start not", () => {
    expect(tilesBetween({ x: 1, y: 2 }, { x: 4, y: 2 })).toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ]);
    expect(tilesBetween({ x: 1, y: 2 }, { x: 1, y: 0 })).toEqual([
      { x: 1, y: 1 },
      { x: 1, y: 0 },
    ]);
  });

  it("joins a slant edge to edge, never across a corner, and ends on the tile", () => {
    for (const to of [
      { x: 5, y: 3 },
      { x: -4, y: 7 },
      { x: 2, y: -6 },
      { x: 1, y: 1 },
    ]) {
      const from = { x: 0, y: 0 };
      const run = tilesBetween(from, to);
      expect(run.length).toBe(Math.abs(to.x) + Math.abs(to.y));
      expect(run.at(-1)).toEqual(to);
      let previous = from;
      for (const tile of run) {
        expect(adjacent(previous, tile)).toBe(true);
        previous = tile;
      }
    }
  });

  it("keeps close to the straight line", () => {
    const run = tilesBetween({ x: 0, y: 0 }, { x: 6, y: 3 });
    for (const tile of run) expect(Math.abs(tile.y - tile.x / 2)).toBeLessThanOrEqual(1);
  });
});

describe("PathStroke", () => {
  it("gives each tile once, the ones skipped over included", () => {
    const stroke = new PathStroke({ x: 2, y: 2 });
    expect(stroke.first()).toEqual({ x: 2, y: 2 });
    expect(stroke.extend({ x: 2, y: 2 })).toEqual([]);
    expect(stroke.extend({ x: 4, y: 2 })).toEqual([
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ]);
    // Going back over the stroke adds nothing.
    expect(stroke.extend({ x: 2, y: 2 })).toEqual([]);
    expect(stroke.extend({ x: 2, y: 3 })).toEqual([{ x: 2, y: 3 }]);
  });
});

describe("skippedMessage", () => {
  it("is null when nothing was refused", () => {
    expect(skippedMessage([])).toBeNull();
  });

  it("counts the tiles and names each reason once, most common first", () => {
    expect(skippedMessage(["Cannot build on water"])).toBe("1 tile skipped: Cannot build on water");
    expect(
      skippedMessage([
        "Too steep",
        "Cannot build on water",
        "Cannot build on water",
        "Cannot build on water",
      ]),
    ).toBe("4 tiles skipped: Cannot build on water; Too steep");
  });
});
