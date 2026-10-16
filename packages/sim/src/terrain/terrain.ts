import { MAX_HEIGHT, type Rect, type Terrain } from "../world/types.js";

export type { Rect } from "../world/types.js";

function outside(what: string, t: Terrain, x: number, y: number): RangeError {
  return new RangeError(`${what} (${x}, ${y}) is outside the ${t.width}x${t.height} terrain`);
}

/** Flat index of corner (cx, cy). Corners form a (width + 1) by (height + 1) grid. */
export function cornerIndex(t: Terrain, cx: number, cy: number): number {
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0) {
    throw outside("Corner", t, cx, cy);
  }
  if (cx > t.width || cy > t.height) throw outside("Corner", t, cx, cy);
  return cy * (t.width + 1) + cx;
}

export function getCorner(t: Terrain, cx: number, cy: number): number {
  return t.corners[cornerIndex(t, cx, cy)] as number;
}

/** Sets a corner height, clamped to 0..MAX_HEIGHT. */
export function setCorner(t: Terrain, cx: number, cy: number, h: number): void {
  t.corners[cornerIndex(t, cx, cy)] = Math.min(MAX_HEIGHT, Math.max(0, h));
}

/** Whether the w by h tile footprint starting at tile (x, y) lies entirely on the map. */
export function inBounds(t: Terrain, x: number, y: number, w = 1, h = 1): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return false;
  return x >= 0 && y >= 0 && x + w <= t.width && y + h <= t.height;
}

/** Flat index of tile (x, y) into `surface` and `water`. */
export function tileIndex(t: Terrain, x: number, y: number): number {
  if (!inBounds(t, x, y)) throw outside("Tile", t, x, y);
  return y * t.width + x;
}

/** Heights of a tile's four corners, in the order NW, NE, SE, SW. */
export function tileCorners(t: Terrain, x: number, y: number): [number, number, number, number] {
  if (!inBounds(t, x, y)) throw outside("Tile", t, x, y);
  return [
    getCorner(t, x, y),
    getCorner(t, x + 1, y),
    getCorner(t, x + 1, y + 1),
    getCorner(t, x, y + 1),
  ];
}

/** The lowest of a tile's four corners. */
export function tileBase(t: Terrain, x: number, y: number): number {
  const [nw, ne, se, sw] = tileCorners(t, x, y);
  return Math.min(nw, ne, se, sw);
}

/**
 * Calls `fn(cx, cy, index)` for every corner of `rect`, row by row: (x..x+w) by (y..y+h),
 * inclusive, so a 2x2 rect visits 9 corners. Throws a RangeError if the rect is not on the map.
 */
export function forEachCornerInRect(
  t: Terrain,
  rect: Rect,
  fn: (cx: number, cy: number, index: number) => void,
): void {
  const { x, y, w, h } = rect;
  if (!inBounds(t, x, y, w, h)) {
    throw new RangeError(
      `Rect ${w}x${h} at (${x}, ${y}) is outside the ${t.width}x${t.height} terrain`,
    );
  }
  for (let cy = y; cy <= y + h; cy++) {
    for (let cx = x; cx <= x + w; cx++) {
      fn(cx, cy, cy * (t.width + 1) + cx);
    }
  }
}
