import { groundHeightAt, groundNormalAt } from "../heightfield.js";
import type { TerrainData } from "../terrain/geometry.js";
import { SUBDIV } from "../units.js";
import { fbm2, noise2, smoothstep } from "./noise.js";

/**
 * The shape of the land beyond the park, and the mesh that draws it.
 *
 * Right at the park's edge the land is the park's own smooth ground carried straight out, so the
 * two meet without a step or a change of slope. It stays like that, level in the outward
 * direction, for the first `LAND_LEVEL` tiles: that is where the entrance lane runs. Further out
 * the edge's own ups and downs die away toward one base height and rolling hills grow out of it,
 * gently at first and to their full size by about `HILLS_FULL` tiles.
 */

/** How far the land runs out from the park's edge, in tiles. */
export const LAND_REACH = 150;
/** For this many tiles out from the edge the land is the edge's height carried straight out. */
export const LAND_LEVEL = 6;
/**
 * By this far out nothing of the edge's own profile is left in the land: whatever is further from
 * the park than this does not change when the park's ground does.
 */
export const EDGE_REACH = 30;
/** By this far out the hills have their full size. */
const HILLS_FULL = 58;
/**
 * How far the land is drawn at all. Past `LAND_REACH` it is a few rings of very large cells with
 * nothing standing on them: far ridges for the haze to swallow, so that a high camera never sees
 * where the hills stop.
 */
export const FAR_REACH = 460;

/** The rise of the whole land toward its rim, which lifts the horizon a little above the park. */
const RIM_RISE = 5;
/** The height of the big hills, valley floor to top. */
const HILL_HEIGHT = 10;
/** Tiles across one big hill and the valley beside it. */
const HILL_SPAN = 120;
/** The smaller rises that ride on the hills: height either way, and tiles across. */
const RISE_HEIGHT = 2.2;
const RISE_SPAN = 34;
/** The far ridges, past the reach: how much higher than the hills they stand, and tiles across. */
const RIDGE_HEIGHT = 16;
const RIDGE_SPAN = 210;
/** The small bumps of the meadow near the park: height either way, and tiles across. */
const BUMP_HEIGHT = 0.42;
const BUMP_SPAN = 11;
/** The bumps are finer than the mesh can carry further out than this, so they fade by here. */
const BUMPS_GONE = 30;

/** The hills are the same for every park: there is one land, and parks are set down in it. */
const SEED = 9127;

/** The land beyond one park. */
export interface OuterLand {
  /** The height the hills grow out of, in world units. */
  readonly base: number;
  /**
   * The land's height in world units at world (`x`, `z`), for points on or outside the park's
   * edge. On the edge it is the park's own smooth ground.
   */
  heightAt(x: number, z: number): number;
  /**
   * Writes the unit normal the land is lit with at world (`x`, `z`) into `out` and returns it.
   * Within `LAND_LEVEL` of the park it is the very normal the park's ground is lit with
   * (`groundNormalAt`), so there is no seam in the light along the edge. `step` is the distance in
   * tiles the slope is measured over, for a mesh whose cells are too big to carry anything finer.
   */
  normalAt(
    x: number,
    z: number,
    out: [number, number, number],
    step?: number,
  ): [number, number, number];
}

/** How far world (`x`, `z`) is outside the rectangle of a `width` by `height` park; 0 inside. */
export function distanceOutside(width: number, height: number, x: number, z: number): number {
  const dx = x < 0 ? -x : x > width ? x - width : 0;
  const dz = z < 0 ? -z : z > height ? z - height : 0;
  return dx === 0 ? dz : dz === 0 ? dx : Math.hypot(dx, dz);
}

/** The hills alone, at a point `d` tiles outside the park: what is added to the base height. */
function hillsAt(x: number, z: number, d: number): number {
  if (d <= LAND_LEVEL) return 0;
  const grown = smoothstep(LAND_LEVEL, HILLS_FULL, d);
  // Broad valley floors and rounded tops: the S-curve flattens both ends of the noise.
  const big = smoothstep(-0.62, 0.7, fbm2(x / HILL_SPAN, z / HILL_SPAN, 3, SEED));
  const rise = noise2(x / RISE_SPAN, z / RISE_SPAN, SEED + 7);
  let h =
    grown * (RIM_RISE * smoothstep(24, LAND_REACH, d) + HILL_HEIGHT * big + RISE_HEIGHT * rise);
  if (d > LAND_REACH * 0.8) {
    const ridge = smoothstep(-0.5, 0.6, noise2(x / RIDGE_SPAN, z / RIDGE_SPAN, SEED + 29));
    h += RIDGE_HEIGHT * ridge * smoothstep(LAND_REACH * 0.8, LAND_REACH * 2, d);
  }
  if (d < BUMPS_GONE) {
    const near = smoothstep(LAND_LEVEL, 14, d) * (1 - smoothstep(18, BUMPS_GONE, d));
    h += near * BUMP_HEIGHT * noise2(x / BUMP_SPAN, z / BUMP_SPAN, SEED + 13);
  }
  return h;
}

/** The mean height of the park's edge, in world units. */
export function meanEdgeHeight(t: TerrainData): number {
  let sum = 0;
  let count = 0;
  for (let x = 0; x <= t.width; x++) {
    sum += groundHeightAt(t, x, 0) + groundHeightAt(t, x, t.height);
    count += 2;
  }
  for (let z = 1; z < t.height; z++) {
    sum += groundHeightAt(t, 0, z) + groundHeightAt(t, t.width, z);
    count += 2;
  }
  return sum / count;
}

/** The least step the slope of the hills is measured over, in tiles. */
const SLOPE_STEP = 0.5;

/**
 * Works out the land around the park `t`. Cheap to ask: no allocation, no mesh lookups. `base` is
 * the height the hills grow out of; left out, it is the mean height of the park's edge. Whoever
 * keeps a land across edits of the park passes the base of the first one, so that digging at the
 * edge reshapes only the ground within `EDGE_REACH` of it and not every hill there is.
 */
export function createOuterLand(t: TerrainData, base = meanEdgeHeight(t)): OuterLand {
  const { width, height } = t;

  /** How much of the edge's own height is left `d` tiles out. */
  const kept = (d: number) => 1 - smoothstep(LAND_LEVEL, EDGE_REACH, d);

  function heightAt(x: number, z: number): number {
    const d = distanceOutside(width, height, x, z);
    if (d <= LAND_LEVEL) return groundHeightAt(t, x, z);
    const hills = base + hillsAt(x, z, d);
    if (d >= EDGE_REACH) return hills;
    return hills + (groundHeightAt(t, x, z) - base) * kept(d);
  }

  /** The land with the edge's height held at `edge`: everything in it that is smooth. */
  function smoothPart(x: number, z: number, edge: number): number {
    const d = distanceOutside(width, height, x, z);
    return hillsAt(x, z, d) + (edge - base) * kept(d);
  }

  function normalAt(x: number, z: number, out: [number, number, number], step = SLOPE_STEP) {
    const d = distanceOutside(width, height, x, z);
    const ground = d < EDGE_REACH ? groundNormalAt(t, x, z) : null;
    if (ground && d <= LAND_LEVEL) {
      out[0] = ground[0];
      out[1] = ground[1];
      out[2] = ground[2];
      return out;
    }
    // The slope of the edge's own profile is the one the park is lit with, faded as the profile
    // is; the slope of the rest is measured.
    const edge = ground ? groundHeightAt(t, x, z) : base;
    const keep = ground ? kept(d) : 0;
    const e = step > SLOPE_STEP ? step : SLOPE_STEP;
    let dx = (smoothPart(x + e, z, edge) - smoothPart(x - e, z, edge)) / (2 * e);
    let dz = (smoothPart(x, z + e, edge) - smoothPart(x, z - e, edge)) / (2 * e);
    if (ground) {
      dx += (-ground[0] / ground[1]) * keep;
      dz += (-ground[2] / ground[1]) * keep;
    }
    const inv = 1 / Math.hypot(dx, 1, dz);
    out[0] = -dx * inv;
    out[1] = inv;
    out[2] = -dz * inv;
    return out;
  }

  return { base, heightAt, normalAt };
}

/** The mesh of the land around the park, as flat arrays. */
export interface SurroundingsGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** The mesh's first cells, at the park's edge, are the park mesh's own size. */
const FIRST_CELL = 1 / SUBDIV;
/** Each loop of cells is this much bigger than the one inside it. */
const CELL_GROWTH = 1.07;
/** The biggest a cell gets within the reach, in tiles: far hills keep a round outline. */
const LARGEST_CELL = 3;
/** Past the reach the cells grow fast, to this at most. */
const FAR_GROWTH = 1.3;
const LARGEST_FAR_CELL = 36;

/** One closed loop of the mesh: how far out it is and how big its cells are. */
export interface RingLoop {
  /** Tiles out from the park's edge. */
  distance: number;
  /** The spacing of its vertices, and how far it is to the next loop. */
  cell: number;
}

/**
 * The loops the land's mesh is made of, from the park's edge (distance 0) out to `FAR_REACH`:
 * each a little further out and a little coarser than the last, so that the mesh is as fine as
 * the park's where the two meet and spends few triangles on the far hills. One loop lies exactly
 * at `EDGE_REACH` and one exactly at `LAND_REACH`.
 */
export function ringLoops(): RingLoop[] {
  const loops: RingLoop[] = [];
  let distance = 0;
  let cell = FIRST_CELL;
  /** Adds loops up to `end`, the last of them exactly on it. */
  const fill = (end: number, growth: number, largest: number): void => {
    // Stop while there is still room for a last band of a decent width.
    while (distance + cell * 1.5 < end) {
      loops.push({ distance, cell });
      distance += cell;
      cell = Math.min(largest, cell * growth);
    }
    loops.push({ distance, cell: end - distance });
    distance = end;
  };
  fill(EDGE_REACH, CELL_GROWTH, LARGEST_CELL);
  fill(LAND_REACH, CELL_GROWTH, LARGEST_CELL);
  fill(FAR_REACH, FAR_GROWTH, LARGEST_FAR_CELL);
  loops.push({ distance, cell });
  return loops;
}

/** The index in `loops` of the loop that lies at `distance`. */
export function loopAt(loops: readonly RingLoop[], distance: number): number {
  const found = loops.findIndex((loop) => loop.distance === distance);
  if (found < 0) throw new Error(`The land has no loop at ${distance} tiles.`);
  return found;
}

/**
 * Builds part of the land around the park: the bands between loop `from` and loop `to` of
 * `loops`, a ring with nothing over the park itself. All of the land is `from` 0 and `to` the
 * last loop.
 *
 * The ring is made of closed loops, each the outline of everything within some distance of the
 * park: the park's own rectangle first, then rectangles with rounded corners, nearly a circle by
 * the rim. The first loop's vertices are the park mesh's border vertices, at the same places
 * (every `1 / SUBDIV` of a tile) with the same heights and normals, so the two join without a
 * crack or a seam. Every loop's vertices are shared by the band of triangles on its inside and
 * the band on its outside, so there are no cracks between bands either, though each loop is
 * coarser than the last. Two parts that meet at a loop have the very same vertices along it,
 * since a vertex depends on nothing but its loop.
 */
export function buildSurroundingsGeometry(
  t: TerrainData,
  land: OuterLand,
  loops: readonly RingLoop[] = ringLoops(),
  from = 0,
  to = loops.length - 1,
): SurroundingsGeometry {
  const { width, height } = t;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const normal: [number, number, number] = [0, 1, 0];

  const vertex = (x: number, z: number, step: number): number => {
    const made = positions.length / 3;
    positions.push(x, land.heightAt(x, z), z);
    land.normalAt(x, z, normal, step);
    normals.push(normal[0], normal[1], normal[2]);
    return made;
  };

  /**
   * The vertices of one loop as eight runs, four sides and four corners in turn, going round by
   * north, east, south and west. Each run starts on the last vertex of the run before, and the
   * last run ends on the first vertex of the first.
   */
  function buildLoop(loop: RingLoop, index: number): number[][] {
    const first = index === 0;
    const d = loop.distance;
    // A loop's vertices are as far apart as the band inside it is wide.
    const cell = first ? FIRST_CELL : d - (loops[index - 1] as RingLoop).distance;
    const along = (tiles: number) =>
      first ? tiles * SUBDIV : Math.max(1, Math.round(tiles / cell));
    const arc = first ? 0 : Math.max(2, Math.ceil(((Math.PI / 2) * d) / cell));
    const nx = along(width);
    const nz = along(height);
    const quarter = Math.PI / 2;
    // Where each run goes, as a function of how far along it (0..1) a vertex is.
    const runs: [number, (k: number) => [number, number]][] = [
      [nx, (k) => [k * width, -d]],
      [arc, (k) => [width + d * Math.sin(k * quarter), -d * Math.cos(k * quarter)]],
      [nz, (k) => [width + d, k * height]],
      [arc, (k) => [width + d * Math.cos(k * quarter), height + d * Math.sin(k * quarter)]],
      [nx, (k) => [(1 - k) * width, height + d]],
      [arc, (k) => [-d * Math.sin(k * quarter), height + d * Math.cos(k * quarter)]],
      [nz, (k) => [-d, (1 - k) * height]],
      [arc, (k) => [-d * Math.cos(k * quarter), -d * Math.sin(k * quarter)]],
    ];
    const out: number[][] = [];
    let last = -1;
    for (let r = 0; r < runs.length; r++) {
      const [segments, at] = runs[r] as [number, (k: number) => [number, number]];
      const run: number[] = [];
      for (let i = 0; i <= segments; i++) {
        if (i === 0 && last >= 0) {
          run.push(last);
        } else if (i === segments && r === runs.length - 1) {
          run.push((out[0] as number[])[0] as number);
        } else {
          let [x, z] = at(segments === 0 ? 0 : i / segments);
          if (first) {
            // On the park's own border the places are whole cells counted from the map's corner,
            // exactly as the park mesh counts them.
            x = Math.round(x * SUBDIV) / SUBDIV;
            z = Math.round(z * SUBDIV) / SUBDIV;
          }
          run.push(vertex(x, z, cell * 0.5));
        }
      }
      last = run[run.length - 1] as number;
      out.push(run);
    }
    return out;
  }

  /** Adds a triangle, turned to face up whichever way round its corners were given. */
  const triangle = (a: number, b: number, c: number): void => {
    const ax = positions[a * 3] as number;
    const az = positions[a * 3 + 2] as number;
    const up =
      ((positions[b * 3 + 2] as number) - az) * ((positions[c * 3] as number) - ax) -
      ((positions[b * 3] as number) - ax) * ((positions[c * 3 + 2] as number) - az);
    if (up > 0) indices.push(a, b, c);
    else if (up < 0) indices.push(a, c, b);
  };

  /** Fills the band between a run of the inner loop and the matching run of the outer one. */
  function zip(inner: number[], outer: number[]): void {
    const m = inner.length - 1;
    const n = outer.length - 1;
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      // Step along whichever loop is behind, so the triangles stay as even as they can be.
      const stepInner = i < m && (j >= n || (i + 1) * n <= (j + 1) * m);
      if (stepInner) {
        triangle(inner[i] as number, outer[j] as number, inner[i + 1] as number);
        i++;
      } else {
        triangle(inner[i] as number, outer[j] as number, outer[j + 1] as number);
        j++;
      }
    }
  }

  let inner = buildLoop(loops[from] as RingLoop, from);
  for (let l = from + 1; l <= to; l++) {
    const outer = buildLoop(loops[l] as RingLoop, l);
    for (let r = 0; r < 8; r++) zip(inner[r] as number[], outer[r] as number[]);
    inner = outer;
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}
