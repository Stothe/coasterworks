/** What the page sends itself to ask the view to go to the next classic angle. */
export const CLASSIC_VIEW_REQUEST = "coasterworks:classic-view";

/** The four classic angles of RCT, as `CameraRig.setClassic` numbers them. */
export type ClassicAngle = 0 | 1 | 2 | 3;

/** The part of the camera rig the cycle uses. */
export interface ClassicRig {
  yaw: number;
  setClassic(index: ClassicAngle): void;
}

/**
 * Makes the function that snaps `rig` to a classic angle, a different one each time it is called:
 * the first, then the second, and so on round the four. It remembers the angle it set and the yaw
 * that gave, so if the player has turned the view since (by hand, or with `q` and `e`) the next
 * call starts again at the first. It follows the yaw and not the pitch, which the rig adjusts
 * itself to clear the hills.
 */
export function classicCycle(rig: ClassicRig): () => void {
  let last: { index: ClassicAngle; yaw: number } | null = null;
  return () => {
    const unmoved = last !== null && rig.yaw === last.yaw;
    const index = (last !== null && unmoved ? (last.index + 1) % 4 : 0) as ClassicAngle;
    rig.setClassic(index);
    last = { index, yaw: rig.yaw };
  };
}

/** Asks the view to go to the next classic angle (the Home key and the Classic view action). */
export function requestClassicView(): void {
  window.dispatchEvent(new Event(CLASSIC_VIEW_REQUEST));
}

/** Calls `handler` whenever the view is asked to go classic. Returns the function that stops it. */
export function onClassicViewRequest(handler: () => void): () => void {
  window.addEventListener(CLASSIC_VIEW_REQUEST, handler);
  return () => window.removeEventListener(CLASSIC_VIEW_REQUEST, handler);
}
