import type { EntrancePlace } from "../context.js";
import { SUBDIV } from "../units.js";
import { noise3, smoothstep } from "./noise.js";
import type { SceneryShape } from "./shapes.js";

/**
 * The park's boundary: a low clipped hedge that runs all the way round, just outside the edge, so
 * that where the park ends can be read without the build grid. It follows the ground, rounds the
 * park's corners, and stops with a rounded end either side of the entrance.
 *
 * Its mesh has the same vertex data as the trees' (`SceneryShape`), so it is drawn with their
 * material: the leaf grain, the light and the shadows are the same, and it does not sway.
 */

/** How far outside the park's edge the hedge's middle line runs, in tiles. */
export const HEDGE_OFFSET = 0.34;
/** Its half width at the foot and its height, in tiles. */
export const HEDGE_HALF_WIDTH = 0.21;
export const HEDGE_HEIGHT = 0.4;
/** How far the tips of the hedge's ends stand back from the entrance tile's sides. */
export const GATE_MARGIN = 0.1;
/** How long the rounding of a hedge's end is, in tiles. */
export const END_LENGTH = 0.2;

/** Stations along the hedge per tile: twice the ground's mesh, so its lumps are finer. */
const STEPS = SUBDIV * 2;

/**
 * The hedge's profile from its outer foot over the top to its inner foot: across, up. Clipped
 * square, with the shoulders rounded off.
 */
const PROFILE: readonly (readonly [number, number])[] = [
  [1.0, -0.2],
  [1.05, 0.12],
  [1.06, 0.42],
  [1.02, 0.68],
  [0.9, 0.88],
  [0.62, 0.99],
  [0.22, 1.04],
  [-0.22, 1.04],
  [-0.62, 0.99],
  [-0.9, 0.88],
  [-1.02, 0.68],
  [-1.06, 0.42],
  [-1.05, 0.12],
  [-1.0, -0.2],
];

const DARK = [0.012, 0.032, 0.012] as const;
const BASE = [0.04, 0.098, 0.024] as const;
const LIGHT = [0.085, 0.158, 0.036] as const;

/** A point on the hedge's middle line and the direction the line runs there. */
interface Station {
  x: number;
  z: number;
  /** Unit direction along the hedge. */
  tx: number;
  tz: number;
  /** How full the hedge is here: 1 along its run, less in the rounding of an end. */
  full: number;
}

/**
 * The stretch of a side the entrance takes out of the hedge, as distances along that side from
 * its start, or null when the entrance is on another side. Sides run the way the hedge does:
 * north eastward, east southward, south westward, west northward.
 */
function gapOn(
  side: number,
  width: number,
  height: number,
  entrance: EntrancePlace | null,
): [number, number] | null {
  if (!entrance || entrance.side !== side) return null;
  const length = side === 0 || side === 2 ? width : height;
  // The hedge is whole up to where the rounding of its end begins.
  const back = GATE_MARGIN + END_LENGTH;
  const lo = (side === 0 || side === 2 ? entrance.x : entrance.y) - back;
  const hi = lo + 1 + 2 * back;
  // The south and west sides are walked backwards. A gate on a corner tile cuts no further than
  // the corner.
  const from = side === 2 || side === 3 ? length - hi : lo;
  return [Math.max(0, from), Math.min(length, from + hi - lo)];
}

/**
 * The hedge's middle line around a `width` by `height` park as runs of stations: one closed run
 * when there is no entrance, otherwise one open run from one side of the gap round to the other.
 */
export function hedgeRuns(
  width: number,
  height: number,
  entrance: EntrancePlace | null,
  steps: number = STEPS,
): { stations: Station[]; closed: boolean }[] {
  const o = HEDGE_OFFSET;
  const all: (Station | null)[] = [];
  // Each side: where it starts, which way it runs, how long it is; then the corner after it.
  const sides: [number, number, number, number, number][] = [
    [0, -o, 1, 0, width],
    [width + o, 0, 0, 1, height],
    [width, height + o, -1, 0, width],
    [-o, height, 0, -1, height],
  ];
  const corners: [number, number][] = [
    [width, 0],
    [width, height],
    [0, height],
    [0, 0],
  ];
  for (let side = 0; side < 4; side++) {
    const [x0, z0, tx, tz, length] = sides[side] as [number, number, number, number, number];
    const gap = gapOn(side, width, height, entrance);
    // Stations on every mesh line of the ground and halfway between, so the hedge follows it
    // closely. The side's last station is the first of the corner after it.
    const marks: number[] = [];
    for (let i = 0; i < length * steps; i++) marks.push(i / steps);
    if (gap) {
      // The hedge stops and starts exactly at the gap's ends, not at the nearest whole cell.
      for (const end of gap) if (end < length && !marks.includes(end)) marks.push(end);
      marks.sort((a, b) => a - b);
    }
    for (const s of marks) {
      if (gap && s > gap[0] && s < gap[1]) continue;
      all.push({ x: x0 + tx * s, z: z0 + tz * s, tx, tz, full: 1 });
      if (gap && s === gap[0]) all.push(null);
    }
    // The quarter turn round the corner.
    const [cx, cz] = corners[side] as [number, number];
    const turns = 5;
    for (let i = 0; i < turns; i++) {
      const angle = ((i / turns) * Math.PI) / 2;
      // The direction turns clockwise seen from above (north, east, south, west).
      const dx = tx * Math.cos(angle) - tz * Math.sin(angle);
      const dz = tz * Math.cos(angle) + tx * Math.sin(angle);
      // Outward is to the left of the direction of travel.
      all.push({ x: cx + dz * o, z: cz - dx * o, tx: dx, tz: dz, full: 1 });
    }
  }

  // Cut the loop at its gaps.
  const firstGap = all.findIndex((station) => station === null);
  if (firstGap < 0) return [{ stations: all as Station[], closed: true }];
  const runs: { stations: Station[]; closed: boolean }[] = [];
  let run: Station[] = [];
  for (let k = 1; k <= all.length; k++) {
    const station = all[(firstGap + k) % all.length] as Station | null;
    if (station) {
      run.push(station);
    } else if (run.length > 0) {
      runs.push({ stations: run, closed: false });
      run = [];
    }
  }
  return runs.filter((r) => r.stations.length >= 2);
}

/** The stations the rounding of a hedge's end is made of. */
const END_SHAPE: readonly (readonly [number, number])[] = [
  // How far into the rounding, and how full the hedge still is there.
  [0.45, 0.9],
  [0.8, 0.62],
  [1, 0.2],
];

/**
 * Builds the hedge around a `width` by `height` park whose land is `heightAt`, leaving the
 * entrance open. Null when the park is too small to have one. `steps` is stations per tile (fewer
 * for a renderer that cannot afford the vertices).
 */
export function buildHedge(
  width: number,
  height: number,
  heightAt: (x: number, z: number) => number,
  entrance: EntrancePlace | null,
  steps: number = STEPS,
): SceneryShape | null {
  if (width < 1 || height < 1) return null;
  const positions: number[] = [];
  const colors: number[] = [];
  const aux: number[] = [];
  const indices: number[] = [];
  const points = PROFILE.length;

  for (const run of hedgeRuns(width, height, entrance, steps)) {
    let stations = run.stations;
    if (!run.closed) {
      // Round both ends: a few stations more, each a little further on and a little less full.
      const first = stations[0] as Station;
      const last = stations[stations.length - 1] as Station;
      const head = END_SHAPE.map(([along, full]) => ({
        ...first,
        x: first.x - first.tx * END_LENGTH * along,
        z: first.z - first.tz * END_LENGTH * along,
        full,
      })).reverse();
      const tail = END_SHAPE.map(([along, full]) => ({
        ...last,
        x: last.x + last.tx * END_LENGTH * along,
        z: last.z + last.tz * END_LENGTH * along,
        full,
      }));
      stations = [...head, ...stations, ...tail];
    }

    const base = positions.length / 3;
    for (const station of stations) {
      const ground = heightAt(station.x, station.z);
      // Outward is to the left of the way the hedge runs.
      const ox = station.tz;
      const oz = -station.tx;
      for (let k = 0; k < points; k++) {
        const [across, up] = PROFILE[k] as readonly [number, number];
        const x = station.x + ox * across * HEDGE_HALF_WIDTH * station.full;
        const z = station.z + oz * across * HEDGE_HALF_WIDTH * station.full;
        // Clipped, but by hand and a while ago: the faces bulge and dip, and shoots stand out.
        const lump =
          noise3(x * 1.3, up * 1.1, z * 1.3, 811) +
          0.55 * noise3(x * 4.7, up * 3.6, z * 4.7, 813) +
          0.3 * noise3(x * 11, up * 8, z * 11, 815);
        const swell = 1 + 0.11 * lump * (up > 0 ? 1 : 0);
        const y = ground + up * HEDGE_HEIGHT * (up > 0 ? station.full * (1 + 0.07 * lump) : 1);
        positions.push(station.x + (x - station.x) * swell, y, station.z + (z - station.z) * swell);
        // Dark at the foot, where it shades itself and the grass, light along the clipped top.
        const lit = smoothstep(0.0, 0.95, up) * (1 + 0.45 * lump);
        const tone = Math.max(0, Math.min(1.4, 0.25 + 0.95 * lit));
        const mixTo = tone <= 0.8 ? [DARK, BASE, tone / 0.8] : [BASE, LIGHT, (tone - 0.8) / 0.6];
        const [from, to, t] = mixTo as [readonly number[], readonly number[], number];
        colors.push(
          (from[0] as number) + ((to[0] as number) - (from[0] as number)) * t,
          (from[1] as number) + ((to[1] as number) - (from[1] as number)) * t,
          (from[2] as number) + ((to[2] as number) - (from[2] as number)) * t,
        );
        aux.push(0, 1, 0.5);
      }
    }

    const rings = stations.length;
    const bands = run.closed ? rings : rings - 1;
    for (let r = 0; r < bands; r++) {
      const a = base + r * points;
      const b = base + ((r + 1) % rings) * points;
      for (let k = 0; k + 1 < points; k++) {
        // Counter-clockwise seen from outside the hedge.
        indices.push(a + k, a + k + 1, b + k, b + k, a + k + 1, b + k + 1);
      }
    }
    if (!run.closed) {
      // Close the two ends with a fan each.
      for (const [ring, flip] of [
        [0, false],
        [rings - 1, true],
      ] as const) {
        const start = base + ring * points;
        for (let k = 1; k + 1 < points; k++) {
          if (flip) indices.push(start, start + k, start + k + 1);
          else indices.push(start, start + k + 1, start + k);
        }
      }
    }
  }

  // Smooth normals: the mean of the faces around each vertex, weighted by area.
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = (indices[i] as number) * 3;
    const b = (indices[i + 1] as number) * 3;
    const c = (indices[i + 2] as number) * 3;
    const ux = (positions[b] as number) - (positions[a] as number);
    const uy = (positions[b + 1] as number) - (positions[a + 1] as number);
    const uz = (positions[b + 2] as number) - (positions[a + 2] as number);
    const vx = (positions[c] as number) - (positions[a] as number);
    const vy = (positions[c + 1] as number) - (positions[a + 1] as number);
    const vz = (positions[c + 2] as number) - (positions[a + 2] as number);
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      normals[v] = (normals[v] as number) + fx;
      normals[v + 1] = (normals[v + 1] as number) + fy;
      normals[v + 2] = (normals[v + 2] as number) + fz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const length = Math.hypot(
      normals[v] as number,
      normals[v + 1] as number,
      normals[v + 2] as number,
    );
    if (length > 0) {
      normals[v] = (normals[v] as number) / length;
      normals[v + 1] = (normals[v + 1] as number) / length;
      normals[v + 2] = (normals[v + 2] as number) / length;
    } else {
      normals[v + 1] = 1;
    }
  }

  return {
    positions: new Float32Array(positions),
    normals,
    colors: new Float32Array(colors),
    aux: new Float32Array(aux),
    indices: new Uint32Array(indices),
  };
}
