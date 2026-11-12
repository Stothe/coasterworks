import { STEP, TILE, type TrackPiece } from "@coasterworks/content";
import { localToWorld, pieceTiles, type Dir, type Pose } from "./pose.js";

// Lower bounds on what a fit leg costs (the A* heuristic of `track/fit.ts`).
//
// The bound is the exact cost of a relaxed problem: an empty, endless, flat plane on which every
// straight-shaped piece (straights, slopes, unbanking) is a straight costing 10, and curves cost
// what they do in the fit. Any real leg, with its slopes laid flat, its pitch and bank ignored and
// nothing in the way, is a leg of the relaxed problem that costs no more, so the relaxed cost
// never overestimates (the heuristic stays admissible). The relaxed cost does not depend on where
// a pose is, only on where the goal is from it, so it is worked out once per set of curves, by a
// Dijkstra search from one pose, into two tables:
//
//   - `exact`: from the origin pose to every pose in a box around it (for closing the circuit);
//   - `cover`: from the origin pose to passing over every tile in a box around it (for points).
//
// The search is cut at `SEARCH_RADIUS` tiles, and only goals within `TABLE_RADIUS` tiles are
// read from the tables. That is safe: a relaxed leg that leaves the search box travels at least
// 2 * SEARCH_RADIUS - TABLE_RADIUS - 3 tiles (every piece costs at least 10 a tile it moves along
// either axis), which costs more than the worst relaxed leg to anything within the table, so
// cutting the search never raises a value that is read. Beyond the tables `normBound` is used.
//
// Heights are not in the tables: `heightExtra` adds what climbing costs over laying flat.

/** Goals at most this many tiles away (along either axis) are read from the tables. */
export const TABLE_RADIUS = 20;
/** How far (tiles) the search behind the tables goes; see the note above on why it is safe. */
const SEARCH_RADIUS = 48;
/** The origin pose sits at the west edge of tile (C, C), facing east. */
const C = SEARCH_RADIUS + 4;
const H = TILE / 2;
/** Half tiles across the search box, on each axis. */
const N = 2 * (2 * C + 1);
const UNSET = 0x7fffffff;

interface Move {
  /** Half tiles moved east and south, and the direction after. */
  dx: number;
  dy: number;
  dir: number;
  weight: number;
  /** Tiles covered, relative to the tile the pose faces into, by tile. */
  tiles: { x: number; y: number }[];
}

export interface Bounds {
  /** Relaxed cost from the origin pose to pose (hx, hy, dir): index `poseIndex`. */
  exact: Int32Array;
  /** Relaxed cost from the origin pose to passing over tile (x, y): index `y * (2C+1) + x`. */
  cover: Int32Array;
}

const cache = new Map<string, Bounds>();

function poseIndex(hx: number, hy: number, dir: number): number {
  return (dir * N + hy) * N + hx;
}

/** Half-tile coordinates of the tile a pose at (hx, hy) facing `dir` faces into. */
function facedTile(hx: number, hy: number, dir: number): { x: number; y: number } {
  const { dx, dy } = localToWorld(dir as Dir, 1, 0);
  return { x: Math.floor((hx + dx) / 2), y: Math.floor((hy + dy) / 2) };
}

/**
 * The relaxed-cost tables for a set of pieces: `straight` (weight 10) plus every flat, unbanked
 * curve in `curves` with its weight. Worked out once per set and kept.
 */
export function boundsFor(curves: readonly { piece: TrackPiece; weight: number }[]): Bounds {
  const key = curves.map((c) => `${c.piece.id}:${c.weight}`).join(",");
  const known = cache.get(key);
  if (known !== undefined) return known;

  // Each move, per direction, worked out once from a reference pose of that direction.
  const shapes = [
    { forward: TILE, right: 0, dDir: 0, weight: 10, piece: null as TrackPiece | null },
    ...curves.map((c) => ({
      forward: c.piece.exit.forward,
      right: c.piece.exit.right,
      dDir: c.piece.exit.dDir,
      weight: c.weight,
      piece: c.piece,
    })),
  ];
  const moves: Move[][] = [];
  for (let dir = 0; dir < 4; dir++) {
    // A join pose facing `dir` near the middle of the box.
    const ref: Pose =
      dir % 2 === 0
        ? { x: C * TILE + H, y: C * TILE, z: 0, dir: dir as Dir, pitch: 0, bank: 0 }
        : { x: C * TILE, y: C * TILE + H, z: 0, dir: dir as Dir, pitch: 0, bank: 0 };
    const face = facedTile(ref.x / H, ref.y / H, dir);
    const list: Move[] = [];
    for (const s of shapes) {
      const { dx, dy } = localToWorld(dir as Dir, s.forward, s.right);
      const tiles =
        s.piece === null
          ? [{ x: 0, y: 0 }]
          : pieceTiles(ref, s.piece).map((t) => ({ x: t.x - face.x, y: t.y - face.y }));
      list.push({ dx: dx / H, dy: dy / H, dir: (dir + s.dDir + 4) % 4, weight: s.weight, tiles });
    }
    moves.push(list);
  }

  const exact = new Int32Array(4 * N * N).fill(UNSET);
  const side = 2 * C + 1;
  const cover = new Int32Array(side * side).fill(UNSET);
  // Dijkstra with a bucket queue: weights are small integers.
  const buckets: number[][] = [];
  const push = (cost: number, node: number) => {
    let b = buckets[cost];
    if (b === undefined) {
      b = [];
      buckets[cost] = b;
    }
    b.push(node);
  };
  const lo = 2 * (C - SEARCH_RADIUS);
  const hi = 2 * (C + SEARCH_RADIUS + 1);
  const origin = poseIndex(2 * C, 2 * C + 1, 1);
  exact[origin] = 0;
  push(0, origin);
  const reach = TABLE_RADIUS + 3;
  for (let cost = 0; cost < buckets.length; cost++) {
    const bucket = buckets[cost];
    if (bucket === undefined) continue;
    for (let i = 0; i < bucket.length; i++) {
      const node = bucket[i] as number;
      if (exact[node] !== cost) continue;
      const hx = node % N;
      const hy = Math.floor(node / N) % N;
      const dir = Math.floor(node / (N * N));
      const face = facedTile(hx, hy, dir);
      const near = Math.abs(face.x - C) <= reach && Math.abs(face.y - C) <= reach;
      for (const m of moves[dir] as Move[]) {
        const g = cost + m.weight;
        if (near) {
          for (const t of m.tiles) {
            const tx = face.x + t.x;
            const ty = face.y + t.y;
            if (tx < 0 || ty < 0 || tx >= side || ty >= side) continue;
            const at = ty * side + tx;
            if (g < (cover[at] as number)) cover[at] = g;
          }
        }
        const nx = hx + m.dx;
        const ny = hy + m.dy;
        if (nx < lo || ny < lo || nx > hi || ny > hi) continue;
        const next = poseIndex(nx, ny, m.dir);
        if (g < (exact[next] as number)) {
          exact[next] = g;
          push(g, next);
        }
      }
    }
    buckets[cost] = [];
  }
  const out = { exact, cover };
  cache.set(key, out);
  return out;
}

/** `localOffset` of `pose`: forward and right of the point (px, py) in the pose's own frame. */
function offsetFrom(pose: Pose, px: number, py: number): { forward: number; right: number } {
  const dx = px - pose.x;
  const dy = py - pose.y;
  switch (pose.dir) {
    case 0:
      return { forward: -dy, right: dx };
    case 1:
      return { forward: dx, right: dy };
    case 2:
      return { forward: dy, right: -dx };
    case 3:
      return { forward: -dx, right: -dy };
  }
}

/**
 * A norm on displacements every piece's weight is at least: 10 a tile along the longer axis plus
 * 1.2 a tile along the shorter (a large curve, 2.5 by 2.5 tiles for 28, is exactly on it; a
 * straight, 1 by 0 for 10, too). So a leg costs at least the norm of where it goes. `dx`, `dy` in
 * fixed-point units; the result rounded down.
 */
export function normBound(dx: number, dy: number): number {
  const a = Math.abs(dx);
  const b = Math.abs(dy);
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  return Math.floor((50 * long + 6 * short) / (5 * TILE));
}

/**
 * At least what a leg from `pose` costs to pass over tile (x, y) on the flat. Far away (beyond
 * the tables): the norm of the way to the tile's centre less what the last piece can reach from
 * its start (a large curve, the farthest-reaching piece, passes over a tile 2.5 tiles forward and
 * 2 to the side for 28, which is the norm of that offset, 27.4, plus 0.6), and at least 10.
 */
export function coverBound(bounds: Bounds, pose: Pose, x: number, y: number): number {
  const cx = x * TILE + H;
  const cy = y * TILE + H;
  const { forward, right } = offsetFrom(pose, cx, cy);
  // In the origin's frame (facing east), the tile's centre is `forward` east and `right` south.
  const tx = C + Math.floor(forward / TILE);
  const ty = C + Math.floor((right + H) / TILE);
  if (Math.abs(tx - C) <= TABLE_RADIUS && Math.abs(ty - C) <= TABLE_RADIUS) {
    const side = 2 * C + 1;
    const v = bounds.cover[ty * side + tx] as number;
    if (v !== UNSET) return v;
  }
  return Math.max(10, normBound(forward, right));
}

/** At least what a leg from `pose` costs to end exactly on `goal` (x, y and direction) on the flat. */
export function poseBound(bounds: Bounds, pose: Pose, goal: Pose): number {
  const { forward, right } = offsetFrom(pose, goal.x, goal.y);
  const hx = 2 * C + forward / H;
  const hy = 2 * C + 1 + right / H;
  const dir = (1 + goal.dir - pose.dir + 4) % 4;
  const tx = Math.floor(hx / 2);
  const ty = Math.floor(hy / 2);
  if (
    Number.isInteger(hx) &&
    Number.isInteger(hy) &&
    Math.abs(tx - C) <= TABLE_RADIUS &&
    Math.abs(ty - C) <= TABLE_RADIUS
  ) {
    const v = bounds.exact[poseIndex(hx, hy, dir)] as number;
    if (v !== UNSET) return v;
  }
  return normBound(forward, right);
}

/**
 * What climbing or dropping `steps` height steps adds at least to the flat bound: every slope
 * piece weighs at least 2 more than a straight and changes the height by at most 4 steps, so a
 * leg that must change height by `steps` has at least ceil(steps / 4) slope pieces.
 */
export function heightExtra(steps: number): number {
  return steps <= 0 ? 0 : 2 * Math.ceil(steps / 4);
}

/** Height steps between fixed-point heights. */
export function stepsBetween(z1: number, z2: number): number {
  return Math.abs(z1 - z2) / STEP;
}
