import { describe, expect, it } from "vitest";
import {
  MAX_HEIGHT,
  cornerIndex,
  createWorld,
  forEachCornerInRect,
  getCorner,
  inBounds,
  setCorner,
  tileBase,
  tileCorners,
  tileIndex,
} from "../src/index.js";

function flat(width = 8, height = 8) {
  return createWorld({ width, height, seed: 1, name: "t" }).terrain;
}

describe("corner access", () => {
  it("indexes corners row-major over a (w+1) x (h+1) grid", () => {
    const t = flat(8, 8);
    expect(cornerIndex(t, 0, 0)).toBe(0);
    expect(cornerIndex(t, 8, 0)).toBe(8);
    expect(cornerIndex(t, 0, 1)).toBe(9);
    expect(cornerIndex(t, 8, 8)).toBe(80);
  });

  it("reads and writes a corner", () => {
    const t = flat();
    setCorner(t, 3, 4, 17);
    expect(getCorner(t, 3, 4)).toBe(17);
    expect(t.corners[cornerIndex(t, 3, 4)]).toBe(17);
    expect(getCorner(t, 4, 3)).toBe(8);
  });

  it("throws rather than aliasing a corner into the next row", () => {
    const t = flat(8, 8);
    expect(() => cornerIndex(t, 9, 0)).toThrow(RangeError);
    expect(() => cornerIndex(t, 0, 9)).toThrow(RangeError);
    expect(() => cornerIndex(t, -1, 0)).toThrow(RangeError);
    expect(() => cornerIndex(t, 0.5, 0)).toThrow(RangeError);
    expect(() => getCorner(t, 9, 0)).toThrow(RangeError);
    expect(() => setCorner(t, 0, 9, 1)).toThrow(RangeError);
    expect(t.corners.every((c) => c === 8)).toBe(true);
  });

  it("clamps heights to 0..MAX_HEIGHT", () => {
    const t = flat();
    setCorner(t, 1, 1, 200);
    expect(getCorner(t, 1, 1)).toBe(MAX_HEIGHT);
    expect(MAX_HEIGHT).toBe(63);
    setCorner(t, 1, 1, -5);
    expect(getCorner(t, 1, 1)).toBe(0);
    setCorner(t, 1, 1, 63);
    expect(getCorner(t, 1, 1)).toBe(63);
  });
});

describe("tiles", () => {
  it("indexes tiles row-major over w x h", () => {
    const t = flat(8, 8);
    expect(tileIndex(t, 0, 0)).toBe(0);
    expect(tileIndex(t, 7, 0)).toBe(7);
    expect(tileIndex(t, 0, 1)).toBe(8);
    expect(tileIndex(t, 7, 7)).toBe(63);
  });

  it("throws for a tile that is not on the map", () => {
    const t = flat(8, 8);
    expect(() => tileIndex(t, 8, 0)).toThrow(RangeError);
    expect(() => tileCorners(t, 0, 8)).toThrow(RangeError);
    expect(() => tileBase(t, -1, 0)).toThrow(RangeError);
  });

  it("orders tile corners NW, NE, SE, SW", () => {
    const t = flat();
    setCorner(t, 1, 1, 20);
    // Corner (1,1) is the SE corner of tile (0,0), SW of (1,0), NW of (1,1), NE of (0,1).
    expect(tileCorners(t, 0, 0)).toEqual([8, 8, 20, 8]);
    expect(tileCorners(t, 1, 0)).toEqual([8, 8, 8, 20]);
    expect(tileCorners(t, 1, 1)).toEqual([20, 8, 8, 8]);
    expect(tileCorners(t, 0, 1)).toEqual([8, 20, 8, 8]);
  });

  it("reports the lowest corner as the tile base", () => {
    const t = flat();
    setCorner(t, 1, 1, 20);
    setCorner(t, 0, 0, 5);
    expect(tileBase(t, 0, 0)).toBe(5);
    expect(tileBase(t, 1, 1)).toBe(8);
    expect(tileBase(t, 5, 5)).toBe(8);
  });
});

describe("inBounds", () => {
  it("accepts every tile of the map and rejects the ring around it", () => {
    const t = flat(8, 8);
    expect(inBounds(t, 0, 0)).toBe(true);
    expect(inBounds(t, 7, 7)).toBe(true);
    expect(inBounds(t, 8, 0)).toBe(false);
    expect(inBounds(t, 0, 8)).toBe(false);
    expect(inBounds(t, -1, 0)).toBe(false);
    expect(inBounds(t, 0, -1)).toBe(false);
  });

  it("checks the whole footprint", () => {
    const t = flat(8, 8);
    expect(inBounds(t, 7, 7, 2, 1)).toBe(false);
    expect(inBounds(t, 7, 7, 1, 2)).toBe(false);
    expect(inBounds(t, 6, 7, 2, 1)).toBe(true);
    expect(inBounds(t, 0, 0, 8, 8)).toBe(true);
    expect(inBounds(t, 0, 0, 9, 8)).toBe(false);
  });

  it("works on non-square maps", () => {
    const t = flat(3, 5);
    expect(inBounds(t, 2, 4)).toBe(true);
    expect(inBounds(t, 3, 4)).toBe(false);
    expect(inBounds(t, 2, 5)).toBe(false);
  });

  it("rejects non-integer coordinates and empty footprints", () => {
    const t = flat();
    expect(inBounds(t, 0.5, 0)).toBe(false);
    expect(inBounds(t, 0, 0, 0, 1)).toBe(false);
    expect(inBounds(t, 0, 0, 1, 0)).toBe(false);
  });
});

describe("forEachCornerInRect", () => {
  it("visits (w+1)*(h+1) corners, row-major", () => {
    const t = flat();
    const seen: [number, number][] = [];
    forEachCornerInRect(t, { x: 0, y: 0, w: 2, h: 2 }, (cx, cy) => seen.push([cx, cy]));
    expect(seen).toHaveLength(9);
    expect(seen).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it("starts at the rect origin and passes the corner's flat index", () => {
    const t = flat();
    const seen: [number, number, number][] = [];
    forEachCornerInRect(t, { x: 7, y: 7, w: 1, h: 1 }, (cx, cy, i) => seen.push([cx, cy, i]));
    expect(seen).toEqual([
      [7, 7, cornerIndex(t, 7, 7)],
      [8, 7, cornerIndex(t, 8, 7)],
      [7, 8, cornerIndex(t, 7, 8)],
      [8, 8, cornerIndex(t, 8, 8)],
    ]);
  });

  it("can raise a whole rect through setCorner", () => {
    const t = flat();
    forEachCornerInRect(t, { x: 2, y: 2, w: 2, h: 2 }, (cx, cy) => setCorner(t, cx, cy, 12));
    expect(getCorner(t, 2, 2)).toBe(12);
    expect(getCorner(t, 4, 4)).toBe(12);
    expect(getCorner(t, 5, 4)).toBe(8);
  });

  it("throws instead of touching corners outside the map", () => {
    const t = flat(8, 8);
    const seen: number[] = [];
    const visit = (_cx: number, _cy: number, i: number) => seen.push(i);
    expect(() => forEachCornerInRect(t, { x: 7, y: 7, w: 2, h: 1 }, visit)).toThrow(RangeError);
    expect(() => forEachCornerInRect(t, { x: -1, y: 0, w: 1, h: 1 }, visit)).toThrow(RangeError);
    expect(() => forEachCornerInRect(t, { x: 0, y: 0, w: 0, h: 1 }, visit)).toThrow(RangeError);
    expect(seen).toEqual([]);
  });

  it("accepts a rect that covers the whole map", () => {
    const t = flat(8, 8);
    let count = 0;
    forEachCornerInRect(t, { x: 0, y: 0, w: 8, h: 8 }, () => count++);
    expect(count).toBe(81);
  });
});
