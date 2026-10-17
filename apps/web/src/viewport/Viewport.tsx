import type { SimClient } from "@coasterworks/protocol";
import {
  attachControls,
  createScene,
  type SceneHandle,
  type TerrainData,
} from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { CLASSIC_VIEW_EVENT, onShellEvent } from "../host/shell";
import { settingsStore, useSettings } from "../state/settings";
import { uiStore, useUiStore } from "../state/uiStore";
import { brushRect, planPlacement, timeOfDay } from "./brush";
import { classicCycle, onClassicViewRequest } from "./classicView";
import { framingDistance } from "./framing";

/** What the app can ask of the view. */
export interface ViewportHandle {
  /**
   * Moves the camera over the area of `w` by `h` tiles at (`x`, `y`): its target goes to the center
   * of the area, kept on the map. The distance, yaw and pitch stay as they are, and the target's
   * height follows the ground there.
   */
  focusTile(x: number, y: number, w: number, h: number): void;
}

export interface ViewportProps {
  terrain: TerrainData | null;
  /** The sim tick, which sets the time of day. */
  tick: number;
  client: SimClient | null;
  /** Called with the outcome of every command a click sent, including one that could not be sent. */
  onResult(result: ExecResult): void;
  /**
   * Called when the player right-clicks a tile: a right press released without dragging, which
   * would otherwise have turned the view. `point` is where, in window coordinates, for a menu.
   */
  onSecondaryClick?(
    tile: { x: number; y: number },
    point: { clientX: number; clientY: number },
  ): void;
  /** Filled with the view's handle while the view is up. */
  ref?: Ref<ViewportHandle>;
}

/** How often the frame rate is worked out, in milliseconds. */
const FPS_SAMPLE_MS = 500;

/** Pointer travel in pixels past which a right press is an orbit and no longer a click. */
const CLICK_SLOP = 4;

/** A scene and whether it has been given terrain yet. */
interface Live {
  scene: SceneHandle;
  hasTerrain: boolean;
}

function show(live: Live, terrain: TerrainData | null): void {
  if (!terrain) return;
  if (live.hasTerrain) {
    live.scene.updateTerrain(terrain);
    return;
  }
  live.scene.setTerrain(terrain);
  live.hasTerrain = true;
  // `setTerrain` centers the target; pull back far enough to see the park, within the zoom limits.
  const { rig } = live.scene;
  rig.distance = framingDistance(terrain, rig.distance, rig.limits.distance);
}

function failure(error: unknown): ExecResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * The 3D view of the park, and the pointer input that edits it. What a click does is the
 * placement in the UI store, which the dock's trays and the command bar start: with none in
 * hand it does nothing but, under the Select tool, select the tile for the inspector. Nothing is
 * outlined under the pointer without a placement.
 */
export function Viewport(props: ViewportProps) {
  const placement = useUiStore((state) => state.placement);
  const showFps = useSettings((state) => state.showFps);
  const [fps, setFps] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const outlineRef = useRef<(() => void) | null>(null);
  // The scene outlives renders, so its handlers read the current props through this.
  const latest = useRef({ ...props, placement, showFps });
  useEffect(() => {
    latest.current = { ...props, placement, showFps };
  });

  useImperativeHandle(
    props.ref,
    () => ({
      focusTile(x, y, w, h) {
        const scene = live.current?.scene;
        if (!scene) return;
        const { rig } = scene;
        rig.target.x = x + w / 2;
        rig.target.z = y + h / 2;
        // The area may reach past the edge; the target stays over the map. Its height is left to the
        // rig, which settles it onto the ground under it on the next frame.
        const { terrain } = latest.current;
        if (terrain) rig.clampTarget(terrain.width, terrain.height);
      },
    }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Read when the scene is made: a change to the cap applies the next time the park loads.
    const scene = createScene(canvas, { pixelRatioCap: settingsStore.getState().pixelRatioCap });
    const mine: Live = { scene, hasTerrain: false };
    live.current = mine;
    show(mine, latest.current.terrain);
    scene.setTimeOfDay(timeOfDay(latest.current.tick));

    const outline = () => {
      const { terrain, placement } = latest.current;
      const at = hover.current;
      const rect =
        at && terrain && placement
          ? brushRect(at.x, at.y, placement.size, terrain.width, terrain.height)
          : null;
      if (rect) scene.highlightTile(rect.x, rect.y, rect.w, rect.h);
      else scene.highlightTile(null);
    };
    outlineRef.current = outline;

    const detach = attachControls(canvas, scene.rig, {
      pick: (clientX, clientY) => scene.pickAt(clientX, clientY),
      onHover: (x, y) => {
        hover.current = x === null || y === null ? null : { x, y };
        outline();
      },
      onTileClick: (x, y, mods) => {
        const { client, terrain, placement, onResult } = latest.current;
        if (!terrain) return;
        if (!placement) {
          // Nothing in hand but the pointer: a click looks at the tile.
          if (uiStore.getState().tool === "select") uiStore.getState().inspectTile(x, y);
          return;
        }
        if (!client) return;
        const plan = planPlacement(placement, mods, x, y, terrain);
        if (!plan) return;
        client
          .command(plan.name, plan.input)
          .then(onResult, (error: unknown) => onResult(failure(error)));
      },
    });

    // A right press (or ctrl + press, the Mac's) turns the view if it moves. If it does not, it was
    // a click: it is told to the app, whose menu opens at the pointer. The controls above have
    // already taken the press, and the browser's own menu is cancelled there.
    let press: { id: number; x: number; y: number; moved: boolean } | null = null;
    const onPressDown = (e: PointerEvent) => {
      const secondary = e.button === 2 || (e.button === 0 && e.ctrlKey);
      press = secondary ? { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false } : null;
    };
    const onPressMove = (e: PointerEvent) => {
      if (press?.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP) press.moved = true;
    };
    const onPressUp = (e: PointerEvent) => {
      const mine = press;
      press = null;
      if (!mine || mine.moved || mine.id !== e.pointerId) return;
      const tile = scene.pickAt(e.clientX, e.clientY);
      if (tile) latest.current.onSecondaryClick?.(tile, { clientX: e.clientX, clientY: e.clientY });
    };
    const onPressCancel = () => {
      press = null;
    };
    canvas.addEventListener("pointerdown", onPressDown);
    canvas.addEventListener("pointermove", onPressMove);
    canvas.addEventListener("pointerup", onPressUp);
    canvas.addEventListener("pointercancel", onPressCancel);

    // Home, the Classic view action and the desktop app's View > Classic View menu item all go to
    // the next of RCT's four angles.
    const goClassic = classicCycle(scene.rig);
    const stopShell = onShellEvent(CLASSIC_VIEW_EVENT, goClassic);
    const stopRequest = onClassicViewRequest(goClassic);

    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);

    // The frame rate is counted over half a second, and only while it is shown.
    let counted = 0;
    let since: number | undefined;
    let frame = requestAnimationFrame(function draw(now) {
      scene.render();
      if (latest.current.showFps) {
        since ??= now;
        counted++;
        if (now - since >= FPS_SAMPLE_MS) {
          setFps(Math.round((counted * 1000) / (now - since)));
          counted = 0;
          since = now;
        }
      } else {
        counted = 0;
        since = undefined;
      }
      frame = requestAnimationFrame(draw);
    });

    return () => {
      cancelAnimationFrame(frame);
      stopShell();
      stopRequest();
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPressDown);
      canvas.removeEventListener("pointermove", onPressMove);
      canvas.removeEventListener("pointerup", onPressUp);
      canvas.removeEventListener("pointercancel", onPressCancel);
      detach();
      scene.dispose();
      live.current = null;
      outlineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (live.current) show(live.current, props.terrain);
  }, [props.terrain]);

  useEffect(() => {
    live.current?.scene.setTimeOfDay(timeOfDay(props.tick));
  }, [props.tick]);

  // The outline is the brush, so it changes with the placement even if the pointer does not move:
  // a bigger brush grows it, and putting the placement down (Esc) takes it away.
  useEffect(() => {
    outlineRef.current?.();
  }, [placement]);

  // A counter that is turned off and on again starts from nothing, not from the last number.
  useEffect(() => {
    if (!showFps) setFps(null);
  }, [showFps]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-label="Park view"
        className="absolute inset-0 block h-full w-full touch-none"
      />
      {showFps && (
        // A readout for the player's eye: not announced, and it never takes the pointer.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-3.5 left-3.5 rounded-md bg-black/50 px-2 py-0.5 text-[11px] tabular-nums text-muted"
        >
          {fps ?? "…"} FPS
        </div>
      )}
    </>
  );
}
