import type { SimClient } from "@coasterworks/protocol";
import {
  attachControls,
  createScene,
  type SceneHandle,
  type TerrainData,
} from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { useEffect, useRef } from "react";
import { CLASSIC_VIEW_EVENT, onShellEvent } from "../host/shell";
import { brushRect, planCommand, timeOfDay, type BrushSize, type TerrainToolId } from "./brush";
import { framingDistance } from "./framing";

export interface ViewportProps {
  terrain: TerrainData | null;
  /** The sim tick, which sets the time of day. */
  tick: number;
  client: SimClient | null;
  tool: TerrainToolId;
  brush: BrushSize;
  /** Called with the outcome of every command a click sent, including one that could not be sent. */
  onResult(result: ExecResult): void;
}

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

/** The 3D view of the park, and the pointer input that edits it. */
export function Viewport(props: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const outlineRef = useRef<(() => void) | null>(null);
  // The scene outlives renders, so its handlers read the current props through this.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = createScene(canvas);
    const mine: Live = { scene, hasTerrain: false };
    live.current = mine;
    show(mine, latest.current.terrain);
    scene.setTimeOfDay(timeOfDay(latest.current.tick));

    const outline = () => {
      const { terrain, brush } = latest.current;
      const at = hover.current;
      const rect =
        at && terrain ? brushRect(at.x, at.y, brush, terrain.width, terrain.height) : null;
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
        const { client, terrain, tool, brush, onResult } = latest.current;
        if (!client || !terrain) return;
        const plan = planCommand(tool, mods, x, y, brush, terrain);
        if (!plan) return;
        client
          .command(plan.name, plan.input)
          .then(onResult, (error: unknown) => onResult(failure(error)));
      },
    });

    // The desktop app's View > Classic View menu item: back to the first of RCT's four angles.
    const stopShell = onShellEvent(CLASSIC_VIEW_EVENT, () => scene.rig.setClassic(0));

    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);

    let frame = requestAnimationFrame(function draw() {
      scene.render();
      frame = requestAnimationFrame(draw);
    });

    return () => {
      cancelAnimationFrame(frame);
      stopShell();
      observer.disconnect();
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

  // The outline is the brush, so it changes with the brush even if the pointer does not move.
  useEffect(() => {
    outlineRef.current?.();
  }, [props.brush, props.tool]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Park view"
      className="absolute inset-0 block h-full w-full touch-none"
    />
  );
}
