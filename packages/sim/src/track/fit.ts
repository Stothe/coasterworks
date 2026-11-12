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
  tilesRefusal,
  tileRefusal,
  TRACK_OUTSIDE,
  type TileContext,
  type TrackBand,
} from "./occupancy.js";
import {
  boundsFor,
  coverBound,
  heightExtra,
  poseBound,
  stepsBetween,
  type Bounds,
} from "./fit-bounds.js";
import {
  applyPiece,
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
// one piece, and only if `placementRefusal` takes it (its tile rule, `tilesRefusal`, the other
// rules holding for every piece the fit tries): the same rule `coaster_add_piece` applies,
// with this fit's own pieces (earlier legs and the path being searched) checked for clearance
// exactly as built ones are, so the fitted list is what the piece commands accept one by one.
// The cost of a leg is the sum of its pieces' weights (`pieceWeight`): straight track is
// cheapest, then gentle slopes, steep slopes, large curves and small curves. Ties go to the
// deeper path, then to the path found first, which follows the piece table's order; nothing
// depends on floats, randomness or map iteration order. The heuristic is admissible: the exact
// cost of the same leg on an empty flat plane (`track/fit-bounds.ts`, which knows the turns a
// point behind or beside the track needs), plus what its height change costs at least.
//
// Bounds on the work. One leg expands at most `MAX_EXPANSIONS` poses, and a whole fit at most
// `MAX_FIT_EXPANSIONS`. When a leg's cap is reached the best leg to the point found so far (if
// any) is taken, so a reachable point is not refused just because proving the best leg is the
// best takes long; when the whole fit's budget runs out first the point is refused with
// `TOO_LONG` (so however many points a course has, a fit's work stays bounded). A leg's result is kept (see `legMemos`) for the same track, points and world, so a
// preview whose last point moves does not fit the earlier legs again; what a kept leg cost is
// still charged to the budget, so a fit gives the same answer whether or not it was kept.
//
// Refusals. Before searching, a point off the map, on a tile track cannot use, or higher or lower
// than the direct (Manhattan) room to it allows is refused (`TOO_STEEP`): the fitter takes the
// direct room, by design, and a climb that needs a detour needs a point on the detour. A search
// that finds nothing reports `TOO_TIGHT` when the point is behind the track and nearer its line
// than a U-turn is wide (the track could not turn round to it), else the nearest placement that
// was refused, else `NO_FIT`. The U-turn geometry is never a refusal by itself: a point behind
// the track is searched for like any other, and a loop round to it is laid when there is room.
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
  /** How much work the fit took (for tests and tuning; nothing depends on it). */
  work: FitWork;
}

export interface FitWork {
  /** Poses charged against `MAX_FIT_EXPANSIONS`, kept legs included: the same however kept. */
  charged: number;
  /** Poses this call expanded itself (kept legs not searched again expand none). */
  searched: number;
  /** Legs that reached their cap and took the best leg found by then. */
  capped: number;
}

export const TOO_STEEP = "Too steep to reach";
export const TOO_TIGHT = "Too tight a turn";
export const NO_FIT = "No track fits here";
export const FIX_EARLIER = "Fix the point before this one";
export const TOO_LONG = "The course is too long to fit at once; build it in parts";
/** A point the track passes over already: reached, with no pieces (`coaster_extend_to` refuses). */
export const ALREADY_REACHED = "The track already reaches that point";

/** Most poses one leg's search expands before it takes the best leg it has, if any. */
export const MAX_EXPANSIONS = 20_000;
/** Most poses one whole fit (every leg of one `fitPoints` call) expands. */
export const MAX_FIT_EXPANSIONS = 50_000;
/** What ending a leg facing away from the next point costs (see `endPenalty` in `fitPoints`). */
export const BEHIND_PENALTY = 40;
export const TIGHT_PENALTY = 400;
/** The least a slope or unbanking piece weighs (see `pieceWeight`). */
const FORCED_WEIGHT = 12;
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
  /** A 64-bit filter (two words) of the tiles this node's path covers, by `tileBit`. */
  seenLo: number;
  seenHi: number;
}

/** Which of 64 filter bits tile index `tile` sets. */
function tileBit(tile: number): number {
  return Math.imul(tile, 0x9e3779b1) >>> 26;
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

/** Smaller bounds on a fit's work than the usual ones, for tests. */
export interface FitLimits {
  /** Poses the whole fit may expand (`MAX_FIT_EXPANSIONS`). */
  budget?: number;
  /** Poses one leg may expand before it takes the best leg it has (`MAX_EXPANSIONS`). */
  legCap?: number;
}

/** How one leg's search went. */
interface LegOutcome {
  /** The leg's pieces, or why there is none. */
  result: TrackPiece[] | string;
  /** Poses it expanded: what it is charged against the fit's budget. */
  expansions: number;
  /** True when it stopped because the fit's budget ran out (such an outcome is not kept). */
  starved: boolean;
  /** True when it reached its cap and took the best leg found by then. */
  capped: boolean;
}

/**
 * Kept leg outcomes, per world. A leg depends on the world only through what placing a piece
 * reads (terrain, water, paths, rides and their access tiles, the park entrance and track), and
 * every change to those is a command; every command, undo and redo moves `worldStamp` (and the
 * ride and path commands also move it when applied directly), and a stamp that moved drops them
 * all.
 */
const legMemos = new WeakMap<World, { stamp: string; legs: Map<string, LegOutcome> }>();
const MAX_KEPT_LEGS = 4096;

/**
 * A text that changes with every logged command, undo and redo (`nextId`) and with every ride,
 * coaster or path change (`rideVersion`, `pathVersion`, the counts): what a kept fit is checked
 * against before it is used again.
 */
export function worldStamp(world: World): string {
  const t = world.terrain;
  return [
    world.nextId,
    world.rideVersion,
    world.pathVersion,
    world.rides.length,
    world.tracks.length,
    world.nextRideId,
    t.width,
    t.height,
  ].join(":");
}

function legsOf(world: World): Map<string, LegOutcome> {
  const stamp = worldStamp(world);
  let memo = legMemos.get(world);
  if (memo === undefined || memo.stamp !== stamp || memo.legs.size >= MAX_KEPT_LEGS) {
    memo = { stamp, legs: new Map() };
    legMemos.set(world, memo);
  }
  return memo.legs;
}

const poseText = (p: Pose) => `${p.x},${p.y},${p.z},${p.dir},${p.pitch},${p.bank}`;
const goalText = (g: Goal | null) =>
  g === null ? "-" : g.kind === "close" ? "close" : `${g.x},${g.y},${g.height}`;

/** The pieces from the start of a search to `node`, in order. */
function pathTo(node: Node): TrackPiece[] {
  const out: TrackPiece[] = [];
  for (let k: Node | null = node; k !== null && k.piece !== null; k = k.parent) out.push(k.piece);
  return out.reverse();
}

/**
 * Fits track through `points` in order from the end of `from`'s track, then (when `close`) back
 * to its start. Never changes the world. A failing point stops the fit: it and every later point
 * (and the close) are reported not ok, the later ones with `FIX_EARLIER`. A point the track
 * already passes over with its last piece is ok with no pieces and the reason `ALREADY_REACHED`.
 */
export function fitPoints(
  world: World,
  from: FitStart,
  points: readonly FitPoint[],
  close: boolean,
  limits: FitLimits = {},
): FitResult {
  const { family, start, rideId, reserved } = from;
  const width = world.terrain.width;
  const candidates = candidatesFor(family);
  const curves = candidates.filter(
    (c) => c.piece.shape === "arc" && c.piece.entry.bank === 0 && c.piece.exit.bank === 0,
  );
  const bounds: Bounds = boundsFor(curves);
  // The candidates by the pitch and bank they start from.
  const byEntry = new Map<number, Candidate[]>();
  for (const c of candidates) {
    const k = (c.piece.entry.pitch + 2) * 5 + c.piece.entry.bank + 2;
    const list = byEntry.get(k);
    if (list === undefined) byEntry.set(k, [c]);
    else list.push(c);
  }
  const following = (at: Pose): readonly Candidate[] =>
    byEntry.get((at.pitch + 2) * 5 + at.bank + 2) ?? [];
  const minRadius = Math.min(...curves.map((c) => Math.abs(c.piece.exit.forward)));
  const uTurn = 2 * minRadius;
  const legCap = limits.legCap ?? MAX_EXPANSIONS;
  // Kept legs are only for the usual per-leg cap (a kept outcome depends on it).
  const legs = legCap === MAX_EXPANSIONS ? legsOf(world) : new Map<string, LegOutcome>();
  const fixedKey = [
    family.id,
    rideId,
    poseText(start),
    from.laid,
    [...reserved].sort((a, b) => a - b).join(","),
  ].join("|");
  let budget = limits.budget ?? MAX_FIT_EXPANSIONS;
  const work: FitWork = { charged: 0, searched: 0, capped: 0 };

  const all: TrackPiece[] = from.pieces.map((id) => {
    const piece = pieceById(id);
    if (piece === undefined) throw new RangeError(`Unknown track piece "${id}"`);
    return piece;
  });
  // Bands of the pieces not in the world's index yet, by tile index.
  const pending = new Map<number, TrackBand[]>();
  const addPending = (at: Pose, piece: TrackPiece, n: number) => {
    for (const t of pieceTiles(at, piece)) {
      const tile = t.y * width + t.x;
      const band: TrackBand = { rideId, piece: n, zLo: t.zLo * STEP, zHi: t.zHi * STEP };
      const list = pending.get(tile);
      if (list === undefined) pending.set(tile, [band]);
      else list.push(band);
    }
  };
  let pose = start;
  /** Where the track's last piece starts (null before it has any). */
  let lastFrom: Pose | null = null;
  let lift: LiftState = 0;
  for (const [n, piece] of all.entries()) {
    if (n >= from.laid) addPending(pose, piece, n);
    lastFrom = pose;
    pose = applyPiece(pose, piece);
    lift = advanceLift(lift, piece);
  }
  let trackText = all.map((p) => p.id).join(",");

  const added: string[] = [];
  let closing: PointFit | null = null;
  const results: PointFit[] = [];
  let failed = false;

  const commit = (pieces: TrackPiece[]) => {
    for (const piece of pieces) {
      addPending(pose, piece, all.length);
      all.push(piece);
      added.push(piece.id);
      trackText += `,${piece.id}`;
      lastFrom = pose;
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

  /**
   * At least what reaching `goal` from `at` costs (see `track/fit-bounds.ts`). For a point, the
   * last piece changes the height by at most 4 steps, so the pieces before it change it by at
   * least the rest; each step costs at least 4 (a steep slope climbs 4 for 16).
   */
  const heuristic = (at: Pose, goal: Goal): number => {
    if (goal.kind === "close") {
      const steps = stepsBetween(at.z, start.z);
      return Math.max(flatBound(at, goal) + heightExtra(steps), 4 * steps);
    }
    const steps = Math.max(0, Math.abs(goal.height - at.z / STEP) - 4);
    return Math.max(flatBound(at, goal) + heightExtra(steps), 10 + 4 * steps);
  };

  /**
   * The flat part of the bound. A track that ends sloped or banked cannot curve until it is level
   * again, and each piece changes its pitch or bank by one level, so its next |pitch| + |bank|
   * pieces run straight on, at 12 or more each (slopes and unbanking): either one of them passes
   * over the point, or the bound from where they end applies after them.
   */
  const flatBound = (at: Pose, goal: Goal): number => {
    const forced = Math.abs(at.pitch) + Math.abs(at.bank);
    if (forced > 0) {
      const ahead = localToWorld(at.dir, 1, 0);
      if (goal.kind === "point") {
        const front = frontTile(at);
        for (let j = 0; j < forced; j++) {
          if (front.x + j * ahead.dx === goal.x && front.y + j * ahead.dy === goal.y) {
            return FORCED_WEIGHT * (j + 1);
          }
        }
      }
      const on: Pose = {
        ...at,
        x: at.x + ahead.dx * TILE * forced,
        y: at.y + ahead.dy * TILE * forced,
        pitch: 0,
        bank: 0,
      };
      return FORCED_WEIGHT * forced + flatBound(on, goal);
    }
    return goal.kind === "close"
      ? poseBound(bounds, at, start)
      : coverBound(bounds, at, goal.x, goal.y);
  };

  /** Searches one leg toward `goal`, expanding at most `cap` poses. */
  const leg = (goal: Goal, next: Goal | null, cap: number): LegOutcome => {
    const goalZ = goal.kind === "close" ? start.z : goal.height * STEP;
    const zMax = Math.max(pose.z, goalZ) + FIT_HEADROOM * STEP;
    const target =
      goal.kind === "close"
        ? { x: start.x, y: start.y }
        : { x: goal.x * TILE + TILE / 2, y: goal.y * TILE + TILE / 2 };
    const offset = localOffset(pose, target.x, target.y);
    const behind = offset.forward < 0 && Math.abs(offset.right) < uTurn;

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
      seenLo: 0,
      seenHi: 0,
    };
    heap.push(root);

    // Rules 1 to 3 of `placementRefusal` hold for every candidate here (the family has it, it
    // follows the pitch and bank, and every pose is a join pose), so only rule 4 is checked;
    // `coaster_build_from_points` checks every rule again when it builds. The bands of the
    // path's own pieces are found by walking back from the node being expanded (`current`),
    // when its filter says the tile may be among them.
    let current: Node = root;
    const scratch: TrackBand[] = [];
    const ctx: TileContext = {
      rideId,
      start,
      reserved,
      extra: (tile) => {
        const a = pending.get(tile);
        const bit = tileBit(tile);
        const word = bit < 32 ? current.seenLo : current.seenHi;
        if ((word & (1 << (bit & 31))) === 0) return a ?? EMPTY;
        scratch.length = 0;
        if (a !== undefined) for (const band of a) scratch.push(band);
        for (let k: Node | null = current; k !== null && k.piece !== null; k = k.parent) {
          for (const b of k.bands) if (b.tile === tile) scratch.push(b.band);
        }
        return scratch;
      },
    };
    bestG.set(root.key, 0);
    let closestH = root.f;
    let blocked: { h: number; reason: string } | null = null;
    let expanded = 0;
    let stopped = false;
    let bestGoal: Node | null = null;

    while (heap.size > 0) {
      const node = heap.pop() as Node;
      if (node.g > (bestG.get(node.key) as number)) continue;
      if (node.goal) {
        return { result: pathTo(node), expansions: expanded, starved: false, capped: false };
      }
      if (expanded >= cap) {
        stopped = true;
        break;
      }
      expanded++;
      if (node.n >= MAX_TRACK_PIECES) continue;

      current = node;
      for (const cand of following(node.pose)) {
        const piece = cand.piece;
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
        const reason = tilesRefusal(world, ctx, node.n, tiles, exit);
        if (reason !== null) {
          const h = hit ? 0 : heuristic(exit, goal);
          if (blocked === null || h < blocked.h) blocked = { h, reason };
          continue;
        }
        bestG.set(key, g);
        const h = hit ? endPenalty(exit, tiles, next) : heuristic(exit, goal);
        if (!hit && h < closestH) closestH = h;
        const n = node.n;
        let seenLo = node.seenLo;
        let seenHi = node.seenHi;
        for (const t of tiles) {
          const bit = tileBit(t.y * width + t.x);
          if (bit < 32) seenLo |= 1 << bit;
          else seenHi |= 1 << (bit & 31);
        }
        const child: Node = {
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
          seenLo,
          seenHi,
        };
        heap.push(child);
        if (hit && (bestGoal === null || before(child, bestGoal))) bestGoal = child;
      }
    }
    // Stopped early: the best leg found so far, if there is one, is good enough.
    const starved = stopped && cap < legCap;
    if (stopped && bestGoal !== null) {
      return { result: pathTo(bestGoal), expansions: expanded, starved, capped: true };
    }
    if (starved) return { result: TOO_LONG, expansions: expanded, starved, capped: false };
    let reason: string;
    if (behind) reason = TOO_TIGHT;
    else if (blocked !== null && blocked.h < closestH) reason = blocked.reason;
    else reason = NO_FIT;
    return { result: reason, expansions: expanded, starved: false, capped: false };
  };

  /**
   * Why `goal` cannot be reached from `pose`, found without a search; null if it may be. Only
   * the direct room counts: the tiles from the one the track faces into to the point's (or, to
   * close, to the one just behind the station) by the shortest grid path, as if straight. A climb
   * that needs a longer way round is refused here on purpose; a point on the way round gives it
   * the room.
   */
  const precheck = (goal: Goal): string | null => {
    const t = world.terrain;
    const front = frontTile(pose);
    let dz: number;
    let tiles: number;
    if (goal.kind === "point") {
      const { x, y } = goal;
      if (x < 1 || y < 1 || x > t.width - 2 || y > t.height - 2) return TRACK_OUTSIDE;
      const ground = tileRefusal(world, reserved, x, y, goal.height);
      if (ground !== null) return ground;
      dz = goal.height - pose.z / STEP;
      tiles = Math.abs(x - front.x) + Math.abs(y - front.y) + 1;
    } else {
      // The closing leg's last piece ends on the station's start, so it lays the tile behind it.
      const back = localToWorld(start.dir, -TILE / 2, 0);
      const last = {
        x: Math.floor((start.x + back.dx) / TILE),
        y: Math.floor((start.y + back.dy) / TILE),
      };
      dz = (start.z - pose.z) / STEP;
      tiles = Math.abs(last.x - front.x) + Math.abs(last.y - front.y) + 1;
    }
    const range = riseRange(tiles, pose.pitch, family.limits.maxPitch, goal.kind === "close");
    if (range === null || dz < range.lo || dz > range.hi) return TOO_STEEP;
    return null;
  };

  /**
   * What a leg ending at `at` adds for the leg after it, toward `next`: nothing when `next` is
   * ahead, `BEHIND_PENALTY` when the track must turn back to it, and `TIGHT_PENALTY` when it
   * would be too tight a turn. This is how a corner point gets a curve through it rather than
   * track running on past it. Nothing either when the leg's last piece, over `tiles`, reaches
   * `next` too (the next leg is then empty).
   */
  const endPenalty = (at: Pose, tiles: readonly PieceTile[], next: Goal | null): number => {
    if (next === null || covered(at, tiles, next)) return 0;
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
    if (goal.kind === "point" && last !== undefined && lastFrom !== null) {
      if (covered(pose, pieceTiles(lastFrom, last), goal)) {
        return { ok: true, reason: ALREADY_REACHED, pieces: 0 };
      }
    }
    if (goal.kind === "close" && posesEqual(pose, start)) {
      return { ok: true, reason: null, pieces: 0 };
    }
    const early = precheck(goal);
    if (early !== null) {
      failed = true;
      return { ok: false, reason: early, pieces: 0 };
    }
    // The same leg from the same track in the same world is searched once (see `legMemos`). A
    // kept outcome is used only when the budget left would have let the search run as far.
    const key = `${fixedKey}|${trackText}|${goalText(goal)}|${goalText(next)}`;
    let outcome = legs.get(key);
    if (outcome === undefined || outcome.expansions > budget) {
      outcome = leg(goal, next, Math.min(legCap, budget));
      work.searched += outcome.expansions;
      if (!outcome.starved) legs.set(key, outcome);
    }
    budget -= outcome.expansions;
    work.charged += outcome.expansions;
    if (outcome.capped) work.capped++;
    const found = outcome.result;
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
  return { pieces: added, points: results, close: closing, ok: !failed, work };
}
