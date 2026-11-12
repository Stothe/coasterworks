import type { GuestSection, ParkPublic, SimClient } from "@coasterworks/protocol";
import {
  attachControls,
  createScene,
  type SceneHandle,
  type TerrainData,
} from "@coasterworks/render";
import { PATH_FOOT, PATH_NONE, PATH_QUEUE, type ExecResult } from "@coasterworks/sim";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { CLASSIC_VIEW_EVENT, onShellEvent } from "../host/shell";
import { settingsStore, useSettings, type GraphicsQuality } from "../state/settings";
import { uiStore, useUiStore } from "../state/uiStore";
import { brushRect, planPlacement, timeOfDay } from "./brush";
import { classicCycle, onClassicViewRequest } from "./classicView";
import { PathStroke, skippedMessage, type Tile } from "./drawPath";
import { framingDistance } from "./framing";

/** What the app can ask of the view. */
export interface ViewportHandle {
  /**
   * Moves the camera over the area of `w` by `h` tiles at (`x`, `y`): its target goes to the center
   * of the area, kept on the map. The distance, yaw and pitch stay as they are, and the target's
   * height follows the ground there.
   */
  focusTile(x: number, y: number, w: number, h: number): void;
  /**
   * A point in the window where a guest is drawn, found by trying points across the view a few
   * pixels apart, or null if no guest is in view. For tests and the console: it is slow.
   */
  findGuest(): { clientX: number; clientY: number; id: number } | null;
}

/** How far apart `findGuest` tries points, in CSS pixels. */
const FIND_STEP = 6;

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
  /** The path layer, one byte per tile (0 none, 1 footpath, 2 queue), or null for none. */
  paths?: Uint8Array | null;
  /**
   * Reads the guests of the latest snapshot. A getter, not a prop: guests move in every snapshot,
   * and the view reads them once per animation frame so that React does not render for each one.
   */
  getGuests?(): GuestSection | null;
  /** Reads the park entrance of the latest snapshot, on the same terms as `getGuests`. */
  getEntrance?(): ParkPublic["entrance"] | undefined;
  /** Filled with the view's handle while the view is up. */
  ref?: Ref<ViewportHandle>;
}

/** How often the frame rate is worked out, in milliseconds. */
const FPS_SAMPLE_MS = 500;

/** Pointer travel in pixels past which a right press is an orbit and no longer a click. */
const CLICK_SLOP = 4;

/** A scene, whether it has been given terrain yet, and what else it was last given. */
interface Live {
  scene: SceneHandle;
  hasTerrain: boolean;
  /** The sim's path layer the scene's was made from, null for none; `undefined` before the first. */
  paths: Uint8Array | null | undefined;
  /** The entrance the scene has, null for none; `undefined` until it has been told either. */
  entrance: ParkPublic["entrance"] | undefined;
  /** The width of the map the scene's path layer was laid out for; 0 while there was no terrain. */
  pathsWidth: number;
  /** The quality the scene was made with, or was last asked for. */
  quality: GraphicsQuality;
  /**
   * A path stroke being drawn, shown before the sim has it: tile index to the path value it gets.
   * A new map each time it changes, so a change is told by identity. Null while nothing is drawn.
   */
  preview: Map<number, number> | null;
  /** The preview the scene's path layer was last made with. */
  previewShown: Map<number, number> | null;
  /**
   * The sim's path layer when a stroke was sent and taken: the preview is kept until a layer other
   * than this one comes, so the path does not blink out between the reply and the snapshot.
   */
  previewUntilNot: Uint8Array | null | undefined;
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

/**
 * Asks the scene for a quality, unless it was the last one asked for: asking for "auto" again
 * starts the scene's measuring of itself over.
 */
function askQuality(live: Live, quality: GraphicsQuality): void {
  if (quality === live.quality) return;
  live.quality = quality;
  live.scene.setQuality(quality);
}

/** Whether two entrances are the same place; `undefined` is "not given yet", and differs from none. */
function sameEntrance(a: ParkPublic["entrance"], b: ParkPublic["entrance"] | undefined): boolean {
  if (b === undefined) return false;
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.side === b.side;
}

/**
 * The path layer as the scene is to draw it: the sim's, with the entrance tile paved. The sim keeps
 * the entrance out of its path layer, since nothing is built on that tile, yet guests walk in
 * across it, and the scene lays the lane only from the map's edge outward: what is paved inside
 * the map is for the layer to say. Given the sim's layer as it is, the paving would stop a tile
 * short of the gate.
 */
function pavedPaths(
  paths: Uint8Array | null,
  entrance: ParkPublic["entrance"],
  terrain: TerrainData | null,
): Uint8Array | null {
  if (!paths || !entrance || !terrain) return paths;
  const { width, height } = terrain;
  const { x, y } = entrance;
  // A layer for some other map, or an entrance that is not on this one: nothing to pave.
  if (paths.length !== width * height || x < 0 || y < 0 || x >= width || y >= height) return paths;
  const at = y * width + x;
  if (paths[at] !== 0) return paths;
  // A copy: the layer is the host's, and is compared with the next one to tell a change.
  const paved = paths.slice();
  paved[at] = PATH_FOOT;
  return paved;
}

/**
 * Gives the scene the entrance and the path layer, each only if it has changed: the scene bakes
 * every layer it is given. A moved entrance lays the paths again, since its tile is part of them,
 * and so does a map of another width, since that is what says which tile it is.
 */
function showPark(
  live: Live,
  paths: Uint8Array | null,
  entrance: ParkPublic["entrance"],
  terrain: TerrainData | null,
): void {
  const moved = !sameEntrance(entrance, live.entrance);
  if (moved) {
    live.entrance = entrance;
    live.scene.setEntrance(entrance);
  }
  if (live.previewUntilNot !== undefined && paths !== live.previewUntilNot) {
    // The snapshot with the stroke in it has come: the sim's layer shows it from now on.
    live.preview = null;
    live.previewUntilNot = undefined;
  }
  const width = terrain?.width ?? 0;
  if (
    !moved &&
    paths === live.paths &&
    width === live.pathsWidth &&
    live.preview === live.previewShown
  )
    return;
  live.paths = paths;
  live.pathsWidth = width;
  live.previewShown = live.preview;
  live.scene.setPaths(pavedPaths(withPreview(paths, live.preview, terrain), entrance, terrain));
}

/** The path layer with a stroke being drawn laid over it: a copy, or `paths` itself if none. */
function withPreview(
  paths: Uint8Array | null,
  preview: Map<number, number> | null,
  terrain: TerrainData | null,
): Uint8Array | null {
  if (!preview || preview.size === 0 || !terrain) return paths;
  const size = terrain.width * terrain.height;
  const out = paths && paths.length === size ? paths.slice() : new Uint8Array(size);
  for (const [index, value] of preview) if (index >= 0 && index < size) out[index] = value;
  return out;
}

function failure(error: unknown): ExecResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Most tiles one stroke sends: the sim's limit for a tile-list path command. */
const MAX_STROKE_TILES = 1024;

/** One drag of the path tool: the tiles it has covered and what the sim said about each. */
interface Stroke {
  /** The command and its defaults as they were when the drag began: the whole drag lays these. */
  command: string;
  defaults: Record<string, unknown>;
  path: PathStroke;
  /** The answers still to come, one per batch of tiles checked. */
  pending: Promise<void>[];
  /** The tiles the sim would take, in the order the pointer came over them. */
  tiles: Tile[];
  /** Why each refused tile was refused. */
  refused: string[];
}

/** What `path_check_tiles` answers. */
interface PathCheck {
  refused: Array<{ x: number; y: number; reason: string }>;
}

/** True for a placement that is drawn by dragging over tiles rather than placed click by click. */
function drawsByDragging(command: string | undefined): boolean {
  return command === "path_build" || command === "path_remove";
}

/**
 * The 3D view of the park, and the pointer input that edits it. What a click does is the
 * placement in the UI store, which the dock's trays and the command bar start: with none in
 * hand it does nothing but select the tile for the inspector, under any tool. Nothing is outlined
 * under the pointer without a placement.
 */
export function Viewport(props: ViewportProps) {
  const placement = useUiStore((state) => state.placement);
  const showFps = useSettings((state) => state.showFps);
  const graphicsQuality = useSettings((state) => state.graphicsQuality);
  const [fps, setFps] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const outlineRef = useRef<(() => void) | null>(null);
  const parkRef = useRef<(() => void) | null>(null);
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
      findGuest() {
        const scene = live.current?.scene;
        const canvas = canvasRef.current;
        if (!scene || !canvas) return null;
        const box = canvas.getBoundingClientRect();
        for (let y = box.top + FIND_STEP; y < box.bottom; y += FIND_STEP) {
          for (let x = box.left + FIND_STEP; x < box.right; x += FIND_STEP) {
            const guest = scene.pickGuestAt(x, y);
            if (guest) return { clientX: x, clientY: y, id: guest.id };
          }
        }
        return null;
      },
    }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Read when the scene is made. The cap is not read again, so a change to it applies the next
    // time the park loads; a change of quality goes to the scene already up, further down.
    const { pixelRatioCap, graphicsQuality: quality } = settingsStore.getState();
    const scene = createScene(canvas, { pixelRatioCap, quality });
    const mine: Live = {
      scene,
      hasTerrain: false,
      paths: undefined,
      entrance: undefined,
      pathsWidth: 0,
      quality,
      preview: null,
      previewShown: null,
      previewUntilNot: undefined,
    };
    live.current = mine;
    show(mine, latest.current.terrain);
    // The paths and the entrance as they are now; `park` looks again in every frame.
    const park = () => {
      const { paths, getEntrance, terrain } = latest.current;
      showPark(mine, paths ?? null, getEntrance?.() ?? null, terrain);
    };
    parkRef.current = park;
    park();
    scene.setGridVisible(latest.current.placement !== null);
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

    // A drag of the path tool is one stroke and one command: as the pointer comes over tiles the
    // sim is asked which it would take (`path_check_tiles`), those are shown at once, and when the
    // drag ends they go in one `path_build_tiles` or `path_remove_tiles`, so the stroke is one
    // charge and one undo step. What was refused (water, too steep) is told once, at the end.
    let stroke: Stroke | null = null;
    const setPreview = (next: Map<number, number> | null) => {
      mine.preview = next;
      mine.previewUntilNot = undefined;
      park();
    };
    const paintTiles = (current: Stroke, tiles: Tile[]) => {
      const { client, placement, terrain } = latest.current;
      // A tool put down or changed mid-drag (Esc, a dock key) ends what the drag lays.
      if (!client || !terrain || placement?.command !== current.command || tiles.length === 0)
        return;
      const remove = current.command === "path_remove";
      const kind = remove ? "remove" : String(current.defaults.kind ?? "foot");
      const value = remove ? PATH_NONE : kind === "queue" ? PATH_QUEUE : PATH_FOOT;
      current.pending.push(
        client.query("path_check_tiles", { tiles, kind }).then(
          (answer) => {
            if (!answer.ok) {
              current.refused.push(...tiles.map(() => answer.error));
              return;
            }
            const refused = new Set<string>();
            for (const tile of (answer.result as PathCheck).refused) {
              refused.add(`${tile.x},${tile.y}`);
              current.refused.push(tile.reason);
            }
            if (stroke !== current && mine.preview === null) return;
            const next = new Map(mine.preview ?? []);
            for (const tile of tiles) {
              if (refused.has(`${tile.x},${tile.y}`)) continue;
              if (current.tiles.length >= MAX_STROKE_TILES) {
                current.refused.push("The stroke is too long");
                continue;
              }
              current.tiles.push(tile);
              next.set(tile.y * terrain.width + tile.x, value);
            }
            setPreview(next);
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            current.refused.push(...tiles.map(() => message));
          },
        ),
      );
    };
    const sendStroke = async (done: Stroke) => {
      await Promise.all(done.pending);
      const { client, onResult } = latest.current;
      if (done.tiles.length > 0 && client) {
        const remove = done.command === "path_remove";
        const name = remove ? "path_remove_tiles" : "path_build_tiles";
        const input = remove
          ? { tiles: done.tiles }
          : { tiles: done.tiles, kind: done.defaults.kind ?? "foot" };
        const result = await client.command(name, input).catch(failure);
        onResult(result);
        if (result.ok) {
          // Kept until the snapshot with the stroke in it comes (see `showPark`).
          mine.previewUntilNot = latest.current.paths ?? null;
          park();
        } else {
          setPreview(null);
        }
      } else {
        setPreview(null);
      }
      const skipped = skippedMessage(done.refused);
      if (skipped) latest.current.onResult({ ok: false, error: skipped });
    };

    const detach = attachControls(canvas, scene.rig, {
      pick: (clientX, clientY) => scene.pickAt(clientX, clientY),
      paint: {
        active: () => {
          const { placement, client } = latest.current;
          return client !== null && drawsByDragging(placement?.command);
        },
        start: (x, y) => {
          const { placement } = latest.current;
          if (!placement) return;
          stroke = {
            command: placement.command,
            defaults: { ...placement.defaults },
            path: new PathStroke({ x, y }),
            pending: [],
            tiles: [],
            refused: [],
          };
          mine.preview = new Map();
          paintTiles(stroke, [{ x, y }]);
        },
        leave: () => stroke?.path.lift(),
        move: (x, y) => {
          const current = stroke;
          if (!current) return;
          paintTiles(current, current.path.extend({ x, y }));
        },
        end: () => {
          const done = stroke;
          stroke = null;
          if (!done) return;
          void sendStroke(done);
        },
      },
      // With nothing in hand, a click on a guest looks at the guest rather than the tile under them.
      onPointClick: (clientX, clientY) => {
        if (latest.current.placement) return false;
        const guest = scene.pickGuestAt(clientX, clientY);
        if (!guest) return false;
        uiStore.getState().inspectGuest(guest.id);
        return true;
      },
      onHover: (x, y) => {
        hover.current = x === null || y === null ? null : { x, y };
        outline();
      },
      onTileClick: (x, y, mods) => {
        const { client, terrain, placement, onResult, getEntrance } = latest.current;
        if (!terrain) return;
        if (!placement) {
          // Nothing in hand but the pointer, whatever tool the dock is on: a click looks at the
          // tile, or at the entrance if that is where it is.
          const entrance = getEntrance?.();
          if (entrance && entrance.x === x && entrance.y === y)
            uiStore.getState().inspectEntrance();
          else uiStore.getState().inspectTile(x, y);
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
    // The guests the scene was last given. The guests module keeps the last two sections to move
    // guests between them, so a section goes in once, when it is new.
    let guests: GuestSection | null | undefined;
    let frame = requestAnimationFrame(function draw(now) {
      const nextGuests = latest.current.getGuests?.() ?? null;
      if (nextGuests !== guests) {
        guests = nextGuests;
        scene.setGuests(nextGuests, now);
      }
      // The entrance comes with the snapshots, which render nothing: this is where it is noticed.
      park();
      scene.render(now);
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
      parkRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (live.current) show(live.current, props.terrain);
  }, [props.terrain]);

  useEffect(() => {
    live.current?.scene.setTimeOfDay(timeOfDay(props.tick));
  }, [props.tick]);

  useEffect(() => {
    parkRef.current?.();
  }, [props.paths]);

  // The build grid shows while there is something to place, and only then.
  useEffect(() => {
    live.current?.scene.setGridVisible(placement !== null);
  }, [placement]);

  // The scene is made at the quality chosen so far; a later choice goes to the scene already up.
  useEffect(() => {
    if (live.current) askQuality(live.current, graphicsQuality);
  }, [graphicsQuality]);

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
          className="pointer-events-none absolute bottom-3.5 left-3.5 rounded-lg bg-(--glass-bg) px-2 py-0.5 text-[11px] tabular-nums text-muted"
        >
          {fps ?? "…"} FPS
        </div>
      )}
    </>
  );
}
