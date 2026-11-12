import {
  Color,
  Vector2,
  Vector3,
  type Material,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from "three";
import type { AtmosphereUniforms } from "./atmosphere.glsl.js";
import type { CameraRig } from "./camera.js";
import type { SunState } from "./sky.js";
import type { TerrainData } from "./terrain/geometry.js";

/**
 * What the scene's modules share: the context each one is created with, the uniforms every shader
 * can read, and the lifecycle a module takes part in. The scene (`scene.ts`) is the only thing
 * that creates modules and calls these methods; a module talks to the others only through the
 * context.
 */

/** How much the renderer spends on looks. Every module honors it. */
export type Quality = "low" | "medium" | "high";

/** The modules a scene is made of. `SceneOptions.modules` switches them off by these names. */
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

/**
 * Uniforms every shader in the scene may read. There is one set per scene, and the objects are
 * shared by reference: put `ctx.uniforms.uTime` itself into a material's uniforms, not a copy, and
 * it follows the scene. The scene writes the clock, the map size and the camera; the atmosphere
 * module writes the sun and sky.
 */
export interface SharedUniforms {
  /** Seconds on the animation clock. */
  uTime: { value: number };
  /** World space, unit, pointing toward the sun (or the moon at night). */
  uSunDir: { value: Vector3 };
  /** Linear, premultiplied by an intensity scale of 0..1. */
  uSunColor: { value: Color };
  /** Linear color of the sky at the horizon, which is also the fog color. */
  uSkyHorizon: { value: Color };
  /** Linear color of the sky overhead. */
  uSkyZenith: { value: Color };
  /** 0 at night to 1 in full day. */
  uDaylight: { value: number };
  /** Park size in tiles. */
  uMapSize: { value: Vector2 };
  /** The camera rig's target, in world space. */
  uCamTarget: { value: Vector3 };
  /** The camera rig's distance from its target. */
  uCamDistance: { value: number };
}

/**
 * GLSL declarations of the shared uniforms, for a shader that reads them. The terrain material
 * includes this already; a `ShaderMaterial` of a module's own prepends it.
 */
export const SHARED_UNIFORMS_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform float uDaylight;
uniform vec2 uMapSize;
uniform vec3 uCamTarget;
uniform float uCamDistance;
`;

/** A fresh set of shared uniforms: a white midday sun, a pale sky, a one-tile map. */
export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new Vector3(0.4, 0.8, 0.45).normalize() },
    uSunColor: { value: new Color(1, 1, 1) },
    uSkyHorizon: { value: new Color(0.6, 0.75, 0.9) },
    uSkyZenith: { value: new Color(0.25, 0.45, 0.8) },
    uDaylight: { value: 1 },
    uMapSize: { value: new Vector2(1, 1) },
    uCamTarget: { value: new Vector3() },
    uCamDistance: { value: 40 },
  };
}

/** The park entrance: the edge tile it stands on and the map edge it faces out of. */
export interface EntrancePlace {
  x: number;
  y: number;
  /** 0 north (toward -Z), 1 east (+X), 2 south (+Z), 3 west (-X). */
  side: 0 | 1 | 2 | 3;
}

/**
 * What a module is told about the frame about to be drawn. The scene fills in one object and
 * hands the same one to every module every frame: read it during `update`, do not keep it.
 */
export interface FrameInfo {
  /** Seconds on the animation clock (the same value as `uTime`). */
  time: number;
  /** Seconds the animation clock moved since the last frame; 0 on the first and when frozen. */
  dt: number;
  /**
   * The `nowMs` this frame was rendered with, in milliseconds: the clock of
   * `SceneHandle.render(nowMs)`, which is also the clock `setGuests(section, atMs)` is stamped
   * on. It is real time, so unlike `time` it is not capped after a stall and it keeps running
   * while the animation clock is frozen. Whatever moves between snapshots is timed with this.
   */
  nowMs: number;
  /** The sun and sky for the scene's time of day. */
  sun: SunState;
}

/** What every module is created with. One per scene. */
export interface RenderContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  rig: CameraRig;
  uniforms: SharedUniforms;
  /**
   * The uniforms the atmosphere's shader chunk (`ATMOSPHERE_GLSL`, with `cwCloudShadow`) reads:
   * one set per scene, made by `createAtmosphereUniforms()` in `atmosphere.glsl.ts`, there from
   * the start whether or not the atmosphere module is on. The terrain material binds these
   * objects; so does any other material that includes `ATMOSPHERE_GLSL`; the atmosphere module
   * writes their values.
   */
  atmosphereUniforms: AtmosphereUniforms;
  /**
   * The quality in force. The scene keeps it current and tells each module of a change through
   * `setQuality`.
   */
  quality: Quality;
  /**
   * True on a software renderer (SwiftShader and the like), where `low` should draw as little as
   * it can: every vertex and pixel is paid for on the CPU. Absent means false.
   */
  readonly software?: boolean;
  /** Latest terrain, or null before the first. */
  terrain(): TerrainData | null;
  /**
   * The height of the ground in world units at world (x, z); 0 before the first terrain. Over the
   * park it is the smooth ground (`groundHeightAt`). Beyond the park's edge it is the outer
   * ground when one is installed (`setOuterGround`), and otherwise the height of the nearest
   * point of the edge. The camera rig keeps its eye above this same function.
   */
  heightAt(x: number, z: number): number;
  /**
   * Installs the height of the land beyond the park, in world units at world (x, z), or takes it
   * away again with null. The scene asks it only for points outside the map (x < 0, z < 0,
   * x > width or z > height), and from then on `heightAt` and the camera's clearance follow it
   * there, so hills out there keep the camera out of them. The function must meet the park's own
   * height along the edge, and it is called a few dozen times a frame, so it has to be cheap. Its
   * owner (the surroundings module) takes it away in `dispose()`.
   */
  setOuterGround(heightAt: ((x: number, z: number) => number) | null): void;
  /** Where the park entrance is, or null when there is none (or none yet). */
  entrance(): EntrancePlace | null;
  /**
   * The one terrain material (see `terrain/material.ts`), for a module that draws more ground with
   * it, as the surroundings do. It exists once the surface, paths and overlay modules do, so call
   * this from a method, not while another of those three is being created.
   */
  terrainMaterial(): Material;
}

/**
 * The lifecycle of a module. A module adds its objects to `ctx.scene` itself and takes them out
 * again in `dispose()`.
 */
export interface SceneModule {
  /** Called on every terrain change, full or partial, with the whole new terrain. */
  setTerrain?(t: TerrainData): void;
  setQuality?(q: Quality): void;
  /** The drawing buffer changed: its size in CSS pixels and the pixel ratio it is drawn at. */
  resize?(width: number, height: number, pixelRatio: number): void;
  /**
   * The park entrance moved, appeared or went (null). Called on every module that has it, after
   * `ctx.entrance()` already answers with the new place.
   */
  setEntrance?(entrance: EntrancePlace | null): void;
  /** Once per rendered frame, before drawing. `frame` is the scene's own object: do not keep it. */
  update?(frame: FrameInfo): void;
  dispose(): void;
}
