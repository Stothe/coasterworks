import type { Speed } from "@coasterworks/protocol";

/** The play speeds, slowest first. Pause is not one of them. */
export const PLAY_SPEEDS = [1, 2, 4, 8] as const satisfies readonly Speed[];

/** True when a key press is aimed at a text field, which keeps its keys. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

/** True when a key press is aimed at a button, which Space presses. */
export function isButton(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && typeof el.tagName === "string" && el.tagName === "BUTTON";
}

/**
 * The speed one step faster (`direction` 1) or slower (-1) along 1x, 2x, 4x, 8x, stopping at the
 * ends. From a pause it steps from `resume`, the speed the pause interrupted.
 */
export function stepSpeed(current: Speed, resume: Speed, direction: 1 | -1): Speed {
  const from = current === 0 ? resume : current;
  const at = Math.max(
    0,
    PLAY_SPEEDS.findIndex((speed) => speed === from),
  );
  return PLAY_SPEEDS[Math.min(PLAY_SPEEDS.length - 1, Math.max(0, at + direction))] ?? 1;
}
