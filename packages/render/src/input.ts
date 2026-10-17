import type { CameraRig } from "./camera.js";

export interface PickedTile {
  x: number;
  y: number;
}

export interface ControlHandlers {
  /** A left click (or tap) on a tile, with the modifier keys held at release. */
  onTileClick(x: number, y: number, mods: { shift: boolean; alt: boolean }): void;
  /** The tile under the pointer after each pointer move, or `null` over nothing or off the canvas. */
  onHover(x: number | null, y: number | null): void;
  /** Maps a client-space point to a tile, normally `scene.pickAt`. */
  pick(clientX: number, clientY: number): PickedTile | null;
}

export interface ControlOptions {
  /** Where key presses are listened for. Defaults to `window`. */
  keyTarget?: Window;
}

/** Pointer travel in pixels past which a left press becomes a pan instead of a click. */
const DRAG_THRESHOLD = 4;
/** Radians of orbit per pixel of right-drag. */
const ORBIT_SPEED = 0.005;
/** Length of the q/e quarter-turn animation. */
const TURN_MS = 250;

type DragMode = "pan" | "orbit";

interface Drag {
  pointerId: number;
  mode: DragMode;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}

interface Turn {
  from: number;
  to: number;
  startedAt: number;
  /** The yaw the turn last set. A different one means something else moved the camera. */
  written: number;
}

const easeInOut = (k: number) => k * k * (3 - 2 * k);

/** True when the player has asked their system for less motion: the turn then snaps. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True when a key press is aimed at a text field, which keeps its keys. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

/**
 * Wires mouse, wheel and key input on `canvas` to the camera `rig` and the tile `handlers`.
 *
 * - Left click picks a tile; left drag past 4 px pans the view instead.
 * - Right drag (or ctrl + left drag, the Mac right click) orbits.
 * - The wheel zooms by `1.1 ** (deltaY / 100)`.
 * - `q` / `e` turn the view a quarter turn over 250 ms, or at once for a player whose system asks
 *   for reduced motion. The number keys and `Home` are not here: the app owns them (the dock
 *   tools, and the classic angles through `rig.setClassic`).
 *
 * A turn gives way to any other change to the rig's yaw, such as the app snapping to a classic
 * angle while it runs.
 *
 * Returns a function that removes every listener and stops any animation.
 */
export function attachControls(
  canvas: HTMLCanvasElement,
  rig: CameraRig,
  handlers: ControlHandlers,
  opts: ControlOptions = {},
): () => void {
  const keyTarget = opts.keyTarget ?? window;
  let drag: Drag | null = null;
  let turn: Turn | null = null;
  let frame = 0;

  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  const stopTurn = () => {
    turn = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const stepTurn = () => {
    frame = 0;
    if (!turn) return;
    if (rig.yaw !== turn.written) {
      // Something else turned the view (a snap to a classic angle): let it stand.
      turn = null;
      return;
    }
    const k = Math.min(1, Math.max(0, (performance.now() - turn.startedAt) / TURN_MS));
    rig.yaw = k >= 1 ? turn.to : turn.from + (turn.to - turn.from) * easeInOut(k);
    turn.written = rig.yaw;
    if (k >= 1) {
      turn = null;
    } else {
      frame = requestAnimationFrame(stepTurn);
    }
  };

  const startTurn = (delta: number) => {
    // A quarter turn pressed mid-turn continues from where the last one is headed.
    const base = turn ? turn.to : rig.yaw;
    if (prefersReducedMotion()) {
      // No turning to watch: the view is simply there.
      stopTurn();
      rig.yaw = base + delta;
      return;
    }
    if (frame) cancelAnimationFrame(frame);
    turn = { from: rig.yaw, to: base + delta, startedAt: performance.now(), written: rig.yaw };
    frame = requestAnimationFrame(stepTurn);
  };

  // Capture keeps a drag alive outside the canvas. It can throw for synthetic pointers and is
  // missing in some DOM implementations, and a drag works without it.
  const capture = (pointerId: number, on: boolean) => {
    try {
      if (on) canvas.setPointerCapture(pointerId);
      else if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    } catch {
      // Ignored: see above.
    }
  };

  const hover = (clientX: number, clientY: number) => {
    const tile = handlers.pick(clientX, clientY);
    handlers.onHover(tile ? tile.x : null, tile ? tile.y : null);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (drag) return;
    const orbit = e.button === 2 || (e.button === 0 && e.ctrlKey);
    if (!orbit && e.button !== 0) return;
    drag = {
      pointerId: e.pointerId,
      mode: orbit ? "orbit" : "pan",
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
    if (orbit) stopTurn();
    capture(e.pointerId, true);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!drag) {
      hover(e.clientX, e.clientY);
      return;
    }
    if (e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (drag.mode === "pan") {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= DRAG_THRESHOLD) return;
      }
      drag.moved = true;
      handlers.onHover(null, null);
    }
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    if (drag.mode === "orbit") {
      rig.orbit(-dx * ORBIT_SPEED, dy * ORBIT_SPEED);
    } else {
      // Dragging the ground: the view moves opposite to the pointer sideways, and "forward" when the pointer comes down.
      rig.pan(-dx, dy, canvas.clientHeight || 1);
    }
  };

  const endDrag = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const finished = drag;
    drag = null;
    capture(e.pointerId, false);
    if (cancelled || finished.moved || finished.mode !== "pan") return;
    const tile = handlers.pick(e.clientX, e.clientY);
    if (tile) handlers.onTileClick(tile.x, tile.y, { shift: e.shiftKey, alt: e.altKey });
  };
  const onPointerUp = (e: PointerEvent) => endDrag(e, false);
  const onPointerCancel = (e: PointerEvent) => endDrag(e, true);

  const onPointerLeave = () => {
    if (!drag) handlers.onHover(null, null);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Normalize line and page scrolling to pixels.
    const deltaY =
      e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    rig.zoom(1.1 ** (deltaY / 100));
  };

  // Right and ctrl + left drags orbit, so the browser's context menu must not open.
  const onContextMenu = (e: Event) => e.preventDefault();

  const onKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const key = e.key.toLowerCase();
    if (key !== "q" && key !== "e") return;
    if (!e.repeat) startTurn(key === "q" ? -Math.PI / 2 : Math.PI / 2);
    e.preventDefault();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  keyTarget.addEventListener("keydown", onKeyDown);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    keyTarget.removeEventListener("keydown", onKeyDown);
    stopTurn();
    drag = null;
    canvas.style.touchAction = previousTouchAction;
  };
}
