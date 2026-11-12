import type { EntrancePlace } from "../context.js";

/**
 * The path layer as a signed distance field, which is what lets the shader draw paths with round,
 * smooth edges instead of tile squares.
 *
 * The shape of the paths is a skeleton grown by `PATH_HALF_WIDTH`. The skeleton is the center point
 * of every path tile, the straight segment between the centers of every two path tiles that share
 * an edge, and the filled square between the centers of every 2 by 2 block of path tiles (which is
 * what makes a plaza solid). So a lone tile is a round pad, a run is a band with round ends, a bend
 * has a round outside, and the paths never leave their own tiles: the edge is 0.1 of a tile inside
 * the tile's border.
 *
 * The field has `PATH_TEXELS` texels to a tile and two bytes to a texel:
 *
 * - R: the signed distance to the edge of that shape, in tiles, negative inside, mapped so that
 *   -0.5 is 0 and +0.5 is 255 (the edge itself falls between 127 and 128). Read with linear
 *   filtering, `r - 0.5` is the distance in tiles.
 * - G: the kind of path: 0 footpath, 255 queue. Every texel of a path tile holds that tile's kind,
 *   so the two kinds meet on the tile border.
 *
 * It covers the map and `PATH_MARGIN` tiles around it. The entrance lane, `PATH_LANE` tiles of
 * footpath straight out of the map from the entrance tile, is part of it.
 *
 * The distance is exact, then smoothed over about a texel. The smoothing leaves a straight edge
 * where it is and turns the sharp inside corner of a bend or a junction into a small fillet, so
 * the edge has no corner anywhere.
 *
 * Baking is a table lookup. What the field looks like inside one tile depends only on the 3 by 3
 * tiles around it: which of them are paths settles the distance (512 cases), and their kinds
 * settle the kind. Each case is worked out the first time it is met and copied from then on. A
 * bake compares the new path layer with the one baked last and writes only the tiles whose
 * surroundings changed.
 */

/** Texels of field along one edge of a tile. */
export const PATH_TEXELS = 8;

/** How many tiles of lane run out of the map from the entrance. */
export const PATH_LANE = 6;

/**
 * How many tiles beyond the map's edge the field covers, on every side: the lane and one tile of
 * open ground past its end.
 */
export const PATH_MARGIN = PATH_LANE + 1;

/** Half the width of a path, in tiles: how far the edge is from the skeleton. */
export const PATH_HALF_WIDTH = 0.4;

/** Bytes per texel: distance, kind. */
const CHANNELS = 2;

/** Skeleton distances are held to this, in tiles. It is what the 3 by 3 tiles around can vouch for. */
const FAR = 1;

/** Texels the smoothing reaches to each side. */
const REACH = 2;

/** The smoothing kernel across `2 * REACH + 1` texels: a binomial, about one texel wide. */
const KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16] as const;

/** One step out of the map through each side, as (dx, dy). */
const OUTWARD: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** A rectangle of texels: `x`, `y` is its north-west texel. */
export interface TexelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The baked field and what it was baked from. Made by `createPathField`. */
export interface PathField {
  /** Two bytes per texel (distance, kind), row by row from the north-west texel. */
  data: Uint8Array;
  /** Texels along X. */
  width: number;
  /** Texels along Z. */
  height: number;
  /** Tiles the field covers along X: the map's width and the margin on both sides. */
  tilesX: number;
  /** Tiles the field covers along Z. */
  tilesY: number;
  /** The map's own size in tiles. */
  mapWidth: number;
  mapHeight: number;
  /**
   * The path kinds `data` was last baked from, one byte per covered tile (0 none, 1 footpath,
   * 2 queue), lane included.
   */
  kinds: Uint8Array;
  /** Where the next bake lays out its kinds before comparing; swapped with `kinds` after. */
  spare: Uint8Array;
}

/** The squared distance from (`px`, `pz`) to the segment from (`ax`, `az`) to (`bx`, `bz`). */
function segmentDistanceSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const ex = bx - ax;
  const ez = bz - az;
  const k = Math.min(1, Math.max(0, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez)));
  const dx = px - (ax + ex * k);
  const dz = pz - (az + ez * k);
  return dx * dx + dz * dz;
}

/**
 * The distance from (`px`, `pz`) to the skeleton of the paths in a 3 by 3 block of tiles, held to
 * `FAR`. The point is in the coordinates of the middle tile, which spans 0..1 on both axes. Bit
 * `(dy + 1) * 3 + (dx + 1)` of `mask` says whether the tile at offset (`dx`, `dy`) is a path.
 */
function skeletonDistance(mask: number, px: number, pz: number): number {
  const has = (dx: number, dy: number) => (mask >> ((dy + 1) * 3 + dx + 1)) & 1;
  let best = FAR * FAR;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!has(dx, dy)) continue;
      const cx = dx + 0.5;
      const cz = dy + 0.5;
      const east = dx < 1 && has(dx + 1, dy) === 1;
      const south = dy < 1 && has(dx, dy + 1) === 1;
      if (east && south && has(dx + 1, dy + 1)) {
        // The filled square between four centers.
        const ox = Math.max(cx - px, 0, px - cx - 1);
        const oz = Math.max(cz - pz, 0, pz - cz - 1);
        best = Math.min(best, ox * ox + oz * oz);
      }
      if (east) best = Math.min(best, segmentDistanceSq(px, pz, cx, cz, cx + 1, cz));
      if (south) best = Math.min(best, segmentDistanceSq(px, pz, cx, cz, cx, cz + 1));
      best = Math.min(best, (px - cx) * (px - cx) + (pz - cz) * (pz - cz));
    }
  }
  return Math.sqrt(best);
}

/** Bytes in one tile's worth of field: `PATH_TEXELS` squared texels of two bytes. */
const BLOCK = PATH_TEXELS * PATH_TEXELS * CHANNELS;

/** The distance bytes of one tile for each 3 by 3 mask, made on first use. */
const tileBytes: (Uint8Array | undefined)[] = [];
for (let mask = 0; mask < 512; mask++) tileBytes.push(undefined);

/**
 * The `PATH_TEXELS` squared distance bytes of the middle tile of a 3 by 3 block with the paths of
 * `mask`. The exact distance is taken on the tile's texels and `REACH` more to every side (all of
 * which the block settles on its own: anything further off is at least `FAR` away), smoothed, and
 * packed. Neighboring tiles agree on the texels they share a view of, so the tiles join without a
 * seam.
 */
function tileDistanceBytes(mask: number): Uint8Array {
  const known = tileBytes[mask];
  if (known) return known;
  const span = PATH_TEXELS + 2 * REACH;
  const exact = new Float64Array(span * span);
  for (let j = 0; j < span; j++) {
    for (let i = 0; i < span; i++) {
      const px = (i - REACH + 0.5) / PATH_TEXELS;
      const pz = (j - REACH + 0.5) / PATH_TEXELS;
      exact[j * span + i] = skeletonDistance(mask, px, pz) - PATH_HALF_WIDTH;
    }
  }
  // Along X into `span` rows of `PATH_TEXELS`, then along Z.
  const rows = new Float64Array(span * PATH_TEXELS);
  for (let j = 0; j < span; j++) {
    for (let i = 0; i < PATH_TEXELS; i++) {
      let sum = 0;
      for (let k = 0; k < KERNEL.length; k++) {
        sum += (KERNEL[k] as number) * (exact[j * span + i + k] as number);
      }
      rows[j * PATH_TEXELS + i] = sum;
    }
  }
  const bytes = new Uint8Array(PATH_TEXELS * PATH_TEXELS);
  for (let j = 0; j < PATH_TEXELS; j++) {
    for (let i = 0; i < PATH_TEXELS; i++) {
      let sum = 0;
      for (let k = 0; k < KERNEL.length; k++) {
        sum += (KERNEL[k] as number) * (rows[(j + k) * PATH_TEXELS + i] as number);
      }
      bytes[j * PATH_TEXELS + i] = Math.min(255, Math.max(0, Math.round(sum * 255 + 127.5)));
    }
  }
  tileBytes[mask] = bytes;
  return bytes;
}

/**
 * What a tile's texels depend on, in one number: the kinds of the 3 by 3 tiles around it, two
 * bits each, row by row from the north-west (so the tile's own kind is bits 8 and 9). Tiles off
 * the field count as open.
 */
function neighborhood(
  kinds: Uint8Array,
  tilesX: number,
  tilesY: number,
  tx: number,
  ty: number,
): number {
  const at = ty * tilesX + tx;
  if (tx > 0 && ty > 0 && tx < tilesX - 1 && ty < tilesY - 1) {
    const north = at - tilesX;
    const south = at + tilesX;
    return (
      (kinds[north - 1] as number) |
      ((kinds[north] as number) << 2) |
      ((kinds[north + 1] as number) << 4) |
      ((kinds[at - 1] as number) << 6) |
      ((kinds[at] as number) << 8) |
      ((kinds[at + 1] as number) << 10) |
      ((kinds[south - 1] as number) << 12) |
      ((kinds[south] as number) << 14) |
      ((kinds[south + 1] as number) << 16)
    );
  }
  let around = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const y = ty + dy;
    if (y < 0 || y >= tilesY) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const x = tx + dx;
      if (x < 0 || x >= tilesX) continue;
      around |= (kinds[y * tilesX + x] as number) << (((dy + 1) * 3 + dx + 1) * 2);
    }
  }
  return around;
}

/** The low bit of every tile in a `neighborhood`: set for a footpath. */
const FOOTPATHS = 0x15555;
/** The high bit of every tile in a `neighborhood`: set for a queue. */
const QUEUES = 0x2aaaa;

/** One tile's texels, both channels, for each neighborhood met so far. */
const tileBlocks = new Map<number, Uint8Array>();

/**
 * The `BLOCK` bytes of a tile with the given `neighborhood`: its distance bytes, and its kind
 * bytes. A path tile carries its own kind on every texel. An open tile carries the kind of the
 * paths around it, so that the ground beside a path reads as that path's kind: where both kinds
 * are around, each texel takes the kind of the path tile whose center is nearest.
 */
function tileBlock(around: number): Uint8Array {
  const known = tileBlocks.get(around);
  if (known) return known;
  let mask = 0;
  for (let k = 0; k < 9; k++) if ((around >> (k * 2)) & 3) mask |= 1 << k;
  const bytes = tileDistanceBytes(mask);
  const own = (around >> 8) & 3;
  const queues = (around & QUEUES) !== 0;
  const footpaths = (around & FOOTPATHS) !== 0;
  const block = new Uint8Array(BLOCK);
  for (let j = 0; j < PATH_TEXELS; j++) {
    for (let i = 0; i < PATH_TEXELS; i++) {
      let queue = own === 2 || (own === 0 && queues && !footpaths);
      if (own === 0 && queues && footpaths) {
        const px = (i + 0.5) / PATH_TEXELS;
        const pz = (j + 0.5) / PATH_TEXELS;
        let best = Infinity;
        for (let k = 0; k < 9; k++) {
          const kind = (around >> (k * 2)) & 3;
          if (kind === 0) continue;
          const ox = px - ((k % 3) - 0.5);
          const oz = pz - (Math.floor(k / 3) - 0.5);
          const distance = ox * ox + oz * oz;
          if (distance < best) {
            best = distance;
            queue = kind === 2;
          }
        }
      }
      const at = (j * PATH_TEXELS + i) * CHANNELS;
      block[at] = bytes[j * PATH_TEXELS + i] as number;
      block[at + 1] = queue ? 255 : 0;
    }
  }
  tileBlocks.set(around, block);
  return block;
}

/**
 * An empty field for a `mapWidth` by `mapHeight` map: no paths anywhere. `bakePathField` fills it
 * in and keeps it up to date.
 */
export function createPathField(mapWidth: number, mapHeight: number): PathField {
  const tilesX = mapWidth + PATH_MARGIN * 2;
  const tilesY = mapHeight + PATH_MARGIN * 2;
  const width = tilesX * PATH_TEXELS;
  const height = tilesY * PATH_TEXELS;
  const data = new Uint8Array(width * height * CHANNELS);
  // Open ground everywhere: one texel written, then doubled up until the array is full.
  data[0] = 255;
  for (let filled = CHANNELS; filled < data.length; filled *= 2) {
    data.copyWithin(filled, 0, Math.min(filled, data.length - filled));
  }
  return {
    data,
    width,
    height,
    tilesX,
    tilesY,
    mapWidth,
    mapHeight,
    kinds: new Uint8Array(tilesX * tilesY),
    spare: new Uint8Array(tilesX * tilesY),
  };
}

/**
 * Lays the kinds of a path layer out over the field's tiles: the map's own paths (any byte other
 * than 0 or 2 is a footpath) and the lane. A `paths` of the wrong length for the map is taken as
 * none: it belongs to a terrain that is still on its way.
 */
function layKinds(
  field: PathField,
  paths: Uint8Array | null,
  entrance: EntrancePlace | null,
  out: Uint8Array,
): void {
  const { tilesX, mapWidth, mapHeight } = field;
  out.fill(0);
  if (paths && paths.length === mapWidth * mapHeight) {
    for (let y = 0; y < mapHeight; y++) {
      const row = (y + PATH_MARGIN) * tilesX + PATH_MARGIN;
      for (let x = 0; x < mapWidth; x++) {
        const kind = paths[y * mapWidth + x] as number;
        if (kind !== 0) out[row + x] = kind === 2 ? 2 : 1;
      }
    }
  }
  if (entrance) {
    const [dx, dy] = OUTWARD[entrance.side] as readonly [number, number];
    for (let step = 1; step <= PATH_LANE; step++) {
      const x = entrance.x + dx * step;
      const y = entrance.y + dy * step;
      // The lane is only ever outside the map: what is paved inside is the sim's to say.
      if (x >= 0 && y >= 0 && x < mapWidth && y < mapHeight) continue;
      const tx = x + PATH_MARGIN;
      const ty = y + PATH_MARGIN;
      // Never on the outermost ring, which stays open so that the field ends on open ground.
      if (tx < 1 || ty < 1 || tx >= tilesX - 1 || ty >= field.tilesY - 1) continue;
      out[ty * tilesX + tx] = 1;
    }
  }
}

/**
 * Brings `field` up to date with a path layer and an entrance. `paths` is the sim's layer, one
 * byte per map tile (0 none, 1 footpath, 2 queue), or null for none; `entrance` adds the lane.
 *
 * Only the tiles around those whose kind changed since the last bake are written, so a call while
 * a player drags a path costs a few tiles, and a call with nothing new costs one pass over the
 * tile kinds. Returns the texels that were written, as one rectangle, or null when nothing
 * changed.
 */
export function bakePathField(
  field: PathField,
  paths: Uint8Array | null,
  entrance: EntrancePlace | null,
): TexelRect | null {
  const { tilesX, tilesY, kinds, spare } = field;
  layKinds(field, paths, entrance, spare);
  let x0 = tilesX;
  let y0 = tilesY;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < tilesY; y++) {
    const row = y * tilesX;
    for (let x = 0; x < tilesX; x++) {
      if (kinds[row + x] === spare[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  field.kinds = spare;
  field.spare = kinds;
  if (x1 < 0) return null;
  // A tile's texels depend on the tiles next to it.
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(tilesX - 1, x1 + 1);
  y1 = Math.min(tilesY - 1, y1 + 1);
  const { data } = field;
  const stride = field.width * CHANNELS;
  const rowBytes = PATH_TEXELS * CHANNELS;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const around = neighborhood(spare, tilesX, tilesY, x, y);
      // Nothing around this tile changed, so neither did its texels.
      if (around === neighborhood(kinds, tilesX, tilesY, x, y)) continue;
      const block = tileBlock(around);
      let at = (y * PATH_TEXELS * field.width + x * PATH_TEXELS) * CHANNELS;
      let from = 0;
      for (let j = 0; j < PATH_TEXELS; j++) {
        for (let k = 0; k < rowBytes; k++) data[at + k] = block[from + k] as number;
        at += stride;
        from += rowBytes;
      }
    }
  }
  return {
    x: x0 * PATH_TEXELS,
    y: y0 * PATH_TEXELS,
    width: (x1 - x0 + 1) * PATH_TEXELS,
    height: (y1 - y0 + 1) * PATH_TEXELS,
  };
}

/** What `samplePathField` reads at a point. */
export interface PathSample {
  /** Signed distance to the edge of the paths in tiles, negative inside, within -0.5..0.5. */
  distance: number;
  /** 0 on or beside a footpath, 1 on or beside a queue, in between where the two meet. */
  queue: number;
}

/**
 * Reads the field at world (`x`, `z`) the way the shader does: linear filtering between texel
 * centers, held at the field's border. For tests and for anything on the CPU that wants to know
 * where the drawn paths are.
 */
export function samplePathField(field: PathField, x: number, z: number): PathSample {
  const { data, width, height } = field;
  const u = Math.min(width - 1, Math.max(0, (x + PATH_MARGIN) * PATH_TEXELS - 0.5));
  const v = Math.min(height - 1, Math.max(0, (z + PATH_MARGIN) * PATH_TEXELS - 0.5));
  const i0 = Math.min(width - 2, Math.floor(u));
  const j0 = Math.min(height - 2, Math.floor(v));
  const fu = u - i0;
  const fv = v - j0;
  const read = (channel: number) => {
    const at = (j0 * width + i0) * CHANNELS + channel;
    const below = at + width * CHANNELS;
    const top = (data[at] as number) * (1 - fu) + (data[at + CHANNELS] as number) * fu;
    const bottom = (data[below] as number) * (1 - fu) + (data[below + CHANNELS] as number) * fu;
    return (top * (1 - fv) + bottom * fv) / 255;
  };
  return { distance: read(0) - 0.5, queue: read(1) };
}
