import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
  Vector4,
  type IUniform,
} from "three";
import type { Quality, RenderContext, SceneModule } from "../context.js";
import { HEIGHT_STEP, WATER_LIFT } from "../units.js";
import type { TerrainData } from "./geometry.js";
import type { TerrainChunk } from "./material.js";
import {
  DETAIL_SIZE,
  FIELD_TEXELS,
  GRAIN_SIZE,
  SURFACE_MARGIN,
  WEIGHT_TEXELS,
  bakeGroundField,
  bakeSurfaceWeights,
  buildDetailNoise,
  buildGrainTexture,
  buildGroundField,
  buildSurfaceWeights,
  changedRect,
  tilesAroundCorners,
  unionRect,
  type GridRect,
  type SurfaceTexture,
} from "./surface-data.js";

/** The ground's look: the `cwSurface` chunk of the terrain shader and the data it reads. */
export type SurfaceModule = TerrainChunk & SceneModule;

/**
 * A GLSL `mat2` that takes world (x, z) to the detail texture's coordinates so that the texture
 * repeats every `period` tiles, turned by `angle` radians. The turn keeps the repeat off the tile
 * grid: no period here is a whole number of tiles along either axis. With `stretch`, the texture
 * is drawn out that many times longer along its second axis, which turns round spots into wisps.
 */
function lay(period: number, angle: number, stretch = 1): string {
  const c = Math.cos(angle) / period;
  const s = Math.sin(angle) / period;
  // GLSL matrices are written a column at a time; the second row is the stretched axis.
  return `mat2(${c.toFixed(6)}, ${(s / stretch).toFixed(6)}, ${(-s).toFixed(6)}, ${(c / stretch).toFixed(6)})`;
}

/** The turn of `lay` alone, to bring a slope read from the texture back to world axes. */
function turn(angle: number): string {
  return lay(1, angle);
}

const FINE = { period: 1.93, angle: 0.55 };
const MID = { period: 7.7, angle: -0.95, stretch: 1.7 };
const BROAD = { period: 29.3, angle: 0.31 };
const BLADE = { period: 4.23, angle: 1.05 };
const TUFT = { period: 10.3, angle: -0.41 };

/**
 * The ground's shader. One function, `cwSurface`, that decides color, roughness and normal from
 * the world position and the ground's own normal.
 *
 * How it stays cheap and calm: everything finer than a few tiles comes from two small tileable
 * textures, the detail noise read at three sizes and the grain read at two. Their mipmaps bring
 * each read to an even tone with distance, so nothing shimmers. The broad variations and the bends
 * of the borders are computed noise, which never repeats. The painted surfaces and the water come
 * from two data textures read once each. Nothing in here knows where a tile begins or ends.
 */
const SURFACE_GLSL = /* glsl */ `
uniform sampler2D cwSurf_weights;
uniform sampler2D cwSurf_field;
uniform sampler2D cwSurf_detail;
uniform sampler2D cwSurf_grain;
// xy: world position of the data textures' north-west corner. zw: one over their size in tiles.
uniform vec4 cwSurf_rect;
// 0 low, 1 medium, 2 high.
uniform float cwSurf_quality;

const mat2 cwSurf_fineLay = ${lay(FINE.period, FINE.angle)};
const mat2 cwSurf_midLay = ${lay(MID.period, MID.angle, MID.stretch)};
// A slope read from the stretched texture is that much gentler along its second axis.
const vec2 cwSurf_midSlope = vec2(1.0, ${(1 / MID.stretch).toFixed(4)});
const mat2 cwSurf_broadLay = ${lay(BROAD.period, BROAD.angle)};
const mat2 cwSurf_bladeLay = ${lay(BLADE.period, BLADE.angle)};
const mat2 cwSurf_tuftLay = ${lay(TUFT.period, TUFT.angle)};
const mat2 cwSurf_fineTurn = ${turn(FINE.angle)};
const mat2 cwSurf_midTurn = ${turn(MID.angle)};

const float cwSurf_heightStep = ${HEIGHT_STEP.toFixed(4)};
const float cwSurf_waterLift = ${WATER_LIFT.toFixed(4)};

// Albedos, linear.
const vec3 cwSurf_grassDeep = vec3(0.046, 0.114, 0.028);
const vec3 cwSurf_grassLush = vec3(0.064, 0.150, 0.030);
const vec3 cwSurf_grassFresh = vec3(0.102, 0.190, 0.038);
const vec3 cwSurf_grassDry = vec3(0.158, 0.182, 0.062);
const vec3 cwSurf_meadowOlive = vec3(0.078, 0.122, 0.036);
const vec3 cwSurf_meadowGreen = vec3(0.078, 0.152, 0.036);
const vec3 cwSurf_meadowStraw = vec3(0.170, 0.176, 0.068);
const vec3 cwSurf_sandLight = vec3(0.500, 0.425, 0.290);
const vec3 cwSurf_sandDark = vec3(0.405, 0.325, 0.205);
const vec3 cwSurf_dirtDark = vec3(0.120, 0.078, 0.046);
const vec3 cwSurf_dirtLight = vec3(0.225, 0.152, 0.088);
const vec3 cwSurf_rockDark = vec3(0.150, 0.140, 0.128);
const vec3 cwSurf_rockLight = vec3(0.360, 0.335, 0.300);
const vec3 cwSurf_moss = vec3(0.085, 0.120, 0.040);
const vec3 cwSurf_snowLight = vec3(0.790, 0.800, 0.810);
const vec3 cwSurf_snowShade = vec3(0.600, 0.675, 0.775);
const vec3 cwSurf_silt = vec3(0.215, 0.185, 0.120);

// How much of a layer shows where its painted weight is \`weight\`, given the height \`h\` (0..1) of
// the ground's small bumps there: the layer comes in first where \`h\` is high, so its edge follows
// the bumps and not the tile, the more so the larger \`sway\` is. Zero weight is always none and
// full weight always all.
float cwSurf_cover(float weight, float h, float sway, float soft) {
  float v = weight * (1.0 + sway) - sway * (1.0 - h);
  return smoothstep(0.5 - soft, 0.5 + soft, v);
}

// Three numbers in 0..1 for a point of the lattice in space.
vec3 cwSurf_hash33(vec3 cell) {
  ivec3 c = ivec3(cell);
  uint h = cwHashU(uvec2(uint(c.x) + uint(c.y) * 0x27D4EB2Fu, uint(c.z) + uint(c.y) * 0x165667B1u));
  return vec3(float(h & 1023u), float((h >> 10) & 1023u), float((h >> 20) & 1023u)) * (1.0 / 1023.0);
}

// Stones packed together in space, about one to a unit, so that a cut through them looks the same
// on a cliff as on the flat. x: how far in from the stone's side this is (0 on the joint between
// two stones). y: a number in 0..1 that names the stone. \`toHere\` is set to the way from the
// stone's middle to this point.
vec2 cwSurf_stones(vec3 p, out vec3 toHere) {
  vec3 i = floor(p);
  vec3 f = p - i;
  float first = 8.0;
  float second = 8.0;
  vec3 best = vec3(0.0);
  toHere = vec3(0.0);
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 cell = vec3(float(x), float(y), float(z));
        vec3 d = cell + cwSurf_hash33(i + cell) - f;
        float dist = dot(d, d);
        if (dist < first) {
          second = first;
          first = dist;
          best = cell;
          toHere = -d;
        } else if (dist < second) {
          second = dist;
        }
      }
    }
  }
  return vec2(sqrt(second) - sqrt(first), cwSurf_hash33(i + best + vec3(57.0, 113.0, 31.0)).x);
}

// The detail noise as it lies on a wall: read on the two upright planes and mixed by which way
// the wall faces, so that it is not drawn out down the slope as a read from above would be.
// \`dx\` and \`dy\` are the change of \`pos\` from this pixel to the next, across and down.
vec4 cwSurf_wall(vec3 pos, vec3 n, vec3 dx, vec3 dy) {
  vec2 facing = n.xz * n.xz;
  facing /= facing.x + facing.y + 1e-4;
  const float scale = 0.31;
  vec4 east = textureGrad(cwSurf_detail, pos.zy * scale, dx.zy * scale, dy.zy * scale);
  vec4 south = textureGrad(cwSurf_detail, pos.xy * scale + 0.37, dx.xy * scale, dy.xy * scale);
  return east * facing.x + south * facing.y;
}

void cwSurface(inout CwSurf s, vec3 worldPos) {
  vec2 p = worldPos.xz;
  vec3 base = s.normal;
  bool rich = cwSurf_quality > 0.5;
  vec3 stepX = dFdx(worldPos);
  vec3 stepY = dFdy(worldPos);

  // World units one pixel covers here, along its longer side.
  vec2 px2 = vec2(dot(stepX.xz, stepX.xz), dot(stepY.xz, stepY.xz));
  float px = sqrt(max(px2.x, px2.y));
  // Drawn marks (flowers, cracks, ripples) leave before they are too small to draw cleanly.
  float near = 1.0 - smoothstep(0.012, 0.05, px);

  // The broadest variations are computed, so they never repeat: the lay of the land over tens of
  // tiles, and bends of three lengths that push the borders of things about.
  float region = (cwFbm(p * 0.037 + vec2(3.7, 9.2), 3) - 0.5) * 4.0;
  float climate = rich ? (cwFbm(p * 0.0113 + vec2(31.0, 5.0), 2) - 0.5) * 4.0 : 0.0;
  vec2 warp = cwGradNoiseD(p * 0.13 + vec2(11.3, 47.1)).yz * 2.1;
  warp += cwGradNoiseD(p * 0.29 + vec2(5.1, 81.7)).yz * 0.95;
  if (rich) warp += cwGradNoiseD(p * 0.63 + vec2(71.9, 23.4)).yz * 0.36;
  float streak = cwGradNoise(vec2(dot(p, vec2(0.62, 0.28)), dot(p, vec2(-0.035, 0.078)))) - 0.5;

  // Everything finer is the two textures, each pushed around by the one before it so that its
  // own repeat does not show. The grain is read a little sharper than its mipmaps would have
  // it, which keeps the grass crisp in the middle distance.
  vec4 broad = texture(cwSurf_detail, cwSurf_broadLay * p + region * 0.15);
  vec4 mid = texture(cwSurf_detail, cwSurf_midLay * p + (broad.g - 0.5) * 0.08);
  vec4 fine = texture(cwSurf_detail, cwSurf_fineLay * p + (mid.g - 0.5) * 0.03);
  vec4 blades = texture(cwSurf_grain, cwSurf_bladeLay * p + (mid.rg - 0.5) * 0.02, -0.3);
  vec4 tufts = texture(cwSurf_grain, cwSurf_tuftLay * p + (broad.rg - 0.5) * 0.04, -0.5);
  float bR = broad.r - 0.5;
  float bG = broad.g - 0.5;
  float mR = mid.r - 0.5;
  float mG = mid.g - 0.5;
  float fR = fine.r - 0.5;
  float blade = blades.r - 0.5;
  float tuft = tufts.r - 0.5;

  // The small bumps of the ground, 0..1 around one half. Layer borders follow them: softly from
  // afar, blade by blade from close by.
  float h = clamp(0.5 + mG * 1.1 + blade * 0.55 + tuft * 0.55, 0.0, 1.0);
  float lump = clamp(0.5 + mR * 1.5 + fR * 0.5, 0.0, 1.0);
  float soft = clamp(px * 2.0, 0.05, 0.3);

  // The painted surfaces and the water, read a little off the true position: the offset wanders
  // over a few tiles, which is what turns a painted rectangle into a patch.
  vec4 w = texture(cwSurf_weights, (p + warp - cwSurf_rect.xy) * cwSurf_rect.zw);
  vec4 field = texture(cwSurf_field, (p + warp * 0.25 - cwSurf_rect.xy) * cwSurf_rect.zw);
  float nearWater = field.r;
  float relief = (field.b - 128.0 / 255.0) * 2.0;
  float slope = 1.0 - base.y;

  // 1 inside the park, 0 out in the meadow, with a wandering border a little outside the edge.
  vec2 q = p + warp * 0.6;
  vec2 outside = max(-q, q - uMapSize);
  float park = 1.0 - smoothstep(0.2, 2.6, max(outside.x, outside.y) + mG * 1.4 + bG * 1.4);

  // Grass: a kept lawn in the park. Deep, lush and fresh greens drift into each other over
  // several scales; rises, slopes and dry spells yellow it a little, water keeps it green.
  float tone = clamp(0.5 + region * 0.22 + bG * 0.5 + mG * 0.55 + bR * 0.2 + streak * 0.8, 0.0, 1.0);
  vec3 lawn = mix(cwSurf_grassDeep, cwSurf_grassLush, smoothstep(0.0, 0.55, tone));
  lawn = mix(lawn, cwSurf_grassFresh, smoothstep(0.4, 1.0, tone) * 0.85);
  float dry = relief * 1.3 + smoothstep(0.04, 0.17, slope) * 0.4 + climate * 0.3 + bR * 0.5;
  dry = clamp(dry - nearWater * 0.6, 0.0, 1.0);
  lawn = mix(lawn, cwSurf_grassDry, dry * 0.55);

  // Meadow: the same grass left alone. Olive and green, going to straw in places.
  float wildTone = clamp(0.5 + climate * 0.3 + region * 0.2 + bG * 0.5 + mG * 0.6, 0.0, 1.0);
  vec3 wild = mix(cwSurf_meadowOlive, cwSurf_meadowGreen, wildTone);
  float straw = clamp(0.3 + bR * 0.9 + mR * 0.9 - climate * 0.3 + relief, 0.0, 1.0);
  wild = mix(wild, cwSurf_meadowStraw, straw * 0.45);

  vec3 color = mix(wild, lawn, park);
  // A slow drift between warmer and cooler green, so no two lawns are quite the same color.
  color *= mix(vec3(1.08, 1.0, 0.88), vec3(0.93, 1.0, 1.12), clamp(0.5 + region * 0.5 + climate * 0.3 + bR * 1.3, 0.0, 1.0));
  // Mottle, tufts and blades. Each of these reads zero once its mipmaps have averaged it out, so
  // from far away this multiplies by one. Tips are yellower than feet.
  float shag = mix(1.4, 1.0, park);
  vec3 grain = blade * vec3(1.0, 0.82, 0.5) + tuft * vec3(0.8, 0.66, 0.42);
  float clump = smoothstep(0.36, 0.64, mid.r) - 0.5;
  color *= 1.0 + (grain + clump * 0.13 + mR * 0.2) * shag + fR * 0.22 + streak * 0.2;
  // Grass seen along the ground shows its lit tips; seen from above, the shade between blades.
  vec3 toEye = normalize(cameraPosition - worldPos);
  float graze = 1.0 - clamp(dot(base, toEye), 0.0, 1.0);
  color = mix(color, color * 1.3 + vec3(0.010, 0.014, 0.0), graze * graze * graze * 0.7);
  if (rich) {
    // Flower heads out in the meadow, in drifts.
    float drift = smoothstep(0.5, 0.8, 0.5 + bG * 1.3 + mR * 0.7) * (1.0 - park) * near;
    float head = blades.g * smoothstep(0.5, 0.56, blades.b) * drift;
    vec3 petal = mix(vec3(0.74, 0.73, 0.64), vec3(0.74, 0.56, 0.08), step(0.8, blades.b));
    petal = mix(petal, vec3(0.44, 0.24, 0.44), step(0.94, blades.b));
    color = mix(color, petal * (0.85 + 0.3 * blades.r), head * 0.8);
  }
  float roughness = 0.93;
  float bump = mix(1.5, 1.05, park);
  float occlusion = 1.0;
  vec2 lean = vec2(0.0);

  // Steep ground cannot hold grass, sand or snow: bare earth first, then rock.
  float steep = slope + (lump - 0.5) * 0.09 + bG * 0.05;
  // On a wall the textures read from above are drawn out down the slope. What bare ground is
  // made of there is read on the wall's own face.
  float wall = smoothstep(0.1, 0.26, slope);
  float wR = mR;
  float wG = mG;
  float wF = fR;
  if (wall > 0.0) {
    vec4 face = cwSurf_wall(worldPos, base, stepX, stepY);
    wR = mix(mR, face.r - 0.5, wall);
    wG = mix(mG, face.g - 0.5, wall);
    wF = fR * (1.0 - wall);
  }

  // Rock, painted or laid bare by the slope: stones of three sizes, each with a face of its own
  // to the light and a tone of its own, shaded in the joints; bedded in layers where it stands
  // up, mossy where it lies flat.
  float block = clamp(0.5 + wR * 1.2 + bR * 0.8 + wF * 0.9, 0.0, 1.0);
  vec3 rockColor = mix(cwSurf_rockDark, cwSurf_rockLight, block);
  rockColor *= mix(vec3(1.07, 1.0, 0.9), vec3(0.93, 1.0, 1.08), clamp(0.5 + bG * 1.6, 0.0, 1.0));
  float crevice = 0.0;
  vec3 push = vec3(0.0);
  float dome = lump;
  float bedShift = 0.0;
  float rubble = 0.0;
  float big = (1.0 - smoothstep(0.25, 0.8, px)) * step(0.004, max(w.b, steep - 0.16));
  if (big > 0.0) {
    vec3 rp = vec3(worldPos.x, worldPos.y * 1.5, worldPos.z);
    vec3 off;
    vec2 boulder = cwSurf_stones(rp * 0.62 + vec3(mR, wG, bG) * 0.5, off);
    float inside = smoothstep(0.0, 0.45, boulder.x);
    dome = mix(lump, clamp(inside * 0.8 + lump * 0.4 - 0.1, 0.0, 1.0), big);
    rockColor *= 1.0 + (boulder.y - 0.5) * 0.34 * big;
    // Half rounded, half a flat face turned its own way.
    vec3 turned = vec3(sin(boulder.y * 37.0), 0.0, cos(boulder.y * 53.0));
    push = (off * 0.5 + turned * 0.3) * big;
    crevice = (1.0 - inside) * big;
    bedShift = boulder.y * 5.0;
    float small = 1.0 - smoothstep(0.08, 0.25, px);
    if (small > 0.0) {
      vec2 chip = cwSurf_stones(rp * 2.3 + vec3(wG, wR, bR) * 1.2 + boulder.y * 9.0, off);
      rockColor *= 1.0 + (chip.y - 0.5) * 0.24 * small;
      turned = vec3(sin(chip.y * 41.0), 0.0, cos(chip.y * 29.0));
      push += (off * 0.3 + turned * 0.28) * small;
      // Not every joint is open: they come and go along their length.
      float open = small * smoothstep(-0.25, 0.25, wR + bG);
      crevice = max(crevice, (1.0 - smoothstep(0.0, 0.25, chip.x)) * open * 0.6);
      rubble = (chip.y - 0.5) * small;
      float tiny = 1.0 - smoothstep(0.012, 0.04, px);
      if (tiny > 0.0) {
        vec2 fleck = cwSurf_stones(rp * 7.1 + chip.y * 5.0, off);
        rockColor *= 1.0 + (fleck.y - 0.5) * 0.2 * tiny;
        push += off * (0.22 * tiny);
        crevice = max(crevice, (1.0 - smoothstep(0.0, 0.2, fleck.x)) * tiny * open * 0.4);
      }
    }
  }
  float beds = sin(worldPos.y * 19.0 + wG * 4.0 + bR * 5.0 + bedShift);
  rockColor *= 1.0 + beds * 0.12 * smoothstep(0.12, 0.3, slope) * near;
  rockColor *= 1.0 - crevice * crevice * 0.5;
  float moss = smoothstep(0.6, 0.85, 0.5 + mG * 1.5 + bG) * smoothstep(0.8, 0.97, base.y);
  rockColor = mix(rockColor, cwSurf_moss * (1.0 + blade), moss * 0.4);
  // Lichen and pits, from close by.
  float spot = max(tufts.g, blades.g) * near * (1.0 - wall);
  rockColor *= 1.0 + spot * (fract(tufts.b * 5.0 + blades.b * 3.0) - 0.6) * 0.5;

  // Painted layers, one over the other. Earth and sand lie in the hollows between tufts, rock
  // comes up stone by stone, snow lies in soft drifts.
  float dirt = cwSurf_cover(w.g, 1.0 - h, 0.5, soft);
  float sand = cwSurf_cover(w.r, 1.0 - h, 0.3, soft);
  float rock = cwSurf_cover(w.b, dome, 0.8, soft);
  float snow = cwSurf_cover(w.a, clamp(0.5 + mG * 1.2 + bG * 0.6, 0.0, 1.0), 0.4, soft * 1.5 + 0.04);
  float scree = smoothstep(0.18, 0.29, steep) * (1.0 - rock);
  float crag = smoothstep(0.28, 0.39, steep + (dome - 0.5) * 0.08);
  float stony = max(rock, crag);

  // Earth: crumbs and clods, and a scattering of stones.
  vec3 dirtColor = mix(cwSurf_dirtDark, cwSurf_dirtLight, clamp(0.5 + wG * 1.1 + bG * 0.9, 0.0, 1.0));
  dirtColor *= 1.0 + wF * 0.45 + wR * mix(0.35, 0.8, wall) + rubble * 0.3 * wall;
  float pebble = max(tufts.g * step(0.66, tufts.b), blades.g * step(0.76, blades.b)) * (1.0 - wall);
  float pebbleTone = fract(tufts.b * 7.0 + blades.b * 3.0);
  vec3 pebbleColor = mix(cwSurf_rockDark, cwSurf_rockLight, pebbleTone * 0.6) * vec3(1.08, 0.98, 0.86);
  dirtColor = mix(dirtColor, pebbleColor, pebble * 0.7);

  // Sand: pale and even, with wind ripples and the odd dark grain.
  vec3 sandColor = mix(cwSurf_sandDark, cwSurf_sandLight, clamp(0.55 + bG * 0.8 + mG * 0.5, 0.0, 1.0));
  float ripplePhase = dot(p, vec2(31.0, 21.0)) + mR * 7.0 + bG * 9.0;
  float ripple = near * sand * (1.0 - snow) * (1.0 - stony);
  sandColor *= 1.0 + fR * 0.14 + mR * 0.08 + sin(ripplePhase) * ripple * 0.035;
  sandColor = mix(sandColor, sandColor * 0.62, blades.g * step(0.8, blades.b) * 0.7);
  lean += vec2(31.0, 21.0) * (cos(ripplePhase) * ripple * 0.004);

  vec3 snowColor = mix(cwSurf_snowShade, cwSurf_snowLight, clamp(0.66 + mG * 1.1 + bR * 0.7, 0.0, 1.0));

  // Around bare ground the grass thins and yellows before it stops, and around rock the earth
  // shows between the tufts.
  float thin = max(max(w.r, w.g), w.b) * (1.0 - max(max(sand, dirt), rock));
  color = mix(color, cwSurf_grassDry * (1.0 + grain), thin * 0.6);
  float worn = smoothstep(0.12, 0.5, w.b) * (1.0 - rock) * smoothstep(0.62, 0.42, h);
  color = mix(color, dirtColor, worn * 0.7);

  color = mix(color, dirtColor, dirt);
  roughness = mix(roughness, 0.96, dirt);
  bump = mix(bump, 1.0, dirt);

  // The grass around sand stands a little above it, and shades its rim.
  color = mix(color, sandColor * (1.0 - 0.35 * sand * (1.0 - sand) * 4.0), sand);
  roughness = mix(roughness, 0.88, sand);
  bump = mix(bump, 0.25, sand);

  // Rock stands above the grass around it, which lies in its shade at the foot.
  color *= 1.0 - 0.3 * rock * (1.0 - rock) * 4.0;
  color = mix(color, rockColor, rock);
  roughness = mix(roughness, 0.8, rock);
  bump = mix(bump, 1.8, rock);

  color = mix(color, snowColor, snow);
  roughness = mix(roughness, 0.62, snow);
  bump = mix(bump, 0.5, snow);

  color = mix(color, dirtColor * 1.15, scree);
  roughness = mix(roughness, 0.96, scree);
  bump = mix(bump, 1.2, scree);

  color = mix(color, rockColor, crag);
  roughness = mix(roughness, 0.8, crag);
  bump = mix(bump, 1.8, crag);
  occlusion *= 1.0 - crevice * 0.35 * stony;
  push *= stony;

  // Water's edge. The level is known wherever water is near, so the ground knows how far above
  // or below the surface it is: silt, not grass, below it, and damp and dark where the water
  // laps, which is as far from it as the proximity says and no higher than a hand above it.
  float level = field.g * 255.0 * cwSurf_heightStep + cwSurf_waterLift;
  float above = worldPos.y - level;
  float shore = smoothstep(0.02, 0.25, nearWater);
  float bed = shore * smoothstep(0.02, -0.1, above);
  color = mix(color, mix(cwSurf_silt, sandColor, max(sand, 0.25)) * (1.0 + fR * 0.2), bed * (1.0 - stony));
  float lap = smoothstep(0.62, 0.9, nearWater + bG * 0.5 + mG * 0.45);
  float damp = lap * (1.0 - smoothstep(0.03, 0.2, above));
  // Under the surface the bed is lit through the water, which does its own darkening.
  float wet = damp * (1.0 - 0.7 * smoothstep(0.0, 0.1, -above));
  color *= mix(vec3(1.0), vec3(0.64, 0.58, 0.49), wet);
  roughness = mix(roughness, 0.42, wet * max(max(sand, stony), 0.35));
  bump *= 1.0 - 0.6 * damp;

  // Bump: lean the normal against the slope of the detail noise (not on a wall, where that
  // noise is drawn out) and of the sand's ripples, and out from the middle of each stone.
  lean += (((fine.ba - 0.5) * cwSurf_fineTurn) * 0.75 + (((mid.ba - 0.5) * cwSurf_midSlope) * cwSurf_midTurn) * 0.55) * (bump * (1.0 - wall));
  vec3 tilt = vec3(lean.x, 0.0, lean.y) - push;
  tilt -= base * dot(base, tilt);

  s.albedo = color;
  s.roughness = roughness;
  s.normal = normalize(base - tilt);
  s.occlusion *= occlusion;
}
`;

/** The detail noise and the grain are the same for every scene, and take a moment to make: made once. */
let detailNoise: Uint8Array | null = null;
let grainMarks: Uint8Array | null = null;

function dataTexture(source: SurfaceTexture): DataTexture {
  const texture = new DataTexture(
    source.data,
    source.width,
    source.height,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** A square texture that repeats, with mipmaps. */
function tilingTexture(data: Uint8Array, size: number): DataTexture {
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** A data texture together with the bytes behind it and whether the GPU has them yet. */
interface Layer {
  source: SurfaceTexture;
  texture: DataTexture;
  uploaded: boolean;
}

function layer(source: SurfaceTexture): Layer {
  const made: Layer = { source, texture: dataTexture(source), uploaded: false };
  made.texture.onUpdate = () => {
    made.uploaded = true;
  };
  return made;
}

/**
 * Marks the texels of `tiles` grown by `reach` for upload. Once the GPU has the whole texture,
 * only those rows' changed stretch is sent again; before that the whole of it is still to go.
 */
function touch(target: Layer, texels: number, tiles: GridRect, reach: number): void {
  const { width, height } = target.source;
  const clampTo = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  const x0 = clampTo((tiles.x0 - reach + SURFACE_MARGIN) * texels, width);
  const x1 = clampTo((tiles.x1 + reach + SURFACE_MARGIN) * texels, width);
  const y0 = clampTo((tiles.y0 - reach + SURFACE_MARGIN) * texels, height);
  const y1 = clampTo((tiles.y1 + reach + SURFACE_MARGIN) * texels, height);
  if (target.uploaded && x1 > x0) {
    for (let y = y0; y < y1; y++) target.texture.addUpdateRange((y * width + x0) * 4, (x1 - x0) * 4);
  }
  target.texture.needsUpdate = true;
}

const QUALITY_LEVEL: Record<Quality, number> = { low: 0, medium: 1, high: 2 };
/** How far the detail and grain textures are kept sharp at a grazing angle, by quality. */
const ANISOTROPY: Record<Quality, number> = { low: 1, medium: 2, high: 4 };

/** The grids of the terrain last baked, to find what a new terrain changes. */
interface Baked {
  width: number;
  height: number;
  surface: Uint8Array;
  water: Uint8Array;
  corners: Int16Array;
}

/**
 * Creates the surface module: the `cwSurface` chunk, the surface weights and ground field it
 * reads (rebaked only where a terrain change reaches), the detail noise and the grain.
 */
export function createSurface(ctx: RenderContext): SurfaceModule {
  const blank = { width: 1, height: 1, corners: new Int16Array(4), surface: new Uint8Array(1), water: new Uint8Array(1) };
  let weights = layer(buildSurfaceWeights(blank));
  let field = layer(buildGroundField(blank));
  detailNoise ??= buildDetailNoise(DETAIL_SIZE);
  grainMarks ??= buildGrainTexture(GRAIN_SIZE);
  const detail = tilingTexture(detailNoise, DETAIL_SIZE);
  const grain = tilingTexture(grainMarks, GRAIN_SIZE);
  detail.anisotropy = grain.anisotropy = ANISOTROPY[ctx.quality];
  let baked: Baked | null = null;

  const uniforms = {
    cwSurf_weights: { value: weights.texture } as IUniform<DataTexture>,
    cwSurf_field: { value: field.texture } as IUniform<DataTexture>,
    cwSurf_detail: { value: detail } as IUniform<DataTexture>,
    cwSurf_grain: { value: grain } as IUniform<DataTexture>,
    cwSurf_rect: { value: new Vector4(-SURFACE_MARGIN, -SURFACE_MARGIN, 1, 1) } as IUniform<Vector4>,
    cwSurf_quality: { value: QUALITY_LEVEL[ctx.quality] } as IUniform<number>,
  };

  function rebuild(t: TerrainData): void {
    // A texture cannot change size once it has been uploaded, so a new map gets new ones.
    weights.texture.dispose();
    field.texture.dispose();
    weights = layer(buildSurfaceWeights(t));
    field = layer(buildGroundField(t));
    uniforms.cwSurf_weights.value = weights.texture;
    uniforms.cwSurf_field.value = field.texture;
    uniforms.cwSurf_rect.value.set(
      -SURFACE_MARGIN,
      -SURFACE_MARGIN,
      1 / (t.width + 2 * SURFACE_MARGIN),
      1 / (t.height + 2 * SURFACE_MARGIN),
    );
    baked = {
      width: t.width,
      height: t.height,
      surface: t.surface.slice(),
      water: t.water.slice(),
      corners: t.corners.slice(),
    };
  }

  return {
    glsl: SURFACE_GLSL,
    uniforms,
    setTerrain(t: TerrainData): void {
      if (!baked || baked.width !== t.width || baked.height !== t.height) {
        rebuild(t);
        return;
      }
      const painted = changedRect(baked.surface, t.surface, t.width, t.height);
      if (painted) {
        bakeSurfaceWeights(t, weights.source, painted);
        touch(weights, WEIGHT_TEXELS, painted, 1);
        baked.surface.set(t.surface);
      }
      const flooded = changedRect(baked.water, t.water, t.width, t.height);
      const raised = changedRect(baked.corners, t.corners, t.width + 1, t.height + 1);
      const shaped = unionRect(flooded, raised && tilesAroundCorners(raised));
      if (shaped) {
        bakeGroundField(t, field.source, shaped);
        touch(field, FIELD_TEXELS, shaped, 1e6);
        baked.water.set(t.water);
        baked.corners.set(t.corners);
      }
    },
    setQuality(q: Quality): void {
      uniforms.cwSurf_quality.value = QUALITY_LEVEL[q];
      if (detail.anisotropy !== ANISOTROPY[q]) {
        detail.anisotropy = grain.anisotropy = ANISOTROPY[q];
        detail.needsUpdate = grain.needsUpdate = true;
      }
    },
    dispose(): void {
      weights.texture.dispose();
      field.texture.dispose();
      detail.dispose();
      grain.dispose();
    },
  };
}
