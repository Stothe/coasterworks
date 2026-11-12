import {
  Box2,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RGFormat,
  UnsignedByteType,
  Vector2,
  Vector4,
  type IUniform,
} from "three";
import type { EntrancePlace, Quality, RenderContext, SceneModule } from "../context.js";
import type { TerrainData } from "./geometry.js";
import type { TerrainChunk } from "./material.js";
import {
  PATH_LANE,
  PATH_MARGIN,
  PATH_TEXELS,
  bakePathField,
  createPathField,
  type PathField,
  type TexelRect,
} from "./path-field.js";

/** The paths: the `cwPaths` chunk of the terrain shader and the path data it reads. */
export type PathsModule = TerrainChunk &
  SceneModule & {
    /** The sim's path layer, one byte per tile (0 none, 1 footpath, 2 queue), or null for none. */
    setPaths(paths: Uint8Array | null): void;
    /** Where the park entrance is, so its lane outside the map is drawn; null for none. */
    setEntrance(entrance: EntrancePlace | null): void;
  };

/** Width of the curb, in tiles, measured in from the path's edge. */
const CURB = 0.09;
/** Width of one paver, in tiles; a paver is twice as long. */
const PAVER = 0.125;
/** How far in from a paver's edge its joint reaches, in paver widths. */
const JOINT = 0.06;
/** Length of one curb stone, in tiles. Not a whole fraction of a tile, so it never keeps step with the grid. */
const CURB_STONE = 0.31;
/** Width of one of the queue's square setts, in tiles. Not a whole fraction of a tile either. */
const SETT = 0.107;

/** Sine and cosine of the 45 degrees the paving is turned by. */
const TURN = Math.SQRT1_2;

/** A number as a GLSL float literal. */
const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/**
 * The paths' shader. One function, `cwPaths`, that lays paving over whatever the ground chunk
 * drew, wherever the baked distance field (`path-field.ts`) says there is path.
 *
 * Everything about the shape comes from the field: the edge is where the distance crosses zero,
 * smoothed over a pixel; the curb is the band just inside it, lit as if its two long edges were
 * chamfered, by leaning the normal along the field's slope; the ground just outside is darkened
 * where it meets the stone. The paving itself is laid in world space, turned 45 degrees to the
 * tile grid and of a size that never keeps step with it, so nothing in here shows where a tile
 * begins or ends.
 *
 * Fine detail is faded by how much ground a pixel covers: joints and the tint of single stones
 * go to their average, chamfers go flat, and from far away a path is an even warm band with a
 * pale edge. Nothing is left to shimmer.
 */
const PATHS_GLSL = /* glsl */ `
uniform sampler2D cwPath_field;
// xy: world position of the field's north-west corner. zw: one over its size in tiles.
uniform vec4 cwPath_rect;
// 0 low, 1 medium, 2 high.
uniform float cwPath_quality;

const float cwPath_curb = ${f(CURB)};
const float cwPath_joint = ${f(JOINT)};
// World (x, z) to paver cells: a 45 degree turn and one cell per paver width.
const mat2 cwPath_lay = mat2(${f(TURN / PAVER)}, ${f(TURN / PAVER)}, ${f(-TURN / PAVER)}, ${f(TURN / PAVER)});
// The same turn back, for a direction.
const mat2 cwPath_unlay = mat2(${f(TURN)}, ${f(-TURN)}, ${f(TURN)}, ${f(TURN)});

const vec3 cwPath_stoneSand = vec3(0.42, 0.295, 0.17);
const vec3 cwPath_stoneRose = vec3(0.37, 0.215, 0.13);
const vec3 cwPath_stoneBuff = vec3(0.48, 0.38, 0.245);
const vec3 cwPath_jointColor = vec3(0.15, 0.115, 0.085);
const vec3 cwPath_curbColor = vec3(0.47, 0.425, 0.35);
const vec3 cwPath_moss = vec3(0.1, 0.15, 0.045);
const vec3 cwPath_earth = vec3(0.27, 0.2, 0.125);
const vec3 cwPath_queueTeal = vec3(0.115, 0.2, 0.225);
const vec3 cwPath_queueBlue = vec3(0.12, 0.165, 0.245);
const vec3 cwPath_queueJoint = vec3(0.045, 0.07, 0.09);
const vec3 cwPath_queueLine = vec3(0.6, 0.55, 0.42);

// The distance to the path's edge in tiles (negative inside) and the kind (0 footpath, 1 queue).
vec2 cwPath_read(vec2 uv) {
  vec2 t = textureLod(cwPath_field, uv, 0.0).rg;
  return vec2(t.r - 0.5, t.g);
}

// Herringbone paving in cell coordinates: every paver is two cells long and one wide, and they
// alternate lying along x and along y in the classic zigzag. Returns how far the point is inside
// its paver's (slightly rounded) outline, in cells; id names the paver and toEdge points from the
// point to the nearest part of the outline.
float cwPath_herringbone(vec2 q, out vec2 id, out vec2 toEdge) {
  vec2 cell = floor(q);
  vec2 inCell = q - cell;
  float s = mod(cell.x + cell.y, 4.0);
  bool upright = s > 1.5;
  bool second = mod(s, 2.0) > 0.5;
  vec2 along = upright ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  id = cell - (second ? along : vec2(0.0));
  // The point relative to the paver's middle, with x along the paver.
  vec2 a = upright ? inCell.yx : inCell;
  vec2 c = vec2(a.x + (second ? 0.0 : -1.0), a.y - 0.5);
  const float corner = 0.14;
  vec2 o = abs(c) - (vec2(1.0, 0.5) - corner);
  float outside = length(max(o, 0.0)) + min(max(o.x, o.y), 0.0) - corner;
  vec2 dir = o.x > o.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  if (o.x > 0.0 && o.y > 0.0) dir = normalize(o);
  dir *= sign(c);
  toEdge = upright ? dir.yx : dir;
  return -outside;
}

// Square setts, for the queues. Returns how far the point is inside its sett, in cells (0 at its
// edge, 0.5 in the middle).
float cwPath_setts(vec2 q, out vec2 id, out vec2 toEdge) {
  id = floor(q);
  vec2 c = q - id - 0.5;
  toEdge = abs(c.x) > abs(c.y) ? vec2(sign(c.x), 0.0) : vec2(0.0, sign(c.y));
  return 0.5 - max(abs(c.x), abs(c.y));
}

void cwPaths(inout CwSurf s, vec3 worldPos) {
  vec2 p = worldPos.xz;
  // How much ground one pixel covers, in tiles. Taken before anything branches.
  float px = max(length(dFdx(p)), length(dFdy(p)));
  vec2 uv = (p - cwPath_rect.xy) * cwPath_rect.zw;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return;
  vec2 field = cwPath_read(uv);
  float d = field.x;
  if (d > 0.3) return;

  // The slope of the field: a unit vector across the edge, pointing out of the path.
  vec2 e = cwPath_rect.zw * ${f(1 / PATH_TEXELS)};
  vec2 slope = vec2(
    cwPath_read(uv + vec2(e.x, 0.0)).x - cwPath_read(uv - vec2(e.x, 0.0)).x,
    cwPath_read(uv + vec2(0.0, e.y)).x - cwPath_read(uv - vec2(0.0, e.y)).x
  );
  float steep = length(slope);
  vec2 outward = steep > 1e-4 ? slope / steep : vec2(0.0);

  // Fine things fade as pixels grow: 1 close up, 0 from far away.
  float nearby = 1.0 - smoothstep(0.012, 0.06, px);
  float closeUp = 1.0 - smoothstep(0.004, 0.022, px);
  // Broad, soft variation so no stretch of path is one even color.
  float broad = cwFbm(p * 0.31 + 7.0, cwPath_quality > 0.5 ? 3 : 2);

  // The lane runs out of the park and gives up: toward its end it narrows, its edge frays, its
  // curb stops and its stones go missing one by one, leaving a worn track that fades into the
  // meadow. 0 in the park and on the first stretch of lane, 1 at the lane's end.
  float beyond = max(max(-p.x, p.x - uMapSize.x), max(-p.y, p.y - uMapSize.y));
  float wild = clamp((beyond - ${f(PATH_LANE - 3.3)}) * ${f(1 / 2.9)}, 0.0, 1.0);
  float fray = 0.0;
  if (wild > 0.0) {
    float ragged = cwFbm(p * 2.1 + 3.0, 3) - 0.5;
    d += wild * wild * 0.27 + ragged * 0.6 * wild;
    fray = smoothstep(0.5, 1.0, wild + ragged * 0.7);
  }
  float tame = 1.0 - wild;

  float aa = max(px * 0.75, 0.002) + wild * 0.07;
  float cover = (1.0 - smoothstep(-aa, aa, d)) * (1.0 - fray);

  // Which way the low sun throws the curb's shadow, and how far.
  float sunFlat = length(uSunDir.xz);
  float toSun = dot(outward, uSunDir.xz / max(sunFlat, 1e-4));
  float reach = min(0.03 * sunFlat / max(uSunDir.y, 0.15), 0.14);

  // The ground beside the path sits in the curb's shade: a tight dark line and a soft wide one,
  // and the curb's own shadow on the side away from the sun.
  float contact = (1.0 - smoothstep(0.0, 0.045, d)) * 0.34 * nearby;
  contact += (1.0 - smoothstep(0.0, 0.18, d)) * mix(0.16, 0.3, nearby);
  contact += clamp(-toSun, 0.0, 1.0) * (1.0 - smoothstep(0.0, reach, d)) * 0.3 * nearby;
  s.albedo *= 1.0 - min(contact, 0.75) * tame * step(0.0, d + aa);
  if (cover <= 0.0) return;

  float depth = -d;
  // The kind channel only reaches half a texel either side of the line, so the blend stays inside that.
  float kindAa = min(px * 0.75 + 0.004, 0.05);
  // Signed distance to the line where queue meets footpath, in tiles, good to about 0.06.
  float fromKinds = (field.y - 0.5) * ${f(1 / PATH_TEXELS)};
  float queue = smoothstep(-kindAa, kindAa, fromKinds);
  // Stone is not one flat color: fine grain close up, in about -1..1.
  float grain = 0.0;
  if (cwPath_quality > 0.5 && closeUp > 0.0) {
    float finest = 1.0 - smoothstep(0.002, 0.008, px);
    grain = (cwGradNoise(p * 31.0) - 0.5) * 1.7;
    grain += (cwGradNoise(p * 97.0 + 5.0) - 0.5) * 1.9 * finest;
    grain *= closeUp;
  }

  vec3 surface = vec3(0.0);
  float rough = 0.8;
  vec2 lean = vec2(0.0);

  if (queue < 0.999) {
    // Footpath: herringbone pavers in three warm stones.
    float cells = px * ${f(1 / PAVER)};
    float detail = 1.0 - smoothstep(0.16, 0.5, cells);
    vec2 id;
    vec2 toEdge;
    float inside = cwPath_herringbone(cwPath_lay * p, id, toEdge);
    vec2 tone = cwHash22(id);
    vec2 pick = cwHash22(id + 19.0);
    vec3 stone = mix(cwPath_stoneSand, cwPath_stoneRose, smoothstep(0.3, 0.9, tone.x));
    stone = mix(stone, cwPath_stoneBuff, step(0.82, pick.x));
    stone *= 0.9 + 0.2 * tone.y;
    vec3 stoneMean = mix(mix(cwPath_stoneSand, cwPath_stoneRose, 0.35), cwPath_stoneBuff, 0.18);
    stone = mix(stoneMean, stone, detail);
    // Worn pale in the middle, darker toward its edges, with a little grain.
    float middle = smoothstep(cwPath_joint, cwPath_joint + 0.32, inside);
    stone *= mix(1.0, mix(0.86, 1.05, middle), detail);
    // Each stone is its own piece of rock: clouded differently from the one beside it.
    float mottle = (cwGradNoise(p * 7.3 + tone * 23.0) - 0.5) * 2.0 * detail;
    stone *= 1.0 + grain * 0.13 + mottle * 0.12;
    float jointAa = cells * 0.7 + 0.01;
    float joint = 1.0 - smoothstep(cwPath_joint - jointAa, cwPath_joint + jointAa, inside);
    joint = mix(${f(3 * JOINT)}, joint, detail);
    // Moss takes to the joints along the foot of the curb, in patches.
    float mossy = (1.0 - smoothstep(0.0, 0.14, depth - cwPath_curb)) * smoothstep(0.45, 0.7, cwValueNoise(p * 2.7 + 50.0));
    vec3 jointColor = mix(cwPath_jointColor, cwPath_moss, mossy * detail);
    vec3 paving = mix(stone, jointColor, joint * 0.9);
    float pavingRough = mix(0.78 + 0.12 * tone.y * detail, 0.95, joint);
    // Each stone is a little pillowed: its face leans away toward the joint around it.
    float pillow = (1.0 - smoothstep(cwPath_joint * 0.5, cwPath_joint + 0.16, inside)) * detail;
    vec2 pavingLean = (cwPath_unlay * toEdge) * pillow * 0.9;
    if (wild > 0.0) {
      // Out on the lane's last stretch: bare trodden earth where a stone has gone.
      float kept = step(wild * 1.25, pick.y + 0.04);
      vec3 earth = cwPath_earth * (0.8 + 0.4 * cwValueNoise(p * 5.0)) * (1.0 + grain * 0.2);
      paving = mix(earth, paving, kept);
      pavingRough = mix(0.95, pavingRough, kept);
      pavingLean *= kept;
    }
    surface = paving;
    rough = pavingRough;
    lean = pavingLean;
  }
  if (queue > 0.001) {
    // Queue: small square setts of blue slate laid on the diagonal, with a pale guide line along
    // each side.
    float cells = px * ${f(1 / SETT)};
    float detail = 1.0 - smoothstep(0.16, 0.5, cells);
    vec2 id;
    vec2 toEdge;
    vec2 q = cwPath_lay * p * ${f(PAVER / SETT)} + vec2(0.37, 0.21);
    float inside = cwPath_setts(q, id, toEdge);
    toEdge = cwPath_unlay * toEdge;
    vec2 tone = cwHash22(id + 71.0);
    vec3 sett = mix(cwPath_queueTeal, cwPath_queueBlue, tone.x) * (0.84 + 0.32 * tone.y);
    sett = mix(mix(cwPath_queueTeal, cwPath_queueBlue, 0.5), sett, detail);
    float middle = smoothstep(cwPath_joint, cwPath_joint + 0.25, inside);
    sett *= mix(1.0, mix(0.84, 1.06, middle), detail);
    float mottle = (cwGradNoise(p * 7.3 + tone * 23.0) - 0.5) * 2.0 * detail;
    sett *= 1.0 + grain * 0.13 + mottle * 0.12;
    float jointAa = cells * 0.7 + 0.01;
    float joint = 1.0 - smoothstep(cwPath_joint - jointAa, cwPath_joint + jointAa, inside);
    joint = mix(${f(4 * JOINT)}, joint, detail);
    vec3 coat = mix(sett, cwPath_queueJoint, joint * 0.9);
    float pillow = (1.0 - smoothstep(cwPath_joint * 0.5, cwPath_joint + 0.16, inside)) * detail;
    float lineAt = cwPath_curb + 0.06;
    float line = 1.0 - smoothstep(0.016 - aa, 0.016 + aa, abs(depth - lineAt));
    coat = mix(coat, cwPath_queueLine * (1.0 + 0.1 * grain), line * 0.92);
    surface = mix(surface, coat, queue);
    rough = mix(rough, mix(0.66, 0.9, joint), queue);
    lean = mix(lean, toEdge * pillow * 0.6 * (1.0 - line), queue);
  }
  // Stretches of paving weathered a little differently, a few stones across.
  float patchy = (cwValueNoise(p * 1.9 + 13.0) - 0.5) * (1.0 - smoothstep(0.1, 0.25, px));
  surface *= 0.9 + 0.2 * broad + 0.12 * patchy;

  // Where queue meets footpath: a sill of curb stone across the path.
  float sill = 1.0 - smoothstep(0.036 - kindAa, 0.036 + kindAa, abs(fromKinds));
  sill *= step(abs(field.y - 0.5), 0.49);

  // The curb's foot: a thin line of shade, dust gathered along it, and the curb's shadow on the
  // side the sun is on.
  float foot = depth - cwPath_curb;
  float shade = 0.3 * (1.0 - smoothstep(0.0, 0.03, foot)) * nearby;
  shade += 0.16 * (1.0 - smoothstep(0.0, 0.12, foot));
  shade += clamp(toSun, 0.0, 1.0) * (1.0 - smoothstep(0.0, reach, foot)) * 0.3 * nearby;
  surface *= 1.0 - min(shade, 0.7) * tame;

  // The curb: a band of pale stone, cut into lengths, with both long edges chamfered. The sill
  // is the same stone.
  float curbFade = 1.0 - smoothstep(0.0, 0.4, wild);
  // From far away the curb is thinner than a pixel: its edge is never smoothed over more than its
  // own width, so the path keeps the share of pale stone it has close up.
  float curbAa = min(aa, cwPath_curb);
  float onCurb = smoothstep(-cwPath_curb - curbAa, -cwPath_curb + curbAa, d) * curbFade;
  bool alongZ = abs(outward.x) > abs(outward.y);
  float stoneAt = (alongZ ? p.y : p.x) * ${f(1 / CURB_STONE)};
  float cutAa = px * ${f(1 / CURB_STONE)} + 0.004;
  float seam = 1.0 - smoothstep(0.02 - cutAa, 0.02 + cutAa, abs(fract(stoneAt) - 0.5));
  float curbTone = cwHash12(vec2(floor(stoneAt + 0.5), alongZ ? 3.0 : 11.0));
  float curbCloud = cwGradNoise(p * 5.1 + 40.0) - 0.5;
  vec3 curb = cwPath_curbColor * (0.9 + 0.2 * curbTone * nearby);
  curb *= (0.93 + 0.14 * broad) * (1.0 + grain * 0.11 + curbCloud * 0.24 * nearby);
  // The sill is one stone: no cuts across it.
  curb *= 1.0 - 0.38 * seam * nearby * onCurb;
  float stoneBand = max(onCurb, sill);
  surface = mix(surface, curb, stoneBand);
  rough = mix(rough, 0.7, stoneBand);
  lean *= 1.0 - stoneBand;
  // Across the curb, 0 at the grass and 1 at the paving: the outer chamfer leans out, the top is
  // level, the inner chamfer leans in.
  float across = depth * ${f(1 / CURB)};
  float outer = 1.0 - smoothstep(0.2, 0.5, across);
  float inner = smoothstep(0.66, 0.86, across) * (1.0 - smoothstep(1.0, 1.15, across));
  lean += outward * (outer * 1.1 - inner * 0.8) * nearby * curbFade;

  s.albedo = mix(s.albedo, surface, cover);
  s.roughness = mix(s.roughness, rough, cover);
  vec3 ground = normalize(cwWorldNormal);
  s.normal = normalize(mix(s.normal, ground + vec3(lean.x, 0.0, lean.y), cover));
}
`;

/** Above this share of the field's texels, a change is sent to the GPU whole, not as a rectangle. */
const WHOLE_UPLOAD_SHARE = 0.25;

function fieldTexture(field: PathField): DataTexture {
  const texture = new DataTexture(
    field.data,
    field.width,
    field.height,
    RGFormat,
    UnsignedByteType,
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  // Two bytes a texel: rows need not end on a four byte boundary.
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

const QUALITY_LEVEL: Record<Quality, number> = { low: 0, medium: 1, high: 2 };

/**
 * Creates the paths module: the `cwPaths` chunk and the distance field behind it.
 *
 * The field is rebaked whenever the paths or the entrance change (only around what changed), and
 * what was rewritten is sent to the GPU once, on the next frame: as one rectangle when it is
 * small, which is the case while a path is being dragged out, or whole when most of it is new.
 */
export function createPaths(ctx: RenderContext): PathsModule {
  let field = createPathField(1, 1);
  let texture = fieldTexture(field);
  // The same bytes under a second name: the renderer copies a rectangle of them into `texture`.
  let source = new DataTexture(field.data, field.width, field.height, RGFormat, UnsignedByteType);
  const uniforms = {
    cwPath_field: { value: texture } as IUniform<DataTexture>,
    cwPath_rect: {
      value: new Vector4(-PATH_MARGIN, -PATH_MARGIN, 1 / field.tilesX, 1 / field.tilesY),
    } as IUniform<Vector4>,
    cwPath_quality: { value: QUALITY_LEVEL[ctx.quality] } as IUniform<number>,
  };
  let paths: Uint8Array | null = null;
  let entrance: EntrancePlace | null = null;
  /** Texels rewritten since the last upload, or null. */
  let dirty: TexelRect | null = null;
  /** The texture is new: it has yet to be sent at all. */
  let whole = true;
  const region = new Box2();
  const origin = new Vector2();

  function rebake(): void {
    const changed = bakePathField(field, paths, entrance);
    if (!changed) return;
    if (!dirty) {
      dirty = changed;
      return;
    }
    const x0 = Math.min(dirty.x, changed.x);
    const y0 = Math.min(dirty.y, changed.y);
    const x1 = Math.max(dirty.x + dirty.width, changed.x + changed.width);
    const y1 = Math.max(dirty.y + dirty.height, changed.y + changed.height);
    dirty.x = x0;
    dirty.y = y0;
    dirty.width = x1 - x0;
    dirty.height = y1 - y0;
  }

  return {
    glsl: PATHS_GLSL,
    uniforms,
    setTerrain(t: TerrainData): void {
      if (field.mapWidth === t.width && field.mapHeight === t.height) return;
      field = createPathField(t.width, t.height);
      texture.dispose();
      source.dispose();
      texture = fieldTexture(field);
      source = new DataTexture(field.data, field.width, field.height, RGFormat, UnsignedByteType);
      uniforms.cwPath_field.value = texture;
      uniforms.cwPath_rect.value.set(
        -PATH_MARGIN,
        -PATH_MARGIN,
        1 / field.tilesX,
        1 / field.tilesY,
      );
      dirty = null;
      whole = true;
      rebake();
    },
    setPaths(next: Uint8Array | null): void {
      paths = next;
      rebake();
    },
    setEntrance(next: EntrancePlace | null): void {
      entrance = next;
      rebake();
    },
    setQuality(q: Quality): void {
      uniforms.cwPath_quality.value = QUALITY_LEVEL[q];
    },
    update(): void {
      // A new texture goes up whole by itself the first time it is drawn with.
      const fresh = whole;
      whole = false;
      if (!dirty) return;
      const share = (dirty.width * dirty.height) / (field.width * field.height);
      if (fresh || share > WHOLE_UPLOAD_SHARE) {
        texture.needsUpdate = true;
      } else {
        region.min.set(dirty.x, dirty.y);
        region.max.set(dirty.x + dirty.width, dirty.y + dirty.height);
        origin.set(dirty.x, dirty.y);
        ctx.renderer.copyTextureToTexture(source, texture, region, origin);
      }
      dirty = null;
    },
    dispose(): void {
      texture.dispose();
      source.dispose();
    },
  };
}
