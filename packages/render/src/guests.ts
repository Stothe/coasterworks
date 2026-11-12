import type { GuestSection } from "@coasterworks/protocol";
import { GuestState } from "@coasterworks/sim";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  SRGBColorSpace,
  UniformsLib,
  UniformsUtils,
  type IUniform,
} from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl.js";
import {
  SHARED_UNIFORMS_GLSL,
  type FrameInfo,
  type Quality,
  type RenderContext,
  type SceneModule,
} from "./context.js";
import type { Ray } from "./picker.js";
import { NOISE_GLSL } from "./shaders/noise.glsl.js";

/** The guests walking around the park. */
export type GuestsModule = SceneModule & {
  /**
   * The guests of the latest snapshot, or null for none. `atMs` is when the snapshot arrived, on
   * the same clock as `SceneHandle.render(nowMs)`, which `update(frame)` gets as `frame.nowMs`;
   * guests move smoothly from where they are shown to where the snapshot puts them over the time
   * a snapshot lasts. A section is not written to again once it has been passed in, so it is kept
   * as it is. Passing the section that is already the latest does nothing.
   */
  setGuests(section: GuestSection | null, atMs: number): void;
  /**
   * The guest a world-space ray hits first, or null. With `reach`, only a guest hit nearer than
   * that distance along the ray counts: what is behind the ground the ray meets is out of sight.
   */
  pickAt(ray: Ray, reach?: number): { id: number } | null;
};

/** The sim's `GuestState.RIDING`: on a ride, and drawn as part of it. */
const RIDING = GuestState.RIDING;

/** The most guests drawn at once. */
export const GUEST_CAPACITY = 2000;

/** Guest positions arrive in these units: 32 to a tile. */
const UNITS_PER_TILE = 32;

// ---------------------------------------------------------------------------------------------
// Moving between snapshots
// ---------------------------------------------------------------------------------------------

/**
 * The guests at one moment: who they are, where they are (in the snapshot's units, 1/32 of a
 * tile) and when. A snapshot's `GuestSection` with the time it arrived is one; so is what
 * `interpolateGuests` wrote, stamped with a time.
 */
export interface GuestMoment {
  count: number;
  id: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Each guest's `GuestState`, when known: a guest getting on or off a ride is not walked. */
  state?: ArrayLike<number>;
  atMs: number;
}

/** Where `interpolateGuests` puts the guests: one entry per guest drawn, in `latest`'s order. */
export interface GuestPlaces {
  count: number;
  id: Int32Array;
  /** In the snapshot's units, 1/32 of a tile, but no longer whole numbers. */
  x: Float32Array;
  y: Float32Array;
  /** Each guest's state in `latest` (0 where `latest` has none). */
  state: Uint8Array;
  /**
   * For each guest its index in `previous`, or -1 when it is drawn where `latest` has it because
   * it was not in `previous` or is too far from where it was to have walked there.
   */
  from: Int32Array;
  /** How far along from `previous` (0) to `latest` (1) the places are; above 1 when running on. */
  k: number;
}

/** Makes the arrays `interpolateGuests` writes to, for up to `capacity` guests. */
export function createGuestPlaces(capacity: number): GuestPlaces {
  return {
    count: 0,
    id: new Int32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    state: new Uint8Array(capacity),
    from: new Int32Array(capacity),
    k: 1,
  };
}

/**
 * A guest shown further than this from where the latest snapshot has it did not walk there (it
 * was moved, or its id was given to another guest): it is put straight at its new place.
 */
export const GUEST_JUMP_UNITS = 3 * UNITS_PER_TILE;

/**
 * How far past the latest snapshot guests keep going, as a share of the way from the one before,
 * when the next snapshot is late. It covers a snapshot that arrives a frame late without the
 * crowd stopping for that frame; after it guests wait where they are.
 */
export const GUEST_RUN_ON = 0.25;

/**
 * Where every guest is at `nowMs`, between the last two moments known. Pure: it reads its
 * arguments and writes only to `out`, which it returns.
 *
 * Guests go from where `previous` has them to where `latest` has them over a span as long as the
 * time between the two, starting when `latest` arrived: at `latest.atMs` they are still at their
 * `previous` places, one span later at their `latest` ones. So the picture runs one snapshot
 * behind, which is what makes it possible to move smoothly with nothing but the past to go on. If
 * the next snapshot is late they run on in a straight line for `GUEST_RUN_ON` of a span and then
 * stand.
 *
 * Guests are matched by id, not by slot: a guest that changed slot is followed, one that is only
 * in `latest` appears at its place, one that is only in `previous` is gone. `out` has `latest`'s
 * guests in `latest`'s order, at most as many as `out` has room for.
 *
 * `index`, when given, must map each id of `previous` to its slot there; it saves building one
 * when slots differ. Without `previous` (or without time between the two) guests are at their
 * `latest` places.
 */
export function interpolateGuests(
  previous: GuestMoment | null,
  latest: GuestMoment | null,
  nowMs: number,
  out: GuestPlaces,
  index?: ReadonlyMap<number, number>,
): GuestPlaces {
  if (!latest) {
    out.count = 0;
    out.k = 1;
    return out;
  }
  const count = Math.min(latest.count, out.id.length);
  out.count = count;
  const span = previous ? latest.atMs - previous.atMs : 0;
  const k = span > 0 ? Math.min(1 + GUEST_RUN_ON, Math.max(0, (nowMs - latest.atMs) / span)) : 1;
  out.k = k;
  const before = previous ? previous.count : 0;
  let lookup = index;
  for (let i = 0; i < count; i++) {
    const id = latest.id[i] as number;
    const x = latest.x[i] as number;
    const y = latest.y[i] as number;
    let j = -1;
    if (previous) {
      if (i < before && previous.id[i] === id) {
        j = i;
      } else {
        if (!lookup) {
          const built = new Map<number, number>();
          for (let s = 0; s < before; s++) built.set(previous.id[s] as number, s);
          lookup = built;
        }
        const found = lookup.get(id);
        // An index that is out of date is not trusted further than it can be checked.
        if (found !== undefined && found < before && previous.id[found] === id) j = found;
      }
    }
    out.id[i] = id;
    const state = latest.state ? (latest.state[i] as number) : 0;
    out.state[i] = state;
    if (j >= 0 && previous) {
      const px = previous.x[j] as number;
      const py = previous.y[j] as number;
      const dx = x - px;
      const dy = y - py;
      // A guest riding is at the ride's middle, out of sight: getting on or off is a jump, not a
      // walk from or to the middle.
      const boarding =
        previous.state !== undefined &&
        latest.state !== undefined &&
        (previous.state[j] === RIDING) !== (state === RIDING);
      if (!boarding && dx * dx + dy * dy <= GUEST_JUMP_UNITS * GUEST_JUMP_UNITS) {
        out.x[i] = px + dx * k;
        out.y[i] = py + dy * k;
        out.from[i] = j;
        continue;
      }
    }
    out.x[i] = x;
    out.y[i] = y;
    out.from[i] = -1;
  }
  return out;
}

/** The difference `to - from` between two angles, taken the short way round: -PI to PI. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ---------------------------------------------------------------------------------------------
// Who a guest is: looks from the id
// ---------------------------------------------------------------------------------------------

/**
 * Clothing colors by the snapshot's color index, 0 to 8: red, orange, yellow, green, teal, blue,
 * violet, pink and cream. Chosen to be told apart at a glance from far away and to sit well
 * together and on grass and paving.
 */
export const GUEST_CLOTHES: readonly number[] = [
  0xd9473f, 0xe68632, 0xe6bd3a, 0x58a858, 0x2aa39c, 0x3d7fd6, 0x8760c9, 0xe46d9b, 0xe6dfd0,
];

const SKIN_TONES: readonly number[] = [0xe7c09f, 0xe6b791, 0xd6a276, 0xb98257, 0x8f5f40, 0x63422e];
/** Black, dark brown, brown, auburn, blond, red, grey. */
const HAIR_COLORS: readonly number[] = [
  0x1d1512, 0x3b2719, 0x6c4526, 0xa3622b, 0xdcb765, 0xb5442b, 0xc8c4bc,
];
/** Denim, dark denim, charcoal, khaki, olive, brown, stone, light denim. */
const TROUSER_COLORS: readonly number[] = [
  0x3b5a88, 0x2b3c5e, 0x30333d, 0x94835f, 0x55663f, 0x5e4838, 0xcfc8b8, 0x7590b4,
];

/** Hair styles: what `cwGuestHair` in the shader draws for each. */
const HAIR_SHORT = 0;
const HAIR_LONG = 1;
const HAIR_CROPPED = 2;
const HAIR_CAP = 3;
const HAIR_BOB = 4;

/** How a guest looks. Colors are linear RGB in 0..1. */
export interface GuestLook {
  shirt: [number, number, number];
  trousers: [number, number, number];
  skin: [number, number, number];
  /** Hair, or the cap when the style is a cap. */
  hair: [number, number, number];
  /** 0 short, 1 long, 2 cropped, 3 cap, 4 bob. */
  hairStyle: number;
  /** Where the sleeve ends along the arm, 0 at the fingertips to 1 at the shoulder. */
  sleeve: number;
  /** Where the trouser leg ends along the leg, 0 at the sole to 1 at the hip. */
  hem: number;
  /** Where trousers meet shirt on the body, 0 at the bottom of the trunk to 1 at the top. */
  belt: number;
  /** Shoes, from near black (0) to pale (1). */
  shoes: number;
  /** Size of the whole figure against the standard one. */
  scale: number;
  /** Size of the head against the figure's. Children have bigger heads. */
  headScale: number;
  /** A number in 0..1 of the guest's own: the offset of its stride, the pace of its glances. */
  seed: number;
}

/** A well mixed 32-bit number from a guest id and a salt (the finisher of MurmurHash3). */
function mix(id: number, salt: number): number {
  let h = (Math.imul(id | 0, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A number in 0..1 (1 excluded) from a guest id and a salt. */
function unit(id: number, salt: number): number {
  return mix(id, salt) / 4294967296;
}

const scratchColor = new Color();

function linear(hex: number): [number, number, number] {
  scratchColor.setHex(hex, SRGBColorSpace);
  return [scratchColor.r, scratchColor.g, scratchColor.b];
}

/** Picks from `list` by a number in 0..1. */
function pick(list: readonly number[], u: number): number {
  return list[Math.min(list.length - 1, Math.floor(u * list.length))] as number;
}

/**
 * How guest `id` looks when the snapshot gives it clothing color `colorIndex`. The same id and
 * color always give the same look: the shirt is the snapshot's color, everything else (skin,
 * hair, cut of the clothes, size) is made up from the id.
 */
export function guestLook(id: number, colorIndex: number): GuestLook {
  const shades = GUEST_CLOTHES.length;
  const shirtIndex = ((colorIndex % shades) + shades) % shades;
  const shirt = linear(GUEST_CLOTHES[shirtIndex] as number);
  const skin = linear(pick(SKIN_TONES, unit(id, 1)));
  const child = unit(id, 2) < 0.14;

  const styleRoll = unit(id, 3);
  let hairStyle = HAIR_SHORT;
  if (styleRoll > 0.36) hairStyle = HAIR_LONG;
  if (styleRoll > 0.6) hairStyle = HAIR_BOB;
  if (styleRoll > 0.74) hairStyle = HAIR_CROPPED;
  if (styleRoll > 0.84) hairStyle = HAIR_CAP;
  // Grey hair is for some of the grown-ups only.
  const hairRoll = unit(id, 4);
  let hair = linear(pick(HAIR_COLORS, hairRoll * (child ? 0.84 : 1)));
  if (hairStyle === HAIR_CAP) {
    // A cap in a clothing color that is not the shirt's.
    const capIndex = (shirtIndex + 1 + Math.floor(unit(id, 5) * (shades - 1))) % shades;
    hair = linear(GUEST_CLOTHES[capIndex] as number);
  }

  let trousers = linear(pick(TROUSER_COLORS, unit(id, 6)));
  // Cream on stone reads as no clothes at all from far away: give cream shirts dark trousers.
  if (shirtIndex === 8) trousers = linear(pick(TROUSER_COLORS, unit(id, 6) * 0.74));

  const sleeveRoll = unit(id, 7);
  const sleeve = sleeveRoll < 0.3 ? 0.24 : sleeveRoll < 0.9 ? 0.66 : 0.93;
  const hemRoll = unit(id, 8);
  const hem = hemRoll < 0.56 ? 0.16 : hemRoll < 0.88 ? 0.58 : 0.74;

  return {
    shirt,
    trousers,
    skin,
    hair,
    hairStyle,
    sleeve,
    hem,
    belt: 0.2 + unit(id, 9) * 0.1,
    shoes: unit(id, 10) < 0.3 ? 0.75 + unit(id, 11) * 0.25 : unit(id, 11) * 0.3,
    scale: child ? 0.68 + unit(id, 12) * 0.1 : 0.92 + unit(id, 12) * 0.16,
    headScale: child ? 1.2 : 1 + unit(id, 13) * 0.06,
    seed: unit(id, 14),
  };
}

// ---------------------------------------------------------------------------------------------
// The figure
// ---------------------------------------------------------------------------------------------

/**
 * The figure's measures, in world units (one tile is 1). It stands with its soles at y = 0,
 * faces +Z, and has its left side at +X. Slightly stylized so that it reads from far away: a big
 * head, a short trunk, sturdy limbs.
 */
export const FIGURE = {
  /** Top of the head. */
  height: 0.42,
  hipY: 0.172,
  kneeY: 0.098,
  legX: 0.034,
  shoulderY: 0.286,
  shoulderX: 0.076,
  elbowY: 0.222,
  neckY: 0.3,
  headY: 0.358,
  headRadius: 0.061,
} as const;

const PART_TRUNK = 0;
const PART_HEAD = 1;
const PART_LEG = 2;
const PART_ARM = 3;

/** The figure as plain arrays. */
export interface GuestFigure {
  /** x, y, z per vertex. */
  positions: Float32Array;
  /** Unit normals, smooth within each part. */
  normals: Float32Array;
  /**
   * Four numbers per vertex: the part (0 trunk, 1 head, 2 leg, 3 arm); how far along the part the
   * vertex is, 0 at its lower end (sole, fingertips, bottom of the trunk) to 1 at its upper;
   * the side (+1 left, -1 right, 0 for trunk and head); and 1 where the vertex is below the knee
   * or the elbow and so bends with it, else 0.
   */
  parts: Float32Array;
  indices: Uint16Array;
  triangleCount: number;
}

/** One level of a part: an ellipse around the part's axis, or a single point when `rx` is 0. */
interface Ring {
  y: number;
  rx: number;
  rz: number;
  /** Middle of the ellipse along Z; 0 when left out. */
  z?: number;
  /** How far along the part, 0..1. */
  along: number;
  /** 1 when this level bends with the knee or elbow. */
  bends?: number;
}

/**
 * Builds the figure: a trunk, a head, two legs with feet and two arms, each a rounded shape of
 * its own (stacked ellipses, closed with a point at every end that can be seen: the trunk is
 * open underneath and so are the soles), 240 triangles in all, a third of them in the head, which
 * is the biggest round thing on it. Normals are averaged over each part's faces, so every part
 * shades as one smooth surface.
 */
export function buildGuestFigure(): GuestFigure {
  const positions: number[] = [];
  const parts: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];

  /**
   * Adds one part from its levels, bottom to top, `segments` vertices around each. `place` moves
   * each vertex from the part's own axis to where it belongs on the figure, without mirroring.
   */
  function addPart(
    rings: readonly Ring[],
    segments: number,
    part: number,
    side: number,
    place: (x: number, y: number, z: number) => [number, number, number],
  ): void {
    const first = positions.length / 3;
    /** First vertex of each level, and how many it has. */
    const starts: number[] = [];
    const sizes: number[] = [];
    for (const ring of rings) {
      const size = ring.rx === 0 ? 1 : segments;
      starts.push(positions.length / 3);
      sizes.push(size);
      for (let s = 0; s < size; s++) {
        // Half a step round, so that a flat side and not a ridge faces forward.
        const angle = ((s + 0.5) / segments) * Math.PI * 2;
        const p = place(
          ring.rx * Math.sin(angle),
          ring.y,
          (ring.z ?? 0) + ring.rz * Math.cos(angle),
        );
        positions.push(p[0], p[1], p[2]);
        parts.push(part, ring.along, side, ring.bends ?? 0);
      }
    }
    // Triangles between each level and the next, wound to face out: going round by rising angle
    // is counterclockwise seen from above.
    const firstIndex = indices.length;
    for (let r = 0; r + 1 < rings.length; r++) {
      const a = starts[r] as number;
      const b = starts[r + 1] as number;
      const lower = sizes[r] as number;
      const upper = sizes[r + 1] as number;
      for (let s = 0; s < segments; s++) {
        const n = (s + 1) % segments;
        if (lower === 1) indices.push(a, b + n, b + s);
        else if (upper === 1) indices.push(a + s, a + n, b);
        else indices.push(a + s, b + n, b + s, a + s, a + n, b + n);
      }
    }

    // Each vertex's normal is the sum of its faces' (bigger faces count for more), so the part
    // shades as one smooth surface.
    const last = positions.length / 3;
    const sums = new Float64Array((last - first) * 3);
    for (let t = firstIndex; t < indices.length; t += 3) {
      const i0 = indices[t] as number;
      const i1 = indices[t + 1] as number;
      const i2 = indices[t + 2] as number;
      const ax = positions[i0 * 3] as number;
      const ay = positions[i0 * 3 + 1] as number;
      const az = positions[i0 * 3 + 2] as number;
      const ux = (positions[i1 * 3] as number) - ax;
      const uy = (positions[i1 * 3 + 1] as number) - ay;
      const uz = (positions[i1 * 3 + 2] as number) - az;
      const vx = (positions[i2 * 3] as number) - ax;
      const vy = (positions[i2 * 3 + 1] as number) - ay;
      const vz = (positions[i2 * 3 + 2] as number) - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const i of [i0, i1, i2]) {
        const o = (i - first) * 3;
        sums[o] = (sums[o] as number) + nx;
        sums[o + 1] = (sums[o + 1] as number) + ny;
        sums[o + 2] = (sums[o + 2] as number) + nz;
      }
    }
    for (let v = 0; v < last - first; v++) {
      const nx = sums[v * 3] as number;
      const ny = sums[v * 3 + 1] as number;
      const nz = sums[v * 3 + 2] as number;
      const length = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / length, ny / length, nz / length);
    }
  }

  const { hipY, kneeY, legX, shoulderY, shoulderX, elbowY, neckY, headY, headRadius } = FIGURE;

  // The trunk: hips, chest, shoulders, a little flatter front to back than side to side. It is
  // open underneath, where only the ground could see.
  const trunkBottom = 0.156;
  const trunkTop = 0.318;
  const trunkAlong = (y: number) => (y - trunkBottom) / (trunkTop - trunkBottom);
  addPart(
    [
      { y: trunkBottom, rx: 0.061, rz: 0.046, along: 0 },
      { y: 0.24, rx: 0.07, rz: 0.05, along: trunkAlong(0.24) },
      { y: neckY - 0.012, rx: 0.054, rz: 0.04, along: trunkAlong(neckY - 0.012) },
      { y: trunkTop, rx: 0, rz: 0, along: 1 },
    ],
    8,
    PART_TRUNK,
    0,
    (x, y, z) => [x, y, z],
  );

  // The head: a ball a touch taller than wide, four levels between its two ends.
  const headRings: Ring[] = [];
  const latitudes = [-90, -48, -12, 24, 58, 90];
  for (const latitude of latitudes) {
    const a = (latitude * Math.PI) / 180;
    const r = Math.abs(latitude) === 90 ? 0 : headRadius * Math.cos(a);
    headRings.push({ y: headY + headRadius * 1.04 * Math.sin(a), rx: r, rz: r, along: 0 });
  }
  addPart(headRings, 10, PART_HEAD, 0, (x, y, z) => [x, y, z]);

  for (const side of [1, -1]) {
    // A leg: a foot longer than it is wide, an ankle, a knee, and a hip tucked into the trunk.
    // The sole is open: nothing ever looks at it.
    addPart(
      [
        { y: 0, rx: 0.027, rz: 0.041, z: 0.014, along: 0, bends: 1 },
        { y: 0.046, rx: 0.022, rz: 0.024, along: 0.27, bends: 1 },
        { y: kneeY, rx: 0.027, rz: 0.028, along: 0.57 },
        { y: hipY + 0.004, rx: 0.031, rz: 0.033, along: 1 },
      ],
      5,
      PART_LEG,
      side,
      (x, y, z) => [x + side * legX, y, z],
    );
    // An arm: built hanging straight down from the shoulder, then leant out a little.
    const lean = side * 0.1;
    const cos = Math.cos(lean);
    const sin = Math.sin(lean);
    const reach = shoulderY - elbowY;
    addPart(
      [
        { y: -0.136, rx: 0, rz: 0, along: 0, bends: 1 },
        { y: -0.122, rx: 0.018, rz: 0.019, along: 0.1, bends: 1 },
        { y: -reach, rx: 0.02, rz: 0.021, along: 0.52 },
        { y: 0.002, rx: 0.023, rz: 0.025, along: 0.94 },
        { y: 0.019, rx: 0, rz: 0, along: 1 },
      ],
      5,
      PART_ARM,
      side,
      (x, y, z) => [side * shoulderX + x * cos - y * sin, shoulderY + x * sin + y * cos, z],
    );
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    parts: new Float32Array(parts),
    indices: new Uint16Array(indices),
    triangleCount: indices.length / 3,
  };
}

// ---------------------------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------------------------

/** How wide a guest is for picking, to either side of its middle, at the standard size. */
const PICK_RADIUS = 0.11;

/**
 * The first of `count` guests a ray hits, as its index, or -1. `places` holds world x, y (soles)
 * and z per guest and `sizes` each one's size against the standard figure. A guest is taken as an
 * upright rod with rounded ends, a little fatter than the figure so that it is easy to hit. The
 * ray's direction need not be unit length; hits behind its origin, or `reach` or further along
 * it, do not count.
 */
export function pickGuest(
  ray: Ray,
  places: Float32Array,
  sizes: Float32Array,
  count: number,
  reach = Infinity,
): number {
  const { origin, direction } = ray;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0)) return -1;
  const dx = direction.x / length;
  const dy = direction.y / length;
  const dz = direction.z / length;
  let best = reach;
  let hit = -1;
  for (let i = 0; i < count; i++) {
    const size = sizes[i] as number;
    // A guest not drawn (one on a ride) cannot be picked.
    if (!(size > 0)) continue;
    const radius = PICK_RADIUS * size;
    // The rod's axis runs from `radius` above the soles to `radius` below the top of the head.
    const rod = Math.max(0, FIGURE.height * size - radius * 2);
    const wx = origin.x - (places[i * 3] as number);
    const wy = origin.y - ((places[i * 3 + 1] as number) + radius);
    const wz = origin.z - (places[i * 3 + 2] as number);
    // Closest points of the ray (parameter t) and the axis (height s above its lower end).
    const along = dx * wx + dy * wy + dz * wz;
    const denominator = 1 - dy * dy;
    let s = denominator > 1e-9 ? (wy - dy * along) / denominator : 0;
    s = Math.min(rod, Math.max(0, s));
    const t = Math.max(0, dy * s - along);
    if (t >= best) continue;
    const ox = wx + dx * t;
    const oy = wy + dy * t - s;
    const oz = wz + dz * t;
    if (ox * ox + oy * oy + oz * oz > radius * radius) continue;
    best = t;
    hit = i;
  }
  return hit;
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

/** Strides a second at a walk. Guests cover ground faster than legs this size could, so the pace
 * is set for looks, not from the distance covered. */
const CADENCE = 2.3;
/** How far a leg swings either way from straight down, in radians. */
const STRIDE = 0.62;
/** From this camera distance to the next, figures are drawn up to `FAR_GROW` bigger, so that a
 * crowd seen from far away is still a crowd of people and not of specks. */
const GROW_NEAR = 24;
const GROW_FAR = 100;
const FAR_GROW = 0.8;

const glsl = (n: number): string => n.toFixed(4);

/** Where the hair is on a head, in both stages: above 0 is hair, below is skin. */
const HAIR_GLSL = /* glsl */ `
// l is a point on the head as a direction from its middle: +Y up, +Z the face.
float cwGuestHair( vec3 l, float style ) {
  float side = abs( l.x );
  // Short: the top and the back of the head, off the ears, brushed to one side in front.
  if ( style < 0.5 ) return 0.95 * l.y - 0.72 * l.z - 0.26 + 0.1 * side + 0.16 * l.x * max( 0.0, l.z );
  // Long: down the back and the sides to the shoulders, parted in the middle.
  if ( style < 1.5 ) return 0.5 * l.y - 0.95 * l.z + 0.2 + 0.28 * side - 0.3 * max( 0.0, l.z ) * ( 1.0 - smoothstep( 0.0, 0.35, side ) );
  // Cropped close: little more than the crown.
  if ( style < 2.5 ) return l.y - 0.4 * l.z - 0.56;
  // A cap: level all round, with a peak over the face.
  if ( style < 3.5 ) return l.y - 0.2 + 0.1 * max( 0.0, l.z );
  // A bob: like long hair, cut at the jaw.
  return min( 0.62 * l.y - 0.9 * l.z + 0.12 + 0.3 * side - 0.14 * l.x * max( 0.0, l.z ), l.y + 0.45 );
}
`;

const VERTEX_DECLARATIONS = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
// Per vertex: part, how far along it, side, bends with the knee or elbow.
attribute vec4 aPart;
// Per guest: how much it is walking (0 standing to 1), its own number, head size, hair style.
attribute vec4 aAnim;
${HAIR_GLSL}

vec2 cwGuestTurn( vec2 v, float angle ) {
  float s = sin( angle );
  float c = cos( angle );
  return vec2( c * v.x - s * v.y, s * v.x + c * v.y );
}

// Moves a vertex of the standing figure to where the guest's pose puts it, and turns its normal
// along. head comes back as the vertex's direction from the middle of the head (the resting
// head: hair and face turn with it), or far outside the unit ball for every other part.
void cwGuestPose( inout vec3 p, inout vec3 n, out vec3 head ) {
  float part = aPart.x;
  float side = aPart.z;
  float bends = aPart.w;
  float walk = aAnim.x;
  float seed = aAnim.y;
  float still = 1.0 - walk;
  float phase = uTime * ${glsl(CADENCE * Math.PI * 2)} * ( 0.92 + 0.16 * fract( seed * 7.13 ) )
    + seed * 6.2832;
  float s = sin( phase );
  float c = cos( phase );
  head = vec3( 9.0 );

  if ( part > 1.5 && part < 2.5 ) {
    // A leg swings from the hip; on its way forward the knee bends and lifts the foot.
    vec2 knee = vec2( ${glsl(FIGURE.kneeY)}, 0.0 );
    float fold = 1.15 * max( 0.0, side * c ) * walk * bends;
    p.yz = knee + cwGuestTurn( p.yz - knee, fold );
    n.yz = cwGuestTurn( n.yz, fold );
    vec2 hip = vec2( ${glsl(FIGURE.hipY)}, 0.0 );
    float swing = -${glsl(STRIDE)} * side * s * walk;
    p.yz = hip + cwGuestTurn( p.yz - hip, swing );
    n.yz = cwGuestTurn( n.yz, swing );
  } else {
    float upper = 1.0;
    if ( part > 2.5 ) {
      // An arm swings against the leg of its side, the forearm a little bent, more so in front.
      vec2 elbow = vec2( ${glsl(FIGURE.elbowY)}, 0.0 );
      // Standing, every guest holds its arms its own way.
      float held = fract( seed * ( side > 0.0 ? 5.3 : 9.1 ) );
      float fold = -( 0.2 + 0.4 * held * still + walk * ( 0.29 + 0.45 * max( 0.0, -side * s ) ) ) * bends;
      p.yz = elbow + cwGuestTurn( p.yz - elbow, fold );
      n.yz = cwGuestTurn( n.yz, fold );
      vec2 shoulder = vec2( ${glsl(FIGURE.shoulderY)}, 0.0 );
      float swing = 0.7 * side * s * walk - 0.05
        + ( 0.05 * sin( uTime * 1.3 + seed * 20.0 ) + 0.22 * ( 0.4 - held ) ) * still;
      p.yz = shoulder + cwGuestTurn( p.yz - shoulder, swing );
      n.yz = cwGuestTurn( n.yz, swing );
    } else if ( part > 0.5 ) {
      vec3 middle = vec3( 0.0, ${glsl(FIGURE.headY)}, 0.0 );
      head = ( p - middle ) / ${glsl(FIGURE.headRadius)};
      // Hair stands a little proud of the skin, and long hair and a bob hang down behind.
      vec3 l = normalize( head );
      float hair = cwGuestHair( l, aAnim.w );
      p += l * ${glsl(FIGURE.headRadius * 0.12)} * smoothstep( -0.05, 0.3, hair );
      float hangs = aAnim.w > 0.5 && aAnim.w < 1.5 ? 1.0 : aAnim.w > 3.5 ? 0.45 : 0.0;
      hangs *= smoothstep( 0.25, -0.5, l.y ) * smoothstep( 0.35, -0.35, l.z );
      p += vec3( 0.0, -${glsl(FIGURE.headRadius * 0.5)}, -${glsl(FIGURE.headRadius * 0.16)} ) * hangs;
      // The head's own size, from the neck.
      vec3 neck = vec3( 0.0, ${glsl(FIGURE.neckY)}, 0.0 );
      p = neck + ( p - neck ) * aAnim.z;
      // Standing guests look about; walking ones keep their eyes on the way.
      float glance = 0.6 * sin( uTime * ( 0.35 + 0.3 * fract( seed * 3.7 ) ) + seed * 31.0 );
      glance *= smoothstep( 0.2, 0.7, sin( uTime * 0.21 + seed * 17.0 ) * 0.5 + 0.5 ) * still;
      p.xz = cwGuestTurn( p.xz, glance );
      n.xz = cwGuestTurn( n.xz, glance );
    } else {
      // The hips stay square to the legs; the trunk takes up the turn of the shoulders.
      upper = smoothstep( ${glsl(FIGURE.hipY)}, ${glsl(FIGURE.shoulderY)}, p.y );
    }
    // The shoulders turn against the stride; a guest standing about has them a little askew.
    float twist = ( -0.16 * s * walk + 0.22 * ( fract( seed * 11.9 ) - 0.5 ) * still ) * upper;
    p.xz = cwGuestTurn( p.xz, twist );
    n.xz = cwGuestTurn( n.xz, twist );
    // A walker leans into it.
    vec2 hip = vec2( ${glsl(FIGURE.hipY)}, 0.0 );
    float lean = 0.09 * walk * upper;
    p.yz = hip + cwGuestTurn( p.yz - hip, lean );
    n.yz = cwGuestTurn( n.yz, lean );
    // A guest standing about shifts its weight and breathes.
    p.x += 0.005 * sin( uTime * 0.8 + seed * 50.0 ) * still * upper;
    p.y += 0.0025 * sin( uTime * 1.9 + seed * 40.0 ) * still * upper;
  }
  // The body sinks as the legs spread, which keeps the foot that is down on the ground.
  p.y -= ${glsl(FIGURE.hipY)} * ( 1.0 - cos( ${glsl(STRIDE)} * s * walk ) );
  // Drawn bigger from far away.
  p *= 1.0 + ${glsl(FAR_GROW)} * smoothstep( ${glsl(GROW_NEAR)}, ${glsl(GROW_FAR)}, uCamDistance );
}
`;

const COLOR_VERTEX_DECLARATIONS = /* glsl */ `
// Per guest, linear colors: shirt and where the sleeve ends; trousers and where the leg ends;
// skin and where the belt is; hair (or cap) and how pale the shoes are.
attribute vec4 aShirt;
attribute vec4 aTrousers;
attribute vec4 aSkin;
attribute vec4 aHair;
// A fragment is one of up to three colors, by where a coordinate lies against two limits:
// A below the first, B between them, C above the second. rgb is the color; A's w is the
// coordinate, B's and C's are the limits. On the head B's w is the hair style instead.
varying vec4 vCwA;
varying vec4 vCwB;
varying vec4 vCwC;
// xyz: direction from the middle of the head (far outside the unit ball off the head).
// w: height above the soles on the standing figure.
varying vec4 vCwHead;
// Where the guest stands, for the shadow of the clouds.
varying vec2 vCwGround;
`;

const COLOR_VERTEX_MAIN = /* glsl */ `
{
  float cwAlong = aPart.y;
  vec3 cwShoe = mix( vec3( 0.02, 0.018, 0.02 ), vec3( 0.62, 0.6, 0.56 ), aHair.a );
  if ( aPart.x < 0.5 ) {
    // Trunk: trousers to the belt, shirt above, a bit of neck.
    vCwA = vec4( aTrousers.rgb, cwAlong );
    vCwB = vec4( aShirt.rgb, aSkin.a );
    vCwC = vec4( aSkin.rgb, 0.95 );
  } else if ( aPart.x < 1.5 ) {
    vCwA = vec4( aSkin.rgb, 0.0 );
    vCwB = vec4( aHair.rgb, aAnim.w );
    vCwC = vec4( aHair.rgb, 100.0 );
  } else if ( aPart.x < 2.5 ) {
    // Leg: shoe, bare shin when the trousers are short, trousers.
    vCwA = vec4( cwShoe, cwAlong );
    vCwB = vec4( aTrousers.a > 0.2 ? aSkin.rgb : aTrousers.rgb, 0.17 );
    vCwC = vec4( aTrousers.rgb, max( aTrousers.a, 0.17 ) );
  } else {
    // Arm: bare to where the sleeve ends.
    vCwA = vec4( aSkin.rgb, cwAlong );
    vCwB = vec4( aSkin.rgb, -1.0 );
    vCwC = vec4( aShirt.rgb, aShirt.a );
  }
  vCwHead = vec4( cwHead, position.y );
  vCwGround = instanceMatrix[ 3 ].xz;
}
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec4 vCwA;
varying vec4 vCwB;
varying vec4 vCwC;
varying vec4 vCwHead;
varying vec2 vCwGround;
${SHARED_UNIFORMS_GLSL}
${NOISE_GLSL}
${ATMOSPHERE_GLSL}
${HAIR_GLSL}
`;

const FRAGMENT_COLOR = /* glsl */ `
{
  bool cwOnHead = vCwHead.x < 5.0;
  vec3 cwL = cwOnHead ? normalize( vCwHead.xyz ) : vec3( 0.0, 1.0, 0.0 );
  float cwCoord = cwOnHead ? cwGuestHair( cwL, vCwB.a ) : vCwA.a;
  float cwFirst = cwOnHead ? 0.0 : vCwB.a;
  float cwSoft = fwidth( cwCoord ) * 0.75 + 0.0001;
  vec3 cwColor = mix( vCwA.rgb, vCwB.rgb, smoothstep( cwFirst - cwSoft, cwFirst + cwSoft, cwCoord ) );
  cwColor = mix( cwColor, vCwC.rgb, smoothstep( vCwC.a - cwSoft, vCwC.a + cwSoft, cwCoord ) );
  // Two eyes, for as long as they are big enough to draw without flicker.
  float cwPixel = fwidth( cwL.y ) + fwidth( cwL.x );
  vec2 cwEye = vec2( abs( cwL.x ) - 0.4, ( cwL.y + 0.04 ) * 0.82 );
  float cwDot = 1.0 - smoothstep( 0.13 - cwPixel * 0.5, 0.13 + cwPixel * 0.5, length( cwEye ) );
  cwDot *= step( 0.0, cwL.z ) * ( 1.0 - smoothstep( 0.16, 0.34, cwPixel ) );
  if ( cwOnHead ) cwColor = mix( cwColor, vec3( 0.03, 0.022, 0.02 ), cwDot * 0.92 );
  // Less light reaches the legs, in among the crowd, than the head and shoulders.
  diffuseColor.rgb = cwColor * mix( 0.76, 1.0, smoothstep( 0.0, 0.26, vCwHead.w ) );
}
`;

// The underside of things (chin, hands, the hem of a shirt) sits in its own shade.
const FRAGMENT_UNDERSIDE = /* glsl */ `
diffuseColor.rgb *= mix( 0.8, 1.0, smoothstep( -0.7, 0.2, dot( normal, viewMatrix[ 1 ].xyz ) ) );
`;

// As on the ground: the sun is the scene's only direct light, and the clouds dim it.
const FRAGMENT_CLOUD_SHADOW = /* glsl */ `
{
  float cwCloud = cwCloudShadow( vCwGround );
  reflectedLight.directDiffuse *= cwCloud;
  reflectedLight.directSpecular *= cwCloud;
}
`;

/** How far the soft shade under a guest reaches from its middle, at the standard size. */
const SHADE_RADIUS = 0.15;
/** How far above the ground the shade is drawn, so that the ground does not swallow it. */
const SHADE_LIFT = 0.012;
/** How dark the shade is at its middle: more where it is all that ties a guest to the ground. */
const SHADE_STRENGTH: Record<Quality, number> = { low: 0.5, medium: 0.34, high: 0.34 };

// The shade under a guest: a flat square per guest, laid along the slope of the ground there,
// that darkens the ground in a soft round patch.
const SHADE_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${SHARED_UNIFORMS_GLSL}
// How the ground rises under the guest, per unit along X and along Z.
attribute vec2 aSlope;
varying vec2 vCwDisc;

void main() {
  vCwDisc = position.xz;
  float grown = 1.0 + ${glsl(FAR_GROW)} * smoothstep( ${glsl(GROW_NEAR)}, ${glsl(GROW_FAR)}, uCamDistance );
  // The guest's own matrix turns and sizes the patch; its height follows the ground instead.
  vec3 reach = mat3( instanceMatrix ) * ( position * ${glsl(SHADE_RADIUS)} * grown );
  vec3 place = instanceMatrix[ 3 ].xyz + reach;
  place.y = instanceMatrix[ 3 ].y + dot( aSlope, reach.xz ) + ${glsl(SHADE_LIFT)};
  vec4 mvPosition = modelViewMatrix * vec4( place, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SHADE_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uCwShade;
varying vec2 vCwDisc;

void main() {
  float fade = 1.0 - smoothstep( 0.15, 1.0, length( vCwDisc ) );
  float alpha = fade * fade * uCwShade;
  // Haze hides the shade along with the ground it lies on.
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      alpha *= exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      alpha *= 1.0 - smoothstep( fogNear, fogFar, vFogDepth );
    #endif
  #endif
  gl_FragColor = vec4( 0.012, 0.016, 0.03, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Puts `addition` right after `#include <name>` in `source`, or in its place. Throws when the
 * include is not there: the names are three.js internals, and a version that renamed one must
 * fail loudly here, not draw unposed figures in silence.
 */
function patch(source: string, name: string, addition: string, replace = false): string {
  const include = `#include <${name}>`;
  if (!source.includes(include)) {
    throw new Error(
      `Guests: three.js's shader has no "${include}". The figures were written against ` +
        `three r186; see packages/render/src/guests.ts.`,
    );
  }
  return source.replace(include, replace ? addition : `${include}\n${addition}`);
}

// ---------------------------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------------------------

/** How long a guest takes to turn most of the way to a new heading, in milliseconds. */
const TURN_MS = 110;
/** How long the walk takes to settle into standing, and to start up again. */
const SETTLE_MS = 160;
/** A guest that moved less than this between two snapshots is standing (snapshot units). */
const STANDING_UNITS = 0.25;
/** How far along X and Z the ground is sampled to find its slope under a guest. */
const SLOPE_STEP = 0.1;
/** The time between snapshots assumed before two have arrived. */
const DEFAULT_SPAN_MS = 50;
/** A gap longer than this between snapshots is a stall, not their pace. */
const MAX_SPAN_MS = 500;

/** One moment's worth of guest places that the module itself owns. */
function createMoment(capacity: number): GuestPlaces & { atMs: number } {
  return { ...createGuestPlaces(capacity), atMs: 0 };
}

/**
 * Creates the guests module: every guest a small rounded figure in its own clothes, hair and
 * size, all drawn as one instanced mesh.
 *
 * Movement: `setGuests` notes where everybody is shown at that moment and where the new snapshot
 * has them; `update` moves each guest from the one to the other with `interpolateGuests`, by id,
 * on the clock of `frame.nowMs`. Starting from what is shown, not from the snapshot before, means
 * a snapshot that comes early or late bends a guest's way a little and never makes it jump. The
 * heading turns toward the way the guest last moved. Heights come from `ctx.heightAt` at the two
 * ends of each step.
 *
 * The walk is in the vertex shader (`cwGuestPose`): legs and arms swing, knees and elbows bend,
 * the body dips with each stride; it fades to standing, breathing and looking about as the
 * guest stops. The shadow is drawn with the same pose. Colors are chosen per fragment from the
 * guest's few colors by how far along a limb the fragment is, which gives sleeves, shorts and
 * shoes clean edges without a triangle spent on them; hair and eyes are drawn the same way from
 * the place on the head.
 *
 * Two things help a crowd read: from far away figures are drawn somewhat bigger (the same in the
 * shadow pass and in picking), and under every guest lies a soft round patch of shade, a second
 * instanced mesh on the same matrices, which ties it to the ground where the sun's shadow is too
 * coarse to, or is switched off.
 */
export function createGuests(ctx: RenderContext): GuestsModule {
  const figure = buildGuestFigure();
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(figure.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(figure.normals, 3));
  geometry.setAttribute("aPart", new BufferAttribute(figure.parts, 4));
  geometry.setIndex(new BufferAttribute(figure.indices, 1));

  const anim = new InstancedBufferAttribute(new Float32Array(GUEST_CAPACITY * 4), 4);
  anim.setUsage(DynamicDrawUsage);
  const shirt = new InstancedBufferAttribute(new Float32Array(GUEST_CAPACITY * 4), 4);
  const trousers = new InstancedBufferAttribute(new Float32Array(GUEST_CAPACITY * 4), 4);
  const skin = new InstancedBufferAttribute(new Float32Array(GUEST_CAPACITY * 4), 4);
  const hair = new InstancedBufferAttribute(new Float32Array(GUEST_CAPACITY * 4), 4);
  geometry.setAttribute("aAnim", anim);
  geometry.setAttribute("aShirt", shirt);
  geometry.setAttribute("aTrousers", trousers);
  geometry.setAttribute("aSkin", skin);
  geometry.setAttribute("aHair", hair);

  const uniforms: Record<string, IUniform> = { ...ctx.uniforms, ...ctx.atmosphereUniforms };

  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vertex = shader.vertexShader;
    vertex = patch(vertex, "common", VERTEX_DECLARATIONS + COLOR_VERTEX_DECLARATIONS);
    vertex = patch(
      vertex,
      "beginnormal_vertex",
      /* glsl */ `
      vec3 cwPosed = vec3( position );
      vec3 cwHead;
      cwGuestPose( cwPosed, objectNormal, cwHead );
      ${COLOR_VERTEX_MAIN}`,
    );
    vertex = patch(vertex, "begin_vertex", "vec3 transformed = cwPosed;", true);
    shader.vertexShader = vertex;

    let fragment = shader.fragmentShader;
    fragment = patch(fragment, "clipping_planes_pars_fragment", FRAGMENT_DECLARATIONS);
    fragment = patch(fragment, "color_fragment", FRAGMENT_COLOR);
    fragment = patch(fragment, "normal_fragment_begin", FRAGMENT_UNDERSIDE);
    fragment = patch(fragment, "lights_fragment_begin", FRAGMENT_CLOUD_SHADOW);
    shader.fragmentShader = fragment;
  };
  material.customProgramCacheKey = () => "cw-guests";

  // The shadow is of the figure as posed, not as built.
  const depthMaterial = new MeshDepthMaterial();
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vertex = shader.vertexShader;
    vertex = patch(vertex, "common", VERTEX_DECLARATIONS);
    vertex = patch(
      vertex,
      "begin_vertex",
      /* glsl */ `
      vec3 transformed = vec3( position );
      vec3 cwNormal = vec3( 0.0, 1.0, 0.0 );
      vec3 cwHead;
      cwGuestPose( transformed, cwNormal, cwHead );`,
      true,
    );
    shader.vertexShader = vertex;
  };
  depthMaterial.customProgramCacheKey = () => "cw-guests-depth";

  const mesh = new InstancedMesh(geometry, material, GUEST_CAPACITY);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.customDepthMaterial = depthMaterial;
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Guests are all over the park and move every frame, so there is no fixed box to cull by.
  mesh.frustumCulled = false;
  ctx.scene.add(mesh);

  // The shade under each guest: one flat square per guest, placed by the same matrices.
  const shadeGeometry = new BufferGeometry();
  shadeGeometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3),
  );
  shadeGeometry.setIndex([0, 2, 1, 0, 3, 2]);
  const slope = new InstancedBufferAttribute(new Float32Array(GUEST_CAPACITY * 2), 2);
  shadeGeometry.setAttribute("aSlope", slope);
  const shadeStrength = { value: SHADE_STRENGTH[ctx.quality] };
  const shadeMaterial = new ShaderMaterial({
    uniforms: { ...UniformsUtils.clone(UniformsLib.fog), ...ctx.uniforms, uCwShade: shadeStrength },
    vertexShader: SHADE_VERTEX,
    fragmentShader: SHADE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const shade = new InstancedMesh(shadeGeometry, shadeMaterial, 1);
  shade.instanceMatrix = mesh.instanceMatrix;
  shade.count = 0;
  shade.frustumCulled = false;
  ctx.scene.add(shade);

  // The two moments guests move between, and the id-to-slot index of the earlier one. `carried`
  // is what was on screen when the latest snapshot arrived.
  let carried = createMoment(GUEST_CAPACITY);
  let spare = createMoment(GUEST_CAPACITY);
  let hasCarried = false;
  let carriedIndex = new Map<number, number>();
  let spareIndex = new Map<number, number>();
  let latestSection: GuestSection | null = null;
  const latest: GuestMoment = { count: 0, id: [], x: [], y: [], atMs: 0 };
  let hasLatest = false;
  let spanMs = DEFAULT_SPAN_MS;
  /** Where everybody is in the frame being drawn. */
  const shown = createGuestPlaces(GUEST_CAPACITY);

  // What the module remembers about each guest, by its slot in the latest snapshot. Each has a
  // second array to build the next snapshot's into (slots change).
  let heading = new Float32Array(GUEST_CAPACITY);
  let headingNext = new Float32Array(GUEST_CAPACITY);
  let walk = new Float32Array(GUEST_CAPACITY);
  let walkNext = new Float32Array(GUEST_CAPACITY);
  /** Ground height where the guest is shown when the latest snapshot arrived. */
  let groundFrom = new Float32Array(GUEST_CAPACITY);
  let groundFromNext = new Float32Array(GUEST_CAPACITY);
  /** The heading the guest is turning to, whether it moved in the latest snapshot, and the
   * ground height where the latest snapshot has it. */
  const headingTo = new Float32Array(GUEST_CAPACITY);
  const moving = new Uint8Array(GUEST_CAPACITY);
  const groundTo = new Float32Array(GUEST_CAPACITY);
  const size = new Float32Array(GUEST_CAPACITY);
  /** The id and color each slot's look attributes were last written for. */
  const lookId = new Int32Array(GUEST_CAPACITY).fill(-1);
  const lookColor = new Int16Array(GUEST_CAPACITY).fill(-1);
  /** World x, y (soles), z of each drawn guest, and its drawn size, for picking. */
  const places = new Float32Array(GUEST_CAPACITY * 3);
  const pickSizes = new Float32Array(GUEST_CAPACITY);
  /** Heights in the making while slots are being matched up. */
  const scratchGround = new Float32Array(GUEST_CAPACITY);
  let lastNowMs: number | null = null;

  // Ranges of the per-frame attributes to upload: only the guests there are. The objects are
  // reused; three.js empties the lists after each upload.
  const matrixRange = { start: 0, count: 0 };
  const animRange = { start: 0, count: 0 };

  function writeLook(slot: number, id: number, colorIndex: number): void {
    const look = guestLook(id, colorIndex);
    const o = slot * 4;
    shirt.array.set(look.shirt, o);
    shirt.array[o + 3] = look.sleeve;
    trousers.array.set(look.trousers, o);
    trousers.array[o + 3] = look.hem;
    skin.array.set(look.skin, o);
    skin.array[o + 3] = look.belt;
    hair.array.set(look.hair, o);
    hair.array[o + 3] = look.shoes;
    anim.array[o + 1] = look.seed;
    anim.array[o + 2] = look.headScale;
    anim.array[o + 3] = look.hairStyle;
    size[slot] = look.scale;
    lookId[slot] = id;
    lookColor[slot] = colorIndex;
  }

  /** The ground under snapshot place (x, y), which is in 1/32 of a tile. */
  const groundAt = (x: number, y: number): number =>
    ctx.heightAt(x / UNITS_PER_TILE, y / UNITS_PER_TILE);

  /** Notes how the ground slopes at snapshot place (x, y), of height `ground`, for slot `i`. */
  function writeSlope(i: number, x: number, y: number, ground: number): void {
    const wx = x / UNITS_PER_TILE;
    const wz = y / UNITS_PER_TILE;
    slope.array[i * 2] = (ctx.heightAt(wx + SLOPE_STEP, wz) - ground) / SLOPE_STEP;
    slope.array[i * 2 + 1] = (ctx.heightAt(wx, wz + SLOPE_STEP) - ground) / SLOPE_STEP;
  }

  function setGuests(section: GuestSection | null, atMs: number): void {
    if (section === latestSection) return;
    if (!section) {
      latestSection = null;
      hasLatest = false;
      hasCarried = false;
      mesh.count = 0;
      shade.count = 0;
      shown.count = 0;
      return;
    }

    // What is on screen at this moment becomes where everybody starts from.
    if (hasLatest) {
      const gap = atMs - latest.atMs;
      if (gap > 0 && gap <= MAX_SPAN_MS) spanMs += (gap - spanMs) * 0.25;
      interpolateGuests(hasCarried ? carried : null, latest, atMs, spare, carriedIndex);
      // Heights go along the same way.
      const k = spare.k;
      for (let i = 0; i < spare.count; i++) {
        const to = groundTo[i] as number;
        groundFromNext[i] =
          spare.from[i] === -1
            ? to
            : (groundFrom[i] as number) + (to - (groundFrom[i] as number)) * k;
      }
      spareIndex.clear();
      for (let i = 0; i < spare.count; i++) spareIndex.set(spare.id[i] as number, i);
      [carried, spare] = [spare, carried];
      [carriedIndex, spareIndex] = [spareIndex, carriedIndex];
      hasCarried = true;
    }
    const previousX = latest.x;
    const previousY = latest.y;
    const had = hasLatest;
    latestSection = section;
    latest.count = section.count;
    latest.id = section.id;
    latest.x = section.x;
    latest.y = section.y;
    latest.state = section.state;
    latest.atMs = atMs;
    hasLatest = true;
    // The carried places are where guests were one span ago, as far as the timing goes.
    carried.atMs = atMs - spanMs;

    // Carry each guest's heading, walk and height over to its slot in the new snapshot.
    interpolateGuests(hasCarried ? carried : null, latest, atMs, shown, carriedIndex);
    let looksChanged = false;
    for (let i = 0; i < shown.count; i++) {
      const id = section.id[i] as number;
      const x = section.x[i] as number;
      const y = section.y[i] as number;
      const colorIndex = section.color[i] as number;
      if (lookId[i] !== id || lookColor[i] !== colorIndex) {
        writeLook(i, id, colorIndex);
        looksChanged = true;
      }
      const to = groundAt(x, y);
      const j = shown.from[i] as number;
      if (j >= 0 && had) {
        // `j` is the guest's slot in the snapshot before: the carried places are in its order.
        const dx = x - (previousX[j] as number);
        const dy = y - (previousY[j] as number);
        const moved = dx * dx + dy * dy > STANDING_UNITS * STANDING_UNITS;
        headingNext[i] = heading[j] as number;
        walkNext[i] = walk[j] as number;
        headingTo[i] = moved ? Math.atan2(dx, dy) : (heading[j] as number);
        moving[i] = moved ? 1 : 0;
        scratchGround[i] = groundFromNext[j] as number;
      } else {
        // New here: it faces a way of its own until it moves.
        const facing = unit(id, 20) * Math.PI * 2;
        headingNext[i] = facing;
        headingTo[i] = facing;
        walkNext[i] = 0;
        moving[i] = 0;
        scratchGround[i] = to;
      }
      groundTo[i] = to;
      writeSlope(i, x, y, to);
    }
    slope.needsUpdate = true;
    [heading, headingNext] = [headingNext, heading];
    [walk, walkNext] = [walkNext, walk];
    groundFrom.set(scratchGround.subarray(0, shown.count));
    if (looksChanged) {
      shirt.needsUpdate = true;
      trousers.needsUpdate = true;
      skin.needsUpdate = true;
      hair.needsUpdate = true;
    }
  }

  function update(frame: FrameInfo): void {
    const stepMs = lastNowMs === null ? 0 : Math.min(100, Math.max(0, frame.nowMs - lastNowMs));
    lastNowMs = frame.nowMs;
    if (!hasLatest) {
      mesh.count = 0;
      shade.count = 0;
      return;
    }
    interpolateGuests(hasCarried ? carried : null, latest, frame.nowMs, shown, carriedIndex);
    const count = shown.count;
    mesh.count = count;
    shade.count = count;
    if (count === 0) return;

    const turn = 1 - Math.exp(-stepMs / TURN_MS);
    const settle = 1 - Math.exp(-stepMs / SETTLE_MS);
    const k = Math.min(1, shown.k);
    const distance = ctx.uniforms.uCamDistance.value;
    const grown = 1 + FAR_GROW * smoothstep((distance - GROW_NEAR) / (GROW_FAR - GROW_NEAR));
    const matrices = mesh.instanceMatrix.array;
    const anims = anim.array;
    const states = latestSection?.state;
    for (let i = 0; i < count; i++) {
      // A guest on a ride is part of the ride: it is not drawn (nor its shade) at the ride's
      // middle, where the sim keeps it, and cannot be picked. Queuing and buying guests are.
      if (states && states[i] === RIDING) {
        matrices.fill(0, i * 16, i * 16 + 16);
        pickSizes[i] = 0;
        continue;
      }
      const facing =
        (heading[i] as number) + angleDelta(heading[i] as number, headingTo[i] as number) * turn;
      heading[i] = facing;
      const pace = (walk[i] as number) + ((moving[i] as number) - (walk[i] as number)) * settle;
      walk[i] = pace;

      const x = (shown.x[i] as number) / UNITS_PER_TILE;
      const z = (shown.y[i] as number) / UNITS_PER_TILE;
      const from = groundFrom[i] as number;
      const y = from + ((groundTo[i] as number) - from) * k;
      const scale = size[i] as number;
      const sin = Math.sin(facing) * scale;
      const cos = Math.cos(facing) * scale;
      // A turn about Y by the heading, the guest's size, and its place: column by column.
      const o = i * 16;
      matrices[o] = cos;
      matrices[o + 1] = 0;
      matrices[o + 2] = -sin;
      matrices[o + 3] = 0;
      matrices[o + 4] = 0;
      matrices[o + 5] = scale;
      matrices[o + 6] = 0;
      matrices[o + 7] = 0;
      matrices[o + 8] = sin;
      matrices[o + 9] = 0;
      matrices[o + 10] = cos;
      matrices[o + 11] = 0;
      matrices[o + 12] = x;
      matrices[o + 13] = y;
      matrices[o + 14] = z;
      matrices[o + 15] = 1;
      anims[i * 4] = pace;

      places[i * 3] = x;
      places[i * 3 + 1] = y;
      places[i * 3 + 2] = z;
      pickSizes[i] = scale * grown;
    }
    matrixRange.count = count * 16;
    animRange.count = count * 4;
    if (mesh.instanceMatrix.updateRanges.length === 0) {
      mesh.instanceMatrix.updateRanges.push(matrixRange);
    }
    if (anim.updateRanges.length === 0) anim.updateRanges.push(animRange);
    mesh.instanceMatrix.needsUpdate = true;
    anim.needsUpdate = true;
  }

  return {
    setGuests,
    update,
    setTerrain(): void {
      // The ground under the guests may have moved.
      if (!hasLatest) return;
      for (let i = 0; i < shown.count; i++) {
        const x = latest.x[i] as number;
        const y = latest.y[i] as number;
        groundTo[i] = groundAt(x, y);
        groundFrom[i] = groundAt(shown.x[i] as number, shown.y[i] as number);
        writeSlope(i, x, y, groundTo[i] as number);
      }
      slope.needsUpdate = true;
    },
    setQuality(quality: Quality): void {
      // The figures cost the same at every quality. Where the sun casts no shadows the shade
      // under a guest is all that ties it to the ground, so it is darker there.
      shadeStrength.value = SHADE_STRENGTH[quality];
    },
    pickAt(ray: Ray, reach?: number): { id: number } | null {
      const hit = pickGuest(ray, places, pickSizes, mesh.count, reach);
      return hit < 0 ? null : { id: shown.id[hit] as number };
    },
    dispose(): void {
      ctx.scene.remove(mesh, shade);
      mesh.dispose();
      shade.dispose();
      geometry.dispose();
      shadeGeometry.dispose();
      material.dispose();
      depthMaterial.dispose();
      shadeMaterial.dispose();
    },
  };
}

/** 0 below 0, 1 above 1, and a smooth S in between: GLSL's `smoothstep(0.0, 1.0, x)`. */
function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
