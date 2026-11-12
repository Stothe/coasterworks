import type { GuestSection, RideStatusSection } from "@coasterworks/protocol";
import { fnv1a64 } from "@coasterworks/sim";
import {
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type MeshStandardMaterial,
} from "three";
import { createAtmosphereUniforms } from "./atmosphere.glsl.js";
import { createAtmosphere, type AtmosphereModule } from "./atmosphere.js";
import { CameraRig } from "./camera.js";
import {
  createSharedUniforms,
  type EntrancePlace,
  type FrameInfo,
  type ModuleName,
  type Quality,
  type RenderContext,
  type SceneModule,
} from "./context.js";
import { createEntrance } from "./entrance.js";
import { createGuests, type GuestsModule } from "./guests.js";
import { groundHeightAt, sceneGroundAt } from "./heightfield.js";
import { pickTile, rayFromCamera, type Ray } from "./picker.js";
import { createPost, glRendererString, type PostModule, type RenderInfo } from "./post.js";
import {
  createRides,
  type PlacementGhost,
  type RidePlace,
  type RidesModule,
} from "./rides/rides.js";
import {
  SOFTWARE,
  createFrameMeter,
  detectQuality,
  isSoftwareRenderer,
  softwareFrameDue,
} from "./quality.js";
import { sunFor } from "./sky.js";
import { createSurroundings } from "./surroundings.js";
import {
  buildTerrainChunk,
  chunkCount,
  type TerrainChunkGeometry,
  type TerrainData,
} from "./terrain/geometry.js";
import { createTerrainMaterial } from "./terrain/material.js";
import { createOverlay, type OverlayModule } from "./terrain/overlay.glsl.js";
import { createPaths, type PathsModule } from "./terrain/paths.glsl.js";
import { createSurface } from "./terrain/surface.glsl.js";
import { CHUNK, SUBDIV } from "./units.js";
import { createWater } from "./water.js";

/**
 * Whether the park's ground casts shadows (the hills on themselves) at `quality`. Not at `low`:
 * the ground is most of the vertices of a frame, and drawing it again into the shadow map is the
 * dearest thing a software renderer does.
 */
function terrainCastsShadow(quality: Quality): boolean {
  return quality !== "low";
}

export interface SceneOptions {
  /** Upper bound on the device pixel ratio the canvas renders at. Default 2. */
  pixelRatioCap?: number;
  /** The quality to draw at, or "auto" to let the renderer choose and adjust. Default "auto". */
  quality?: Quality | "auto";
  /**
   * Which modules to create; one set to `false` is left out and whatever it draws is missing. All
   * are on by default. For look development, to judge one module without the others.
   */
  modules?: Partial<Record<ModuleName, boolean>>;
  /**
   * Seconds. When set, the animation clock stands at this value and never advances, so that two
   * frames of the same scene are the same picture.
   */
  frozenTime?: number;
}

export interface SceneHandle {
  /** The camera rig. Move it to move the view; `render()` applies it. */
  rig: CameraRig;
  /**
   * Replaces the terrain and rebuilds every chunk. The first terrain (and any terrain of a different
   * size) also centers the rig's target on the map.
   */
  setTerrain(t: TerrainData): void;
  /** Rebuilds only the chunks whose ground changed since the last call. */
  updateTerrain(t: TerrainData): void;
  /** Sets the time of the visual day, 0..1 (0 dawn, 0.5 noon), which moves the sun and recolors the sky. */
  setTimeOfDay(t: number): void;
  /** The path layer: one byte per tile, 0 none, 1 footpath, 2 queue. Null for no paths. */
  setPaths(paths: Uint8Array | null): void;
  /**
   * The guests of the latest snapshot, or null for none. `atMs` is when the snapshot arrived, on
   * the clock `render(nowMs)` runs on; omitted, it is `performance.now()`. The section belongs to
   * the scene from here on: pass a new one for each snapshot and do not write to one already
   * passed, since the guests module keeps the last two to move guests between them.
   */
  setGuests(guests: GuestSection | null, atMs?: number): void;
  /**
   * Where the park entrance is, or null for none. `side` is 0 north, 1 east, 2 south, 3 west.
   * Every module that takes an entrance is told, and `ctx.entrance()` answers with it.
   */
  setEntrance(e: { x: number; y: number; side: 0 | 1 | 2 | 3 } | null): void;
  /**
   * The park's rides and stalls, from the latest snapshot that carried them, or null for none.
   * Matched by id: a ride already drawn keeps its place in its turn.
   */
  setRides(rides: readonly RidePlace[] | null): void;
  /**
   * What every ride is doing, from the latest snapshot (ascending id order), or null. Looked up
   * by id each frame: a status for a ride the scene does not have, or a ride with no status, is
   * fine (the two may disagree for a frame).
   */
  setRideStatus(status: RideStatusSection | null): void;
  /**
   * Draws a ride of `type` see-through on its footprint at (`x`, `y`) turned `rot` (quarter turns
   * clockwise), tinted green when `ok` and red when the sim would refuse it; null hides it.
   */
  setPlacementGhost(ghost: PlacementGhost | null): void;
  /** Shows or hides the build grid. Hidden by default. */
  setGridVisible(on: boolean): void;
  /** The quality to draw at, or "auto" (the default) to let the renderer choose and adjust. */
  setQuality(q: Quality | "auto"): void;
  /**
   * Draws a frame. `nowMs` drives the animation clock (a `requestAnimationFrame` timestamp does);
   * omitted, it is `performance.now()`.
   */
  render(nowMs?: number): void;
  /** Resizes the drawing buffer to the canvas's current client size. */
  resize(): void;
  /** The tile under a client-space point, or `null` over nothing. */
  pickAt(clientX: number, clientY: number): { x: number; y: number } | null;
  /** The guest under a client-space point, or `null` over none (or one behind a ride). */
  pickGuestAt(clientX: number, clientY: number): { id: number } | null;
  /**
   * The ride or stall under a client-space point, or `null`. A ride is hit by its box (its
   * footprint and height), so it wins over the tile under it; a guest nearer along the ray wins
   * over it (and this answers null), and so does ground in front of it.
   */
  pickRideAt(clientX: number, clientY: number): { id: number } | null;
  /** Highlights the tile rectangle at (`x`, `y`) of `w` by `h` tiles, on the ground; `null` clears it. */
  highlightTile(x: number, y: number, w: number, h: number): void;
  highlightTile(rect: null): void;
  /**
   * How the scene is being drawn: the quality in force, the graphics hardware, the frame time.
   * The same object every time, whose fields give the present values whenever they are read.
   */
  readonly info: RenderInfo;
  /** Frees GPU resources. The canvas itself is left usable for a new scene. */
  dispose(): void;
}

/** The longest step the animation clock takes in one frame, in seconds: a stall is not replayed. */
const MAX_CLOCK_STEP = 0.1;
/**
 * How many corners beyond a chunk's own its mesh depends on. The smooth ground at a point reads
 * the corners two away, and the normals of the chunk's border vertices sample a little outside it.
 */
const CHUNK_REACH = 2;

interface Chunk {
  hash: bigint;
  mesh: Mesh;
}

const radiansToDegrees = (radians: number) => (radians * 180) / Math.PI;

function toBufferGeometry(g: TerrainChunkGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(g.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(g.normals, 3));
  geometry.setIndex(new BufferAttribute(g.indices, 1));
  return geometry;
}

/**
 * Hashes the corner heights that decide a chunk's mesh: its own and those within `CHUNK_REACH` of
 * it. The surface and water layers are not part of the mesh (modules draw them from the whole
 * terrain), so painting a surface rebuilds no chunk.
 */
function chunkHash(t: TerrainData, chunkX: number, chunkY: number): bigint {
  const x0 = chunkX * CHUNK;
  const y0 = chunkY * CHUNK;
  const x1 = Math.min(t.width, x0 + CHUNK);
  const y1 = Math.min(t.height, y0 + CHUNK);
  const cornerX0 = Math.max(0, x0 - CHUNK_REACH);
  const cornerX1 = Math.min(t.width, x1 + CHUNK_REACH);
  const cornerY0 = Math.max(0, y0 - CHUNK_REACH);
  const cornerY1 = Math.min(t.height, y1 + CHUNK_REACH);
  const bytes = (a: Int16Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

  let hash = fnv1a64(new Uint8Array([x1 - x0, y1 - y0, x0 - cornerX0, y0 - cornerY0]));
  for (let y = cornerY0; y <= cornerY1; y++) {
    const row = y * (t.width + 1);
    hash = fnv1a64(bytes(t.corners.subarray(row + cornerX0, row + cornerX1 + 1)), hash);
  }
  return hash;
}

/**
 * Creates the three.js scene on `canvas`. This is the orchestrator: it owns the renderer, the
 * camera and its rig, the shared uniforms and the chunked terrain meshes, creates the modules that
 * draw everything else, and runs their lifecycle. What a thing looks like is its module's
 * business, never this file's.
 */
export function createScene(canvas: HTMLCanvasElement, opts: SceneOptions = {}): SceneHandle {
  const pixelRatioCap = opts.pixelRatioCap ?? 2;
  const enabled = (name: ModuleName) => opts.modules?.[name] !== false;

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  // PCFShadowMap is the soft-edged filter; three r186 deprecated PCFSoftShadowMap in its favor.
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  const rig = new CameraRig();
  const camera = new PerspectiveCamera(radiansToDegrees(rig.fovY), 1, 0.5, 1500);
  const uniforms = createSharedUniforms();
  const gl = glRendererString(renderer);
  /** On a software renderer `low` is cheaper still (`SOFTWARE`): see `cheap`. */
  const software = isSoftwareRenderer(gl);

  let terrain: TerrainData | null = null;
  let terrainMaterial: MeshStandardMaterial | null = null;
  let requested: Quality | "auto" = opts.quality ?? "auto";
  let entrancePlace: EntrancePlace | null = null;
  /** The height of the land beyond the park, when a module (the surroundings) has given one. */
  let outerGround: ((x: number, z: number) => number) | null = null;

  const ctx: RenderContext = {
    renderer,
    scene,
    camera,
    rig,
    uniforms,
    atmosphereUniforms: createAtmosphereUniforms(),
    quality: requested === "auto" ? detectQuality(gl) : requested,
    software,
    terrain: () => terrain,
    // The park's own ground over the map; beyond its edge, whatever lies out there.
    heightAt: (x, z) => sceneGroundAt(terrain, outerGround, x, z),
    setOuterGround: (heightAt) => {
      outerGround = heightAt;
    },
    entrance: () => entrancePlace,
    terrainMaterial: () => {
      if (!terrainMaterial) throw new Error("The terrain material does not exist yet.");
      return terrainMaterial;
    },
  };
  // The rig keeps its target on the ground and its eye out of the hills, as the terrain is now,
  // and out of the land beyond the park too once that has a height of its own.
  rig.heightAt = ctx.heightAt;

  // The modules, in the order their lifecycle methods run. The three terrain chunks come first:
  // the terrain material is made of them, and the surroundings draw with it.
  const modules: SceneModule[] = [];
  const add = <M extends SceneModule>(name: ModuleName, create: (ctx: RenderContext) => M) => {
    if (!enabled(name)) return null;
    const module = create(ctx);
    modules.push(module);
    return module;
  };
  const surface = add("surface", createSurface);
  const paths: PathsModule | null = add("paths", createPaths);
  const overlay: OverlayModule | null = add("overlay", createOverlay);
  terrainMaterial = createTerrainMaterial(ctx, { surface, paths, overlay });
  const atmosphere: AtmosphereModule | null = add("atmosphere", createAtmosphere);
  add("water", createWater);
  add("surroundings", createSurroundings);
  add("entrance", createEntrance);
  const rides: RidesModule | null = add("rides", createRides);
  const guests: GuestsModule | null = add("guests", createGuests);
  const post: PostModule | null = add("post", createPost);
  post?.request(requested);

  // Without the atmosphere there would be no light at all: a plain stand-in, so that the other
  // modules can still be looked at.
  const standIn = atmosphere
    ? null
    : [new HemisphereLight(0xffffff, 0x777777, 0.9), new DirectionalLight(0xffffff, 1.6)];
  if (standIn) {
    standIn[1]?.position.copy(uniforms.uSunDir.value).multiplyScalar(100);
    scene.add(...standIn);
  }
  // Without the post module the frame is drawn directly and the frame time is measured here.
  const meter = post ? null : createFrameMeter();

  const chunkGroup = new Group();
  scene.add(chunkGroup);
  const chunks = new Map<string, Chunk>();

  /** What every module's `update` is handed: one object, filled in anew each frame. */
  const frame: FrameInfo = { time: opts.frozenTime ?? 0, dt: 0, nowMs: 0, sun: sunFor(0.4) };
  let highlightRect: { x: number; y: number; w: number; h: number } | null = null;
  /** Seconds on the animation clock, and the `nowMs` of the frame that last moved it. */
  let clock = opts.frozenTime ?? 0;
  let lastNow: number | null = null;
  let disposed = false;
  /** True from a lost WebGL context until the browser gives it back: nothing is drawn. */
  let contextLost = false;
  // The default for a lost context is that it never comes back; asking for it back means the
  // browser restores it (after a GPU reset, a driver switch, waking from sleep) and three with it.
  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
  };
  const onContextRestored = () => {
    contextLost = false;
    for (const module of modules) module.contextRestored?.();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  /** When the last frame was drawn, for the software renderer's frame interval. */
  let lastDrawn: number | null = null;
  /** What the last drawn frame cost, measured at the next frame offered; null until measured. */
  let drawCost = 0;
  let measuring = false;
  /** True while the cheapest drawing is in force: a software renderer at `low`. */
  const cheap = () => software && ctx.quality === "low";
  const terrainSubdiv = () => (cheap() ? SOFTWARE.subdiv : SUBDIV);
  /** The cells per tile edge the chunks were built with. */
  let builtSubdiv = SUBDIV;

  function disposeChunk(chunk: Chunk): void {
    chunkGroup.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
  }

  function buildChunk(t: TerrainData, cx: number, cy: number, hash: bigint): Chunk {
    builtSubdiv = terrainSubdiv();
    const mesh = new Mesh(
      toBufferGeometry(buildTerrainChunk(t, cx, cy, builtSubdiv)),
      ctx.terrainMaterial(),
    );
    mesh.castShadow = terrainCastsShadow(ctx.quality);
    mesh.receiveShadow = true;
    chunkGroup.add(mesh);
    return { hash, mesh };
  }

  /** Tells every module about the terrain now in force. */
  function terrainChanged(t: TerrainData): void {
    uniforms.uMapSize.value.set(t.width, t.height);
    for (const module of modules) module.setTerrain?.(t);
  }

  /** Builds every chunk of `t` again, as for a new terrain. */
  function rebuildChunks(t: TerrainData): void {
    for (const chunk of chunks.values()) disposeChunk(chunk);
    chunks.clear();
    const { cx, cy } = chunkCount(t);
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        chunks.set(`${x},${y}`, buildChunk(t, x, y, chunkHash(t, x, y)));
      }
    }
  }

  function setTerrain(t: TerrainData): void {
    const previous = terrain;
    terrain = t;
    rebuildChunks(t);
    if (!previous || previous.width !== t.width || previous.height !== t.height) {
      const x = t.width / 2;
      const z = t.height / 2;
      rig.target = { x, y: groundHeightAt(t, x, z), z };
    }
    terrainChanged(t);
  }

  function updateTerrain(t: TerrainData): void {
    if (!terrain || terrain.width !== t.width || terrain.height !== t.height) {
      setTerrain(t);
      return;
    }
    terrain = t;
    const { cx, cy } = chunkCount(t);
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        const key = `${x},${y}`;
        const hash = chunkHash(t, x, y);
        const existing = chunks.get(key);
        if (existing && existing.hash === hash) continue;
        if (existing) disposeChunk(existing);
        chunks.set(key, buildChunk(t, x, y, hash));
      }
    }
    terrainChanged(t);
  }

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    const pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      pixelRatioCap,
      cheap() ? SOFTWARE.pixelRatio : Infinity,
    );
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    for (const module of modules) module.resize?.(width, height, pixelRatio);
  }

  /** Puts `quality` in force: the context first, then every module. */
  function applyQuality(quality: Quality): void {
    if (quality === ctx.quality) return;
    ctx.quality = quality;
    for (const chunk of chunks.values()) chunk.mesh.castShadow = terrainCastsShadow(quality);
    for (const module of modules) module.setQuality?.(quality);
    // Into or out of the software renderer's cheapest drawing: the ground mesh and the size of the
    // drawing buffer change with it.
    if (terrain && terrainSubdiv() !== builtSubdiv) rebuildChunks(terrain);
    resize();
  }

  function render(nowMs?: number): void {
    if (disposed || contextLost) return;
    const now = nowMs ?? performance.now();
    // A software renderer rests between frames, in proportion to what a frame costs it: a frame
    // offered sooner is skipped whole, so that the page keeps the CPU it needs.
    if (cheap()) {
      if (measuring && lastDrawn !== null) {
        // The browser offers the next frame once the last has been drawn: the gap is its cost.
        drawCost = now - lastDrawn;
        measuring = false;
      }
      if (!softwareFrameDue(now, lastDrawn, drawCost)) return;
      measuring = true;
    }
    lastDrawn = now;
    let dt = 0;
    if (opts.frozenTime === undefined && lastNow !== null) {
      dt = Math.min(MAX_CLOCK_STEP, Math.max(0, (now - lastNow) / 1000));
      clock += dt;
    }
    lastNow = now;

    // The target cannot leave the map, however the rig was moved since the last frame.
    if (terrain) rig.clampTarget(terrain.width, terrain.height);
    // The view follows the ground, and the camera stays above it, however the rig was moved.
    rig.settle();
    // The rig owns the field of view; follow it if it changed.
    const fov = radiansToDegrees(rig.fovY);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    rig.applyTo(camera);

    uniforms.uTime.value = clock;
    uniforms.uCamTarget.value.set(rig.target.x, rig.target.y, rig.target.z);
    uniforms.uCamDistance.value = rig.distance;

    frame.time = clock;
    frame.dt = dt;
    frame.nowMs = now;
    for (const module of modules) module.update?.(frame);

    if (post) {
      post.render();
      // The post module decides the quality on "auto"; what it wants goes to everyone.
      applyQuality(post.info.quality);
    } else {
      meter?.sample(performance.now());
      renderer.render(scene, camera);
    }
  }

  /** The world-space ray under a client-space point, or null when the canvas has no size. */
  function rayAt(clientX: number, clientY: number): Ray | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    return rayFromCamera(rig, ndcX, ndcY, camera.aspect, rig.fovY);
  }

  /** How far past the ground a guest's hit may be and still count: a foot's width. */
  const GUEST_PICK_SLACK = 0.15;

  /**
   * How far along `ray` (unit length) something may be and still be seen: the ground it meets
   * first, with a little slack for what stands on it; without terrain, any distance.
   */
  function groundReach(ray: Ray): number {
    const ground = terrain ? pickTile(ray, terrain) : null;
    if (!ground) return Infinity;
    return (
      Math.hypot(
        ground.point.x - ray.origin.x,
        ground.point.y - ray.origin.y,
        ground.point.z - ray.origin.z,
      ) + GUEST_PICK_SLACK
    );
  }

  function pickAt(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!terrain) return null;
    const ray = rayAt(clientX, clientY);
    const hit = ray ? pickTile(ray, terrain) : null;
    return hit ? { x: hit.x, y: hit.y } : null;
  }

  function highlightTile(x: number | null, y?: number, w?: number, h?: number): void {
    highlightRect =
      x === null || y === undefined || w === undefined || h === undefined ? null : { x, y, w, h };
    overlay?.setHighlight(highlightRect);
    // The build grid gathers around what the player points at: the middle of the highlight.
    overlay?.setCursor(
      highlightRect
        ? { x: highlightRect.x + highlightRect.w / 2, z: highlightRect.y + highlightRect.h / 2 }
        : null,
    );
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
    // Last made, first unmade.
    for (let i = modules.length - 1; i >= 0; i--) modules[i]?.dispose();
    modules.length = 0;
    for (const chunk of chunks.values()) disposeChunk(chunk);
    chunks.clear();
    if (standIn) {
      scene.remove(...standIn);
      for (const light of standIn) light.dispose();
    }
    terrainMaterial?.dispose();
    // No forceContextLoss(): the canvas must stay usable for a new scene (React strict mode mounts twice).
    renderer.dispose();
  }

  /** One object for the life of the scene; its fields read the present state each time. */
  const info: RenderInfo = {
    get quality() {
      return ctx.quality;
    },
    gl,
    get frameMs() {
      return post ? post.info.frameMs : (meter?.frameMs ?? 0);
    },
  };

  atmosphere?.setTimeOfDay(0.4);
  resize();

  return {
    rig,
    setTerrain,
    updateTerrain,
    setTimeOfDay(t: number): void {
      frame.sun = sunFor(t);
      atmosphere?.setTimeOfDay(t);
    },
    setPaths(next: Uint8Array | null): void {
      paths?.setPaths(next);
    },
    setGuests(section: GuestSection | null, atMs?: number): void {
      guests?.setGuests(section, atMs ?? performance.now());
    },
    setEntrance(e: EntrancePlace | null): void {
      // A copy, so that nothing the caller does to its own object later reaches the modules.
      entrancePlace = e ? { x: e.x, y: e.y, side: e.side } : null;
      // The paths module (the lane), the gate, and whoever else keeps clear of the entrance.
      for (const module of modules) module.setEntrance?.(entrancePlace);
    },
    setRides(list: readonly RidePlace[] | null): void {
      rides?.setRides(list);
    },
    setRideStatus(status: RideStatusSection | null): void {
      rides?.setRideStatus(status);
    },
    setPlacementGhost(ghost: PlacementGhost | null): void {
      rides?.setPlacementGhost(ghost);
    },
    setGridVisible(on: boolean): void {
      overlay?.setGridVisible(on);
    },
    setQuality(q: Quality | "auto"): void {
      requested = q;
      if (post) {
        post.request(q);
        applyQuality(post.info.quality);
      } else {
        applyQuality(q === "auto" ? detectQuality(gl) : q);
      }
    },
    render,
    resize,
    pickAt,
    pickGuestAt(clientX: number, clientY: number): { id: number } | null {
      const ray = guests ? rayAt(clientX, clientY) : null;
      if (!ray || !guests) return null;
      // A guest behind a hill, past the ground the ray meets or behind a ride is out of sight:
      // only those nearer than both can be picked.
      const reach = groundReach(ray);
      const ride = rides?.pickAt(ray, reach) ?? null;
      return guests.pickAt(ray, ride ? ride.distance : reach);
    },
    pickRideAt(clientX: number, clientY: number): { id: number } | null {
      const ray = rides ? rayAt(clientX, clientY) : null;
      if (!ray || !rides) return null;
      const ride = rides.pickAt(ray, groundReach(ray));
      if (!ride) return null;
      // A guest in front of the ride is what the player points at.
      if (guests?.pickAt(ray, ride.distance)) return null;
      return { id: ride.id };
    },
    highlightTile,
    info,
    dispose,
  };
}
