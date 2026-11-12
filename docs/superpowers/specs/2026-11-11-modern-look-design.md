# Modern look: renderer redesign

Date: 2026-11-11. Status: design calls by Claude under Steve's standing "make all the decisions" hand-off (2026-10-16). Steve's one stated requirement for this pass: "modern graphics, not something that looks like minecraft."

## 1. Why

The first renderer (Plan B) met the letter of the spec ("stylized 3D with lighting") and missed the look. What makes it read as blocky:

- every tile is two flat-shaded triangles, so hills are facets and steps;
- grass is a two-tone checkerboard, one flat color per tile;
- surfaces change on hard tile-square borders (the sand around the pond is a rectangle);
- water is a flat translucent rectangle;
- the park is a square slab floating in a single-color sky;
- no ambient occlusion, no atmosphere, thin shadows, 1 px white outline for the cursor.

The sim stays exactly as it is: a tile grid with integer corner heights. Only how it is drawn changes. The grid is a build aid that appears when the player is placing something, not the look of the world.

## 2. Target look

A sunlit miniature landscape: smooth rolling ground, lush grass with natural variation, surfaces that blend into each other along organic edges, clear water with a visible bed and a soft shoreline, warm paved paths with rounded corners, small animated guests, a real sky with drifting clouds and their shadows, soft sun shadows, contact shading in the creases, gentle haze toward a horizon of hills and trees. Saturated but natural, never neon. Original art only: no imitation of any existing game's assets, characters or signature look.

Anti-goals (any of these is a failed result): visible facets on terrain; a visible per-tile pattern when no build tool is active; hard square borders between surfaces; single flat color fills on large areas; the world ending in a hard edge against the sky; aliasing/shimmer; heavy bloom; noisy or dirty-looking AO; night so dark the park cannot be read.

## 3. Technical calls

- three.js r186, `WebGLRenderer` (WebGL2), custom GLSL through `MeshStandardMaterial.onBeforeCompile` and `ShaderMaterial`, post-processing with three's own addons (`three/examples/jsm/postprocessing/*`). No new runtime dependencies. Not the WebGPU/TSL renderer in this pass: CI paints in SwiftShader and the WebGL path is the one that can be verified everywhere today.
- **r186 is newer than most model knowledge. Verify every three.js API, shader chunk name and addon against the installed source in `node_modules/three` (`src/renderers/shaders/ShaderChunk/`, `examples/jsm/`). Do not trust memory.** (Known already: `PCFSoftShadowMap` is gone; `PCFShadowMap` is the soft filter.)
- Procedural only: no image files, no binary assets. Noise, patterns and models are generated in code.
- World space is unchanged (`units.ts`): X = tile x, Z = tile y, Y = corner height × `HEIGHT_STEP` (0.25). One tile is one world unit.
- Unit tests cover pure logic only (math, geometry builders, data textures, interpolation). Looks are verified with screenshots from the look-dev harness (section 7).
- Prettier and `pnpm typecheck` must pass. Existing public exports of `@coasterworks/render` that the web app uses keep working (`createScene`, `SceneHandle` methods, `attachControls`, `CameraRig`, `pickTile`, `rayFromCamera`, `groundHeightAt`, `sunFor`, `TerrainData`, units).

## 4. Smooth ground (`heightfield.ts`)

The drawn ground is a smooth surface through the sim's corner heights: separable monotone cubic Hermite (Fritsch-Carlson limited tangents) over the corner grid.

- 1D rule for samples p0 p1 p2 p3, interpolating p1..p2: tangent at p1 is 0 when `(p1-p0)*(p2-p1) <= 0`, otherwise `(p2-p0)/2` clamped in magnitude to `3*min(|p1-p0|,|p2-p1|)`; same at p2. Apply along X on four rows, then along Z.
- Consequences that matter: the surface passes exactly through every corner; a flat tile stays exactly flat (paths and future rides sit level); a single raised tile becomes a soft mound, not a pyramid; no overshoot above the highest or below the lowest corner.
- Off the map the corner grid is extended by clamping to the nearest edge corner.
- `groundHeightAt(t, x, z)` (existing export, world units) becomes this function. `groundNormalAt(t, x, z)` is its analytic or central-difference normal. Everything that stands on the ground (camera, guests, gate, trees, outline) uses these.
- The tile picker keeps its two-triangle DDA (`tileTriangles` stays for it); the difference from the smooth surface is a fraction of a step and picking is per tile. **Superseded (review, 2026-11-12):** on a steep tile the smooth surface's rounded shoulder stands well above the flat triangles (a 16-step ramp mis-picked three tiles away), so `pickTile` now walks the same DDA but looks for where the ray first meets `groundHeightAt`, sampled every 0.02 units and bisected, skipping a tile whose highest corner the ray stays above; the flat triangles remain only for a ray that starts under the ground.

**As built (foundation).** `heightfield.ts` keeps the 1D tangent rule above and every consequence listed, but builds the surface as one bicubic Hermite patch per tile (corner heights, the limited tangent at each corner along X and along Z, zero twist; the result is held to the range of the tile's four corners) instead of interpolating four rows along X and then the results along Z. Reason, measured: the rows-then-columns form leaves a crease along tile borders in one axis wherever the limiter switches exactly at a border, which integer corner heights make common (a slope step of 0.11 on the sample hill, 0.36 on steeper test land, i.e. up to about 20 degrees, on Z-running borders only). The patch form is continuous in slope across every tile border on both axes (measured step under 0.001 on the sample park, on rolling land and on random rough land) and treats X and Z alike. Flat tiles stay exactly flat.

**As built (foundation), the normal the ground is lit with.** `groundNormalAt` is not the exact normal of `groundHeightAt`. The limited tangent is zero along an axis at any corner where the land stops rising on that axis, and on a ridge or valley that runs diagonally across the grid (two faces meeting, which is every corner of every hill and pit the land tools make, the sample hill's four hips included: its faces are straight runs of two steps a tile, not stepped rings) that is every corner on the fold, on both axes. The surface there is a chain of small level spots, one a tile, and its exact normal swings by 0.36 (about 20 degrees) once per tile along the fold: a visible per-tile band, measured on an ideal hip `2*min(x,z)` and seen on the sample hill. No tangent rule removes it while keeping level tiles level, no overshoot and no crease (two level edges leave such a corner at right angles, so a surface with a slope there must bulge above them), and a twist estimate does not help (0.361 against 0.364). So the shape keeps every guarantee above and the light uses a smoother slope: `groundNormalAt` is the normal of the cubic B-spline surface through the 4 by 4 corners around the point (the corner grid clamped at the map's edge, as for the height). Measured: the swing along the same hip is 0.017, on a steeper hip (4 steps a tile) 0.024, on a ridge that also climbs 0.05; it is exact on any plane; it is exactly `[0, 1, 0]` where those 16 corners are level; its direction and its rate of change are continuous everywhere. It differs from the exact normal by 0.5 degrees on average on the sample park, about 5 on steep rolling land, and up to about 25 right on a sharp fold or peak. What follows for module owners: a level tile next to a slope is still exactly level to stand on, but is lit leaning a little toward the slope, fading out across that one tile; the ridge line itself still has the level spots in its silhouette (under 0.4 of a height step, 0.1 world units, on a 2-step hip), which close-up shots should be checked for. It depends only on the terrain and the point, so two meshes sharing a vertex position get bit-identical normals.

## 5. Architecture (`packages/render/src`)

```
units.ts            + SUBDIV = 4 (mesh cells per tile edge)
heightfield.ts      smooth ground                                   [foundation]
ground.ts           re-exports groundHeightAt                       [foundation]
context.ts          RenderContext, SharedUniforms, Quality, SceneModule, FrameInfo   [foundation]
shaders/noise.glsl.ts   shared GLSL noise library                   [foundation]
scene.ts            orchestrator: owns renderer, camera rig, modules [foundation; integrator only afterwards]
terrain/geometry.ts     smooth chunk meshes (indexed, shared vertices, normals continuous across chunks) [foundation]
terrain/material.ts     createTerrainMaterial(ctx): composes the three GLSL chunks below [foundation]
terrain/surface.glsl.ts + terrain/surface-data.ts   ground look      [surface]
terrain/paths.glsl.ts + terrain/path-field.ts       paths           [paths]
terrain/overlay.glsl.ts                             grid + highlight [overlay]
water.ts            water surface                                    [water]
atmosphere.ts (+ sky.ts, atmosphere.glsl.ts)  sky, sun, clouds, fog, IBL, shadows  [atmosphere]
post.ts             composer, AO, bloom, grade, AA, quality governor [post]
guests.ts           instanced guests                                 [guests]
entrance.ts         park gate                                        [guests]
surroundings.ts (+ scenery/*)  land beyond the park, trees, boundary [surroundings]
```

### 5.1 Context and module contract (`context.ts`)

```ts
export type Quality = "low" | "medium" | "high";

export interface SharedUniforms {
  uTime: { value: number }; // seconds on the animation clock
  uSunDir: { value: Vector3 }; // world space, unit, pointing toward the sun (or moon at night)
  uSunColor: { value: Color }; // linear, premultiplied by intensity scale 0..1
  uSkyHorizon: { value: Color }; // linear horizon/fog color
  uSkyZenith: { value: Color }; // linear
  uDaylight: { value: number }; // 0 night .. 1 full day
  uMapSize: { value: Vector2 }; // park size in tiles
  uCamTarget: { value: Vector3 }; // rig target, world
  uCamDistance: { value: number };
}

export interface EntrancePlace {
  x: number;
  y: number;
  side: 0 | 1 | 2 | 3; // 0 north (-Z), 1 east, 2 south, 3 west
}

export interface FrameInfo {
  time: number; // seconds on the animation clock (= uTime); capped, can be frozen
  dt: number;
  nowMs: number; // the nowMs of SceneHandle.render(nowMs): the clock setGuests' atMs is on
  sun: SunState;
}

export interface RenderContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  rig: CameraRig;
  uniforms: SharedUniforms;
  atmosphereUniforms: AtmosphereUniforms; // what ATMOSPHERE_GLSL reads; see 5.2
  quality: Quality;
  /** Latest terrain, or null before the first. */
  terrain(): TerrainData | null;
  /** Ground height in world units at world (x, z): the park's smooth ground, and beyond its edge the outer ground if one is installed; 0 before the first terrain. */
  heightAt(x: number, z: number): number;
  /** Installs (or with null removes) the height of the land beyond the park. */
  setOuterGround(heightAt: ((x: number, z: number) => number) | null): void;
  /** Where the park entrance is, or null. */
  entrance(): EntrancePlace | null;
  terrainMaterial(): Material;
}

export interface SceneModule {
  setTerrain?(t: TerrainData): void; // called on every terrain change (full or partial)
  setQuality?(q: Quality): void;
  resize?(width: number, height: number, pixelRatio: number): void;
  setEntrance?(entrance: EntrancePlace | null): void; // on every module that has it
  update?(frame: FrameInfo): void; // once per rendered frame, before drawing
  dispose(): void;
}
```

**As built (foundation), two additions to `context.ts`:** `RenderContext` also has `terrainMaterial(): Material`, the one terrain material of 5.2, because the surroundings draw with it and get nothing but `ctx` (call it from a method, not while the surface, paths or overlay module is being created). And `SHARED_UNIFORMS_GLSL` holds the GLSL declarations of the shared uniforms, for a module's own `ShaderMaterial` to prepend (bind the `ctx.uniforms.*` objects themselves, not copies). `ctx.quality` is kept current by the scene, which then calls `setQuality` on every module.

**As built (foundation, after review), what else the context hands a module so that no owner has to edit `context.ts` or `scene.ts`:**

- `FrameInfo.nowMs`: the `nowMs` the frame was rendered with. It is the clock `setGuests(section, atMs)` is stamped on, so the guests module interpolates with `(frame.nowMs - atMs)`. It is real time: not capped after a stall, and still running when `frozenTime` freezes `time`. The scene fills in one `FrameInfo` object and passes the same one every frame: read it in `update`, do not keep it.
- `ctx.entrance()` and `SceneModule.setEntrance?(e)`: `scene.setEntrance(e)` stores a copy, then calls `setEntrance` on every module that has one (the paths module for the lane, the gate, and the surroundings if it wants to: to leave a gap in the boundary marker and keep trees off the lane). `ctx.entrance()` already answers with the new place when the call arrives, and a module created or rebuilt later can ask at any time. `EntrancePlace` lives in `context.ts`.
- `ctx.setOuterGround(fn | null)`: the surroundings module installs the height of its land beyond the park (world units at world x, z). From then on `ctx.heightAt` and the camera rig's clearance (`rig.heightAt` is the same function) use the park's smooth ground over the map, edge included, and `fn` outside it, so the camera cannot end up inside a hill out there. `fn` is asked only for points outside the map, must meet the park's height along the edge, runs a few dozen times a frame (keep it cheap: no allocation, no mesh lookups), and is taken away again in the module's `dispose()`. Nobody writes `rig.heightAt` directly.
- `ctx.atmosphereUniforms`: see 5.2.

Each module file exports one `createX(ctx): XModule` where `XModule extends SceneModule` with its own setters. Modules add their objects to `ctx.scene` themselves and remove them in `dispose()`. A module never edits another module's files; it talks to others only through `ctx`.

### 5.2 Terrain shader composition (`terrain/material.ts`)

One `MeshStandardMaterial` patched in `onBeforeCompile`, used by the park terrain and by the surroundings. The fragment stage runs three chunk functions in this order on a shared struct:

```glsl
struct CwSurf {
  vec3 albedo;      // linear
  float roughness;
  vec3 normal;      // world space, unit (start: interpolated geometric normal)
  float occlusion;  // 1 = none; multiplies albedo
  vec3 emissive;    // linear, added unlit
};
void cwSurface(inout CwSurf s, vec3 worldPos);   // terrain/surface.glsl.ts
void cwPaths(inout CwSurf s, vec3 worldPos);     // terrain/paths.glsl.ts
void cwOverlay(inout CwSurf s, vec3 worldPos);   // terrain/overlay.glsl.ts
```

Each chunk file exports `{ glsl: string; uniforms: Record<string, IUniform> }`; `glsl` declares its own uniforms and helper functions (prefix every identifier with the chunk's name, e.g. `cwSurf_`, `cwPath_`, `cwOvl_`). `material.ts` prepends the noise library and the shared-uniform declarations, merges all uniforms, and wires `s` into `diffuseColor`, `roughnessFactor`, `normal` (converted to view space) and `totalEmissiveRadiance`. The atmosphere module exports `ATMOSPHERE_GLSL` with `float cwCloudShadow(vec2 worldXZ)` (1 = full sun), which `material.ts` also includes and applies to the direct sun term (or to albedo if patching the light loop is not robust).

**As built (foundation, after review): the atmosphere chunk's own uniforms.** `cwCloudShadow` may read the shared uniforms, the noise library and uniforms of its own (cloud cover, wind, an octave count by quality). Those are declared in `ATMOSPHERE_GLSL` (prefix `cwAtm_`) and made by `createAtmosphereUniforms()` in `atmosphere.glsl.ts`: one entry per declaration, under the same name, at a starting value that gives a sensible result on its own (it is what a scene with the atmosphere module switched off draws with). The scene calls it once and keeps the set as `ctx.atmosphereUniforms`, which exists before any module does; its type follows the function's return type, so the atmosphere owner adds a uniform by editing `atmosphere.glsl.ts` alone. `createTerrainMaterial` binds those objects by reference. The atmosphere module drives the chunk by writing `ctx.atmosphereUniforms.<name>.value`. Any other material that pastes `ATMOSPHERE_GLSL` (the water does, to receive cloud shadow) binds the same objects: `uniforms: { ...ctx.uniforms, ...ctx.atmosphereUniforms, ...its own }`.

Outside the park rectangle (`worldPos.xz` outside `[0,uMapSize]`) `cwSurface` draws wild meadow, `cwPaths` draws only the entrance lane, and `cwOverlay` draws nothing.

### 5.3 Scene handle (`scene.ts`)

Existing `SceneHandle` methods stay. Added:

```ts
setPaths(paths: Uint8Array | null): void;          // one byte per tile: 0 none, 1 footpath, 2 queue
setGuests(guests: GuestSection | null, atMs?: number): void;   // latest snapshot section
setEntrance(e: { x: number; y: number; side: 0|1|2|3 } | null): void;
setGridVisible(on: boolean): void;                 // build grid; off by default
setQuality(q: Quality | "auto"): void;             // default "auto"
pickGuestAt(clientX: number, clientY: number): { id: number } | null;
render(nowMs?: number): void;                      // nowMs drives the animation clock; omitted = performance.now()
readonly info: { quality: Quality; gl: string; frameMs: number };
```

`SceneOptions` gains `quality?: Quality | "auto"`, `modules?: Partial<Record<ModuleName, boolean>>` (look-dev: switch modules off), `frozenTime?: number` (seconds; freezes the animation clock for deterministic shots).

### 5.4 Final module signatures (as built by the foundation)

Every body below marked _placeholder_ is a few dozen working lines meant to be replaced wholesale by its owner; the exported names, types and signatures are final, except the ones marked _owner's to reshape_. Those are the placeholder data helpers behind a module (`buildSurfaceWeights`; `buildPathTiles`, `PathTiles`, `PATH_MARGIN`; `buildWaterGeometry`, `WaterGeometry`; `buildSurroundingsGeometry`, `SurroundingsGeometry`): used only inside their own module, they are rewritten, renamed or dropped by its owner as section 6 asks (the path field, for one, becomes an 8-texel-per-tile two-channel distance field). Everything final is re-exported from `packages/render/src/index.ts`; the helpers to reshape are not, so no module owner edits `index.ts`. Each module's data helper has a test file of its own (`test/surface-data.test.ts`, `test/path-field.test.ts`, `test/water.test.ts`, `test/surroundings.test.ts`) that describes the placeholder and is rewritten with it; an owner adds further test files of their own and touches no other module's. Lifecycle, for every module: created once in `createScene` in the order surface, paths, overlay, (terrain material), atmosphere, water, surroundings, entrance, guests, post; `setTerrain(t)` after every `setTerrain`/`updateTerrain` on the scene (always the whole new terrain; a module diffs for itself); `setEntrance(e)` on every module that has one, when `scene.setEntrance` is called; `resize(width, height, pixelRatio)` in CSS pixels; `update(frame)` once per frame in that same order, before drawing; `setQuality(q)` when the quality in force changes; `dispose()` in reverse order. A module switched off with `SceneOptions.modules` is never created and the scene's setters for it do nothing.

```ts
// units.ts
export const SUBDIV = 4;

// heightfield.ts (ground.ts re-exports both)
export function groundHeightAt(t: TerrainData, x: number, z: number): number; // world units
export function groundNormalAt(t: TerrainData, x: number, z: number): [number, number, number]; // unit; the normal the ground is lit with (section 4)

// context.ts
export type Quality = "low" | "medium" | "high";
export type ModuleName =
  | "surface"
  | "paths"
  | "overlay"
  | "water"
  | "atmosphere"
  | "post"
  | "guests"
  | "entrance"
  | "surroundings";
export interface SharedUniforms {
  /* exactly as 5.1 */
}
export const SHARED_UNIFORMS_GLSL: string;
export function createSharedUniforms(): SharedUniforms;
export interface EntrancePlace {
  x: number;
  y: number;
  side: 0 | 1 | 2 | 3;
} // 0 north (-Z), 1 east, 2 south, 3 west
export interface FrameInfo {
  time: number;
  dt: number;
  nowMs: number;
  sun: SunState;
} // one object, refilled each frame
export interface RenderContext {
  /* exactly as 5.1 */
}
export interface SceneModule {
  /* exactly as 5.1 */
}

// shaders/noise.glsl.ts: GLSL ES 3.00, integer hashes, no textures, values in 0..1 (ends included, never outside: safe for pow and sqrt)
export const NOISE_GLSL: string;
//   float cwHash12(vec2 p);            vec2 cwHash22(vec2 p);
//   float cwValueNoise(vec2 p);        float cwGradNoise(vec2 p);
//   vec3  cwGradNoiseD(vec2 p);        // x = value, yz = d/dp (zero on the rare sample held at 0 or 1)
//   float cwFbm(vec2 p, int octaves);  vec3 cwFbmD(vec2 p, int octaves);   // up to 8 octaves
//   vec2  cwVoronoi(vec2 p);           // x = F1 distance, y = cell id 0..1

// terrain/geometry.ts
export interface TerrainData {
  width: number;
  height: number;
  corners: Int16Array;
  surface: Uint8Array;
  water: Uint8Array;
}
export interface TerrainChunkGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  tileCount: number;
}
export function buildTerrainChunk(
  t: TerrainData,
  chunkX: number,
  chunkY: number,
): TerrainChunkGeometry;
export function tileTriangles(t: TerrainData, x: number, y: number, out: Float64Array): void; // picker only
export function chunkCount(t: TerrainData): { cx: number; cy: number };

// terrain/material.ts
export interface TerrainChunk {
  glsl: string;
  uniforms: Record<string, IUniform>;
}
export interface TerrainChunks {
  surface: TerrainChunk | null;
  paths: TerrainChunk | null;
  overlay: TerrainChunk | null;
}
export const CW_SURF_GLSL: string; // the CwSurf struct
export function createTerrainMaterial(
  ctx: RenderContext,
  chunks: TerrainChunks,
): MeshStandardMaterial;

// terrain/surface.glsl.ts + terrain/surface-data.ts            [placeholder: one flat color per surface, nearest]
export type SurfaceModule = TerrainChunk & SceneModule; // glsl defines: void cwSurface(inout CwSurf s, vec3 worldPos)
export function createSurface(ctx: RenderContext): SurfaceModule;
// owner's to reshape, not in index.ts:
export function buildSurfaceWeights(t: TerrainData): Uint8Array; // RGBA per tile: sand, dirt, rock, snow

// terrain/paths.glsl.ts + terrain/path-field.ts                [placeholder: flat tan/blue tile squares, nearest]
export type PathsModule = TerrainChunk &
  SceneModule & {
    // glsl defines: void cwPaths(inout CwSurf s, vec3 worldPos)
    setPaths(paths: Uint8Array | null): void; // one byte per tile: 0 none, 1 footpath, 2 queue
    setEntrance(entrance: EntrancePlace | null): void;
  };
export function createPaths(ctx: RenderContext): PathsModule;
// owner's to reshape, not in index.ts (EntrancePlace is final and lives in context.ts):
export const PATH_MARGIN = 4; // tiles of lane the placeholder texture covers off the map
export interface PathTiles {
  data: Uint8Array;
  width: number;
  height: number;
}
export function buildPathTiles(
  paths: Uint8Array | null,
  width: number,
  height: number,
  entrance: EntrancePlace | null,
): PathTiles;

// terrain/overlay.glsl.ts                                      [placeholder: plain grid lines, plain white border]
export type OverlayModule = TerrainChunk &
  SceneModule & {
    // glsl defines: void cwOverlay(inout CwSurf s, vec3 worldPos)
    setGridVisible(on: boolean): void;
    setHighlight(rect: { x: number; y: number; w: number; h: number } | null): void; // tiles
    setCursor(point: { x: number; z: number } | null): void; // world; null = center the grid on the camera target
  };
export function createOverlay(ctx: RenderContext): OverlayModule;

// water.ts                                                     [placeholder: flat translucent mesh, water tiles + 1-tile apron]
export type WaterModule = SceneModule;
export function createWater(ctx: RenderContext): WaterModule;
// owner's to reshape, not in index.ts:
export interface WaterGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  tileCount: number;
}
export function buildWaterGeometry(t: TerrainData): WaterGeometry | null;

// atmosphere.ts + atmosphere.glsl.ts (+ sky.ts: sunFor, SunState unchanged)   [placeholder: the first renderer's lighting]
export type AtmosphereModule = SceneModule & { setTimeOfDay(t: number): void };
export function createAtmosphere(ctx: RenderContext): AtmosphereModule;
export const ATMOSPHERE_GLSL: string; // float cwCloudShadow(vec2 worldXZ)  -> 1.0 for now
export function createAtmosphereUniforms(): {
  /* one IUniform per uniform ATMOSPHERE_GLSL declares, by name (5.2); none for now */
};
export type AtmosphereUniforms = ReturnType<typeof createAtmosphereUniforms>;

// post.ts + quality.ts                                         [placeholder draw: renderer.render + ACES; meter and governor real]
export interface RenderInfo {
  quality: Quality;
  gl: string;
  frameMs: number;
}
export type PostModule = SceneModule & {
  render(): void; // draws the frame; called by the scene after every update()
  request(quality: Quality | "auto"): void; // what the player asked for
  readonly info: RenderInfo; // info.quality = the quality post wants in force
};
export function createPost(ctx: RenderContext): PostModule;
export function glRendererString(renderer: WebGLRenderer): string;
export function detectQuality(glRenderer: string): Quality; // software or unknown -> "low", else "high"
export interface GovernorState {
  quality: Quality;
  ceiling: Quality; /* ... */
}
export function createGovernor(quality: Quality, nowMs: number): GovernorState;
export function stepGovernor(
  state: GovernorState,
  frameMs: number,
  nowMs: number,
  pausedMs?: number,
): GovernorState; // pure; pausedMs = FrameMeter.pausedMs of the same frame
export interface FrameMeter {
  sample(nowMs: number): number;
  readonly frameMs: number;
  readonly pausedMs: number; // how long drawing had stopped before the last sample (a hidden tab), else 0
}
export function createFrameMeter(): FrameMeter;

// guests.ts                                                    [placeholder: capsules, no interpolation, no heading]
export type GuestsModule = SceneModule & {
  setGuests(section: GuestSection | null, atMs: number): void; // atMs: same clock as SceneHandle.render(nowMs)
  pickAt(ray: Ray): { id: number } | null; // Ray from picker.ts; direction need not be unit
};
export function createGuests(ctx: RenderContext): GuestsModule;
export const GUEST_CAPACITY = 2000;

// entrance.ts                                                  [placeholder: two boxes and a lintel]
export type EntranceModule = SceneModule & { setEntrance(entrance: EntrancePlace | null): void };
export function createEntrance(ctx: RenderContext): EntranceModule;

// surroundings.ts                                              [placeholder: level ring at the edge heights]
export type SurroundingsModule = SceneModule;
export function createSurroundings(ctx: RenderContext): SurroundingsModule;
export const SURROUNDINGS_REACH = 150;
// owner's to reshape, not in index.ts:
export interface SurroundingsGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}
export function buildSurroundingsGeometry(t: TerrainData): SurroundingsGeometry;

// scene.ts
export interface SceneOptions {
  pixelRatioCap?: number;
  quality?: Quality | "auto";
  modules?: Partial<Record<ModuleName, boolean>>;
  frozenTime?: number;
}
export interface SceneHandle {
  /* the methods of 5.3; `info` is a RenderInfo: one object whose fields read the present values */
}
export function createScene(canvas: HTMLCanvasElement, opts?: SceneOptions): SceneHandle;
```

How the terrain shader is wired (`terrain/material.ts`, verified against r186's `meshphysical.glsl.js`; a missing include throws at compile time and `test/terrain-material.test.ts` checks the installed three):

- Vertex: after `#include <common>` the varyings `cwWorldPos`, `cwWorldNormal`; after `#include <project_vertex>` they are set from `modelMatrix`, `transformed`, `objectNormal`.
- Fragment declarations, after `#include <clipping_planes_pars_fragment>` (the last of three's own): the two varyings, `SHARED_UNIFORMS_GLSL`, `NOISE_GLSL`, `ATMOSPHERE_GLSL`, `CW_SURF_GLSL`, then the surface, paths and overlay chunks. So a chunk may use all of those plus `vViewPosition`, `cameraPosition`, `viewMatrix` and three's `common` helpers, and `texture(...)`.
- Fragment main, after `#include <emissivemap_fragment>`: `CwSurf` starts as `{ diffuseColor.rgb, roughnessFactor, normalize(cwWorldNormal), 1.0, vec3(0) }`, runs `cwSurface`, `cwPaths`, `cwOverlay`, then `diffuseColor.rgb = albedo * occlusion`, `roughnessFactor = clamp(roughness, 0.04, 1.0)`, `normal = normalize((viewMatrix * vec4(s.normal, 0.0)).xyz)`, `totalEmissiveRadiance += emissive`.
- Cloud shadow, after `#include <lights_fragment_begin>`: `reflectedLight.directDiffuse` and `directSpecular` are multiplied by `cwCloudShadow(cwWorldPos.xz)`. Hemisphere and ambient light are indirect in three and are untouched. This holds as long as the sun (or moon) is the scene's only direct light.
- Chunk uniforms are bound by reference in `onBeforeCompile`; a module changes its look by writing `uniforms.x.value` (to swap a texture, assign a new one to `.value`). Changing a chunk's GLSL needs a new material. `customProgramCacheKey` is a hash of all the GLSL.
- A chunk whose module is off is replaced by an empty function.

How the scene uses the modules (`scene.ts`), which a module owner can rely on:

- Chunks: 16 by 16 tiles, one indexed mesh each, `castShadow` and `receiveShadow` on, all with the one terrain material. A chunk is rebuilt when a corner within 2 of it changes. Surface and water bytes rebuild no chunk: modules get them through `setTerrain`.
- `uMapSize`, `uTime`, `uCamTarget`, `uCamDistance` are written by the scene (before `update`); `uSunDir`, `uSunColor`, `uSkyHorizon`, `uSkyZenith`, `uDaylight` by the atmosphere module. With the atmosphere off the scene adds a plain stand-in hemisphere and directional light so other modules can still be looked at.
- `highlightTile(x, y, w, h)` calls `overlay.setHighlight(rect)` and `overlay.setCursor(center of rect)`; `highlightTile(null)` clears both.
- `setEntrance(e)` stores a copy of `e` (what `ctx.entrance()` returns) and then goes to every module that has a `setEntrance`: the paths module, the entrance module, and any other that declares one. `setGuests(section, atMs ?? performance.now())`. A section passed to `setGuests` is never written to again by whoever passed it (each snapshot is a new section with new arrays; the look-dev demo does the same), so the guests module may keep the last two by reference; it must not write to them either.
- Quality: the scene starts `ctx.quality` from `detectQuality(gl)` on "auto" or from the named quality, calls `post.request(requested)`, and after each `post.render()` applies `post.info.quality` to `ctx.quality` and every module's `setQuality` if it changed. With post off it draws with `renderer.render` and keeps its own frame meter.
- The renderer is created with `antialias: true`, shadow maps on, `PCFShadowMap`. Tone mapping and exposure belong to the post module.
- A module's own `ShaderMaterial` (sky, water, guests, trees) must end its fragment `main` with `#include <tonemapping_fragment>` and then `#include <colorspace_fragment>`. In r186 the renderer applies tone mapping and the output color space only when it draws to the canvas (`WebGLPrograms.js`: `toneMapping` is the renderer's only when there is no render target and `material.toneMapped` is true), and only through those two chunks; three adds their declarations to every `ShaderMaterial` itself (not to a `RawShaderMaterial`). At `low` the post module draws straight to the canvas, so a material without them comes out linear and untoned there while looking right at `medium` and `high`, where the composer's output pass does both. `low` is also what SwiftShader in CI gets. A material that should haze sets `fog: true`, merges `UniformsLib.fog` into its uniforms, and includes `<fog_pars_vertex>` and `<fog_vertex>` (which needs `mvPosition`) in the vertex stage and `<fog_pars_fragment>` and, before the two above, `<fog_fragment>` in the fragment stage.
- Quality on "auto" must not be marked down by a hidden tab: the post module passes `meter.pausedMs` to `stepGovernor` with every frame (`post.ts` does; whoever rewrites `render()` keeps that call as it is).
- `ctx.heightAt` (and the camera's clearance) is the park's smooth ground over the map and the surroundings' outer ground beyond its edge once `ctx.setOuterGround` has been called (5.1).
- The animation clock starts at 0 (or `frozenTime`) and advances by the real time between `render(nowMs)` calls, at most 0.1 s a frame.

## 6. Modules

Every module honors `Quality` and must look right at all times of day.

**Surface** (`cwSurface`). Per-tile surface weights come from a data texture built on the CPU (`surface-data.ts`: sand, dirt, rock, snow in RGBA; grass is the remainder), sampled with linear filtering at noise-warped coordinates and height-blended so borders are organic, never square. Grass: several hues mixed by multi-octave noise at two or three scales, slightly drier on rises, subtle mow/wind streak, fine grain up close that fades with distance (no shimmer). Steep slopes show earth then rock regardless of the painted surface. Sand darkens and smooths near water (a second data texture carries a blurred water-proximity field). Normal detail by bump from noise derivatives. No per-tile pattern.

**Paths** (`cwPaths` + `path-field.ts`). The CPU bakes a signed distance field, 8 texels per tile, from the path grid: distance to the union of segments joining adjacent path-tile centers, tile-center points, and filled squares between the centers of every 2×2 block of path tiles (so plazas are solid), minus the half width (~0.40 tile). R = signed distance mapped to 0..255 over ±0.5 tile, G = kind (footpath/queue), linear filtered. The shader draws: anti-aliased rounded edge, a lighter curb band with a faked bevel (normal from the field's gradient), a paver pattern that follows world space with per-stone tint variation, contact darkening on the grass side. Queue paths get a distinct colored surface. The entrance lane (from the entrance tile outward a few tiles) is part of the field. `scene.setPaths` rebuilds the field.

**Overlay** (`cwOverlay`). The build grid: thin soft lines at tile borders, strongest near the cursor and fading out over ~12 tiles and with camera distance, only when `setGridVisible(true)`. The highlight rectangle (replaces the 1 px line loop): soft translucent fill, a brighter rounded border with a slow pulse, draped on the ground by construction. Both are uniforms; nothing is rebuilt per hover.

**Water** (`water.ts`). A flat mesh per water body at `SUBDIV` resolution, extended one tile past the water tiles so the visible shoreline is where the smooth ground meets the level, not a tile edge. Per-vertex depth (level minus ground) drives: color from clear shallow turquoise to deeper blue-green, opacity (bed visible in the shallows), an animated foam line at the shore. Ripple normals from scrolling noise, Fresnel reflection of the sky colors, a sun glint. Receives cloud shadow. Calm, not ocean waves.

**Atmosphere** (`atmosphere.ts`, `sky.ts`, `atmosphere.glsl.ts`). `sunFor(t)` keeps its signature and gains what the modules need (moon at night, sky colors). A sky dome with a physically motivated gradient and sun disc, soft procedural clouds that drift, stars at night. Image-based ambient light from the sky (PMREM, refreshed only when the sun has moved enough). One shadowed directional sun whose shadow frustum is fitted to what the camera sees and snapped to texels (no swimming), soft edges, size by quality. Fog/haze toward the horizon color. `cwCloudShadow` moves cloud shadows across the land. Dusk is warm; night is cool moonlight, readable.

**Post** (`post.ts`). `EffectComposer` on a multisampled half-float target: scene, ground-truth AO (subtle, clean), restrained bloom (sun glints and bright sky only), a finish pass (gentle tilt-shift toward the top and bottom of the frame scaled by zoom, slight vignette, a small contrast/saturation grade), tone mapping and sRGB out, edge AA. Tiers: `low` = direct render, no composer (also what SwiftShader gets); `medium` = AO at half resolution, no tilt-shift; `high` = everything. "auto" starts from the GPU string (software renderers get `low`) and a frame-time governor steps down after sustained slow frames (never up more than once per minute). Target: 60 fps on an M1 Air at 1440×900, mid-size park, `high` or `medium`.

**Guests** (`guests.ts`) and **gate** (`entrance.ts`). One `InstancedMesh`, capacity 2,000, of a small smooth figure (rounded body, head, legs, arms; about 150 to 250 triangles) with per-instance position, heading, clothing color (9-color palette, pleasant and distinct), skin/hair variation from the id, and a walk cycle animated in the vertex shader (leg and arm swing, slight bob) that idles when standing. Positions interpolate between the last two snapshots by guest id (`interpolateGuests`, pure, tested), timed with `frame.nowMs` against the snapshots' `atMs` (the same clock; never `frame.time`, which is capped and can be frozen); heading follows velocity, smoothed. Guests stand on the smooth ground and cast shadows. `pickGuestAt` is a CPU ray test. The gate is a procedural arch at the entrance tile facing its edge: rounded pillars, a curved sign board, a couple of flags that wave; smooth-shaded.

**Surroundings** (`surroundings.ts`). Land beyond the park so the world never ends: a ring mesh from the park border out to roughly 150 tiles, whose inner vertices coincide with the park mesh's border vertices and heights, staying level for the first few tiles (the entrance lane) and then rising into gentle procedural hills; drawn with the terrain material. Instanced trees (two or three species built from displaced, smooth-shaded primitives with vertex-color shading and a wind sway), bushes and rocks scattered deterministically, sparse near the park and denser farther out, with cheap far versions. A low boundary marker along the park edge (posts or hedge) so the buildable area reads without the grid, with a gap at the entrance (`ctx.entrance()`, and an optional `setEntrance` to hear of changes), whose lane also stays clear of trees. Because its hills are higher than the park's edge, the module installs their height with `ctx.setOuterGround(fn)` (5.1) so the camera stays out of them, and removes it in `dispose()`; its own trees, bushes and rocks stand on that same function. Nothing is placed inside the park: the sim owns what stands there.

## 7. Look-dev harness (apps/web)

`apps/web/lookdev.html` + `src/lookdev/main.ts` (+ `src/lookdev/demo.ts`): mounts only the render scene (no UI, no worker) on the sample park built in the page. Development only: the production build has the one entry `index.html` and does not include it. URL parameters:

| Parameter                         | Meaning                                                                                                                                                                                                                                                                                                              | Default              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `tod=0.4`                         | time of the visual day, 0..1 (0 dawn, 0.5 noon, about 0.93 sunset, 0 night)                                                                                                                                                                                                                                          | 0.4                  |
| `cam=x,z,distance,yaw,pitch`      | camera: target tile, distance, angles in radians, set on the rig as given (a player's own limits are pitch 0.26..1.4 and distance 4..200); parts left out keep their defaults                                                                                                                                        | `32,32,90,0.785,0.7` |
| `quality=low\|medium\|high\|auto` | `SceneOptions.quality`                                                                                                                                                                                                                                                                                               | auto                 |
| `still=<seconds>`                 | freezes the animation clock at that value (`frozenTime`) and stops the demo crowd, so every frame is the same picture                                                                                                                                                                                                | off                  |
| `modules=a,b,c`                   | only these modules are created; `modules=-post,-water` creates all but these                                                                                                                                                                                                                                         | all                  |
| `demo=1`                          | a synthetic path network (avenue, 3 by 3 plaza at tile 31..33 by 38..40, a loop around the pond, a second loop, a branch past the hill, two queues), an entrance at (32, 63) on the south edge, and 150 guests walking it, updated every 50 ms through `setGuests` with a new section each time, as snapshots arrive | off                  |
| `grid=1`                          | `setGridVisible(true)`                                                                                                                                                                                                                                                                                               | off                  |
| `hl=x,y,w,h`                      | `highlightTile(x, y, w, h)`                                                                                                                                                                                                                                                                                          | none                 |
| `seed=7`                          | the sample park's seed                                                                                                                                                                                                                                                                                               | 7 (the app's park)   |

It sets `window.__lookdev = { ready, gl, frameMs, quality, frames }`; `ready` turns true after three drawn frames.

`apps/web/scripts/lookdev-shot.mjs` takes a PNG of that page with Playwright's Chromium on the real GPU. The dev server must already be running on the port given (vite has `strictPort` on 5173, so always pass a port):

```sh
# from the repository root
pnpm --filter @coasterworks/web exec vite --port 5273 --strictPort     # leave running; stop it when done
node apps/web/scripts/lookdev-shot.mjs --port 5273 --preset overview --out /tmp/shots/overview.png
node apps/web/scripts/lookdev-shot.mjs --port 5273 --preset hill --query "tod=0.8&modules=-post" --out /tmp/shots/hill-late.png
```

| Option              | Meaning                                                                 | Default    |
| ------------------- | ----------------------------------------------------------------------- | ---------- |
| `--port <n>`        | port of the dev server                                                  | required   |
| `--out <file.png>`  | where to write the PNG (its folder is created)                          | required   |
| `--preset <name>`   | `overview`, `lake`, `hill`, `paths`, `edge`, `dusk`, `night`, `closeup` | `overview` |
| `--query "a=b&c=d"` | page parameters laid over the preset's                                  | none       |
| `--size <WxH>`      | viewport in CSS pixels                                                  | `1440x900` |
| `--dpr <n>`         | device pixel ratio                                                      | 1          |
| `--frames <n>`      | frames to let pass after `ready` before the shot                        | 30         |
| `--software`        | paint with SwiftShader, as CI does, instead of the GPU                  | off        |

Presets (all `tod=0.4` unless said): `overview` `cam=32,32,90,0.785,0.7`; `lake` `cam=37,29,22,0.6,0.6`; `hill` `cam=19,15,36,0.9,0.55`; `paths` `demo=1&cam=33,36,30,0.785,0.75`; `edge` `demo=1&cam=32,58,34,3.6,0.27` (low across the south edge to the horizon, gate in view); `dusk` `tod=0.93&demo=1&cam=32,32,70,2.4,0.5`; `night` `tod=0&demo=1&cam=32,34,60,0.785,0.65`; `closeup` `demo=1&cam=32,39,8,0.785,0.5`. On the sample park (seed 7) the hill's peak is at about tile (19, 15) and the pond's water is tiles 33..40 by 27..30.

It prints one line of JSON, `{"out","url","gl","frameMs","quality","errors"}`: `gl` is the WebGL renderer string (on a Mac it must name Metal and the GPU, e.g. `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, ...)`; SwiftShader there means the launch flags stopped working), `frameMs` the smoothed time between frames, `errors` the page's console errors and uncaught exceptions (a shader that fails to compile lands here). With any error the exit code is 1 and the PNG is still written. It launches `chromium` with `channel: "chromium"` (the full browser in new headless mode) and `--use-angle=metal --enable-gpu --ignore-gpu-blocklist` on macOS. Agents look at the PNG (Read tool) to judge their work.

## 8. Web wiring and content

- `Viewport` feeds `setPaths`, `setGuests` (latest section each frame), `setEntrance`, `setGridVisible(placement !== null)`; a Graphics quality setting (Auto/Low/Medium/High) next to the pixel-ratio setting.
- The sample park gains what Plan D1 Task 8 describes (an entrance on the south edge, paths to the pond and around the hill, fee $5, park open) so the opening view has paths and guests.
- The Paths tray, guest inspector and the rest of Plan D1 Task 7 are not part of this pass.

## 9. Out of scope

Rides, shops, scenery placement, coaster track, weather, the WebGPU renderer, GPU id-buffer picking, LOD for 256×256 parks (chunks are frustum-culled; revisit in the performance pass).
