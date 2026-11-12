import { noise3, randomStream, smoothstep } from "./noise.js";

/**
 * The models of everything that stands on the land beyond the park: three kinds of tree, bushes
 * and rocks, each built here out of plain numbers. Nothing is loaded and nothing is drawn by
 * hand: a canopy is a ball pushed out into lobes and roughened with noise, a spruce is a profile
 * turned around its trunk, a rock is a ball knocked out of shape.
 *
 * Every vertex carries four things: its place, a normal for smooth shading, a color with the
 * shading of the form already in it (hollows between lobes and the underside are darker, crowns
 * and tips lighter, so a canopy has depth under any light), and three numbers for the shader in
 * `aux`: how much the vertex sways in the wind (0 at the roots to 1 at the top), whether it is
 * foliage (1) or bark and stone (0), and a number of its own in 0..1 that puts its flutter out of
 * step with its neighbors'.
 *
 * Each model comes at four levels of detail, 0 the finest. Models stand with their foot at the
 * origin, reach a little below it so that they can be sunk into a slope, and are about as tall in
 * tiles as `SHAPE_HEIGHT` says.
 */

/** What can stand on the land. */
export const OAK = 0;
export const BIRCH = 1;
export const SPRUCE = 2;
export const BUSH = 3;
export const ROCK = 4;
export const KIND_COUNT = 5;
export type SceneryKind = 0 | 1 | 2 | 3 | 4;

/** Levels of detail: 0 is seen from a few tiles away, 3 only at the horizon. */
export type SceneryLod = 0 | 1 | 2 | 3;
export const LOD_COUNT = 4;

/** How many different models of each kind there are, by level of detail. */
export const VARIANTS: readonly (readonly number[])[] = [
  [3, 2, 1, 1], // oak
  [2, 2, 1, 1], // birch
  [2, 2, 1, 1], // spruce
  [2, 1, 1, 0], // bush
  [2, 1, 1, 0], // rock
];

/** About how tall each kind's model is, in tiles, before an instance scales it. */
export const SHAPE_HEIGHT: readonly number[] = [2.45, 3.05, 3.5, 0.5, 0.55];

/** One model, as flat arrays. */
export interface SceneryShape {
  /** Three floats per vertex. */
  positions: Float32Array;
  /** Unit normals, three floats per vertex. */
  normals: Float32Array;
  /** Linear albedo with the form's shading baked in, three floats per vertex. */
  colors: Float32Array;
  /** Sway weight, foliage flag and flutter phase, three floats per vertex. */
  aux: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
}

type Rgb = readonly [number, number, number];

/** The vertices and triangles of a model as they are being put together. */
class ShapeBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly aux: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(x: number, y: number, z: number, color: Rgb, sway: number, leaf: number, phase: number) {
    this.positions.push(x, y, z);
    this.normals.push(0, 0, 0);
    this.colors.push(color[0], color[1], color[2]);
    this.aux.push(sway, leaf, phase);
    return this.vertexCount - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /**
   * Gives the vertices from `firstVertex` on their normals: the mean of the faces around each,
   * weighted by area, taken over the triangles from index `firstIndex` on. A part that shares no
   * vertex with another is smoothed on its own this way.
   */
  smooth(firstVertex: number, firstIndex: number): void {
    const { positions: p, normals: n, indices } = this;
    for (let i = firstIndex; i < indices.length; i += 3) {
      const a = (indices[i] as number) * 3;
      const b = (indices[i + 1] as number) * 3;
      const c = (indices[i + 2] as number) * 3;
      const ux = (p[b] as number) - (p[a] as number);
      const uy = (p[b + 1] as number) - (p[a + 1] as number);
      const uz = (p[b + 2] as number) - (p[a + 2] as number);
      const vx = (p[c] as number) - (p[a] as number);
      const vy = (p[c + 1] as number) - (p[a + 1] as number);
      const vz = (p[c + 2] as number) - (p[a + 2] as number);
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      for (const v of [a, b, c]) {
        n[v] = (n[v] as number) + fx;
        n[v + 1] = (n[v + 1] as number) + fy;
        n[v + 2] = (n[v + 2] as number) + fz;
      }
    }
    for (let v = firstVertex * 3; v < n.length; v += 3) {
      const length = Math.hypot(n[v] as number, n[v + 1] as number, n[v + 2] as number);
      if (length > 0) {
        n[v] = (n[v] as number) / length;
        n[v + 1] = (n[v + 1] as number) / length;
        n[v + 2] = (n[v + 2] as number) / length;
      } else {
        n[v + 1] = 1;
      }
    }
  }

  finish(): SceneryShape {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors: new Float32Array(this.colors),
      aux: new Float32Array(this.aux),
      indices: new Uint32Array(this.indices),
    };
  }
}

/** A ball of triangles: unit directions, the triangles between them, and each one's neighbors. */
interface Sphere {
  directions: Float64Array;
  indices: Uint32Array;
  /** For vertex `v`, its neighbors are `neighbors[starts[v] .. starts[v + 1]]`. */
  neighbors: Uint32Array;
  starts: Uint32Array;
}

const spheres = new Map<number, Sphere>();

/**
 * A geodesic ball: an icosahedron with every face cut into `frequency` squared triangles and
 * pushed out onto the unit sphere. 20, 80, 180, 320... triangles, evenly spread, no poles.
 */
export function geodesicSphere(frequency: number): Sphere {
  const known = spheres.get(frequency);
  if (known) return known;

  const g = (1 + Math.sqrt(5)) / 2;
  const base: [number, number, number][] = [
    [-1, g, 0],
    [1, g, 0],
    [-1, -g, 0],
    [1, -g, 0],
    [0, -1, g],
    [0, 1, g],
    [0, -1, -g],
    [0, 1, -g],
    [g, 0, -1],
    [g, 0, 1],
    [-g, 0, -1],
    [-g, 0, 1],
  ];
  const faces: [number, number, number][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];

  const directions: number[] = [];
  const indexOf = new Map<string, number>();
  const point = (x: number, y: number, z: number): number => {
    const inv = 1 / Math.hypot(x, y, z);
    const key = `${Math.round(x * inv * 1e5)},${Math.round(y * inv * 1e5)},${Math.round(z * inv * 1e5)}`;
    const known = indexOf.get(key);
    if (known !== undefined) return known;
    const made = directions.length / 3;
    directions.push(x * inv, y * inv, z * inv);
    indexOf.set(key, made);
    return made;
  };

  const indices: number[] = [];
  const n = frequency;
  for (const [ia, ib, ic] of faces) {
    const a = base[ia] as [number, number, number];
    const b = base[ib] as [number, number, number];
    const c = base[ic] as [number, number, number];
    // Rows of points across the face, from `a` toward the edge `b`-`c`.
    const rows: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const row: number[] = [];
      for (let j = 0; j <= i; j++) {
        const wa = (n - i) / n;
        const wb = (i - j) / n;
        const wc = j / n;
        row.push(
          point(
            a[0] * wa + b[0] * wb + c[0] * wc,
            a[1] * wa + b[1] * wb + c[1] * wc,
            a[2] * wa + b[2] * wb + c[2] * wc,
          ),
        );
      }
      rows.push(row);
    }
    for (let i = 0; i < n; i++) {
      const upper = rows[i] as number[];
      const lower = rows[i + 1] as number[];
      for (let j = 0; j <= i; j++) {
        indices.push(upper[j] as number, lower[j] as number, lower[j + 1] as number);
        if (j < i) indices.push(upper[j] as number, lower[j + 1] as number, upper[j + 1] as number);
      }
    }
  }

  const count = directions.length / 3;
  const sets: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] as number;
    const b = indices[i + 1] as number;
    const c = indices[i + 2] as number;
    sets[a]?.add(b).add(c);
    sets[b]?.add(a).add(c);
    sets[c]?.add(a).add(b);
  }
  const starts = new Uint32Array(count + 1);
  const neighbors: number[] = [];
  for (let v = 0; v < count; v++) {
    starts[v] = neighbors.length;
    for (const other of sets[v] as Set<number>) neighbors.push(other);
  }
  starts[count] = neighbors.length;

  const made: Sphere = {
    directions: new Float64Array(directions),
    indices: new Uint32Array(indices),
    neighbors: new Uint32Array(neighbors),
    starts,
  };
  spheres.set(frequency, made);
  return made;
}

/** The larger of two numbers, with the corner where they cross rounded off over a width of `k`. */
function smoothMax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const mixRgb = (a: Rgb, b: Rgb, k: number): Rgb => [
  mix(a[0], b[0], k),
  mix(a[1], b[1], k),
  mix(a[2], b[2], k),
];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The three colors foliage is shaded between: in the hollows, in the open, and on the crowns. */
interface Foliage {
  dark: Rgb;
  base: Rgb;
  light: Rgb;
}

/** One ball of a canopy, placed relative to the canopy's middle. */
interface Lobe {
  x: number;
  y: number;
  z: number;
  r: number;
}

interface CanopySpec {
  /** The middle of the canopy. */
  center: readonly [number, number, number];
  /** The balls it is the union of. Each must reach around the middle or well into another. */
  lobes: readonly Lobe[];
  /** Scales the finished form about its middle, to make it broad or tall. */
  stretch: readonly [number, number, number];
  /** The geodesic frequency of its mesh. */
  detail: number;
  /** How wide the rounding of the creases between lobes is. */
  fillet: number;
  /** How far noise pushes the surface in and out, as a share of its radius; and how fine. */
  bumps: number;
  bumpScale: number;
  /** What the underside is squashed by: 1 leaves it round, 0.4 makes it nearly flat. */
  under: number;
  seed: number;
  foliage: Foliage;
  /** The height of the whole plant, which the sway weight is measured against. */
  height: number;
  /** How strongly the hollows are shaded: 1 for a hero model, less for far ones. */
  depth: number;
  /** Draws the underside down to the ground: for far models, which have no trunk to stand on. */
  grounded?: boolean;
  /**
   * Sprays of leaves standing out of the surface: how many, how big across in tiles, and whether
   * each is a twenty-sided ball (fine) or an eight-sided one. They give the crown a broken,
   * leafy outline, which no smooth form has.
   */
  tufts?: { count: number; size: number; fine: boolean };
}

/** An eight-sided ball, for the cheaper sprays. */
const OCTAHEDRON = {
  directions: [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1],
  indices: [0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0, 4, 3, 0, 1, 3, 4, 5, 3, 1, 0, 3, 5],
} as const;

/**
 * Adds a canopy: one closed surface around `center`, the outline of a handful of overlapping
 * balls as seen from the middle, with the creases between them rounded, the whole roughened by
 * noise and squashed from below.
 *
 * Its colors carry its shading. Where the surface lies inside the smoothed-out form (a hollow
 * between two lobes) it is dark, where it stands out of it (the crown of a lobe) it is light, and
 * the underside is darker than the top.
 */
function addCanopy(builder: ShapeBuilder, spec: CanopySpec): void {
  const sphere = geodesicSphere(spec.detail);
  const count = sphere.directions.length / 3;
  const radius = new Float64Array(count);
  let meanRadius = 0;

  for (let v = 0; v < count; v++) {
    const ux = sphere.directions[v * 3] as number;
    const uy = sphere.directions[v * 3 + 1] as number;
    const uz = sphere.directions[v * 3 + 2] as number;
    let r = 0;
    for (const lobe of spec.lobes) {
      // Where the ray from the middle leaves this ball.
      const along = ux * lobe.x + uy * lobe.y + uz * lobe.z;
      const inside =
        along * along - (lobe.x * lobe.x + lobe.y * lobe.y + lobe.z * lobe.z) + lobe.r * lobe.r;
      if (inside <= 0) continue;
      const exit = along + Math.sqrt(inside);
      if (exit <= 0) continue;
      r = r === 0 ? exit : smoothMax(r, exit, spec.fillet);
    }
    if (r === 0) r = spec.fillet;
    const s = spec.bumpScale;
    const rough =
      noise3(ux * s + spec.seed, uy * s, uz * s, spec.seed) +
      0.45 * noise3(ux * s * 2.3, uy * s * 2.3 + spec.seed, uz * s * 2.3, spec.seed + 5);
    r *= 1 + spec.bumps * rough;
    radius[v] = r;
    meanRadius += r;
  }
  meanRadius /= count;

  // The form with its lobes smoothed away, to tell hollows from crowns by.
  let smooth = radius;
  const passes = Math.round((spec.detail * spec.detail) / 4);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float64Array(count);
    for (let v = 0; v < count; v++) {
      let sum = smooth[v] as number;
      const from = sphere.starts[v] as number;
      const to = sphere.starts[v + 1] as number;
      for (let k = from; k < to; k++) sum += smooth[sphere.neighbors[k] as number] as number;
      next[v] = sum / (to - from + 1);
    }
    smooth = next;
  }

  const [cx, cy, cz] = spec.center;
  const [sx, sy, sz] = spec.stretch;
  let low = Infinity;
  let high = -Infinity;
  const ys = new Float64Array(count);
  for (let v = 0; v < count; v++) {
    const uy = sphere.directions[v * 3 + 1] as number;
    const y = cy + uy * (radius[v] as number) * sy * (uy < 0 ? spec.under : 1);
    ys[v] = y;
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  if (spec.grounded && high > low) {
    // Keep the top where it is and stretch the rest down until the lowest point is in the grass.
    const stretch = (high + 0.06) / (high - low);
    for (let v = 0; v < count; v++) ys[v] = high - (high - (ys[v] as number)) * stretch;
    low = -0.06;
  }

  const firstVertex = builder.vertexCount;
  const firstIndex = builder.indices.length;
  const { dark, base, light } = spec.foliage;
  for (let v = 0; v < count; v++) {
    const ux = sphere.directions[v * 3] as number;
    const uy = sphere.directions[v * 3 + 1] as number;
    const uz = sphere.directions[v * 3 + 2] as number;
    const r = radius[v] as number;
    const x = cx + ux * r * sx;
    const y = ys[v] as number;
    const z = cz + uz * r * sz;

    // Positive in a hollow, negative on a crown.
    const hollow = (((smooth[v] as number) - r) / meanRadius) * spec.depth;
    const open = Math.min(1.4, Math.max(0.2, 1 - 5.2 * hollow));
    const up = high > low ? (y - low) / (high - low) : 1;
    // The sky lights the top; the underside sees only the ground.
    const sky = 0.36 + 0.64 * smoothstep(0.02, 0.6, up) + 0.12 * smoothstep(0.7, 1, up);
    const fleck = 1 + 0.22 * noise3(ux * 4.3, uy * 4.3, uz * 4.3 + spec.seed, spec.seed + 9);
    const tone = open * sky * fleck;
    const color =
      tone <= 0.78
        ? mixRgb(dark, base, clamp01(tone / 0.78))
        : mixRgb(base, light, clamp01((tone - 0.78) / 0.5));

    const sway = clamp01(y / spec.height);
    const phase = 0.5 + 0.5 * noise3(ux * 2.1 + 3, uy * 2.1, uz * 2.1, spec.seed + 17);
    builder.vertex(x, y, z, color, sway, 1, clamp01(phase));
  }
  for (let i = 0; i < sphere.indices.length; i += 3) {
    builder.triangle(
      firstVertex + (sphere.indices[i] as number),
      firstVertex + (sphere.indices[i + 1] as number),
      firstVertex + (sphere.indices[i + 2] as number),
    );
  }
  builder.smooth(firstVertex, firstIndex);

  // Lean each normal a little toward the direction out of the canopy's heart, so that light
  // falls on the whole crown as on one mass while every lobe still catches it for itself.
  const heartY = cy - (cy - low) * 0.35;
  const n = builder.normals;
  const p = builder.positions;
  for (let v = firstVertex * 3; v < n.length; v += 3) {
    let ox = (p[v] as number) - cx;
    let oy = (p[v + 1] as number) - heartY;
    let oz = (p[v + 2] as number) - cz;
    const inv = 1 / (Math.hypot(ox, oy, oz) || 1);
    ox *= inv;
    oy *= inv;
    oz *= inv;
    const nx = mix(n[v] as number, ox, 0.26);
    const ny = mix(n[v + 1] as number, oy, 0.26);
    const nz = mix(n[v + 2] as number, oz, 0.26);
    const length = Math.hypot(nx, ny, nz) || 1;
    n[v] = nx / length;
    n[v + 1] = ny / length;
    n[v + 2] = nz / length;
  }

  if (spec.tufts) addTufts(builder, spec, firstVertex, count, low, high);
}

/**
 * Stands sprays of leaves on the canopy whose `count` vertices start at `firstVertex`: small
 * balls half sunk into the surface at places picked from its vertices, each shaded as the canopy
 * is there, lighter on its outward side and darker where it meets the crown.
 */
function addTufts(
  builder: ShapeBuilder,
  spec: CanopySpec,
  firstVertex: number,
  count: number,
  low: number,
  high: number,
): void {
  const tufts = spec.tufts;
  if (!tufts) return;
  const random = randomStream(spec.seed * 131 + 7);
  const ball = tufts.fine ? geodesicSphere(1) : OCTAHEDRON;
  const corners = ball.directions.length / 3;
  for (let k = 0; k < tufts.count; k++) {
    // Somewhere on the canopy, but seldom on its underside, which nobody sees.
    let v = firstVertex + Math.floor(random() * count);
    for (let again = 0; again < 3; again++) {
      const up = ((builder.positions[v * 3 + 1] as number) - low) / (high - low || 1);
      if (up > 0.16) break;
      v = firstVertex + Math.floor(random() * count);
    }
    const px = builder.positions[v * 3] as number;
    const py = builder.positions[v * 3 + 1] as number;
    const pz = builder.positions[v * 3 + 2] as number;
    const nx = builder.normals[v * 3] as number;
    const ny = builder.normals[v * 3 + 1] as number;
    const nz = builder.normals[v * 3 + 2] as number;
    const size = tufts.size * (0.62 + 0.76 * random());
    const shade = 0.88 + 0.3 * random();
    const sway = builder.aux[v * 3] as number;
    const phase = random();
    // Any way up: the balls have corners, and they should not all point the same way.
    const spin = random() * Math.PI * 2;
    const tilt = random() * Math.PI;
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);

    const first = builder.vertexCount;
    for (let c = 0; c < corners; c++) {
      const bx = ball.directions[c * 3] as number;
      const by = ball.directions[c * 3 + 1] as number;
      const bz = ball.directions[c * 3 + 2] as number;
      // Turned about the vertical, then tipped over.
      const rx = bx * cs - bz * sn;
      const rz = bx * sn + bz * cs;
      const dx = rx;
      const dy = by * ct - rz * st;
      const dz = by * st + rz * ct;
      const facing = dx * nx + dy * ny + dz * nz;
      const reach = size * (0.82 + 0.36 * random());
      const tone = shade * (0.8 + 0.34 * facing);
      const index = builder.vertex(
        px - nx * size * 0.3 + dx * reach,
        py - ny * size * 0.3 + dy * reach,
        pz - nz * size * 0.3 + dz * reach,
        [
          (builder.colors[v * 3] as number) * tone,
          (builder.colors[v * 3 + 1] as number) * tone,
          (builder.colors[v * 3 + 2] as number) * tone * 0.94,
        ],
        sway,
        1,
        phase,
      );
      // Mostly the crown's own normal, so the sprays model its surface without speckling it.
      const mx = dx * 0.5 + nx * 0.62;
      const my = dy * 0.5 + ny * 0.62;
      const mz = dz * 0.5 + nz * 0.62;
      const length = Math.hypot(mx, my, mz) || 1;
      builder.normals[index * 3] = mx / length;
      builder.normals[index * 3 + 1] = my / length;
      builder.normals[index * 3 + 2] = mz / length;
    }
    for (let i = 0; i < ball.indices.length; i += 3) {
      builder.triangle(
        first + (ball.indices[i] as number),
        first + (ball.indices[i + 1] as number),
        first + (ball.indices[i + 2] as number),
      );
    }
  }
}

interface TrunkSpec {
  /** Radius at the ground and at the top. */
  bottom: number;
  top: number;
  /** Where it ends, inside the canopy. */
  height: number;
  /** How far the top is off the vertical. */
  lean: readonly [number, number];
  sides: number;
  rings: number;
  /** Bark in the light, and in the shade under the canopy. */
  bark: Rgb;
  shade: Rgb;
  /** The height at which the canopy's shade begins. */
  shadeFrom: number;
  /** The height of the whole plant, for the sway weight. */
  plant: number;
  seed: number;
  /** Dark bands across the bark, as a birch has: 0 for none. */
  bands: number;
}

/** How far below its foot a model reaches, to stay in the ground on a slope. */
const ROOT_DEPTH = 0.22;

/** Adds a trunk: a tapering tube from under the ground into the canopy, flared at the foot. */
function addTrunk(builder: ShapeBuilder, spec: TrunkSpec): void {
  const firstVertex = builder.vertexCount;
  const firstIndex = builder.indices.length;
  const { sides, rings } = spec;
  for (let ring = 0; ring <= rings; ring++) {
    // The first ring is under the ground; the rest are spread closer together near the foot.
    const k = ring / rings;
    const y = ring === 0 ? -ROOT_DEPTH : spec.height * k * k * (0.4 + 0.6 * k);
    const up = Math.max(0, y) / spec.height;
    const flare = 1 + 0.75 * Math.exp(-Math.max(0, y) / 0.16);
    const r = mix(spec.bottom, spec.top, up) * flare;
    // A slight S-bend on the way to the lean.
    const bend = up * up * (3 - 2 * up);
    const ax = spec.lean[0] * bend;
    const az = spec.lean[1] * bend;
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      const knot =
        1 + 0.12 * noise3(Math.cos(angle) * 1.7, y * 2.2, Math.sin(angle) * 1.7, spec.seed);
      const x = ax + Math.cos(angle) * r * knot;
      const z = az + Math.sin(angle) * r * knot;
      let color = mixRgb(
        spec.bark,
        spec.shade,
        smoothstep(spec.shadeFrom - 0.45, spec.shadeFrom + 0.1, y),
      );
      // The foot stands in its own shade and the grass's.
      color = mixRgb(color, spec.shade, 0.55 * (1 - smoothstep(0, 0.22, y)));
      if (spec.bands > 0) {
        const band = noise3(angle * 0.6, y * 7.5, 0.3, spec.seed + 3);
        color = mixRgb(color, [0.05, 0.045, 0.04], spec.bands * smoothstep(0.18, 0.4, band));
      }
      const sway = clamp01(y / spec.plant);
      builder.vertex(x, y, z, color, sway, 0, 0.5);
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let side = 0; side < sides; side++) {
      const a = firstVertex + ring * sides + side;
      const b = firstVertex + ring * sides + ((side + 1) % sides);
      const c = a + sides;
      const d = b + sides;
      builder.triangle(a, c, b);
      builder.triangle(b, c, d);
    }
  }
  builder.smooth(firstVertex, firstIndex);
}

interface LimbSpec {
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  /** Radius where it leaves the trunk and where it ends, inside the canopy. */
  thick: number;
  thin: number;
  sides: number;
  bark: Rgb;
  shade: Rgb;
  /** The height of the whole plant, for the sway weight. */
  plant: number;
}

/** Adds a limb: a tapering tube from the trunk up into a lobe of the canopy, bowed a little. */
function addLimb(builder: ShapeBuilder, spec: LimbSpec): void {
  const firstVertex = builder.vertexCount;
  const firstIndex = builder.indices.length;
  const [fx, fy, fz] = spec.from;
  const dx = spec.to[0] - fx;
  const dy = spec.to[1] - fy;
  const dz = spec.to[2] - fz;
  const length = Math.hypot(dx, dy, dz) || 1;
  // Two directions across the limb: level, and the one square to both.
  const flat = Math.hypot(dx, dz) || 1;
  const ax = -dz / flat;
  const az = dx / flat;
  const bx = (dy * az) / length;
  const by = (dz * ax - dx * az) / length;
  const bz = (-dy * ax) / length;
  const rings = 3;
  for (let ring = 0; ring <= rings; ring++) {
    const k = ring / rings;
    const r = mix(spec.thick, spec.thin, k);
    // Limbs set out level and turn upward.
    const bow = -0.1 * length * Math.sin(k * Math.PI);
    const cx = fx + dx * k;
    const cy = fy + dy * k + bow;
    const cz = fz + dz * k;
    const color = mixRgb(spec.bark, spec.shade, 0.35 + 0.65 * k);
    for (let side = 0; side < spec.sides; side++) {
      const angle = (side / spec.sides) * Math.PI * 2;
      const c = Math.cos(angle) * r;
      const s = Math.sin(angle) * r;
      const y = cy + by * s;
      builder.vertex(
        cx + ax * c + bx * s,
        y,
        cz + az * c + bz * s,
        color,
        clamp01(y / spec.plant),
        0,
        0.5,
      );
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let side = 0; side < spec.sides; side++) {
      const a = firstVertex + ring * spec.sides + side;
      const b = firstVertex + ring * spec.sides + ((side + 1) % spec.sides);
      const c = a + spec.sides;
      const d = b + spec.sides;
      builder.triangle(a, b, c);
      builder.triangle(b, d, c);
    }
  }
  builder.smooth(firstVertex, firstIndex);
  // Whichever way round the tube came out, its normals point away from its middle line.
  const n = builder.normals;
  const p = builder.positions;
  for (let v = firstVertex; v < builder.vertexCount; v++) {
    const k = Math.floor((v - firstVertex) / spec.sides) / rings;
    const ox = (p[v * 3] as number) - (fx + dx * k);
    const oz = (p[v * 3 + 2] as number) - (fz + dz * k);
    if (ox * (n[v * 3] as number) + oz * (n[v * 3 + 2] as number) < 0) {
      n[v * 3] = -(n[v * 3] as number);
      n[v * 3 + 1] = -(n[v * 3 + 1] as number);
      n[v * 3 + 2] = -(n[v * 3 + 2] as number);
    }
  }
}

/** The mesh frequency of a canopy at each level of detail: main form, and a side clump. */
const CANOPY_DETAIL: readonly (readonly [number, number])[] = [
  [7, 4],
  [5, 2],
  [3, 0],
  [1, 0],
];
const TRUNK_SIDES: readonly number[] = [8, 5, 4, 0];
const TRUNK_RINGS: readonly number[] = [6, 3, 1, 0];

const OAK_FOLIAGE: Foliage = {
  dark: [0.01, 0.03, 0.012],
  base: [0.046, 0.112, 0.024],
  light: [0.125, 0.21, 0.04],
};
const BIRCH_FOLIAGE: Foliage = {
  dark: [0.018, 0.046, 0.016],
  base: [0.068, 0.142, 0.034],
  light: [0.15, 0.235, 0.056],
};
const SPRUCE_FOLIAGE: Foliage = {
  dark: [0.01, 0.03, 0.02],
  base: [0.034, 0.088, 0.048],
  light: [0.08, 0.158, 0.078],
};
const BUSH_FOLIAGE: Foliage = {
  dark: [0.014, 0.036, 0.012],
  base: [0.052, 0.112, 0.026],
  light: [0.115, 0.19, 0.042],
};
const OAK_BARK: Rgb = [0.2, 0.15, 0.105];
const OAK_BARK_SHADE: Rgb = [0.075, 0.056, 0.042];

/**
 * A broad tree: a stout trunk that forks into limbs under a wide crown of many lobes, some
 * hanging low, a few standing above the rest.
 */
function buildOak(variant: number, lod: SceneryLod): SceneryShape {
  const builder = new ShapeBuilder();
  const random = randomStream(4101 + variant * 733);
  const [mainDetail, sideDetail] = CANOPY_DETAIL[lod] as readonly [number, number];
  const height = SHAPE_HEIGHT[OAK] as number;
  const centerY = 1.36 + 0.1 * random();
  const lean: [number, number] = [(random() - 0.5) * 0.34, (random() - 0.5) * 0.34];

  const lobes: Lobe[] = [{ x: 0, y: 0, z: 0, r: 0.6 }];
  // A ring of boughs around the middle, each its own size and height.
  const around = 6 + Math.floor(random() * 2);
  const turn = random() * Math.PI * 2;
  for (let i = 0; i < around; i++) {
    const angle = turn + ((i + (random() - 0.5) * 0.6) / around) * Math.PI * 2;
    const r = 0.36 + 0.17 * random();
    const reach = 0.46 + 0.17 * random();
    lobes.push({
      x: Math.cos(angle) * reach,
      y: -0.2 + 0.34 * random(),
      z: Math.sin(angle) * reach,
      r,
    });
  }
  // A smaller ring above them, turned so its lobes stand over the gaps.
  const above = 3 + Math.floor(random() * 2);
  for (let i = 0; i < above; i++) {
    const angle = turn + 0.5 + ((i + (random() - 0.5) * 0.5) / above) * Math.PI * 2;
    const r = 0.33 + 0.1 * random();
    const reach = 0.26 + 0.14 * random();
    lobes.push({
      x: Math.cos(angle) * reach,
      y: 0.3 + 0.16 * random(),
      z: Math.sin(angle) * reach,
      r,
    });
  }
  // And the top, off to one side, so the crown is not a dome.
  const crown = random() * Math.PI * 2;
  lobes.push({ x: Math.cos(crown) * 0.14, y: 0.56, z: Math.sin(crown) * 0.14, r: 0.4 });

  if (TRUNK_SIDES[lod]) {
    addTrunk(builder, {
      bottom: 0.125,
      top: 0.07,
      height: centerY + 0.05,
      lean,
      sides: TRUNK_SIDES[lod] as number,
      rings: TRUNK_RINGS[lod] as number,
      bark: OAK_BARK,
      shade: OAK_BARK_SHADE,
      shadeFrom: centerY - 0.3,
      plant: height,
      seed: 31 + variant,
      bands: 0,
    });
  }
  if (lod === 0) {
    // Limbs from the fork out into three of the lower boughs.
    const forkY = centerY * 0.62;
    for (let i = 0; i < 3; i++) {
      const lobe = lobes[1 + ((i * 2 + variant) % around)] as Lobe;
      addLimb(builder, {
        from: [lean[0] * 0.3, forkY + 0.06 * i, lean[1] * 0.3],
        to: [lean[0] + lobe.x * 0.86, centerY + lobe.y * 0.8, lean[1] + lobe.z * 0.86],
        thick: 0.058,
        thin: 0.026,
        sides: 5,
        bark: OAK_BARK,
        shade: OAK_BARK_SHADE,
        plant: height,
      });
    }
  }
  addCanopy(builder, {
    center: [lean[0], centerY, lean[1]],
    lobes,
    stretch: [1.02, 0.94, 1.02],
    detail: mainDetail,
    fillet: lod <= 1 ? 0.07 : lod === 2 ? 0.1 : 0.14,
    bumps: lod === 0 ? 0.075 : lod === 1 ? 0.05 : 0.02,
    bumpScale: 3.4,
    // Far models have no trunk, so their canopy comes further down.
    under: lod === 3 ? 1.2 : 0.8,
    seed: 11 + variant * 7,
    foliage: OAK_FOLIAGE,
    height,
    depth: lod <= 1 ? 1 : 0.6,
    grounded: lod === 3,
    ...(lod === 0 ? { tufts: { count: 96, size: 0.15, fine: false } } : {}),
  });
  if (sideDetail > 0) {
    // A low bough off to one side breaks the symmetry.
    const angle = random() * Math.PI * 2;
    const out = 0.8 + 0.12 * random();
    addCanopy(builder, {
      center: [lean[0] + Math.cos(angle) * out, centerY - 0.4, lean[1] + Math.sin(angle) * out],
      lobes: [
        { x: 0, y: 0, z: 0, r: 0.33 },
        { x: Math.cos(angle) * 0.2, y: 0.06, z: Math.sin(angle) * 0.2, r: 0.28 },
        { x: -Math.sin(angle) * 0.22, y: -0.05, z: Math.cos(angle) * 0.22, r: 0.27 },
        { x: Math.sin(angle) * 0.2, y: 0.1, z: -Math.cos(angle) * 0.2, r: 0.26 },
      ],
      stretch: [1.05, 0.85, 1.05],
      detail: sideDetail,
      fillet: 0.06,
      bumps: 0.08,
      bumpScale: 2.6,
      under: 0.75,
      seed: 53 + variant * 3,
      foliage: {
        dark: OAK_FOLIAGE.dark,
        base: mixRgb(OAK_FOLIAGE.dark, OAK_FOLIAGE.base, 0.85),
        light: mixRgb(OAK_FOLIAGE.base, OAK_FOLIAGE.light, 0.8),
      },
      height,
      depth: 1,
      ...(lod === 0 ? { tufts: { count: 16, size: 0.12, fine: false } } : {}),
    });
  }
  return builder.finish();
}

/**
 * A slender tree: a thin pale trunk carrying three loose tufts of lighter green, one above and
 * to the side of the next, with the trunk showing between them.
 */
function buildBirch(variant: number, lod: SceneryLod): SceneryShape {
  const builder = new ShapeBuilder();
  const random = randomStream(9203 + variant * 389);
  const height = SHAPE_HEIGHT[BIRCH] as number;
  const lean: [number, number] = [(random() - 0.5) * 0.44, (random() - 0.5) * 0.44];
  const top = height - 0.42;

  if (TRUNK_SIDES[lod]) {
    addTrunk(builder, {
      bottom: 0.07,
      top: 0.03,
      height: top,
      lean,
      sides: Math.max(4, (TRUNK_SIDES[lod] as number) - 2),
      rings: TRUNK_RINGS[lod] as number,
      bark: [0.46, 0.45, 0.41],
      shade: [0.24, 0.24, 0.21],
      shadeFrom: top,
      plant: height,
      seed: 71 + variant,
      bands: lod <= 1 ? 0.85 : 0,
    });
  }

  /** The middle of the trunk at height `y`, as `addTrunk` bends it. */
  const trunkAt = (y: number): [number, number] => {
    const up = Math.min(1, Math.max(0, y / top));
    const bend = up * up * (3 - 2 * up);
    return [lean[0] * bend, lean[1] * bend];
  };

  // Tufts from the lowest up: how high, how big, how far off the trunk.
  const tufts: readonly (readonly [number, number, number])[] =
    lod <= 1
      ? [
          [1.42, 0.5, 0.22],
          [2.02, 0.46, 0.17],
          [2.58, 0.34, 0.05],
        ]
      : lod === 2
        ? [
            [1.42, 0.5, 0.2],
            [2.02, 0.46, 0.15],
            [2.58, 0.34, 0.05],
          ]
        : [[2.0, 0.62, 0]];
  const detail: readonly number[] =
    lod === 0 ? [5, 4, 4] : lod === 1 ? [4, 3, 2] : lod === 2 ? [2, 2, 1] : [1];
  const turn = random() * Math.PI * 2;
  tufts.forEach(([y, r, off], index) => {
    const angle = turn + index * 2.3;
    const [tx, tz] = trunkAt(y);
    const lobes: Lobe[] = [{ x: 0, y: 0, z: 0, r: r * 0.8 }];
    const count = 4;
    for (let i = 0; i < count; i++) {
      const around = angle + ((i + 0.6 * random()) / count) * Math.PI * 2;
      const size = r * (0.6 + 0.22 * random());
      const reach = r * (0.42 + 0.14 * random());
      lobes.push({
        x: Math.cos(around) * reach,
        y: r * (-0.3 + 0.6 * random()),
        z: Math.sin(around) * reach,
        r: size,
      });
    }
    addCanopy(builder, {
      center: [tx + Math.cos(angle) * off, y, tz + Math.sin(angle) * off],
      lobes,
      stretch: lod <= 2 ? [1, 1.12, 1] : [0.9, 1.7, 0.9],
      detail: detail[index] as number,
      fillet: lod <= 1 ? 0.05 : 0.12,
      bumps: lod === 0 ? 0.09 : lod === 1 ? 0.06 : 0.02,
      bumpScale: 3.2,
      under: 0.92,
      seed: 23 + variant * 5 + index * 31,
      foliage: {
        // The lower tufts stand in the shade of the upper.
        dark: BIRCH_FOLIAGE.dark,
        base: mixRgb(BIRCH_FOLIAGE.dark, BIRCH_FOLIAGE.base, 0.8 + 0.1 * index),
        light: mixRgb(BIRCH_FOLIAGE.base, BIRCH_FOLIAGE.light, 0.7 + 0.15 * index),
      },
      height,
      depth: lod <= 1 ? 1 : 0.6,
      grounded: lod === 3,
      ...(lod === 0 ? { tufts: { count: Math.round(72 * r), size: 0.11, fine: false } } : {}),
    });
  });
  return builder.finish();
}

/** The rings of points around a spruce, by level of detail, and how many tiers of boughs. */
const SPRUCE_SIDES: readonly number[] = [14, 8, 6, 5];
const SPRUCE_TIERS: readonly number[] = [6, 4, 2, 1];

/**
 * A spruce: tiers of drooping boughs around a straight trunk, each tier a skirt that is widest at
 * its hem and tucks in under the tier above. The hems wave in and out around the tree, differently
 * on every tier, so no tier is a plain cone.
 */
function buildSpruce(variant: number, lod: SceneryLod): SceneryShape {
  const builder = new ShapeBuilder();
  const random = randomStream(6607 + variant * 151);
  const height = SHAPE_HEIGHT[SPRUCE] as number;
  const sides = SPRUCE_SIDES[lod] as number;
  const tiers = SPRUCE_TIERS[lod] as number;
  const foot = lod === 3 ? 0.05 : 0.42;
  const widest = 0.84 + 0.1 * random();
  const { dark, base, light } = SPRUCE_FOLIAGE;

  if (TRUNK_SIDES[lod]) {
    addTrunk(builder, {
      bottom: 0.1,
      top: 0.06,
      height: foot + 0.5,
      lean: [0, 0],
      sides: Math.max(4, (TRUNK_SIDES[lod] as number) - 2),
      rings: 2,
      bark: [0.17, 0.11, 0.075],
      shade: [0.06, 0.042, 0.032],
      shadeFrom: foot,
      plant: height,
      seed: 91 + variant,
      bands: 0,
    });
  }

  const firstVertex = builder.vertexCount;
  const firstIndex = builder.indices.length;
  /** The outline of the whole tree at height `y`: wide below, drawn in to the tip. */
  const outline = (y: number) => {
    const k = clamp01((y - foot) / (height - foot));
    return widest * Math.pow(1 - k, 0.88) + 0.02;
  };

  let rings = 0;
  const ring = (y: number, r: number, tier: number, wave: number, tone: number, droop: number) => {
    const lobesHere = 5 + ((tier * 2 + variant) % 3);
    const phase = tier * 1.9 + variant * 0.7;
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      const lump =
        Math.sin(angle * lobesHere + phase) * 0.6 +
        noise3(Math.cos(angle) * 2.2, tier * 1.3, Math.sin(angle) * 2.2, 77 + variant) * 0.9;
      const rr = Math.max(0.012, r * (1 + wave * lump));
      const yy = y - droop * (0.5 + 0.5 * lump) * r;
      const shade = clamp01(tone * (1 + 0.22 * wave * lump * 4));
      const color =
        shade <= 0.6 ? mixRgb(dark, base, shade / 0.6) : mixRgb(base, light, (shade - 0.6) / 0.4);
      const sway = clamp01(yy / height);
      const flutter = 0.5 + 0.5 * Math.sin(angle * 3 + tier * 2.1);
      builder.vertex(Math.cos(angle) * rr, yy, Math.sin(angle) * rr, color, sway, 1, flutter);
    }
    rings++;
  };

  // From the lowest boughs up. Each tier: a tucked-in start under the tier, its hem, a point on
  // its back, and its top, which the next tier's start hides under its own hem.
  const span = (height - 0.16 - foot) / tiers;
  ring(foot + 0.02, 0.06, 0, 0, 0.1, 0);
  for (let tier = 0; tier < tiers; tier++) {
    const y0 = foot + tier * span;
    const y1 = y0 + span;
    const hem = outline(y0) * (0.86 + 0.26 * random());
    const neck = outline(y1) * 0.5;
    const wave = lod >= 2 ? 0.05 : 0.17;
    const lift = tier === 0 ? 0.1 : 0.04;
    // The lighter the higher: the top tiers stand in the open, the lower ones under them.
    const open = 0.78 + 0.22 * (tier / Math.max(1, tiers - 1));
    ring(y0 + lift, hem, tier, wave, 0.92 * open, 0.3);
    if (lod <= 1)
      ring(mix(y0, y1, 0.42), mix(hem, neck, 0.56), tier, wave * 0.6, 0.62 * open, 0.12);
    if (tier < tiers - 1) ring(y1 + 0.05, neck, tier, wave * 0.3, 0.3 * open, 0);
  }
  ring(height - 0.14, 0.05, tiers, 0, 0.95, 0);
  const tip = builder.vertex(0, height, 0, light, 1, 1, 0.5);

  for (let r = 0; r + 1 < rings; r++) {
    for (let side = 0; side < sides; side++) {
      const a = firstVertex + r * sides + side;
      const b = firstVertex + r * sides + ((side + 1) % sides);
      const c = a + sides;
      const d = b + sides;
      builder.triangle(a, c, b);
      builder.triangle(b, c, d);
    }
  }
  const last = firstVertex + (rings - 1) * sides;
  for (let side = 0; side < sides; side++) {
    builder.triangle(last + side, tip, last + ((side + 1) % sides));
  }
  builder.smooth(firstVertex, firstIndex);
  return builder.finish();
}

/** A low, wide shrub: a canopy sitting on the ground. */
function buildBush(variant: number, lod: SceneryLod): SceneryShape {
  const builder = new ShapeBuilder();
  const random = randomStream(2903 + variant * 97);
  const lobes: Lobe[] = [{ x: 0, y: 0, z: 0, r: 0.3 }];
  const around = 4 + variant;
  const turn = random() * Math.PI * 2;
  for (let i = 0; i < around; i++) {
    const angle = turn + ((i + (random() - 0.5) * 0.6) / around) * Math.PI * 2;
    const r = 0.2 + 0.1 * random();
    const reach = r * (0.78 + 0.14 * random());
    lobes.push({
      x: Math.cos(angle) * reach,
      y: 0.02 + 0.1 * random(),
      z: Math.sin(angle) * reach,
      r,
    });
  }
  addCanopy(builder, {
    center: [0, 0.2, 0],
    lobes,
    stretch: [1.1, 0.95, 1.1],
    detail: lod === 0 ? 4 : lod === 1 ? 3 : 2,
    fillet: 0.07,
    bumps: 0.1,
    bumpScale: 2.8,
    under: 1.1,
    seed: 41 + variant * 13,
    foliage: BUSH_FOLIAGE,
    height: 1.4,
    depth: 1,
    ...(lod === 0 ? { tufts: { count: 30, size: 0.08, fine: false } } : {}),
  });
  return builder.finish();
}

/** A boulder: a ball knocked out of shape, flat-footed, weathered grey with moss on its top. */
function buildRock(variant: number, lod: SceneryLod): SceneryShape {
  const builder = new ShapeBuilder();
  const random = randomStream(7717 + variant * 211);
  const sphere = geodesicSphere(lod === 0 ? 4 : lod === 1 ? 2 : 1);
  const count = sphere.directions.length / 3;
  const sx = 0.5 + 0.2 * random();
  const sz = 0.42 + 0.2 * random();
  const sy = 0.34 + 0.12 * random();
  const seed = 301 + variant * 17;
  const stone: Rgb = [0.27, 0.255, 0.235];
  const stoneDark: Rgb = [0.085, 0.08, 0.078];
  const moss: Rgb = [0.07, 0.105, 0.035];

  const firstVertex = builder.vertexCount;
  for (let v = 0; v < count; v++) {
    const ux = sphere.directions[v * 3] as number;
    const uy = sphere.directions[v * 3 + 1] as number;
    const uz = sphere.directions[v * 3 + 2] as number;
    // Broad dents, then a few flat cuts where the noise runs high: boulders are not round.
    const dent = noise3(ux * 1.25, uy * 1.25, uz * 1.25, seed);
    const cut = noise3(ux * 2.6 + 9, uy * 2.6, uz * 2.6, seed + 4);
    const r =
      1 +
      0.34 * dent -
      0.2 * smoothstep(0.1, 0.5, cut) +
      0.05 * noise3(ux * 6, uy * 6, uz * 6, seed + 8);
    const x = ux * r * sx;
    const y = (uy < 0 ? uy * 0.55 : uy) * r * sy + sy * 0.3;
    const z = uz * r * sz;
    const crease = clamp01(0.5 - 1.6 * dent + 1.1 * smoothstep(0.1, 0.5, cut));
    let color = mixRgb(stone, stoneDark, 0.75 * crease);
    color = mixRgb(color, stoneDark, 0.6 * (1 - smoothstep(-0.02, 0.2, y)));
    const mossy =
      smoothstep(0.35, 0.8, uy) * smoothstep(-0.2, 0.25, noise3(ux * 3, uy * 3, uz * 3, seed + 12));
    color = mixRgb(color, moss, 0.7 * mossy);
    builder.vertex(x, y, z, color, 0, 0.25 * mossy, 0.5);
  }
  for (let i = 0; i < sphere.indices.length; i += 3) {
    builder.triangle(
      firstVertex + (sphere.indices[i] as number),
      firstVertex + (sphere.indices[i + 1] as number),
      firstVertex + (sphere.indices[i + 2] as number),
    );
  }
  builder.smooth(firstVertex, 0);
  return builder.finish();
}

/**
 * Builds model number `variant` of `kind` at level of detail `lod`. The same arguments always
 * give the same model, to the last bit.
 */
export function buildSceneryShape(
  kind: SceneryKind,
  variant: number,
  lod: SceneryLod,
): SceneryShape {
  switch (kind) {
    case OAK:
      return buildOak(variant, lod);
    case BIRCH:
      return buildBirch(variant, lod);
    case SPRUCE:
      return buildSpruce(variant, lod);
    case BUSH:
      return buildBush(variant, lod);
    default:
      return buildRock(variant, lod);
  }
}
