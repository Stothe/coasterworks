import {
  STEP,
  TILE,
  TRACK_PIECES,
  familyRefusesPiece,
  pieceById,
  pitchRise,
  type CoasterFamily,
  type TrackPiece,
} from "@coasterworks/content";
import type { World } from "../world/types.js";
import {
  placementRefusal,
  tileRefusal,
  TRACK_OUTSIDE,
  type PieceContext,
  type TrackBand,
} from "./occupancy.js";
import {
  applyPiece,
  endPose,
  localToWorld,
  pieceTiles,
  posesEqual,
  type PieceTile,
  type Pose,
} from "./pose.js";
import { MAX_TRACK_PIECES } from "./record.js";

// Point-driven building: lays track through a list of points with the piece table, the way a
// player drawing a course would want it, and says why a point cannot be reached.
//
// Reaching a point. A point is a tile (x, y) and a height in whole steps. A stretch of track (a
// "leg") reaches it when its last piece passes over that tile with the height inside the band it
// covers there (`pieceTiles`: for a flat piece its height, for a slope anything between its two
// ends). The leg ends at that piece's exit, facing whichever way the piece leaves. If the track
// already passes over the point with its last piece, the leg is empty. Closing the circuit is a
// leg of its own that must end exactly on the start pose (`circuitCloses` semantics).
//
// The search. Each leg is an A* search over join poses from where the track ends. A step lays
// one piece, and only if `placementRefusal` takes it: the same rule `coaster_add_piece` applies,
// with this fit's own pieces (earlier legs and the path being searched) checked for clearance
// exactly as built ones are, so the fitted list is what the piece commands accept one by one.
// The cost of a leg is the sum of its pieces' weights (`pieceWeight`): straight track is
// cheapest, then gentle slopes, steep slopes, large curves and small curves. Ties go to the
// deeper path, then to the path found first, which follows the piece table's order; nothing
// depends on floats, randomness or map iteration order. The heuristic is admissible (every
// piece weighs at least 10 per tile it moves along either axis and 4 per height step), and each
// leg stops after `MAX_EXPANSIONS` poses.
//
// What it lays: no station or brake pieces, and no banking (a track that ends banked is eased
// back to level first); banking is for the piece builder. Climbs before the track first drops
// after a lift are lift pieces, so a circuit that climbs above its station always has a lift
// hill; after that drop, climbs are plain slopes.

/** A point to reach: a tile and a height in whole height steps (the ground is the default). */
export interface FitPoint {
  x: number;
  y: number;
  height: number;
}

/** Where a fit starts: a coaster's track so far, and what placing its pieces needs. */
export interface FitStart {
  rideId: number;
  family: CoasterFamily;
  /** The pose the first station piece starts from. */
  start: Pose;
  /** The track before the fit, from the first station piece on. */
  pieces: readonly string[];
  /** How many of `pieces` are in the world's track index already (the rest are checked here). */
  laid: number;
  /** Tile indexes no track may cross: every entrance, exit and service tile, the coaster's own. */
  reserved: ReadonlySet<number>;
}

/** How one point (or the closing leg) went: reached or not, why not, and the pieces of its leg. */
export interface PointFit {
  ok: boolean;
  reason: string | null;
  pieces: number;
}

export interface FitResult {
  /** The pieces the fit lays, in order, after `FitStart.pieces`. Only legs that succeeded. */
  pieces: string[];
  points: PointFit[];
  /** The closing leg, when one was asked for. */
  close: PointFit | null;
  /** True when every point (and the close) was reached. */
  ok: boolean;
}

export const TOO_STEEP = "Too steep to reach";
export const TOO_TIGHT = "Too tight a turn";
export const NO_FIT = "No track fits here";
export const FIX_EARLIER = "Fix the point before this one";

/** Most poses one leg's search expands before it gives up. */
export const MAX_EXPANSIONS = 20_000;
/** What ending a leg facing away from the next point costs (see `endPenalty` in `fitPoints`). */
export const BEHIND_PENALTY = 40;
export const TIGHT_PENALTY = 400;
/** Height steps a leg may climb above the higher of its two ends, to clear paths or itself. */
export const FIT_HEADROOM = 10;

/**
 * The cost of laying `piece` in a fit: straight 10, gentle slopes and unbanking 12, steep slopes
 * 16, large curves 28, small curves 32. A lift piece weighs what its plain slope does. Every
 * piece weighs at least 10 for each tile it moves the track along either axis (a large curve
 * moves 2.5, a small one 1.5) and 4 for each height step it climbs, which the heuristic uses.
 */
export function pieceWeight(piece: TrackPiece): number {
  switch (piece.kind) {
    case "straight":
    case "station":
    case "brake":
      return 10;
    case "curve_large":
      return 28;
    case "curve_small":
      return 32;
    case "bank":
      return 12;
    default:
      return Math.max(Math.abs(piece.entry.pitch), Math.abs(piece.exit.pitch)) >= 2 ? 16 : 12;
  }
}

const isUp = (p: TrackPiece) => p.entry.pitch > 0 || p.exit.pitch > 0;
const isDown = (p: TrackPiece) => p.entry.pitch < 0 || p.exit.pitch < 0;

/** Lift state along a track: 0 no lift yet, 1 on or after a lift, 2 dropped after a lift. */
type LiftState = 0 | 1 | 2;

function advanceLift(state: LiftState, piece: TrackPiece): LiftState {
  if (piece.flags.lift) return state === 2 ? 2 : 1;
  if (state === 1 && isDown(piece)) return 2;
  return state;
}

interface Candidate {
  piece: TrackPiece;
  weight: number;
  up: boolean;
}

/** The pieces a fit may lay for `family`, in piece table order. */
function candidatesFor(family: CoasterFamily): Candidate[] {
  const out: Candidate[] = [];
  for (const piece of TRACK_PIECES) {
    if (piece.flags.station || piece.flags.brake) continue;
    if (familyRefusesPiece(family, piece) !== null) continue;
    const e = Math.abs(piece.entry.bank);
    const x = Math.abs(piece.exit.bank);
    if (!(e === 0 && x === 0) && !(x < e)) continue;
    out.push({ piece, weight: pieceWeight(piece), up: isUp(piece) });
  }
  return out;
}

/** The tile a join pose faces into. */
function frontTile(pose: Pose): { x: number; y: number } {
  const { dx, dy } = localToWorld(pose.dir, TILE / 2, 0);
  return { x: Math.floor((pose.x + dx) / TILE), y: Math.floor((pose.y + dy) / TILE) };
}

/** Forward and right offsets of point (px, py) from `pose`, in its own frame. */
function localOffset(pose: Pose, px: number, py: number): { forward: number; right: number } {
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
 * The least and most a track can climb (in steps) over `tiles` straight tiles from pitch `pitch`,
 * changing pitch by at most one level a tile, within `maxPitch`; ending flat when `endFlat`.
 */
function riseRange(
  tiles: number,
  pitch: number,
  maxPitch: number,
  endFlat: boolean,
): { lo: number; hi: number } | null {
  let lo: (number | null)[] = [null, null, null, null, null];
  let hi: (number | null)[] = [null, null, null, null, null];
  lo[pitch + 2] = 0;
  hi[pitch + 2] = 0;
  for (let k = 0; k < tiles; k++) {
    const nlo: (number | null)[] = [null, null, null, null, null];
    const nhi: (number | null)[] = [null, null, null, null, null];
    for (let a = -2; a <= 2; a++) {
      const l = lo[a + 2];
      const h = hi[a + 2];
      if (l === null || l === undefined || h === null || h === undefined) continue;
      for (let b = a - 1; b <= a + 1; b++) {
        if (Math.abs(b) > maxPitch) continue;
        const rise = (pitchRise(a) + pitchRise(b)) / 2;
        const cl = nlo[b + 2];
        const ch = nhi[b + 2];
        if (cl === null || cl === undefined || l + rise < cl) nlo[b + 2] = l + rise;
        if (ch === null || ch === undefined || h + rise > ch) nhi[b + 2] = h + rise;
      }
    }
    lo = nlo;
    hi = nhi;
  }
  let outLo: number | null = null;
  let outHi: number | null = null;
  for (let p = -2; p <= 2; p++) {
    if (endFlat && p !== 0) continue;
    const l = lo[p + 2];
    const h = hi[p + 2];
    if (l === null || l === undefined || h === null || h === undefined) continue;
    if (outLo === null || l < outLo) outLo = l;
    if (outHi === null || h > outHi) outHi = h;
  }
  return outLo === null || outHi === null ? null : { lo: outLo, hi: outHi };
}

/** A pose reached by the search, and how it got there. */
interface Node {
  pose: Pose;
  key: number;
  g: number;
  f: number;
  seq: number;
  parent: Node | null;
  piece: TrackPiece | null;
  /** Pieces in the whole track once this node's piece is laid. */
  n: number;
  /** This node's piece's bands, by tile index. */
  bands: { tile: number; band: TrackBand }[];
  lift: LiftState;
  goal: boolean;
}

function before(a: Node, b: Node): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.g !== b.g) return a.g > b.g;
  return a.seq < b.seq;
}

/** A binary min-heap of nodes ordered by `before`. */
class Heap {
  private items: Node[] = [];
  get size(): number {
    return this.items.length;
  }
  push(node: Node): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!before(items[i] as Node, items[up] as Node)) break;
      [items[i], items[up]] = [items[up] as Node, items[i] as Node];
      i = up;
    }
  }
  pop(): Node | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && before(items[l] as Node, items[m] as Node)) m = l;
        if (r < items.length && before(items[r] as Node, items[m] as Node)) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m] as Node, items[i] as Node];
        i = m;
      }
    }
    return top;
  }
}

/** A number unique to a search state: the join pose and the lift state. */
function stateKey(pose: Pose, lift: LiftState): number {
  const hx = pose.x / (TILE / 2);
  const hy = pose.y / (TILE / 2);
  const z = Math.min(1023, pose.z / STEP);
  return ((((((hx * 1024 + hy) * 1024 + z) * 4 + pose.dir) * 5 + pose.pitch + 2) * 5 +
    pose.bank +
    2) *
    3 +
    lift) as number;
}

/** What a leg aims for: a point to pass over, or the start pose to close on. */
type Goal = { kind: "point"; x: number; y: number; height: number } | { kind: "close" };

const EMPTY: readonly TrackBand[] = Object.freeze([]);

/**
 * Fits track through `points` in order from the end of `from`'s track, then (when `close`) back
 * to its start. Never changes the world. A failing point stops the fit: it and every later point
 * (and the close) are reported not ok, the later ones with `FIX_EARLIER`.
 */
export function fitPoints(
  world: World,
  from: FitStart,
  points: readonly FitPoint[],
  close: boolean,
): FitResult {
  const { family, start, rideId, reserved } = from;
  const width = world.terrain.width;
  const candidates = candidatesFor(family);
  const minRadius = Math.min(
    ...candidates.filter((c) => c.piece.shape === "arc").map((c) => Math.abs(c.piece.exit.forward)),
  );
  const uTurn = 2 * minRadius;

  const all: TrackPiece[] = from.pieces.map((id) => {
    const piece = pieceById(id);
    if (piece === undefined) throw new RangeError(`Unknown track piece "${id}"`);
    return piece;
  });
  // Bands of the pieces not in the world's index yet, by tile index.
  const pending = new Map<number, TrackBand[]>();
  const addPending = (pose: Pose, piece: TrackPiece, n: number) => {
    for (const t of pieceTiles(pose, piece)) {
      const tile = t.y * width + t.x;
      const band: TrackBand = { rideId, piece: n, zLo: t.zLo * STEP, zHi: t.zHi * STEP };
      const list = pending.get(tile);
      if (list === undefined) pending.set(tile, [band]);
      else list.push(band);
    }
  };
  let pose = start;
  let lift: LiftState = 0;
  for (const [n, piece] of all.entries()) {
    if (n >= from.laid) addPending(pose, piece, n);
    pose = applyPiece(pose, piece);
    lift = advanceLift(lift, piece);
  }

  const added: string[] = [];
  let closing: PointFit | null = null;
  const results: PointFit[] = [];
  let failed = false;

  const commit = (pieces: TrackPiece[]) => {
    for (const piece of pieces) {
      addPending(pose, piece, all.length);
      all.push(piece);
      added.push(piece.id);
      pose = applyPiece(pose, piece);
      lift = advanceLift(lift, piece);
    }
  };

  /** Does a piece ending at `exit` over `tiles` reach `goal`? */
  const covered = (exit: Pose, tiles: readonly PieceTile[], goal: Goal): boolean => {
    if (goal.kind === "close") return posesEqual(exit, start);
    for (const t of tiles) {
      if (t.x === goal.x && t.y === goal.y && t.zLo <= goal.height && goal.height <= t.zHi) {
        return true;
      }
    }
    return false;
  };

  const heuristic = (at: Pose, goal: Goal): number => {
    if (goal.kind === "close") {
      const cheb = Math.max(Math.abs(at.x - start.x), Math.abs(at.y - start.y));
      const dz = Math.abs(at.z - start.z) / STEP;
      return Math.max(Math.floor((cheb * 10) / TILE), 4 * dz);
    }
    const cx = goal.x * TILE + TILE / 2;
    const cy = goal.y * TILE + TILE / 2;
    const cheb = Math.max(Math.abs(at.x - cx), Math.abs(at.y - cy));
    // The piece that passes over the point starts near it: within half a tile of the tile's
    // centre for a straight or slope (weight at least 10), 1.5 tiles for a small curve (32) and
    // 2.5 for a large one (28). Getting there costs at least 10 a tile.
    const near = (reach: number, weight: number) =>
      weight + Math.floor((Math.max(0, cheb - reach) * 10) / TILE);
    const xy = Math.min(near(TILE / 2, 10), near((3 * TILE) / 2, 32), near((5 * TILE) / 2, 28));
    const z = 10 + 4 * Math.max(0, Math.abs(goal.height - at.z / STEP) - 4);
    return Math.max(xy, z);
  };

  /** Lays one leg toward `goal`: its pieces, or why it cannot be laid. */
  const leg = (goal: Goal, next: Goal | null): TrackPiece[] | string => {
    const goalZ = goal.kind === "close" ? start.z : goal.height * STEP;
    const zMax = Math.max(pose.z, goalZ) + FIT_HEADROOM * STEP;
    const target =
      goal.kind === "close"
        ? { x: start.x, y: start.y }
        : { x: goal.x * TILE + TILE / 2, y: goal.y * TILE + TILE / 2 };
    const offset = localOffset(pose, target.x, target.y);
    const behind = offset.forward < 0 && Math.abs(offset.right) < uTurn;

    const ids = all.map((p) => p.id);
    const heap = new Heap();
    const bestG = new Map<number, number>();
    let seq = 0;
    const root: Node = {
      pose,
      key: 2 * stateKey(pose, lift),
      g: 0,
      f: heuristic(pose, goal),
      seq: seq++,
      parent: null,
      piece: null,
      n: all.length,
      bands: [],
      lift,
      goal: false,
    };
    heap.push(root);
    bestG.set(root.key, 0);
    let closestH = root.f;
    let blocked: { h: number; reason: string } | null = null;
    let expanded = 0;

    while (heap.size > 0) {
      const node = heap.pop() as Node;
      if (node.g > (bestG.get(node.key) as number)) continue;
      if (node.goal) {
        const out: TrackPiece[] = [];
        for (let k: Node | null = node; k !== null && k.piece !== null; k = k.parent) {
          out.push(k.piece);
        }
        return out.reverse();
      }
      if (++expanded > MAX_EXPANSIONS) break;
      if (node.n >= MAX_TRACK_PIECES) continue;

      // The track this node stands for, and the bands of the path's own pieces by tile: built
      // the first time a piece needs placing from this node.
      let ctx: PieceContext | null = null;
      const context = (): PieceContext => {
        if (ctx !== null) return ctx;
        const chain: TrackPiece[] = [];
        const chainBands = new Map<number, TrackBand[]>();
        for (let k: Node | null = node; k !== null && k.piece !== null; k = k.parent) {
          chain.push(k.piece);
          for (const { tile, band } of k.bands) {
            const list = chainBands.get(tile);
            if (list === undefined) chainBands.set(tile, [band]);
            else list.push(band);
          }
        }
        ids.length = all.length;
        for (let i = chain.length - 1; i >= 0; i--) ids.push((chain[i] as TrackPiece).id);
        ctx = {
          rideId,
          family,
          start,
          pieces: ids,
          pose: node.pose,
          reserved,
          extra: (tile) => {
            const a = pending.get(tile);
            const b = chainBands.get(tile);
            if (a === undefined) return b ?? EMPTY;
            return b === undefined ? a : a.concat(b);
          },
        };
        return ctx;
      };

      for (const cand of candidates) {
        const piece = cand.piece;
        if (piece.entry.pitch !== node.pose.pitch || piece.entry.bank !== node.pose.bank) continue;
        // Climbs are lift pieces until the track first drops after its lift.
        if (cand.up && family.limits.lift && piece.flags.lift !== node.lift < 2) continue;
        const exit = applyPiece(node.pose, piece);
        if (exit.z > zMax) continue;
        const tiles = pieceTiles(node.pose, piece);
        const hit = covered(exit, tiles, goal);
        const childLift = advanceLift(node.lift, piece);
        // A goal state is kept apart from the same pose reached without passing the point.
        const key = 2 * stateKey(exit, childLift) + (hit ? 1 : 0);
        const g = node.g + cand.weight;
        const known = bestG.get(key);
        if (known !== undefined && known <= g) continue;
        const reason = placementRefusal(world, context(), piece);
        if (reason !== null) {
          const h = hit ? 0 : heuristic(exit, goal);
          if (blocked === null || h < blocked.h) blocked = { h, reason };
          continue;
        }
        bestG.set(key, g);
        const h = hit ? endPenalty(exit, next) : heuristic(exit, goal);
        if (!hit && h < closestH) closestH = h;
        const n = node.n;
        heap.push({
          pose: exit,
          key,
          g,
          f: g + h,
          seq: seq++,
          parent: node,
          piece,
          n: n + 1,
          bands: tiles.map((t) => ({
            tile: t.y * width + t.x,
            band: { rideId, piece: n, zLo: t.zLo * STEP, zHi: t.zHi * STEP },
          })),
          lift: childLift,
          goal: hit,
        });
      }
    }
    if (blocked !== null && blocked.h < closestH) return blocked.reason;
    return behind ? TOO_TIGHT : NO_FIT;
  };

  /** Why `goal` cannot be reached from `pose`, found without a search; null if it may be. */
  const precheck = (goal: Goal): string | null => {
    const t = world.terrain;
    const front = frontTile(pose);
    let tx: number;
    let ty: number;
    let dz: number;
    let tiles: number;
    let px: number;
    let py: number;
    if (goal.kind === "point") {
      tx = goal.x;
      ty = goal.y;
      if (tx < 1 || ty < 1 || tx > t.width - 2 || ty > t.height - 2) return TRACK_OUTSIDE;
      const ground = tileRefusal(world, reserved, tx, ty, goal.height);
      if (ground !== null) return ground;
      dz = goal.height - pose.z / STEP;
      tiles = Math.abs(tx - front.x) + Math.abs(ty - front.y) + 1;
      px = tx * TILE + TILE / 2;
      py = ty * TILE + TILE / 2;
    } else {
      const startTile = frontTile(start);
      dz = (start.z - pose.z) / STEP;
      tiles = Math.abs(startTile.x - front.x) + Math.abs(startTile.y - front.y);
      px = start.x;
      py = start.y;
    }
    const offset = localOffset(pose, px, py);
    if (offset.forward < 0 && Math.abs(offset.right) < uTurn) return TOO_TIGHT;
    const range = riseRange(tiles, pose.pitch, family.limits.maxPitch, goal.kind === "close");
    if (range === null || dz < range.lo || dz > range.hi) return TOO_STEEP;
    return null;
  };

  /**
   * What a leg ending at `at` adds for the leg after it, toward `next`: nothing when `next` is
   * ahead, `BEHIND_PENALTY` when the track must turn back to it, and `TIGHT_PENALTY` when it
   * would be too tight a turn. This is how a corner point gets a curve through it rather than
   * track running on past it.
   */
  const endPenalty = (at: Pose, next: Goal | null): number => {
    if (next === null) return 0;
    const [px, py] =
      next.kind === "close"
        ? [start.x, start.y]
        : [next.x * TILE + TILE / 2, next.y * TILE + TILE / 2];
    const offset = localOffset(at, px, py);
    if (offset.forward >= 0) return 0;
    return Math.abs(offset.right) < uTurn ? TIGHT_PENALTY : BEHIND_PENALTY;
  };

  const run = (goal: Goal, next: Goal | null): PointFit => {
    if (failed) return { ok: false, reason: FIX_EARLIER, pieces: 0 };
    const last = all[all.length - 1];
    if (goal.kind === "point" && last !== undefined) {
      const lastStart = endPose(
        start,
        all.slice(0, -1).map((p) => p.id),
      );
      if (covered(applyPiece(lastStart, last), pieceTiles(lastStart, last), goal))
        return { ok: true, reason: null, pieces: 0 };
    }
    if (goal.kind === "close" && posesEqual(pose, start)) {
      return { ok: true, reason: null, pieces: 0 };
    }
    const early = precheck(goal);
    const found = early ?? leg(goal, next);
    if (typeof found === "string") {
      failed = true;
      return { ok: false, reason: found, pieces: 0 };
    }
    commit(found);
    return { ok: true, reason: null, pieces: found.length };
  };

  const goals: Goal[] = points.map((p) => ({ kind: "point", x: p.x, y: p.y, height: p.height }));
  if (close) goals.push({ kind: "close" });
  for (const [i, goal] of goals.entries()) {
    const fit = run(goal, goals[i + 1] ?? null);
    if (goal.kind === "point") results.push(fit);
    else closing = fit;
  }
  return { pieces: added, points: results, close: closing, ok: !failed };
}
