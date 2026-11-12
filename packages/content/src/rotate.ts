// Rotation helpers shared by the sim and the renderer. Integer math only.
//
// Convention (the same as the sim's tiles): x grows right (east), y grows down (south).
// A rotation `rot` is `rot` clockwise quarter turns: 0 none, 1 = 90 degrees clockwise,
// 2 = 180, 3 = 270 (90 counter-clockwise). Offsets are tile coordinates relative to the
// footprint's top-left at rotation 0 and may lie one tile outside the footprint.

export type Rot = 0 | 1 | 2 | 3;
export type Side = 0 | 1 | 2 | 3;

/** Footprint size after `rot` clockwise quarter turns: odd rotations swap width and height. */
export function rotatedFootprint(
  footprint: { w: number; h: number },
  rot: Rot,
): { w: number; h: number } {
  return rot % 2 === 0 ? { w: footprint.w, h: footprint.h } : { w: footprint.h, h: footprint.w };
}

/**
 * Carries an offset with its footprint through `rot` clockwise quarter turns. The result is
 * relative to the top-left of the rotated footprint (see `rotatedFootprint`). One quarter turn
 * maps (x, y) in a w-by-h footprint to (h - 1 - y, x) in the new h-by-w footprint.
 */
export function rotateOffset(
  offset: { x: number; y: number },
  footprint: { w: number; h: number },
  rot: Rot,
): { x: number; y: number } {
  const { x, y } = offset;
  const { w, h } = footprint;
  switch (rot) {
    case 0:
      return { x, y };
    case 1:
      return { x: h - 1 - y, y: x };
    case 2:
      return { x: w - 1 - x, y: h - 1 - y };
    case 3:
      return { x: y, y: w - 1 - x };
  }
}

/** Rotates a side (0 north, 1 east, 2 south, 3 west) clockwise by `rot` quarter turns. */
export function rotateSide(side: Side, rot: Rot): Side {
  return ((side + rot) % 4) as Side;
}
