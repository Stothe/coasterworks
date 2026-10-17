import { fnv1a64 } from "@coasterworks/sim";
import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";
import { CameraRig } from "./camera.js";
import { groundHeightAt } from "./ground.js";
import { srgbToLinear } from "./palette.js";
import { pickTile, rayFromCamera } from "./picker.js";
import { sunFor, type SunState } from "./sky.js";
import {
  buildChunkGeometry,
  buildWaterGeometry,
  chunkCount,
  type ChunkGeometry,
  type TerrainData,
} from "./terrain-geometry.js";
import { CHUNK, HEIGHT_STEP } from "./units.js";

export interface SceneOptions {
  /** Upper bound on the device pixel ratio the canvas renders at. Default 2. */
  pixelRatioCap?: number;
}

export interface SceneHandle {
  /** The camera rig. Move it to move the view; `render()` applies it. */
  rig: CameraRig;
  /**
   * Replaces the terrain and rebuilds every chunk. The first terrain (and any terrain of a different
   * size) also centers the rig's target on the map.
   */
  setTerrain(t: TerrainData): void;
  /** Rebuilds only the chunks whose corner, surface or water bytes changed since the last call. */
  updateTerrain(t: TerrainData): void;
  /** Sets the time of the visual day, 0..1 (0 dawn, 0.5 noon), which moves the sun and recolors the sky. */
  setTimeOfDay(t: number): void;
  render(): void;
  /** Resizes the drawing buffer to the canvas's current client size. */
  resize(): void;
  /** The tile under a client-space point, or `null` over nothing. */
  pickAt(clientX: number, clientY: number): { x: number; y: number } | null;
  /** Outlines the tile rectangle at (`x`, `y`) of `w` by `h` tiles, following the terrain; `null` clears it. */
  highlightTile(x: number, y: number, w: number, h: number): void;
  highlightTile(rect: null): void;
  /** Frees GPU resources. The canvas itself is left usable for a new scene. */
  dispose(): void;
}

/** Side of the square the sun's shadow map covers around the camera target, in world units. */
const SHADOW_SIZE = 64;
/** How far the sun light sits from the target along the sun direction. */
const SUN_DISTANCE = 100;
/** How far the highlight outline floats above the terrain. */
const HIGHLIGHT_LIFT = 0.06;

interface Chunk {
  hash: bigint;
  terrain: Mesh;
  water: Mesh | null;
}

const radiansToDegrees = (radians: number) => (radians * 180) / Math.PI;

/** The sRGB color floats of a chunk converted to linear light, which is what vertex colors are read as. */
function linearColors(colors: Float32Array): Float32Array {
  const out = new Float32Array(colors.length);
  // Every vertex of a triangle shares one color, so convert once per triangle.
  for (let i = 0; i + 8 < colors.length; i += 9) {
    const r = srgbToLinear(colors[i] as number);
    const g = srgbToLinear(colors[i + 1] as number);
    const b = srgbToLinear(colors[i + 2] as number);
    for (let v = 0; v < 3; v++) {
      out[i + v * 3] = r;
      out[i + v * 3 + 1] = g;
      out[i + v * 3 + 2] = b;
    }
  }
  return out;
}

function toBufferGeometry(g: ChunkGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(g.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(g.normals, 3));
  geometry.setAttribute("color", new BufferAttribute(linearColors(g.colors), 3));
  geometry.setIndex(new BufferAttribute(g.indices, 1));
  return geometry;
}

/** Hashes the bytes that decide a chunk's meshes: its corner, surface and water slices. */
function chunkHash(t: TerrainData, chunkX: number, chunkY: number): bigint {
  const x0 = chunkX * CHUNK;
  const y0 = chunkY * CHUNK;
  const x1 = Math.min(t.width, x0 + CHUNK);
  const y1 = Math.min(t.height, y0 + CHUNK);
  const bytes = (a: Int16Array | Uint8Array) =>
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

  let hash = fnv1a64(new Uint8Array([x1 - x0, y1 - y0]));
  for (let y = y0; y <= y1; y++) {
    const row = y * (t.width + 1);
    hash = fnv1a64(bytes(t.corners.subarray(row + x0, row + x1 + 1)), hash);
  }
  for (let y = y0; y < y1; y++) {
    const row = y * t.width;
    hash = fnv1a64(bytes(t.surface.subarray(row + x0, row + x1)), hash);
    hash = fnv1a64(bytes(t.water.subarray(row + x0, row + x1)), hash);
  }
  return hash;
}

/** Creates the three.js scene, camera rig and lighting on `canvas`. */
export function createScene(canvas: HTMLCanvasElement, opts: SceneOptions = {}): SceneHandle {
  const pixelRatioCap = opts.pixelRatioCap ?? 2;

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  // PCFShadowMap is the soft-edged filter; three r186 removed PCFSoftShadowMap in its favor.
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new Scene();
  const skyColor = new Color();
  scene.background = skyColor;
  const fog = new Fog(0x9fd3f2, 22, 48);
  scene.fog = fog;

  const rig = new CameraRig();
  const camera = new PerspectiveCamera(radiansToDegrees(rig.fovY), 1, 0.5, 1500);

  const hemisphere = new HemisphereLight(0xdcefff, 0x5c8a3a, 0.75);
  scene.add(hemisphere);

  const sun = new DirectionalLight(0xfff1d6, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_SIZE / 2;
  sun.shadow.camera.right = SHADOW_SIZE / 2;
  sun.shadow.camera.top = SHADOW_SIZE / 2;
  sun.shadow.camera.bottom = -SHADOW_SIZE / 2;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = SUN_DISTANCE * 2.2;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const terrainMaterial = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.9,
  });
  const waterMaterial = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.2,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });
  const highlightMaterial = new LineBasicMaterial({
    color: 0xffffff,
    fog: false,
    toneMapped: false,
  });

  const chunkGroup = new Group();
  scene.add(chunkGroup);
  const chunks = new Map<string, Chunk>();
  let terrain: TerrainData | null = null;
  // The rig keeps its target on the ground and its eye out of the hills, as the terrain is now.
  rig.heightAt = (x, z) => (terrain ? groundHeightAt(terrain, x, z) : 0);

  let highlight: LineSegments | null = null;
  let highlightRect: [number, number, number, number] | null = null;
  let sky: SunState = sunFor(0.4);
  let disposed = false;

  function applySky(): void {
    skyColor.setRGB(sky.skyColor[0], sky.skyColor[1], sky.skyColor[2], SRGBColorSpace);
    fog.color.copy(skyColor);
    sun.color.setRGB(sky.color[0], sky.color[1], sky.color[2], SRGBColorSpace);
    sun.intensity = sky.intensity;
    hemisphere.intensity = sky.ambient;
  }

  function disposeChunk(chunk: Chunk): void {
    chunkGroup.remove(chunk.terrain);
    chunk.terrain.geometry.dispose();
    if (chunk.water) {
      chunkGroup.remove(chunk.water);
      chunk.water.geometry.dispose();
    }
  }

  function buildChunk(t: TerrainData, cx: number, cy: number, hash: bigint): Chunk {
    const mesh = new Mesh(toBufferGeometry(buildChunkGeometry(t, cx, cy)), terrainMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    chunkGroup.add(mesh);

    let water: Mesh | null = null;
    const waterGeometry = buildWaterGeometry(t, cx, cy);
    if (waterGeometry) {
      water = new Mesh(toBufferGeometry(waterGeometry), waterMaterial);
      water.renderOrder = 1;
      chunkGroup.add(water);
    }
    return { hash, terrain: mesh, water };
  }

  function groundHeight(t: TerrainData, cx: number, cy: number): number {
    const x = Math.min(t.width, Math.max(0, cx));
    const y = Math.min(t.height, Math.max(0, cy));
    return (t.corners[y * (t.width + 1) + x] as number) * HEIGHT_STEP;
  }

  function rebuildHighlight(): void {
    if (highlight) {
      scene.remove(highlight);
      highlight.geometry.dispose();
      highlight = null;
    }
    if (!highlightRect || !terrain) return;
    const t = terrain;
    const x0 = Math.max(0, highlightRect[0]);
    const y0 = Math.max(0, highlightRect[1]);
    const x1 = Math.min(t.width, highlightRect[0] + highlightRect[2]);
    const y1 = Math.min(t.height, highlightRect[1] + highlightRect[3]);
    if (x1 <= x0 || y1 <= y0) return;

    // Walk the outline corner by corner so it follows the terrain along every edge.
    const loop: [number, number][] = [];
    for (let x = x0; x < x1; x++) loop.push([x, y0]);
    for (let y = y0; y < y1; y++) loop.push([x1, y]);
    for (let x = x1; x > x0; x--) loop.push([x, y1]);
    for (let y = y1; y > y0; y--) loop.push([x0, y]);

    const positions = new Float32Array(loop.length * 2 * 3);
    loop.forEach(([cx, cy], i) => {
      const [nx, ny] = loop[(i + 1) % loop.length] as [number, number];
      positions.set(
        [
          cx,
          groundHeight(t, cx, cy) + HIGHLIGHT_LIFT,
          cy,
          nx,
          groundHeight(t, nx, ny) + HIGHLIGHT_LIFT,
          ny,
        ],
        i * 6,
      );
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    highlight = new LineSegments(geometry, highlightMaterial);
    highlight.renderOrder = 2;
    scene.add(highlight);
  }

  function setTerrain(t: TerrainData): void {
    const previous = terrain;
    for (const chunk of chunks.values()) disposeChunk(chunk);
    chunks.clear();
    terrain = t;
    const { cx, cy } = chunkCount(t);
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        chunks.set(`${x},${y}`, buildChunk(t, x, y, chunkHash(t, x, y)));
      }
    }
    if (!previous || previous.width !== t.width || previous.height !== t.height) {
      rig.target = {
        x: t.width / 2,
        y: groundHeight(t, Math.round(t.width / 2), Math.round(t.height / 2)),
        z: t.height / 2,
      };
    }
    rebuildHighlight();
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
    rebuildHighlight();
  }

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function render(): void {
    if (disposed) return;
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

    // The sun and its shadow box follow the target.
    const elevation = Math.max(0.12, sky.elevation);
    const flat = Math.cos(elevation);
    sun.position.set(
      rig.target.x + SUN_DISTANCE * flat * Math.sin(sky.azimuth),
      rig.target.y + SUN_DISTANCE * Math.sin(elevation),
      rig.target.z + SUN_DISTANCE * flat * Math.cos(sky.azimuth),
    );
    sun.target.position.set(rig.target.x, rig.target.y, rig.target.z);

    // Keep the haze at the horizon as the camera moves out; the opening values are the floor.
    fog.near = Math.max(22, rig.distance * 1.5);
    fog.far = Math.max(48, rig.distance * 3.5);

    renderer.render(scene, camera);
  }

  function pickAt(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!terrain) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const ray = rayFromCamera(rig, ndcX, ndcY, camera.aspect, rig.fovY);
    const hit = pickTile(ray, terrain);
    return hit ? { x: hit.x, y: hit.y } : null;
  }

  function highlightTile(x: number | null, y?: number, w?: number, h?: number): void {
    highlightRect =
      x === null || y === undefined || w === undefined || h === undefined ? null : [x, y, w, h];
    rebuildHighlight();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const chunk of chunks.values()) disposeChunk(chunk);
    chunks.clear();
    highlightRect = null;
    rebuildHighlight();
    terrainMaterial.dispose();
    waterMaterial.dispose();
    highlightMaterial.dispose();
    sun.shadow.dispose();
    // No forceContextLoss(): the canvas must stay usable for a new scene (React strict mode mounts twice).
    renderer.dispose();
  }

  applySky();
  resize();

  return {
    rig,
    setTerrain,
    updateTerrain,
    setTimeOfDay(t: number): void {
      sky = sunFor(t);
      applySky();
    },
    render,
    resize,
    pickAt,
    highlightTile,
    dispose,
  };
}
