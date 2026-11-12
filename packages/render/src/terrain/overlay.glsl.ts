import { DataTexture, FloatType, RedFormat, Vector2, Vector4, type IUniform } from "three";
import type { FrameInfo, RenderContext, SceneModule } from "../context.js";
import { waterSurfaceY } from "../water.js";
import type { TerrainData } from "./geometry.js";
import type { TerrainChunk } from "./material.js";

/** The build aids drawn on the ground: the `cwOverlay` chunk of the terrain shader. */
export type OverlayModule = TerrainChunk &
  SceneModule & {
    /** Shows or hides the build grid. Hidden to start with. */
    setGridVisible(on: boolean): void;
    /** The tile rectangle to highlight, in tiles, or null for none. */
    setHighlight(rect: { x: number; y: number; w: number; h: number } | null): void;
    /**
     * Where the player's pointer is on the ground, in world units: the grid is strongest around
     * it. Null when the pointer is nowhere, and the grid then centers on the camera's target.
     */
    setCursor(point: { x: number; z: number } | null): void;
  };

/** Seconds the grid and the highlight take to fade in or out. */
export const OVERLAY_FADE_SECONDS = 0.15;
/** Time constant, in seconds, of the highlight's glide to a new rectangle. */
export const HIGHLIGHT_GLIDE_SECONDS = 0.04;
/** Time constant, in seconds, with which the middle of the grid follows the pointer. */
export const GRID_FOLLOW_SECONDS = 0.11;

/** What the water texture holds for a tile with no water over it: far below any ground. */
export const NO_WATER = -1e4;

/**
 * The world height of the water surface over every tile, row by row, or `NO_WATER`: over a water
 * tile its own level's surface, and over a dry tile beside water (corner to corner counts) that
 * water's, the highest when there are several, because the water module's sheets reach one tile
 * past their water to meet the bank. Ground of such a tile that is lower than this is under
 * water. Writes into `out` when it has the right length, so that a change of water on a map of
 * the same size allocates nothing.
 */
export function buildWaterHeights(t: TerrainData, out?: Float32Array): Float32Array {
  const { width, height, water } = t;
  const heights = out && out.length === width * height ? out : new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let level = water[y * width + x] as number;
      if (level === 0) {
        for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
            level = Math.max(level, water[ny * width + nx] as number);
          }
        }
      }
      heights[y * width + x] = level === 0 ? NO_WATER : waterSurfaceY(level);
    }
  }
  return heights;
}

/**
 * Moves `value` toward `target` by at most `step`, never past it. A fade is this with
 * `step = dt / OVERLAY_FADE_SECONDS` on a value in 0..1.
 */
export function approach(value: number, target: number, step: number): number {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return target;
}

/** Smooth start and stop for a fade: 0 at 0, 1 at 1, level at both ends; held to 0..1. */
export function easeInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * How much of the way to its goal a gliding value covers in `dt` seconds when it closes the gap
 * with time constant `tau`: 0 for no time, toward 1 for a long time, the same total over one long
 * frame as over many short ones.
 */
export function glideShare(dt: number, tau: number): number {
  if (!(dt > 0)) return 0;
  if (!(tau > 0)) return 1;
  return 1 - Math.exp(-dt / tau);
}

/**
 * The build grid and the highlight, drawn in the terrain shader from a handful of uniforms: they
 * lie on the ground by construction and nothing is rebuilt when the pointer moves.
 *
 * The grid. Lines on every tile border, each a little under two pixels wide whatever the zoom
 * (never thinner than 0.012 of a tile up close, never wider than 0.06 of one far away), with
 * edges softened over the pixel's own footprint on that axis. That width is deliberate: the
 * picture is smoothed again after it is drawn (SMAA at `high`, FXAA at `medium`), and a line
 * nearer one pixel wide comes out of that pass as a row of beads. A line that would be thinner
 * than a pixel is drawn a pixel wide and fainter by the same factor, and once tiles are only a
 * few pixels across an axis's lines dissolve into their average cover: so the far side of a
 * shallow view goes quietly even, with no shimmer and no moire, while lines running away from the
 * camera stay crisp. Every corner carries a plus mark, the lines at full strength for a sixth of
 * a tile either side of the crossing, and the lines between the marks are much lighter. The lines
 * are strongest at the grid's core (the pointer, or all of the rectangle being placed) and fade
 * out over about ten tiles; the marks last to twelve and a half. So the grid thins into a field
 * of marks and then into nothing, and never ends on an edge. It is also drawn lighter where its
 * lines crowd together on screen and from high up, and its ink leans toward the hue of the
 * ground under it.
 *
 * The highlight. A rounded rectangle from a signed distance: a translucent pane of pale blue
 * that is denser toward the rim, a near-white border never under two pixels wide, a line of
 * clear blue hugging the border's inside like the edge of a sheet of glass, faint tile divisions
 * inside a rectangle of more than one tile, and just outside the rim a soft dark edge and a halo
 * of the pane's light. The border, the rim's glow and the halo breathe slowly, once in about
 * 2.7 seconds.
 *
 * Ink is put into the albedo, so it takes the scene's light and shadow and sits in the picture,
 * plus an unlit part that is a trace by day and most of what shows at night. Under every grid
 * line goes a wider, soft darkening that grows with how light the ground is: on grass the pale
 * line does the work, on sand and paving the dark keyline does.
 */
const OVERLAY_GLSL = /* glsl */ `
uniform float cwOvl_grid;
uniform vec2 cwOvl_center;
uniform vec2 cwOvl_core;
uniform vec4 cwOvl_rect;
uniform float cwOvl_hl;
uniform sampler2D cwOvl_water;

const vec3 cwOvl_GRID_INK = vec3(0.72, 0.77, 0.80);
const vec3 cwOvl_EDGE_INK = vec3(0.78, 0.80, 0.80);
const vec3 cwOvl_FILL_INK = vec3(0.42, 0.72, 1.0);
const vec3 cwOvl_GLASS_INK = vec3(0.2, 0.54, 0.95);
// What a pane of the fill's blue lets through of the light of the ground under it.
const vec3 cwOvl_PANE_TINT = vec3(0.62, 0.84, 1.0);
// Tiles from the middle of the grid to where its last corner marks are gone.
const float cwOvl_REACH = 12.5;
// How much the unlit share of the ink rises in twilight, at its most.
const float cwOvl_TWILIGHT = 1.6;

// Tiles to the nearest tile border, per axis.
vec2 cwOvl_toBorder(vec2 p) {
  return abs(fract(p - 0.5) - 0.5);
}

// How much of the pixel is covered by the lines on the borders of each axis. d: tiles to the
// nearest border; fp: the size of a pixel in tiles on that axis; halfWidth: the wanted half
// width in tiles.
vec2 cwOvl_lines(vec2 d, vec2 fp, vec2 halfWidth) {
  // Never drawn thinner than a pixel: fainter instead, by as much as it would have been thinner.
  vec2 drawn = max(halfWidth, 0.5 * fp);
  vec2 soft = 1.0 * fp;
  vec2 line = 1.0 - smoothstep(drawn - soft, drawn + soft, d);
  line *= clamp(halfWidth / drawn, 0.0, 1.0);
  // Tiles a few pixels across: the lines give way to their average cover.
  return mix(line, 2.0 * halfWidth, clamp((fp - 0.18) / 0.3, 0.0, 1.0));
}

float cwOvl_luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void cwOverlay(inout CwSurf s, vec3 worldPos) {
  // Nothing to draw, which is nearly always: the ground pays one comparison.
  if (cwOvl_grid <= 0.0 && cwOvl_hl <= 0.0) return;

  // Ground under water is the bed of a pond, seen through the water. The aids are not drawn on
  // the bed but where the eye's ray to it passes the water's surface, so through the water they
  // show lying level on it, tile for tile, and meet the ones on the bank at the shore.
  ivec2 tile = clamp(ivec2(floor(worldPos.xz)), ivec2(0), textureSize(cwOvl_water, 0) - 1);
  float depth = max(texelFetch(cwOvl_water, tile, 0).r - worldPos.y, 0.0);
  vec3 toEye = cameraPosition - worldPos;
  vec2 p = worldPos.xz + toEye.xz * (depth / max(toEye.y, depth + 1e-3));
  // All the screen-space derivatives the chunk needs, taken before any branch on position.
  vec2 dpx = dFdx(p);
  vec2 dpy = dFdy(p);
  // The build aids belong to the park: the land around it shows none.
  vec2 beyond = max(-p, p - uMapSize);
  if (max(beyond.x, beyond.y) > 0.5) return;

  // The size of a pixel in tiles along x and along z.
  vec2 fp = clamp(vec2(length(vec2(dpx.x, dpy.x)), length(vec2(dpx.y, dpy.y))), 1e-5, 4.0);
  vec2 toBorder = cwOvl_toBorder(p);
  vec2 halfWidth = clamp(0.85 * fp, vec2(0.006), vec2(0.03));
  float lightGround = smoothstep(0.2, 0.4, cwOvl_luma(s.albedo));
  // The water takes a good part of whatever is drawn under it, more of it the deeper the bed:
  // ink there is laid on more heavily to come out about as strong as on the bank.
  float wet = smoothstep(0.0, 0.05, depth);
  float lift = 1.0 + wet * (0.5 + 2.0 * min(depth, 1.0));
  // The unlit share of the ink. By day the sun does the work and this is a trace that keeps a
  // line readable in shade; at night it is most of what shows. In between, with the sun on the
  // horizon, the ground is lit about as dimly as at night but warmly, the grid's pale ink on
  // it goes grey, and its unlit share has to carry more than at either end.
  float unlit = mix(1.0, 0.4, uDaylight);
  float twilight = 6.75 * uDaylight * (1.0 - uDaylight) * (1.0 - uDaylight);

  // Tiles from the grid's core: the pointer, or the rectangle being placed. The grid is at
  // full strength all over a large rectangle and fades from its sides, not from its middle.
  float fromCenter = length(max(abs(p - cwOvl_center) - cwOvl_core, 0.0));
  if (cwOvl_grid > 0.0 && fromCenter < cwOvl_REACH) {
    vec2 line = cwOvl_lines(toBorder, fp, halfWidth);
    // A plus mark on every corner: each line is stronger for a sixth of a tile either side of
    // a crossing. Once that rhythm is finer than the pixels it gives way to its average.
    vec2 along = toBorder.yx;
    vec2 alongFp = fp.yx;
    vec2 mark = 1.0 - smoothstep(vec2(0.1) - alongFp, vec2(0.18) + alongFp, along);
    mark = mix(mark, vec2(0.28), clamp((alongFp - 0.1) / 0.2, 0.0, 1.0));
    // The lines are strongest by the pointer and gone well before the marks, so the grid thins
    // into a field of corner marks and then into nothing. Where the lines are strong the marks
    // are only an accent on them; they come into their own as the lines go.
    float nearLines = 1.0 - smoothstep(0.0, 0.85 * cwOvl_REACH, fromCenter);
    float nearMarks = 1.0 - smoothstep(0.15 * cwOvl_REACH, cwOvl_REACH, fromCenter);
    float markInk = mix(0.4, 0.15, nearLines) * nearMarks;
    // Lines that crowd together on screen are drawn lighter, so a zoomed-out or foreshortened
    // grid stays a tint and does not become a mesh.
    vec2 crowd = 1.0 - 0.5 * smoothstep(0.012, 0.08, fp);
    vec2 cover = line * crowd * (0.28 * nearLines + markInk * mark);
    float ink = min(max(cover.x, cover.y) * lift, 1.0);
    // The ink leans a little toward the hue of the ground it lies on: mint on grass, cream on
    // sand. It then reads as a mark on that ground and not as a sheet laid over the picture.
    vec3 hue = s.albedo / max(max(s.albedo.r, max(s.albedo.g, s.albedo.b)), 1e-3);
    vec3 gridInk = cwOvl_GRID_INK * mix(vec3(1.0), hue, 0.22);

    vec2 keyLine = cwOvl_lines(toBorder, fp, 2.4 * halfWidth + 0.004);
    float key = max(keyLine.x, keyLine.y) * nearLines;

    // Thinner from high up.
    float far = 1.0 - 0.85 * smoothstep(70.0, 190.0, uCamDistance);
    // The park's own borders are the last lines: none beyond, and no line ends poking out.
    vec2 edge = min(p, uMapSize - p) + halfWidth + fp;
    float park = clamp(edge.x / fp.x, 0.0, 1.0) * clamp(edge.y / fp.y, 0.0, 1.0);
    float strength = cwOvl_grid * far * park;

    s.albedo *= 1.0 - 0.3 * key * lightGround * strength;
    s.albedo = mix(s.albedo, gridInk, ink * strength);
    s.emissive += gridInk * (ink * strength * 0.05 * (unlit + cwOvl_TWILIGHT * twilight) * lift);
  }

  if (cwOvl_hl > 0.0) {
    vec2 c = cwOvl_rect.xy;
    vec2 b = cwOvl_rect.zw;
    // Corners round a little more on a larger rectangle.
    float least = min(b.x, b.y);
    float radius = min(min(0.5 * least, 0.16 + 0.04 * least), 0.3);
    vec2 q = abs(p - c) - b + radius;
    // Negative inside the rounded rectangle, in tiles from its rim.
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    if (sd < 0.6) {
      // The size of a pixel in tiles across the rim: the pixel's footprint along the direction
      // in which the distance grows.
      vec2 grow = q.x > 0.0 && q.y > 0.0 ? normalize(q) : (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
      grow *= sign(p - c);
      float aa = clamp(length(vec2(dot(grow, dpx), dot(grow, dpy))), 1e-5, 0.5);
      float pulse = 0.5 + 0.5 * sin(uTime * 2.3);

      float inside = 1.0 - smoothstep(-aa, aa, sd);
      // The border: a band just inside the rim, never under two pixels wide.
      float halfBorder = max(clamp(1.25 * aa, 0.014, 0.05), aa);
      float border = 1.0 - smoothstep(halfBorder - 0.75 * aa, halfBorder + 0.75 * aa, abs(sd + halfBorder));

      // The fill is denser toward the rim. A sum of four smooth falloffs, one per side, not a
      // function of the distance: that would crease along the diagonals of a large rectangle.
      vec2 lo = p - (c - b);
      vec2 hi = (c + b) - p;
      float rim = exp(-lo.x / 0.2) + exp(-hi.x / 0.2) + exp(-lo.y / 0.2) + exp(-hi.y / 0.2);
      rim = 1.0 - exp(-rim);
      float fill = inside * (0.09 + 0.24 * rim * mix(0.7, 1.0, pulse));

      // A line of clear color hugging the inside of the border, like the edge of a pane of
      // glass: it is laid on as paint, so it keeps its hue on sand and paving, where the fill's
      // brightening alone turns to plain white.
      float inward = max(-(sd + 2.0 * halfBorder), 0.0);
      float glass = inside * exp(-inward / max(0.035, 1.5 * aa));

      // Tile divisions inside a rectangle of more than one tile, thinning out just short of
      // the border.
      vec2 division = cwOvl_lines(toBorder, fp, halfWidth);
      float divisions = max(division.x, division.y) * inside * (1.0 - smoothstep(-0.14, -0.05, sd));

      // Just outside the rim: a soft dark edge, deeper on light ground, and a halo of the fill's
      // light that breathes with the pulse, fainter on light ground. Between them the border
      // stands off whatever it lies on.
      float outside = 1.0 - inside;
      float shade = outside * exp(-max(sd, 0.0) / 0.07);
      float halo = outside * exp(-max(sd, 0.0) / mix(0.05, 0.1, pulse)) * mix(0.09, 0.16, pulse);

      float k = cwOvl_hl;
      s.albedo *= 1.0 - k * shade * mix(0.22, 0.6, lightGround);
      // Light ground has little room left to brighten, and a pane that only brightens turns to
      // frost on it. There the pane works as blue glass does and holds back the warm part of
      // the ground's own light.
      s.albedo *= mix(vec3(1.0), cwOvl_PANE_TINT, min(k * fill * 2.4 * lightGround, 1.0));
      fill += halo * mix(1.0, 0.4, lightGround);
      fill *= lift;
      // The fill lightens the ground toward its tint and leaves the ground's own detail showing.
      s.albedo += (1.0 - s.albedo) * cwOvl_FILL_INK * (k * fill);
      s.albedo = mix(s.albedo, cwOvl_GLASS_INK, k * glass * mix(0.32, 0.44, pulse));
      s.albedo = mix(s.albedo, cwOvl_EDGE_INK, min(k * divisions * 0.3 * lift, 1.0));
      float edgeInk = k * border * mix(0.84, 1.0, pulse);
      s.albedo = mix(s.albedo, cwOvl_EDGE_INK, edgeInk);
      s.emissive += (cwOvl_FILL_INK * (k * fill * 0.12) + cwOvl_EDGE_INK * (edgeInk * mix(0.16, 0.24, pulse) * lift)) * unlit;
    }
  }
}
`;

/** The shader's own names for the uniforms below, checked against the GLSL by the tests. */
interface OverlayUniforms extends Record<string, IUniform> {
  /** How strongly the grid shows, 0..1: the eased fade. */
  cwOvl_grid: IUniform<number>;
  /** World x and z the grid gathers around. */
  cwOvl_center: IUniform<Vector2>;
  /**
   * Half the size, in tiles along x and z, of the part around the center where the grid is at
   * full strength: half the highlighted rectangle, or nothing.
   */
  cwOvl_core: IUniform<Vector2>;
  /** The highlight: its middle in x and y (world x and z), half its size in z and w, in tiles. */
  cwOvl_rect: IUniform<Vector4>;
  /** How strongly the highlight shows, 0..1: the eased fade. */
  cwOvl_hl: IUniform<number>;
  /** One texel per tile: the world height of the water surface over it (`buildWaterHeights`). */
  cwOvl_water: IUniform<DataTexture>;
}

/** A texture of one float per tile, read texel by texel. */
function waterTexture(heights: Float32Array, width: number, height: number): DataTexture {
  const texture = new DataTexture(heights, width, height, RedFormat, FloatType);
  texture.needsUpdate = true;
  return texture;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Creates the overlay module: the `cwOverlay` chunk and the uniforms that drive it. The setters
 * only note what is wanted; `update` moves the uniforms there on the frame's real-time clock
 * (`FrameInfo.nowMs`), so fades and glides run at the same pace at any frame rate and also while
 * the animation clock is frozen. The slow pulse reads `uTime` in the shader.
 */
export function createOverlay(ctx: RenderContext): OverlayModule {
  const uniforms: OverlayUniforms = {
    cwOvl_grid: { value: 0 },
    cwOvl_center: { value: new Vector2(0, 0) },
    cwOvl_core: { value: new Vector2(0, 0) },
    cwOvl_rect: { value: new Vector4(0, 0, 0, 0) },
    cwOvl_hl: { value: 0 },
    // Until there is a terrain: one tile, dry.
    cwOvl_water: { value: waterTexture(new Float32Array([NO_WATER]), 1, 1) },
  };

  /** The water the texture was last built from, and the size of that map. */
  let lastWater: Uint8Array | null = null;
  let mapWidth = 0;
  let mapHeight = 0;
  let waterHeights: Float32Array | null = null;

  let gridOn = false;
  /** Linear progress of the two fades, 0..1; the uniforms carry the eased values. */
  let gridFade = 0;
  let highlightFade = 0;
  let highlightOn = false;
  /** The rectangle wanted: middle x, middle z, half width, half depth. */
  let wantX = 0;
  let wantZ = 0;
  let wantHalfW = 0;
  let wantHalfH = 0;
  let hasCursor = false;
  let cursorX = 0;
  let cursorZ = 0;
  /** The `nowMs` of the last frame, or null before the first. */
  let lastMs: number | null = null;

  return {
    glsl: OVERLAY_GLSL,
    uniforms,
    setGridVisible(on: boolean): void {
      gridOn = on;
    },
    setHighlight(rect): void {
      highlightOn = rect !== null && rect.w > 0 && rect.h > 0;
      if (!rect || !highlightOn) return;
      wantHalfW = rect.w / 2;
      wantHalfH = rect.h / 2;
      wantX = rect.x + wantHalfW;
      wantZ = rect.y + wantHalfH;
    },
    setCursor(point): void {
      hasCursor = point !== null;
      if (!point) return;
      cursorX = point.x;
      cursorZ = point.z;
    },
    setTerrain(t: TerrainData): void {
      // Only the water matters here, and most terrain changes leave it alone.
      const sameSize = lastWater !== null && mapWidth === t.width && mapHeight === t.height;
      if (sameSize && sameBytes(lastWater as Uint8Array, t.water)) return;
      if (sameSize && waterHeights) {
        (lastWater as Uint8Array).set(t.water);
        buildWaterHeights(t, waterHeights);
        uniforms.cwOvl_water.value.needsUpdate = true;
        return;
      }
      lastWater = t.water.slice();
      mapWidth = t.width;
      mapHeight = t.height;
      waterHeights = buildWaterHeights(t);
      uniforms.cwOvl_water.value.dispose();
      uniforms.cwOvl_water.value = waterTexture(waterHeights, t.width, t.height);
    },
    update(frame: FrameInfo): void {
      const dt = lastMs === null ? 0 : Math.max(0, (frame.nowMs - lastMs) / 1000);
      lastMs = frame.nowMs;
      const fadeStep = dt / OVERLAY_FADE_SECONDS;

      // The middle of the grid: the pointer, or what the camera looks at. While the grid is out
      // of sight it simply sits there, so it fades in where it belongs; in sight it follows.
      const target = ctx.uniforms.uCamTarget.value;
      const centerX = hasCursor ? cursorX : target.x;
      const centerZ = hasCursor ? cursorZ : target.z;
      const center = uniforms.cwOvl_center.value;
      const follow = gridFade <= 0 ? 1 : glideShare(dt, GRID_FOLLOW_SECONDS);
      center.x += (centerX - center.x) * follow;
      center.y += (centerZ - center.y) * follow;
      // Its core is the rectangle being placed, so the lines reach as far past a large
      // rectangle as past a single tile.
      const core = uniforms.cwOvl_core.value;
      core.x += ((highlightOn ? wantHalfW : 0) - core.x) * follow;
      core.y += ((highlightOn ? wantHalfH : 0) - core.y) * follow;

      gridFade = approach(gridFade, gridOn ? 1 : 0, fadeStep);
      uniforms.cwOvl_grid.value = easeInOut(gridFade);

      // The highlight appears where it is wanted and glides from there on. When it is switched
      // off it stays where it was while it fades.
      const rect = uniforms.cwOvl_rect.value;
      if (highlightOn) {
        const glide = highlightFade <= 0 ? 1 : glideShare(dt, HIGHLIGHT_GLIDE_SECONDS);
        rect.x += (wantX - rect.x) * glide;
        rect.y += (wantZ - rect.y) * glide;
        rect.z += (wantHalfW - rect.z) * glide;
        rect.w += (wantHalfH - rect.w) * glide;
      }
      highlightFade = approach(highlightFade, highlightOn ? 1 : 0, fadeStep);
      uniforms.cwOvl_hl.value = easeInOut(highlightFade);
    },
    dispose(): void {
      uniforms.cwOvl_water.value.dispose();
    },
  };
}
