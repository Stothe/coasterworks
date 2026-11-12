import type { EntrancePlace } from "../context.js";
import { LAND_REACH, distanceOutside } from "./land.js";
import { fbm2, hash2, noise2, smoothstep } from "./noise.js";
import { BIRCH, BUSH, OAK, ROCK, SPRUCE, type SceneryKind } from "./shapes.js";

/**
 * Where everything on the land beyond the park stands: which trees, bushes and rocks, where, how
 * big, turned which way and tinted how.
 *
 * It is all worked out from the coordinates: a lattice of cells laid over the world, one
 * candidate per cell at a place inside it picked by a hash, kept or dropped by comparing another
 * hash with how wooded the land is there. Woods are where a slow noise runs high, so trees stand
 * in clumps with clearings between, and the bar is lower the further from the park, so the land
 * is open parkland near the fence and forest toward the horizon. Nothing here depends on the
 * park's ground, only on its size, so digging in the park never moves a tree, and the same park
 * has the same woods in every session.
 */

/** Trees keep this far from the park's edge, so no canopy hangs over the boundary. */
export const TREE_MARGIN = 2.4;
/** Bushes and rocks may come this close: just clear of the boundary marker. */
export const SMALL_MARGIN = 1.15;
/** Bushes and rocks are too small to see further out than this, so there are none. */
export const SMALL_REACH = 46;

/**
 * Trees further from the park than this are drawn larger and stand further apart: out there a
 * wood is seen as a mass, and fewer, bigger crowns make the same mass for less.
 */
export const FAR_TREES_FROM = 96;

/** Everything scattered around one park, as parallel arrays with one entry per thing. */
export interface Scatter {
  count: number;
  kind: Uint8Array;
  /** Any byte; whoever draws takes it modulo the number of models it has. */
  variant: Uint8Array;
  /** World position, and tiles outside the park. */
  x: Float32Array;
  z: Float32Array;
  distance: Float32Array;
  /** Scale across and scale upward, as multiples of the model. */
  size: Float32Array;
  tall: Float32Array;
  /** Turn about the vertical, radians. */
  turn: Float32Array;
  /** What the model's colors are multiplied by, three floats each. */
  tint: Float32Array;
  /**
   * A number in 0..1 that says how soon the thing goes when there is less to spend: a lower
   * quality draws only those below its share.
   */
  rank: Float32Array;
}

const SEED = 5309;

/** How wooded the land is at (`x`, `z`), `d` tiles from the park: 0 open, 1 forest. */
export function woodedAt(x: number, z: number, d: number): number {
  const broad = fbm2(x / 62 + 11.3, z / 62 - 4.7, 3, SEED);
  const ragged = noise2(x / 9.5, z / 9.5, SEED + 1);
  // Near the park only the strongest of the noise makes a copse; far out nearly all of it does.
  const bar = 0.3 - 0.52 * smoothstep(5, 80, d);
  return smoothstep(bar - 0.07, bar + 0.07, broad + 0.2 * ragged);
}

/** A number in 0..1 from a cell and a channel. */
const chance = (ix: number, iz: number, channel: number) =>
  hash2(ix, iz, SEED + channel * 7919) / 4294967296;

/** Picks what kind of tree grows at (`x`, `z`). */
function treeKindAt(
  x: number,
  z: number,
  wooded: number,
  pick: number,
  lone: boolean,
): SceneryKind {
  // A fifth of the trees are whatever they like, so no wood is all of one kind.
  if (pick < 0.2) return pick < 0.07 ? OAK : pick < 0.14 ? BIRCH : SPRUCE;
  const dark = fbm2(x / 88 - 21, z / 88 + 37, 2, SEED + 2);
  const pale = noise2(x / 38 + 5, z / 38 - 9, SEED + 3);
  // Spruce keeps to stands of its own; birch likes the edges of woods and open ground.
  if (dark + (pick - 0.5) * 0.2 > 0.04 && !lone) return SPRUCE;
  if (pale > 0.2 || (wooded < 0.55 && pick > 0.6)) return BIRCH;
  return OAK;
}

/** How far out the cleared way reaches, and how wide it is by the gate, in tiles. */
export const LANE_LENGTH = 22;
export const LANE_HALF_WIDTH = 2.6;

/**
 * Whether (`x`, `z`) lies on the way in to the entrance of a `width` by `height` park: the strip
 * the lane runs out along, which is kept clear of everything, wide by the gate and narrowing
 * further out.
 */
export function onLane(
  width: number,
  height: number,
  entrance: EntrancePlace | null,
  x: number,
  z: number,
): boolean {
  if (!entrance) return false;
  // How far out from the entrance's edge, and how far off the lane's middle.
  let out: number;
  let off: number;
  switch (entrance.side) {
    case 0:
      out = -z;
      off = x - (entrance.x + 0.5);
      break;
    case 1:
      out = x - width;
      off = z - (entrance.y + 0.5);
      break;
    case 2:
      out = z - height;
      off = x - (entrance.x + 0.5);
      break;
    default:
      out = -x;
      off = z - (entrance.y + 0.5);
  }
  if (out < -1 || out > LANE_LENGTH) return false;
  const half = LANE_HALF_WIDTH - Math.max(0, out - LANE_LENGTH * 0.5) * 0.14;
  return Math.abs(off) < half;
}

/**
 * Scatters trees, bushes and rocks around a `width` by `height` park, from just outside its edge
 * to `reach` tiles out. Deterministic: the same park size gives the same scatter.
 */
export function scatterScenery(width: number, height: number, reach = LAND_REACH): Scatter {
  const kind: number[] = [];
  const variant: number[] = [];
  const xs: number[] = [];
  const zs: number[] = [];
  const distance: number[] = [];
  const size: number[] = [];
  const tall: number[] = [];
  const turn: number[] = [];
  const tint: number[] = [];
  const rank: number[] = [];

  const put = (
    k: SceneryKind,
    ix: number,
    iz: number,
    channel: number,
    x: number,
    z: number,
    d: number,
    across: number,
    up: number,
  ): void => {
    kind.push(k);
    variant.push(Math.floor(chance(ix, iz, channel + 1) * 256));
    xs.push(x);
    zs.push(z);
    distance.push(d);
    size.push(across);
    tall.push(up);
    turn.push(chance(ix, iz, channel + 2) * Math.PI * 2);
    rank.push(chance(ix, iz, channel + 3));
    if (k === ROCK) {
      const grey = 0.82 + 0.36 * chance(ix, iz, channel + 4);
      tint.push(grey * 1.02, grey, grey * 0.97);
      return;
    }
    // Neighbors share a cast (a warmer or a cooler green), and each tree has a little of its own.
    const cast =
      0.9 * noise2(x / 27 + 3, z / 27 + 8, SEED + 4) + 1.7 * (chance(ix, iz, channel + 4) - 0.5);
    const warm = Math.max(-1, Math.min(1, cast));
    const bright = 0.74 + 0.4 * chance(ix, iz, channel + 5);
    tint.push(bright * (1 + 0.3 * warm), bright * (1 + 0.06 * warm), bright * (1 - 0.26 * warm));
  };

  /** Visits every cell of a lattice of `cell`-tile cells that can hold a point within `far`. */
  const lattice = (
    cell: number,
    far: number,
    channel: number,
    visit: (ix: number, iz: number, x: number, z: number, d: number) => void,
  ): void => {
    const ix0 = Math.floor(-far / cell);
    const ix1 = Math.floor((width + far) / cell);
    const iz0 = Math.floor(-far / cell);
    const iz1 = Math.floor((height + far) / cell);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        // Anywhere in the cell but its very rim, so two neighbors never stand on one spot.
        const x = (ix + 0.08 + 0.84 * chance(ix, iz, channel + 8)) * cell;
        const z = (iz + 0.08 + 0.84 * chance(ix, iz, channel + 9)) * cell;
        const d = distanceOutside(width, height, x, z);
        if (d > 0 && d <= far) visit(ix, iz, x, z, d);
      }
    }
  };

  const tree = (far: boolean) => (ix: number, iz: number, x: number, z: number, d: number) => {
    const channel = far ? 40 : 0;
    if (d < TREE_MARGIN || far !== d >= FAR_TREES_FROM) return;
    const wooded = woodedAt(x, z, d);
    // Outside the woods a tree stands alone here and there, fewer right by the park.
    const alone = 0.012 + 0.03 * smoothstep(4, 30, d);
    const share = Math.max(wooded * 0.9, alone);
    if (chance(ix, iz, channel) >= share) return;
    const lone = wooded < 0.3;
    const k = treeKindAt(x, z, wooded, chance(ix, iz, channel + 6), lone);
    const grown = chance(ix, iz, channel + 7);
    // Trees standing alone have had room to spread; far ones are drawn larger and fewer.
    const across = (lone ? 1.0 : 0.74) + 0.56 * grown * grown + (far ? 0.28 : 0);
    const up = across * (0.86 + 0.36 * chance(ix, iz, channel + 10));
    put(k, ix, iz, channel + 20, x, z, d, across, up);
  };
  lattice(1.72, Math.min(reach, FAR_TREES_FROM), 0, tree(false));
  lattice(2.45, reach, 40, tree(true));

  lattice(1.25, Math.min(reach, SMALL_REACH), 80, (ix, iz, x, z, d) => {
    if (d < SMALL_MARGIN) return;
    const wooded = woodedAt(x, z, d);
    // Thickest along the edge of a wood, a few under the trees, the odd one in the open.
    const edge = wooded * (1 - wooded) * 4;
    const share = 0.014 + 0.36 * edge + 0.07 * wooded;
    if (chance(ix, iz, 80) >= share) return;
    const across = 0.75 + 0.85 * chance(ix, iz, 86);
    put(BUSH, ix, iz, 100, x, z, d, across, across * (0.8 + 0.4 * chance(ix, iz, 87)));
  });

  lattice(1.9, Math.min(reach, SMALL_REACH), 120, (ix, iz, x, z, d) => {
    if (d < SMALL_MARGIN) return;
    // Rocks lie in a few stony patches and almost nowhere else.
    const stony = smoothstep(0.34, 0.56, noise2(x / 13 + 31, z / 13 - 12, SEED + 5));
    if (chance(ix, iz, 120) >= 0.006 + 0.3 * stony) return;
    const big = chance(ix, iz, 126);
    const across = 0.45 + 1.5 * big * big;
    put(ROCK, ix, iz, 140, x, z, d, across, across * (0.8 + 0.5 * chance(ix, iz, 127)));
  });

  return {
    count: kind.length,
    kind: Uint8Array.from(kind),
    variant: Uint8Array.from(variant),
    x: Float32Array.from(xs),
    z: Float32Array.from(zs),
    distance: Float32Array.from(distance),
    size: Float32Array.from(size),
    tall: Float32Array.from(tall),
    turn: Float32Array.from(turn),
    tint: Float32Array.from(tint),
    rank: Float32Array.from(rank),
  };
}
