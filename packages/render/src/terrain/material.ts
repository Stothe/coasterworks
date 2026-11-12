import { MeshStandardMaterial, type IUniform } from "three";
import { ATMOSPHERE_GLSL } from "../atmosphere.glsl.js";
import { SHARED_UNIFORMS_GLSL, type RenderContext } from "../context.js";
import { NOISE_GLSL } from "../shaders/noise.glsl.js";

/**
 * The terrain material: one `MeshStandardMaterial` whose look comes from three GLSL chunks, each
 * owned by a module. The park's ground and the land around it are both drawn with it.
 *
 * Every chunk works on one struct, in this order:
 *
 * ```glsl
 * struct CwSurf {
 *   vec3 albedo;      // linear
 *   float roughness;
 *   vec3 normal;      // world space, unit (starts as the interpolated geometric normal)
 *   float occlusion;  // 1 = none; multiplies albedo
 *   vec3 emissive;    // linear, added unlit
 * };
 * void cwSurface(inout CwSurf s, vec3 worldPos);   // terrain/surface.glsl.ts
 * void cwPaths(inout CwSurf s, vec3 worldPos);     // terrain/paths.glsl.ts
 * void cwOverlay(inout CwSurf s, vec3 worldPos);   // terrain/overlay.glsl.ts
 * ```
 *
 * A chunk's GLSL may use, without declaring them: the shared uniforms (`uTime`, `uSunDir`,
 * `uMapSize` and the rest of `SharedUniforms`), the noise library (`cwHash12`, `cwFbm`, ...),
 * `cwCloudShadow`, the struct `CwSurf`, the varyings `cwWorldPos` and `cwWorldNormal`, and what
 * three.js itself has declared by then (`vViewPosition`, `cameraPosition`, `viewMatrix`). It
 * declares its own uniforms and helpers, each named with the chunk's prefix.
 */

/** One module's part of the terrain shader. */
export interface TerrainChunk {
  /**
   * GLSL ES 3.00 source: the chunk's uniform declarations and helpers, and its one entry function
   * (`cwSurface`, `cwPaths` or `cwOverlay`).
   */
  glsl: string;
  /** The uniforms `glsl` declares, by name. The material keeps these very objects. */
  uniforms: Record<string, IUniform>;
}

/** The three chunks of the terrain shader. A null chunk leaves the surface as it is. */
export interface TerrainChunks {
  surface: TerrainChunk | null;
  paths: TerrainChunk | null;
  overlay: TerrainChunk | null;
}

/** The struct the chunks share. Declared once, ahead of all of them. */
export const CW_SURF_GLSL = /* glsl */ `
struct CwSurf {
  vec3 albedo;
  float roughness;
  vec3 normal;
  float occlusion;
  vec3 emissive;
};
`;

/** What stands in for a chunk whose module is switched off. */
const EMPTY_CHUNKS = {
  surface: /* glsl */ `void cwSurface(inout CwSurf s, vec3 worldPos) {}`,
  paths: /* glsl */ `void cwPaths(inout CwSurf s, vec3 worldPos) {}`,
  overlay: /* glsl */ `void cwOverlay(inout CwSurf s, vec3 worldPos) {}`,
} as const;

/**
 * Puts `addition` right after the line `#include <name>` in `source`. Throws when the include is
 * not there: the names are three.js internals, and a version that renamed one must fail here, at
 * compile time, with a message that says what to look for, not draw unpatched ground in silence.
 */
function after(source: string, name: string, addition: string, stage: string): string {
  const include = `#include <${name}>`;
  if (!source.includes(include)) {
    throw new Error(
      `Terrain material: three.js's standard ${stage} shader has no "${include}". ` +
        `The shader was written against three r186; see packages/render/src/terrain/material.ts.`,
    );
  }
  return source.replace(include, `${include}\n${addition}`);
}

/** Fails when `source` lacks an include whose variables the patch relies on. */
function requires(source: string, name: string, stage: string): void {
  after(source, name, "", stage);
}

/** A short, stable key for a string (FNV-1a, 32 bits). */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 cwWorldPos;
varying vec3 cwWorldNormal;
`;

// The ground is never scaled unevenly, so the model matrix turns normals as it turns positions.
const VERTEX_MAIN = /* glsl */ `
cwWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
cwWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
`;

// Runs after three.js has set up diffuseColor, roughnessFactor, normal and totalEmissiveRadiance,
// and before any lighting reads them.
const FRAGMENT_MAIN = /* glsl */ `
{
  CwSurf cwS;
  cwS.albedo = diffuseColor.rgb;
  cwS.roughness = roughnessFactor;
  cwS.normal = normalize( cwWorldNormal );
  cwS.occlusion = 1.0;
  cwS.emissive = vec3( 0.0 );
  cwSurface( cwS, cwWorldPos );
  cwPaths( cwS, cwWorldPos );
  cwOverlay( cwS, cwWorldPos );
  diffuseColor.rgb = cwS.albedo * cwS.occlusion;
  roughnessFactor = clamp( cwS.roughness, 0.04, 1.0 );
  normal = normalize( ( viewMatrix * vec4( cwS.normal, 0.0 ) ).xyz );
  totalEmissiveRadiance += cwS.emissive;
}
`;

// The only direct light in the scene is the sun (or the moon), so dimming all direct light by the
// cloud shadow dims exactly that. Sky light is indirect and is left alone.
const FRAGMENT_CLOUD_SHADOW = /* glsl */ `
{
  float cwCloud = cwCloudShadow( cwWorldPos.xz );
  reflectedLight.directDiffuse *= cwCloud;
  reflectedLight.directSpecular *= cwCloud;
}
`;

/**
 * Creates the terrain material from the three chunks. The shared uniforms, the atmosphere chunk's
 * (`ctx.atmosphereUniforms`) and each chunk's own are bound by reference, so a module changes the
 * look by writing to its uniform objects; nothing is recompiled.
 *
 * The material keeps three.js's lighting, shadows, fog and tone mapping: the chunks only decide
 * the surface (color, roughness, normal, glow) that the standard lighting then shades.
 */
export function createTerrainMaterial(
  ctx: RenderContext,
  chunks: TerrainChunks,
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });

  const chunkSource = [
    chunks.surface?.glsl ?? EMPTY_CHUNKS.surface,
    chunks.paths?.glsl ?? EMPTY_CHUNKS.paths,
    chunks.overlay?.glsl ?? EMPTY_CHUNKS.overlay,
  ].join("\n");
  const declarations = [
    VERTEX_DECLARATIONS,
    SHARED_UNIFORMS_GLSL,
    NOISE_GLSL,
    ATMOSPHERE_GLSL,
    CW_SURF_GLSL,
    chunkSource,
  ].join("\n");

  const uniforms: Record<string, IUniform> = {
    ...ctx.uniforms,
    // What `cwCloudShadow` reads: the scene's own set, which the atmosphere module writes.
    ...ctx.atmosphereUniforms,
    ...chunks.surface?.uniforms,
    ...chunks.paths?.uniforms,
    ...chunks.overlay?.uniforms,
  };
  const key = `cw-terrain-${hashText(declarations)}`;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    let vertex = shader.vertexShader;
    // `objectNormal` and `transformed` come from these two.
    requires(vertex, "beginnormal_vertex", "vertex");
    requires(vertex, "begin_vertex", "vertex");
    vertex = after(vertex, "common", VERTEX_DECLARATIONS, "vertex");
    vertex = after(vertex, "project_vertex", VERTEX_MAIN, "vertex");
    shader.vertexShader = vertex;

    let fragment = shader.fragmentShader;
    // `roughnessFactor` and `normal` come from these two.
    requires(fragment, "roughnessmap_fragment", "fragment");
    requires(fragment, "normal_fragment_begin", "fragment");
    // The last of three.js's own declarations, so the chunks can use anything declared above it.
    fragment = after(fragment, "clipping_planes_pars_fragment", declarations, "fragment");
    fragment = after(fragment, "emissivemap_fragment", FRAGMENT_MAIN, "fragment");
    fragment = after(fragment, "lights_fragment_begin", FRAGMENT_CLOUD_SHADOW, "fragment");
    shader.fragmentShader = fragment;
  };
  // Two terrain materials with different chunks must not share a compiled program.
  material.customProgramCacheKey = () => key;
  return material;
}
