import { Vector4, type IUniform } from "three";

/**
 * What the atmosphere module gives other shaders, as GLSL to paste ahead of them (after the shared
 * uniforms and the noise library). The terrain material includes it already.
 *
 * - `float cwCloudShadow(vec2 worldXZ)`: how much direct sunlight (or moonlight) reaches the
 *   ground at a world position, 1 in full sun down to `1 - strength` under the thickest cloud.
 *   Soft, a few noise lookups, safe to call once per fragment.
 *
 * The clouds are one field, `cwAtmClouds`, laid out in world tiles on a layer above the land and
 * carried along by the wind. The sky dome draws that field where a view ray meets the layer, and
 * `cwCloudShadow` reads it where the ray from the ground toward the sun meets it, so the shadow on
 * a spot is the very cloud that stands between that spot and the sun, and the two drift together.
 * (`cwAtmLayerPoint` is that meeting point. The layer is bent down toward the horizon by
 * `CW_ATM_CURVE`, as a cloud deck appears to be, which keeps far clouds from being squashed into
 * streaks and a low sun's shadows from running off to infinity.)
 *
 * The chunk may read the shared uniforms, the noise library and uniforms of its own. Its own are
 * declared in the GLSL below (named `cwAtm_...`) and made by `createAtmosphereUniforms()`, one
 * entry per declaration under the same name. The scene makes one set per scene and keeps it as
 * `ctx.atmosphereUniforms`; the terrain material binds those objects, and so must every other
 * material that pastes this chunk (`uniforms: { ...ctx.uniforms, ...ctx.atmosphereUniforms }`).
 * The atmosphere module drives the chunk by writing `ctx.atmosphereUniforms.<name>.value`. The
 * starting values are what a scene without the atmosphere module draws with: a fair-weather sky
 * whose cloud shadows drift on their own, since the wind works from `uTime`.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
#ifndef CW_ATMOSPHERE_GLSL
#define CW_ATMOSPHERE_GLSL

// x: cloud cover, 0 clear to 1 overcast. y: how much of the direct light the thickest cloud takes
// away. z: one over the size of a cloud cell in tiles. w: height of the cloud layer in tiles.
uniform vec4 cwAtm_cloud;
// xy: the wind, in tiles a second along world X and Z. z: how fast the clouds change shape.
// w: how many octaves of detail the shadows are drawn with (the quality sets it).
uniform vec4 cwAtm_wind;

// How far the cloud layer is bent down toward the horizon.
const float CW_ATM_CURVE = 0.36;

// Where a ray from a point on the ground, going in direction dir, meets the cloud layer: world XZ.
vec2 cwAtmLayerPoint(vec2 worldXZ, vec3 dir) {
  return worldXZ + cwAtm_cloud.w * dir.xz / (max(dir.y, 0.0) + CW_ATM_CURVE);
}

// The cloud field at a point of the layer. Above 0 there is cloud, and the higher the thicker
// (it seldom passes 0.3); below 0 is clear air, and how far below says how far from a cloud.
// detail is how many octaves to sum, and may be fractional: the last one fades in, so a caller
// can take detail away smoothly with distance. Fewer octaves give the same clouds with rounder
// edges, which is what lets the shadows be cheaper than the sky.
float cwAtmClouds(vec2 layerXZ, float detail) {
  vec2 q = (layerXZ - cwAtm_wind.xy * uTime) * cwAtm_cloud.z;
  float phase = uTime * cwAtm_wind.z;

  // The weather: a slow pattern much larger than a cloud that thins the cover here and banks it
  // up there, so the sky has clear stretches.
  float weather = cwGradNoise(q * 0.27 + vec2(40.5, 7.25) + phase * 0.05);
  float cover = clamp(cwAtm_cloud.x + (weather - 0.5) * 0.45, 0.0, 1.0);

  // The body of a cloud is one smooth lump. On it sit the puffs: each further octave is folded
  // about its middle, which makes round bumps with sharp creases between them, the way a
  // cumulus cloud heaps up.
  float sum = 0.55 * cwGradNoise(q + vec2(3.1, -7.7) + phase * vec2(0.09, 0.05));
  float weight = 0.45 * (16.0 / 31.0);
  vec2 drift = phase * vec2(0.31, -0.2);
  vec2 p = cwOctave * q + vec2(17.3, 9.1) + drift;
  for (int k = 1; k < 6; k++) {
    float keep = clamp(detail - float(k), 0.0, 1.0);
    // An octave left out counts as its own average, so the field keeps its level.
    float puff = keep > 0.0 ? mix(0.28, abs(2.0 * cwGradNoise(p) - 1.0), keep) : 0.28;
    sum += weight * puff;
    weight *= 0.5;
    // Each octave is turned, so the same drift carries each a different way and the shapes churn.
    p = cwOctave * p + vec2(17.3, 9.1) + drift;
  }

  return sum - mix(0.53, 0.3, cover);
}

float cwCloudShadow(vec2 worldXZ) {
  float density = cwAtmClouds(cwAtmLayerPoint(worldXZ, uSunDir), cwAtm_wind.w);
  return 1.0 - cwAtm_cloud.y * smoothstep(-0.05, 0.12, density);
}

#endif
`;

/** How much of the sky the clouds cover in fair weather, 0 clear to 1 overcast. */
export const CLOUD_COVER = 0.56;
/** The size of a cloud cell, in tiles: a cloud and the gap beside it. */
export const CLOUD_CELL = 60;
/** The height of the cloud layer above the land, in tiles. */
export const CLOUD_HEIGHT = 150;
/** How much of the sun's direct light the thickest cloud takes away. */
export const CLOUD_SHADOW_STRENGTH = 0.52;

/**
 * A fresh set of the uniforms `ATMOSPHERE_GLSL` declares, at their starting values. The type of
 * `ctx.atmosphereUniforms` follows whatever this returns, so adding an entry here is all it takes
 * for the atmosphere module to write it and for the terrain and the water to read it.
 */
export function createAtmosphereUniforms() {
  return {
    cwAtm_cloud: {
      value: new Vector4(CLOUD_COVER, CLOUD_SHADOW_STRENGTH, 1 / CLOUD_CELL, CLOUD_HEIGHT),
    },
    cwAtm_wind: { value: new Vector4(0.9, 0.42, 0.012, 2) },
  } satisfies Record<string, IUniform>;
}

/** The uniforms of the atmosphere's shader chunk, by name. */
export type AtmosphereUniforms = ReturnType<typeof createAtmosphereUniforms>;
