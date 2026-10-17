/** The view is pulled back this many map-widths from the target, so a new park shows whole. */
export const FRAMING = 1.05;

/**
 * How far from the target the camera starts, so that the park shows whole: at least `current`,
 * and about `FRAMING` map-widths for the longer side, but never beyond the rig's `limits`
 * (`[nearest, farthest]`). A map too big to fit within the farthest zoom opens at that zoom.
 */
export function framingDistance(
  map: { width: number; height: number },
  current: number,
  limits: readonly [number, number],
): number {
  const wanted = Math.max(current, Math.max(map.width, map.height) * FRAMING);
  return Math.min(limits[1], Math.max(limits[0], wanted));
}
