import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  Mesh,
  OneFactor,
  ShaderMaterial,
  SrcColorFactor,
  UniformsLib,
  UniformsUtils,
  ZeroFactor,
} from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl.js";
import {
  SHARED_UNIFORMS_GLSL,
  type Quality,
  type RenderContext,
  type SceneModule,
} from "./context.js";
import { groundHeightAt, groundNormalAt } from "./heightfield.js";
import { NOISE_GLSL } from "./shaders/noise.glsl.js";
import type { TerrainData } from "./terrain/geometry.js";
import { HEIGHT_STEP, SUBDIV } from "./units.js";

/**
 * The water of the park: ponds and lakes as one level sheet per water level, drawn over the
 * smooth ground.
 *
 * The sheet covers the water tiles and the tiles around them, cell for cell and diagonal for
 * diagonal like the ground mesh, and every vertex carries how deep the water is there (the
 * surface minus the ground). The ground hides the sheet where it stands above it, so the shore is
 * the curve where the smooth ground meets the level, not a tile edge; and because the depth is
 * interpolated over the same triangles as the ground, its zero line is that same curve. The
 * shader fades the water out toward it, so the two surfaces never fight there.
 *
 * Everything else is the shader's: the depth gives the color (the bed shows through the
 * shallows, deeper water turns blue-green and opaque), the foam along the shore and the light
 * playing on the bed; scrolling noise gives the ripples, which bend the reflection of the sky and
 * break the sun into glints.
 */

/** The water surfaces of the park. */
export type WaterModule = SceneModule;

/**
 * How far below its nominal level the water surface is drawn, in world units. Land around a pool
 * is very often at exactly the pool's level; a surface a little under the brim meets that land
 * inside the tiles next to the pool, where the mesh reaches, and leaves a bank standing over it.
 */
export const WATER_DROP = 0.035;

/** The world height of the water surface for a sim water level. */
export function waterSurfaceY(level: number): number {
  return level * HEIGHT_STEP - WATER_DROP;
}

/** The water as flat arrays: one indexed sheet per water level, all in the same arrays. */
export interface WaterGeometry {
  /** Three numbers per vertex. Y is the surface of the vertex's own sheet. */
  positions: Float32Array;
  /**
   * One number per vertex: the surface minus the smooth ground, in world units. Positive under
   * water, zero or less where the ground stands above the surface, and never above zero on the
   * outer border of a sheet, so that water with nothing to hold it in fades out there.
   */
  depths: Float32Array;
  /**
   * One number per vertex: how steeply the ground under it slopes, as rise over run (the slope of
   * the normal the ground is lit with, which is smooth from vertex to vertex).
   */
  banks: Float32Array;
  /** Triangles, counter-clockwise seen from above. Those wholly over dry land are left out. */
  indices: Uint32Array;
  /** Tiles the sheets cover: each level's water tiles and the dry tiles around them. */
  tileCount: number;
}

/**
 * Builds the water sheets. For every water level on the map there is one sheet, at
 * `waterSurfaceY(level)`: a grid of `SUBDIV` by `SUBDIV` cells over each tile with that level and
 * over each dry tile next to one (corner neighbors too), sharing vertices, with every cell split
 * along the same diagonal as the ground mesh splits it. A tile with water of another level is
 * left to its own sheet. Triangles whose three corners are all dry are dropped: the ground covers
 * them. Returns null when nothing is under water.
 */
export function buildWaterGeometry(t: TerrainData): WaterGeometry | null {
  const { width, height, water } = t;

  // The levels on the map, and the tiles all the sheets can reach.
  const present = new Uint8Array(256);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const level = water[y * width + x] as number;
      if (level === 0) continue;
      present[level] = 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(width - 1, x1 + 1);
  y1 = Math.min(height - 1, y1 + 1);

  // Sub-grid vertices of that box, addressed by whole cells from the map's corner as the ground
  // mesh does, so the heights are the ground mesh's own.
  const boxW = x1 - x0 + 1;
  const boxH = y1 - y0 + 1;
  const row = boxW * SUBDIV + 1;
  const ground = new Float32Array(row * (boxH * SUBDIV + 1)).fill(Number.NaN);
  const vertexOf = new Int32Array(ground.length);
  const covered = new Uint8Array(boxW * boxH);

  const positions: number[] = [];
  const depths: number[] = [];
  const banks: number[] = [];
  const indices: number[] = [];
  let tileCount = 0;

  const isCovered = (x: number, y: number): boolean =>
    x >= x0 && y >= y0 && x <= x1 && y <= y1 && covered[(y - y0) * boxW + (x - x0)] === 1;

  /** Whether sub-grid vertex (`i`, `j`), counted from the map's corner, has a tile next to it that the sheet does not cover. */
  const onBorder = (i: number, j: number): boolean => {
    const tx = Math.floor(i / SUBDIV);
    const ty = Math.floor(j / SUBDIV);
    const left = i % SUBDIV === 0 ? tx - 1 : tx;
    const up = j % SUBDIV === 0 ? ty - 1 : ty;
    for (let y = up; y <= ty; y++) {
      for (let x = left; x <= tx; x++) {
        if (!isCovered(x, y)) return true;
      }
    }
    return false;
  };

  for (let level = 1; level < 256; level++) {
    if (!present[level]) continue;
    const surface = waterSurfaceY(level);

    covered.fill(0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const own = water[y * width + x] as number;
        let cover = own === level;
        if (own === 0) {
          for (let dy = -1; dy <= 1 && !cover; dy++) {
            for (let dx = -1; dx <= 1 && !cover; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              cover = water[ny * width + nx] === level;
            }
          }
        }
        if (cover) {
          covered[(y - y0) * boxW + (x - x0)] = 1;
          tileCount++;
        }
      }
    }

    vertexOf.fill(-1);
    const depthAt = new Float32Array(4);
    const cell = new Int32Array(4);

    /** The index of sub-grid vertex `slot` in this sheet, made on first use. */
    const vertex = (slot: number, i: number, j: number, depth: number): number => {
      let index = vertexOf[slot] as number;
      if (index < 0) {
        index = positions.length / 3;
        vertexOf[slot] = index;
        positions.push(i / SUBDIV, surface, j / SUBDIV);
        depths.push(depth);
        const normal = groundNormalAt(t, i / SUBDIV, j / SUBDIV);
        banks.push(Math.hypot(normal[0], normal[2]) / normal[1]);
      }
      return index;
    };

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!covered[(y - y0) * boxW + (x - x0)]) continue;
        for (let b = 0; b < SUBDIV; b++) {
          for (let a = 0; a < SUBDIV; a++) {
            // The cell's corners in the order NW, NE, SW, SE.
            for (let c = 0; c < 4; c++) {
              const i = x * SUBDIV + a + (c & 1);
              const j = y * SUBDIV + b + (c >> 1);
              const slot = (j - y0 * SUBDIV) * row + (i - x0 * SUBDIV);
              let h = ground[slot] as number;
              if (Number.isNaN(h)) {
                h = groundHeightAt(t, i / SUBDIV, j / SUBDIV);
                ground[slot] = h;
                // Read back as stored: the diagonal is chosen on the same 32-bit heights as the
                // ground mesh chooses it.
                h = ground[slot] as number;
              }
              cell[c] = slot;
              const depth = surface - h;
              depthAt[c] = depth > 0 && onBorder(i, j) ? 0 : depth;
            }
            const hNW = ground[cell[0] as number] as number;
            const hNE = ground[cell[1] as number] as number;
            const hSW = ground[cell[2] as number] as number;
            const hSE = ground[cell[3] as number] as number;
            // Corner numbers of the two triangles, as the ground mesh winds them.
            const split =
              Math.abs(hNW - hSE) <= Math.abs(hNE - hSW) ? SPLIT_NW_SE : SPLIT_NE_SW;
            for (let k = 0; k < 6; k += 3) {
              const c0 = split[k] as number;
              const c1 = split[k + 1] as number;
              const c2 = split[k + 2] as number;
              const d0 = depthAt[c0] as number;
              const d1 = depthAt[c1] as number;
              const d2 = depthAt[c2] as number;
              if (d0 <= 0 && d1 <= 0 && d2 <= 0) continue;
              for (const c of [c0, c1, c2]) {
                const i = x * SUBDIV + a + (c & 1);
                const j = y * SUBDIV + b + (c >> 1);
                indices.push(vertex(cell[c] as number, i, j, depthAt[c] as number));
              }
            }
          }
        }
      }
    }
  }

  if (indices.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    depths: new Float32Array(depths),
    banks: new Float32Array(banks),
    indices: new Uint32Array(indices),
    tileCount,
  };
}

// A cell's corners are numbered NW 0, NE 1, SW 2, SE 3.
const SPLIT_NW_SE = [0, 2, 3, 0, 3, 1];
const SPLIT_NE_SW = [0, 2, 1, 1, 2, 3];

/** What both passes' vertex stages hand on: where the fragment is, and the sheet's depth there. */
const VARYINGS_GLSL = /* glsl */ `
varying vec3 cwWorldPos;
varying float cwDepth;
varying float cwBank;
`;

/**
 * What both passes' fragment stages share: the shared uniforms, the noise, how water takes the
 * color out of light, and where the shore is. Both passes must agree on the shore to the pixel.
 */
const WATER_GLSL = /* glsl */ `
${VARYINGS_GLSL}
${SHARED_UNIFORMS_GLSL}
${NOISE_GLSL}

// What water takes out of the light passing through it, per world unit of the way: red goes
// first, which is what turns a sandy bed turquoise.
const vec3 cwWater_absorb = vec3(6.4, 1.55, 1.75);

// The depth of the water that is drawn, from the depth of the sheet and the slope of the bank
// under it. The water stops short of where the sheet meets the ground, by a distance along the
// ground that wanders from place to place and breathes in and out, so the waterline is never the
// ground's own straight contour, and it laps. On a bank of slope s, a distance r is a depth of
// s * r; the slope is capped so that a steep bank keeps its water close.
// "lap" comes back as the phase of that breathing, 0..1.
float cwWater_shore(vec2 p, float sheetDepth, float bank, out float lap) {
  float wander = cwFbm(p * 0.31 + vec2(3.7, 9.2), 2);
  float fine = cwGradNoise(p * 1.7 + vec2(uTime * 0.04, -uTime * 0.03));
  lap = 0.5 + 0.5 * sin(uTime * 0.85 + wander * 11.0 + fine * 3.0);
  float back = 0.62 * smoothstep(0.22, 0.78, wander) + 0.1 * fine + 0.05 * lap;
  return sheetDepth - min(bank, 0.3) * back - 0.006 * lap;
}

// How wide, in depth, the fade at the very edge of the water is: a little, and never less than
// a pixel and a half, so the waterline is soft and does not stair-step.
float cwWater_edgeWidth(float depth) {
  return max(0.012, fwidth(depth) * 1.5);
}

// How far light travels through the water to the bed and back toward the eye, for a depth: more
// when looking along the surface than when looking down.
float cwWater_path(float depth, vec3 view) {
  return depth * (1.5 - 0.5 * clamp(view.y, 0.0, 1.0));
}
`;

/** The vertex stage of the tint pass. */
const TINT_VERTEX = /* glsl */ `
attribute float depth;
attribute float bank;
${VARYINGS_GLSL}
#include <common>
#include <fog_pars_vertex>

void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <fog_vertex>
  cwWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  cwDepth = depth;
  cwBank = bank;
}
`;

/**
 * The fragment stage of the tint pass, which multiplies what is already drawn (the bed) by what
 * the water lets through of each color. It is a multiplier, not a color, so it is neither tone
 * mapped nor converted; but where the frame is drawn straight to the canvas the bed is already
 * stored encoded, and the multiplier is encoded to match (`cwWater_encoded`). Haze thins it, as
 * the bed it darkens is already part haze.
 */
const TINT_FRAGMENT = /* glsl */ `
uniform float cwWater_encoded;
#include <common>
#include <fog_pars_fragment>
${WATER_GLSL}

void main() {
  float lap;
  float depth = cwWater_shore(cwWorldPos.xz, cwDepth, cwBank, lap);
  float keep = smoothstep(0.0, cwWater_edgeWidth(depth), depth);
  if (depth <= 0.0) discard;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      keep *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      keep *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  vec3 view = normalize(cameraPosition - cwWorldPos);
  vec3 clear = exp(-cwWater_path(depth, view) * cwWater_absorb);
  clear = mix(vec3(1.0), clear, keep);
  if (cwWater_encoded > 0.5) clear = pow(clear, vec3(0.4545));
  gl_FragColor = vec4(clear, 1.0);
}
`;

/** The vertex stage of the surface pass: as the tint pass, and the sun's shadow besides. */
const SURFACE_VERTEX = /* glsl */ `
attribute float depth;
attribute float bank;
${VARYINGS_GLSL}
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>

void main() {
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>
  cwWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  cwDepth = depth;
  cwBank = bank;
}
`;

/**
 * The fragment stage of the surface pass: the light the water itself sends to the eye (what it
 * scatters back, the sky mirrored in it, the sun's glint, the foam), blended over the tinted bed
 * by how much of the bed all that covers. `CW_WATER_DETAIL` is 0 at low quality (two ripple
 * layers, no light on the bed, plainer foam) and 1 otherwise.
 */
const SURFACE_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
${WATER_GLSL}
${ATMOSPHERE_GLSL}

// The color of the light the water scatters back, in the shallows and in the deep.
const vec3 cwWater_shallow = vec3(0.035, 0.38, 0.31);
const vec3 cwWater_deep = vec3(0.01, 0.15, 0.17);
const vec3 cwWater_foam = vec3(0.78, 0.80, 0.80);

// The slope of one ripple layer: two noise fields of nearly the same grain drifting across each
// other, so the pattern changes shape as it moves and never reads as a sliding texture.
vec2 cwWater_wave(vec2 p, float grain, vec2 drift) {
  vec3 a = cwGradNoiseD(p * grain + drift * uTime);
  vec3 b = cwGradNoiseD(p * grain * 1.31 - drift.yx * (uTime * 0.83) + vec2(41.3, 17.9));
  return a.yz + b.yz * 1.31;
}

// How much of a detail of this grain (features per world unit) a pixel of this size can still
// show: 1 up close, 0 once a feature is smaller than about two pixels.
float cwWater_keep(float grain, float pixel) {
  return 1.0 - smoothstep(0.18, 0.5, grain * pixel);
}

// The bright net of light that ripples throw on the bed: thin lines where two drifting noise
// fields agree.
float cwWater_caustic(vec2 p) {
  vec2 q = p * 7.5;
  float a = cwGradNoise(q + vec2(uTime * 0.31, uTime * 0.19));
  float b = cwGradNoise(q * 1.37 - vec2(uTime * 0.23, -uTime * 0.33) + vec2(31.7, 5.3));
  float line = max(1.0 - abs(a - b) * 3.2, 0.0);
  line *= line;
  // A soft glow along each line and a bright core.
  return line * 0.35 + line * line * line * 0.65;
}

void main() {
  vec2 p = cwWorldPos.xz;
  float pixel = max(length(dFdx(p)), length(dFdy(p)));

  float lap;
  float depth = cwWater_shore(p, cwDepth, cwBank, lap);
  float edge = smoothstep(0.0, cwWater_edgeWidth(depth), depth);
  if (depth <= 0.0) discard;

  // Ripples: a few layers of drifting noise, stronger where a gust is passing and fading out
  // layer by layer as they get too small for the pixel.
  float gust = cwGradNoise(p * 0.16 + vec2(uTime * 0.021, uTime * 0.013));
  float chop = mix(0.45, 1.2, smoothstep(0.3, 0.72, gust));
  // The shallows lie calmer.
  chop *= mix(0.55, 1.0, smoothstep(0.0, 0.18, depth));
  float keepMid = cwWater_keep(2.4, pixel);
  vec2 swell = cwWater_wave(p, 0.85, vec2(0.11, 0.07)) * (0.035 * chop * cwWater_keep(0.85, pixel));
  vec2 ruffle = cwWater_wave(p, 2.4, vec2(-0.13, 0.19)) * (0.03 * chop * keepMid);
  vec2 slope = swell + ruffle;
  // The same ripples as the sun's glint sees them: see below.
  vec2 glitter = swell * 1.2 + ruffle * 3.0;
  float keepFine = 0.0;
  #if CW_WATER_DETAIL > 0
    keepFine = cwWater_keep(6.1, pixel);
    vec2 shiver = cwWater_wave(p, 6.1, vec2(0.21, -0.27)) * (0.022 * chop * keepFine);
    slope += shiver;
    glitter += shiver * 7.0;
  #endif
  vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));

  vec3 view = normalize(cameraPosition - cwWorldPos);
  float facing = max(dot(normal, view), 0.001);
  // More mirror than plain water has when seen from above, so the surface shows as a surface.
  float away = 1.0 - facing;
  float fresnel = 0.04 + 0.96 * pow(away, 4.5);

  // The light that arrives: the sun, through cloud and shadow, and the sky.
  float sunReach = getShadowMask() * cwCloudShadow(p);
  vec3 sunLight = uSunColor * (max(uSunDir.y, 0.0) * sunReach);
  // The sky's light, part of it taken as plain white: under a deep blue sky the water keeps its
  // own color.
  vec3 skyTone = mix(uSkyHorizon, uSkyZenith, 0.5);
  vec3 skyLight = mix(skyTone, vec3(dot(skyTone, vec3(0.3, 0.5, 0.2))), 0.5) * 0.55;

  // In the water: what it scatters back toward the eye, more of it the longer the way through.
  float path = cwWater_path(depth, view);
  float cloudy = 0.8 + 0.5 * cwGradNoise(p * 0.23 + vec2(5.1, 2.3));
  float murk = 1.0 - exp(-path * 1.5 * cloudy);
  vec3 body = mix(cwWater_shallow, cwWater_deep, smoothstep(0.1, 1.2, depth));
  vec3 under = body * murk * (sunLight + skyLight);
  // Ripples that lean toward the sun gather a little more of its light into the water than those
  // that lean away: a soft shading that shows the ripples from any side, glint or no glint.
  under *= 1.0 + clamp(dot(slope, uSunDir.xz) * 3.2, -0.3, 0.3);

  #if CW_WATER_DETAIL > 0
    // Sunlight gathered into a moving net on the bed, in patches, where the bed is near enough
    // to show it.
    float net = cwWater_caustic(p + slope * 1.5) * cwWater_keep(9.0, pixel);
    float patches = smoothstep(0.25, 0.7, cwGradNoise(p * 1.1 + vec2(uTime * 0.05, 7.0)));
    float bedShows = smoothstep(0.02, 0.1, depth) * exp(-path * 3.0);
    under += vec3(0.5, 0.62, 0.5) * sunLight * (net * bedShows * (0.3 + 0.7 * patches) * 0.3);
  #endif

  // On the water: the sky, mirrored in the rippled surface.
  vec3 mirrored = reflect(-view, normal);
  mirrored.y = abs(mirrored.y);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(clamp(mirrored.y, 0.0, 1.0), 0.55));
  #if CW_WATER_DETAIL > 0
    // Clouds in the mirror. The shadow function says how much cloud stands between a place and
    // the sun; asked about the place whose sunward ray ends where the mirrored ray does, it
    // says how much cloud the mirror shows. The layer's height is not known here and need not
    // be: any height gives clouds of the right kind, drifting the right way.
    // The clouds are far away, so the ripples smear their picture; it is looked up through a
    // surface with most of the ripple taken out, which keeps it from breaking into blotches.
    vec3 calm = reflect(-view, normalize(vec3(-slope.x * 0.3, 1.0, -slope.y * 0.3)));
    calm.y = abs(calm.y);
    vec2 toMirrored = calm.xz / (calm.y + 0.16) - uSunDir.xz / (max(uSunDir.y, 0.0) + 0.16);
    float cloud = smoothstep(0.0, 0.5, 1.0 - cwCloudShadow(p + toMirrored * 14.0));
    sky = mix(sky, uSunColor * 0.8 + uSkyHorizon * 0.45, cloud * 0.55);
  #endif
  // Low in the mirror stands the land around the water, not the sky.
  vec3 land = vec3(0.035, 0.06, 0.03) * (uSunColor * max(uSunDir.y, 0.0) + skyLight);
  sky = mix(land, sky, 0.3 + 0.7 * smoothstep(0.02, 0.2, mirrored.y));
  vec3 light = under * (1.0 - fresnel) + sky * fresnel;
  float through = (1.0 - fresnel) * (1.0 - murk);

  // And the sun: a tight glint off the ripples, which are tilted more steeply for it than they
  // are drawn, so that the glitter spreads over a patch of water and not one mirror point. As
  // the ripples fade with distance the glint widens into a soft sheen.
  vec3 glintNormal = normalize(vec3(-glitter.x, 1.0, -glitter.y));
  float halfway = max(dot(glintNormal, normalize(uSunDir + view)), 0.0);
  float tight = mix(90.0, 1400.0, keepMid * (0.5 + 0.5 * keepFine));
  float glint = pow(halfway, tight) * (tight + 8.0) * 0.0075 + pow(halfway, 40.0) * 0.06;
  light += uSunColor * (glint * sunReach * smoothstep(0.0, 0.08, depth));

  // Foam: a soft band on the waterline that breaks into lace on its way out, heavier on some
  // stretches of shore than on others, swelling and thinning with the lapping.
  float reach = cwGradNoise(p * 0.8 + vec2(11.0 + uTime * 0.015, 4.0));
  float lace = cwFbm(p * 7.0 + vec2(uTime * 0.05, uTime * 0.03), CW_WATER_DETAIL > 0 ? 3 : 2);
  lace = mix(0.5, lace, cwWater_keep(7.0, pixel));
  // How far out from the waterline this is, along the ground, in tiles.
  float out1 = depth / max(cwBank, 0.1);
  float wash = (0.1 + 0.1 * lap) * (0.4 + 1.2 * reach);
  float along = out1 / wash;
  float fade = 1.0 - smoothstep(0.0, 1.0, along);
  float foam = fade * smoothstep(0.34, 0.8, lace + 0.5 * fade * fade);
  foam *= 0.66 * (0.35 + 0.65 * smoothstep(0.15, 0.6, reach));
  light = mix(light, cwWater_foam * (sunLight + skyLight), foam);
  through *= 1.0 - foam;

  light = mix(vec3(4.0, 0.0, 0.0), light, getShadowMask()); // DEBUG
  float alpha = 1.0 - through;
  gl_FragColor = vec4(light / max(alpha, 1e-3), alpha * edge);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** The water module keeps no surface layer: this stands in for it in the terrain it remembers. */
const NO_SURFACE = new Uint8Array(0);

/** Whether the water has to be rebuilt for `next`: its water changed, or the ground under or near it did. */
function waterChanged(last: TerrainData | null, next: TerrainData): boolean {
  if (!last || last.width !== next.width || last.height !== next.height) return true;
  const { width, height } = next;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < next.water.length; i++) {
    const level = next.water[i] as number;
    if (level !== last.water[i]) return true;
    if (level === 0) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return false;
  // The corners that shape the ground under the sheets: those of the tiles around the water,
  // and one more ring, which the smooth ground's slopes are taken from.
  const stride = width + 1;
  const cx0 = Math.max(0, x0 - 2);
  const cy0 = Math.max(0, y0 - 2);
  const cx1 = Math.min(width, x1 + 3);
  const cy1 = Math.min(height, y1 + 3);
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      if (next.corners[y * stride + x] !== last.corners[y * stride + x]) return true;
    }
  }
  return false;
}

/**
 * Creates the water module: one geometry for all the water on the map, rebuilt when the water or
 * the ground around it changes, and drawn twice after the ground. The first pass multiplies the
 * bed by what the water lets through of each color; the second lays the water's own light over
 * it. The second receives the sun's shadows and the clouds', and reads the sun and sky from the
 * shared uniforms; both take the scene's fog.
 */
export function createWater(ctx: RenderContext): WaterModule {
  const encoded = { value: 0 };
  const tintMaterial = new ShaderMaterial({
    uniforms: {
      ...UniformsUtils.merge([UniformsLib.fog]),
      ...ctx.uniforms,
      cwWater_encoded: encoded,
    },
    vertexShader: TINT_VERTEX,
    fragmentShader: TINT_FRAGMENT,
    fog: true,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: ZeroFactor,
    blendDst: SrcColorFactor,
    blendSrcAlpha: ZeroFactor,
    blendDstAlpha: OneFactor,
  });
  const surfaceMaterial = new ShaderMaterial({
    uniforms: {
      ...UniformsUtils.merge([UniformsLib.lights, UniformsLib.fog]),
      ...ctx.uniforms,
      ...ctx.atmosphereUniforms,
    },
    defines: { CW_WATER_DETAIL: ctx.quality === "low" ? 0 : 1 },
    vertexShader: SURFACE_VERTEX,
    fragmentShader: SURFACE_FRAGMENT,
    lights: true,
    fog: true,
    transparent: true,
    depthWrite: false,
  });
  let tint: Mesh | null = null;
  let surface: Mesh | null = null;
  let last: TerrainData | null = null;

  function clear(): void {
    if (!tint || !surface) return;
    ctx.scene.remove(tint, surface);
    tint.geometry.dispose();
    tint = null;
    surface = null;
  }

  return {
    setTerrain(t: TerrainData): void {
      if (!waterChanged(last, t)) return;
      // A copy of what the sheets were built from: the caller may go on changing its arrays.
      last = {
        width: t.width,
        height: t.height,
        corners: t.corners.slice(),
        surface: NO_SURFACE,
        water: t.water.slice(),
      };
      clear();
      const built = buildWaterGeometry(t);
      if (!built) return;
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(built.positions, 3));
      geometry.setAttribute("depth", new BufferAttribute(built.depths, 1));
      geometry.setAttribute("bank", new BufferAttribute(built.banks, 1));
      // Level everywhere; the shadow lookup is nudged along it.
      const normals = new Float32Array(built.positions.length);
      for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
      geometry.setAttribute("normal", new BufferAttribute(normals, 3));
      geometry.setIndex(new BufferAttribute(built.indices, 1));
      geometry.computeBoundingSphere();

      // After the ground, so the bed is there to tint; and the tint before the surface.
      tint = new Mesh(geometry, tintMaterial);
      tint.renderOrder = 1;
      // The bed is stored encoded exactly when the frame goes straight to the canvas.
      tint.onBeforeRender = (renderer) => {
        encoded.value = renderer.getRenderTarget() === null ? 1 : 0;
      };
      surface = new Mesh(geometry, surfaceMaterial);
      surface.receiveShadow = true;
      surface.renderOrder = 2;
      ctx.scene.add(tint, surface);
    },
    setQuality(q: Quality): void {
      const detail = q === "low" ? 0 : 1;
      if (surfaceMaterial.defines.CW_WATER_DETAIL === detail) return;
      surfaceMaterial.defines.CW_WATER_DETAIL = detail;
      surfaceMaterial.needsUpdate = true;
    },
    dispose(): void {
      clear();
      tintMaterial.dispose();
      surfaceMaterial.dispose();
    },
  };
}
