import { MeshDepthMaterial, MeshStandardMaterial, Vector4, type IUniform } from "three";
import { ATMOSPHERE_GLSL } from "../atmosphere.glsl.js";
import { SHARED_UNIFORMS_GLSL, type RenderContext } from "../context.js";
import { NOISE_GLSL } from "../shaders/noise.glsl.js";

/**
 * The one material everything on the land beyond the park is drawn with: trees, bushes, rocks and
 * the hedge. It is three.js's standard material, so it takes the scene's sun, sky light, shadows,
 * fog and tone mapping as the ground does, with four things added:
 *
 * - Wind. Each vertex sways by its weight (`cwAux.x`: 0 at the roots, 1 at the top) in slow gusts
 *   that travel across the land, and foliage (`cwAux.y`) flutters a little on top of that, each
 *   vertex out of step with the next (`cwAux.z`). The shadow pass moves the same way.
 * - Leaves. Up close the foliage gets its grain here: dabs of lighter leaf over the darker green
 *   of the model, fixed to the plant, each rounded under the light. It fades out before it could
 *   shimmer.
 * - Cloud shadow on the direct light, as the ground has.
 * - A little sun through the leaves: foliage facing away from the sun, seen against it, glows
 *   faintly instead of going black.
 *
 * Colors come from the model's vertex colors, which already carry the shading of its form, times
 * the instance's tint.
 */

/** The wind's own uniforms; the clock is the scene's. */
export interface SceneryUniforms {
  /** xy: the unit direction the wind blows toward, on the ground. z: sway, tiles. w: flutter. */
  cwScn_wind: IUniform<Vector4>;
}

/** The materials scenery is drawn with: the lit one and the one its shadows are drawn with. */
export interface SceneryMaterials {
  lit: MeshStandardMaterial;
  depth: MeshDepthMaterial;
  uniforms: SceneryUniforms;
  dispose(): void;
}

const VERTEX_DECLARATIONS = /* glsl */ `
attribute vec3 cwAux;
uniform float uTime;
uniform vec4 cwScn_wind;
`;

const VERTEX_VARYINGS = /* glsl */ `
varying vec3 cwScnPos;
varying vec3 cwScnWorld;
varying float cwScnLeaf;
`;

// Moves \`transformed\`. The offset is worked out in world space, where the wind blows, and
// brought back into the model's own space, since three.js applies the instance matrix later.
const VERTEX_SWAY = /* glsl */ `
#ifdef USE_INSTANCING
  mat3 cwIm = mat3( instanceMatrix );
  vec3 cwRoot = instanceMatrix[ 3 ].xyz;
#else
  mat3 cwIm = mat3( 1.0 );
  vec3 cwRoot = vec3( 0.0 );
#endif
{
  float cwWeight = cwAux.x * cwAux.x;
  if ( cwWeight > 0.0 ) {
    // Where this plant is along the wind decides when a gust reaches it.
    float cwAlong = dot( cwRoot.xz, cwScn_wind.xy ) * 0.16 + dot( cwRoot.xz, cwScn_wind.yx ) * 0.05;
    float cwGust = 0.55 + 0.45 * sin( uTime * 0.31 - cwAlong * 0.35 );
    float cwSwing = sin( uTime * 1.25 - cwAlong ) + 0.45 * sin( uTime * 2.3 - cwAlong * 1.7 + 1.3 );
    vec3 cwOffset = vec3( cwScn_wind.x, 0.0, cwScn_wind.y ) * ( ( 0.35 + cwSwing * 0.65 ) * cwGust * cwWeight * cwScn_wind.z );
    float cwPhase = cwAux.z * 6.2832 + cwAlong * 3.0;
    cwOffset += vec3( sin( uTime * 4.1 + cwPhase ), 0.6 * sin( uTime * 3.3 + cwPhase * 1.3 ), cos( uTime * 3.7 + cwPhase ) ) * ( cwScn_wind.w * cwAux.y * ( 0.4 + 0.6 * cwGust ) * cwAux.x );
    transformed += vec3( dot( cwIm[ 0 ], cwOffset ) / dot( cwIm[ 0 ], cwIm[ 0 ] ), dot( cwIm[ 1 ], cwOffset ) / dot( cwIm[ 1 ], cwIm[ 1 ] ), dot( cwIm[ 2 ], cwOffset ) / dot( cwIm[ 2 ], cwIm[ 2 ] ) );
  }
}
`;

// The still position, in world directions and tiles, for the leaf grain to be fixed to; each
// plant reads a different part of the noise.
const VERTEX_VARYINGS_MAIN = /* glsl */ `
cwScnPos = cwIm * position + cwRoot.zxy * 0.371;
cwScnWorld = ( modelMatrix * vec4( cwIm * transformed + cwRoot, 1.0 ) ).xyz;
cwScnLeaf = cwAux.y;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
${VERTEX_VARYINGS}
${SHARED_UNIFORMS_GLSL}
${NOISE_GLSL}
${ATMOSPHERE_GLSL}

uint cwScn_hashU( vec3 p ) {
  uvec3 q = uvec3( ivec3( floor( p ) ) );
  uint h = q.x * 0x9E3779B1u + q.y * 0x85EBCA77u + q.z * 0xC2B2AE3Du;
  h ^= h >> 15;
  h *= 0x2C1B3C6Du;
  h ^= h >> 12;
  h *= 0x297A2D39u;
  h ^= h >> 15;
  return h;
}

// Dabs of leaf scattered through space, about one to a unit, each a flat disc lying its own way:
// x is how far inside the nearest dab p is (1 at its middle, 0 outside all of them), y a number of
// the dab's own in 0..1, and \`way\` the way from the dab's middle to p, in units of its size.
vec2 cwScn_dabs( vec3 p, out vec3 way ) {
  vec3 corner = floor( p - 0.5 );
  float best = 9.0;
  float pick = 0.0;
  way = vec3( 0.0 );
  for ( int k = 0; k < 8; k ++ ) {
    vec3 cell = corner + vec3( float( k & 1 ), float( ( k >> 1 ) & 1 ), float( ( k >> 2 ) & 1 ) );
    uint h = cwScn_hashU( cell );
    vec3 spot = vec3( float( h & 1023u ), float( ( h >> 10 ) & 1023u ), float( ( h >> 20 ) & 1023u ) ) * ( 1.0 / 1023.0 );
    uint g = h * 0x9E3779B1u + 0x7F4A7C15u;
    g ^= g >> 16;
    vec3 axis = normalize( vec3( float( g & 1023u ), float( ( g >> 10 ) & 1023u ), float( ( g >> 20 ) & 1023u ) ) * ( 2.0 / 1023.0 ) - 0.999 );
    float own = float( g >> 24 ) * ( 1.0 / 255.0 );
    vec3 off = ( p - ( cell + 0.2 + 0.6 * spot ) ) / ( 0.48 + 0.17 * own );
    float across = dot( off, axis );
    float d = dot( off, off ) + 3.6 * across * across;
    if ( d < best ) {
      best = d;
      way = off;
      pick = own;
    }
  }
  return vec2( 1.0 - smoothstep( 0.35, 1.0, best ), pick );
}

vec3 cwScn_bump = vec3( 0.0 );
float cwScn_grain = 0.0;
`;

// The leaf grain: dabs of lighter, yellower leaf over the darker green of the model, at two
// sizes, each dab rounded under the light. It is fixed to the plant and keeps the model's mean
// color, so from far away, where it has faded out, nothing changes.
const FRAGMENT_COLOR = /* glsl */ `
{
  // Tiles one pixel covers on the plant; a grain is gone before a pixel is as big as a dab.
  vec3 cwDx = dFdx( cwScnPos );
  vec3 cwDy = dFdy( cwScnPos );
  float cwPx = sqrt( max( dot( cwDx, cwDx ), dot( cwDy, cwDy ) ) );
  float cwCoarse = 1.0 - smoothstep( 0.012, 0.042, cwPx );
  float cwFine = 1.0 - smoothstep( 0.005, 0.017, cwPx );
  if ( cwCoarse > 0.0 ) {
    vec3 cwWayA;
    vec3 cwWayB = vec3( 0.0 );
    vec2 cwA = cwScn_dabs( cwScnPos * vec3( 8.5, 10.0, 8.5 ), cwWayA );
    vec2 cwB = vec2( 0.0 );
    if ( cwFine > 0.0 ) cwB = cwScn_dabs( cwScnPos.zyx * vec3( 19.0, 22.0, 19.0 ) + 3.7, cwWayB );
    // Each dab has a brightness of its own; 0.34 is about what the dabs come to over a surface.
    float cwTone = ( cwA.x * ( 0.55 + 0.9 * cwA.y ) - 0.34 ) * cwCoarse + ( cwB.x * ( 0.55 + 0.9 * cwB.y ) - 0.34 ) * 0.8 * cwFine;
    float cwAmount = mix( 0.14, 0.56, cwScnLeaf );
    diffuseColor.rgb *= 1.0 + cwTone * cwAmount;
    // Leaves in the light are yellower, the depths between them bluer.
    diffuseColor.rgb *= 1.0 + cwTone * cwScnLeaf * vec3( 0.1, 0.02, -0.2 );
    cwScn_bump = ( cwWayA * cwA.x * cwCoarse + cwWayB.zyx * cwB.x * 0.8 * cwFine ) * vec3( 1.0, 0.65, 1.0 ) * mix( 0.12, 0.42, cwScnLeaf );
    cwScn_grain = cwTone;
  }
}
`;

// Leans the normal the way out of the dab the pixel is in, which rounds each dab under the light.
// The way is in world directions.
const FRAGMENT_NORMAL = /* glsl */ `
{
  vec3 cwLean = ( viewMatrix * vec4( cwScn_bump, 0.0 ) ).xyz;
  cwLean -= normal * dot( normal, cwLean );
  normal = normalize( normal + cwLean );
}
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
roughnessFactor = mix( 0.94, 0.74, cwScnLeaf ) - cwScn_grain * 0.12 * cwScnLeaf;
`;

// The only direct light in the scene is the sun (or the moon), so dimming all direct light by the
// cloud shadow dims exactly that. Then the sun through the leaves, which has no shadow of its own
// and so is kept faint.
const FRAGMENT_LIGHT = /* glsl */ `
{
  float cwCloud = cwCloudShadow( cwScnWorld.xz );
  reflectedLight.directDiffuse *= cwCloud;
  reflectedLight.directSpecular *= cwCloud;
  // The sun as the shared uniforms have it: its color there is scaled to 0..1, and the light
  // itself is about three times that.
  vec3 cwSun = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
  float cwBack = max( 0.0, - dot( geometryNormal, cwSun ) );
  float cwToward = pow( max( 0.0, - dot( geometryViewDir, cwSun ) ), 3.0 );
  reflectedLight.directDiffuse += uSunColor * diffuseColor.rgb * vec3( 1.0, 1.0, 0.45 ) * ( cwBack * ( 0.25 + 1.4 * cwToward ) * cwScnLeaf * cwCloud * RECIPROCAL_PI );
}
`;

/** Puts `addition` right after `#include <name>` in `source`, or throws: the names are three.js's. */
function after(source: string, name: string, addition: string, stage: string): string {
  const include = `#include <${name}>`;
  if (!source.includes(include)) {
    throw new Error(
      `Scenery material: three.js's ${stage} shader has no "${include}". ` +
        `The shader was written against three r186; see packages/render/src/scenery/material.ts.`,
    );
  }
  return source.replace(include, `${include}\n${addition}`);
}

/**
 * Creates the scenery materials for a scene. The shared uniforms and the atmosphere's are bound
 * by reference, so the wind runs on the scene's clock and cloud shadows fall where the ground's
 * do.
 */
export function createSceneryMaterials(ctx: RenderContext): SceneryMaterials {
  const uniforms: SceneryUniforms = {
    // Out of the south-west, as the ground's faint wind streaks run.
    cwScn_wind: { value: new Vector4(0.83, -0.56, 0.05, 0.007) },
  };
  const bound: Record<string, IUniform> = {
    ...ctx.uniforms,
    ...ctx.atmosphereUniforms,
    ...uniforms,
  };

  const lit = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  lit.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, bound);
    let vertex = shader.vertexShader;
    vertex = after(vertex, "common", VERTEX_DECLARATIONS + VERTEX_VARYINGS, "standard vertex");
    vertex = after(vertex, "begin_vertex", VERTEX_SWAY + VERTEX_VARYINGS_MAIN, "standard vertex");
    shader.vertexShader = vertex;

    let fragment = shader.fragmentShader;
    fragment = after(
      fragment,
      "clipping_planes_pars_fragment",
      FRAGMENT_DECLARATIONS,
      "standard fragment",
    );
    fragment = after(fragment, "color_fragment", FRAGMENT_COLOR, "standard fragment");
    fragment = after(fragment, "roughnessmap_fragment", FRAGMENT_ROUGHNESS, "standard fragment");
    fragment = after(fragment, "normal_fragment_maps", FRAGMENT_NORMAL, "standard fragment");
    fragment = after(fragment, "lights_fragment_begin", FRAGMENT_LIGHT, "standard fragment");
    shader.fragmentShader = fragment;
  };
  lit.customProgramCacheKey = () => "cw-scenery";

  // The shadow pass draws with this: three.js's own depth material, swaying as the lit one does.
  const depth = new MeshDepthMaterial();
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: ctx.uniforms.uTime, ...uniforms });
    let vertex = shader.vertexShader;
    vertex = after(vertex, "common", VERTEX_DECLARATIONS, "depth vertex");
    vertex = after(vertex, "begin_vertex", VERTEX_SWAY, "depth vertex");
    shader.vertexShader = vertex;
  };
  depth.customProgramCacheKey = () => "cw-scenery-depth";

  return {
    lit,
    depth,
    uniforms,
    dispose(): void {
      lit.dispose();
      depth.dispose();
    },
  };
}
