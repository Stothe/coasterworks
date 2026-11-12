import type { Terrain, World } from "../world/types.js";
import { PATH_NONE } from "./paths.js";

/** The distance in a field for a tile the target cannot be walked to. */
export const UNREACHABLE = 0xffff;

/** Fewest and most distance fields a cache keeps at once; see `fieldCacheCapacity`. */
export const MIN_FIELD_CACHE = 64;
export const MAX_FIELD_CACHE = 512;
/** Tiles' worth of distance fields a cache may hold: 8 million, 16 MB of `Uint16Array`. */
export const FIELD_CACHE_TILES = 8_000_000;

/**
 * How many distance fields a cache on a `width` by `height` map keeps at once: as many as fit in
 * `FIELD_CACHE_TILES` tiles, but no fewer than 64 and no more than 512. A 64 by 64 park keeps 512,
 * a 256 by 256 one (the largest map) 122. Adding one more evicts the one used least recently.
 */
export function fieldCacheCapacity(width: number, height: number): number {
  const fit = Math.floor(FIELD_CACHE_TILES / Math.max(1, width * height));
  return Math.min(MAX_FIELD_CACHE, Math.max(MIN_FIELD_CACHE, fit));
}

/**
 * A flood from several targets at once (see `RouteCache.multiSourceField`): for every tile the
 * steps to the nearest of them, and the owner of the one that claimed it.
 */
export interface MultiSourceField {
  /** Steps to the nearest target, `UNREACHABLE` where there is none. */
  dist: Uint16Array;
  /** The owner given for that target, 0 where there is none. */
  owner: Int32Array;
}

/** Whether tile `index`, known to be on the map, has a path on it or is accepted by `extra`. */
function isOpen(
  path: Uint8Array,
  extra: ((index: number) => boolean) | null,
  index: number,
): boolean {
  return (path[index] as number) !== PATH_NONE || (extra !== null && extra(index));
}

/** A cached field, and when it was last asked for. */
interface CachedField {
  field: Uint16Array;
  /** The value of the cache's use clock the last time this field was returned. */
  used: number;
}

/**
 * Distance fields over the path network: for one target tile, the number of steps from every other
 * tile to it. Guests follow a field downhill, so finding a way costs one flood fill per target
 * rather than one search per guest.
 *
 * A tile is walkable if it has a path or a queue on it, or if the `extraWalkable` predicate says
 * so. The park entrance has no path on it but guests start and end their visit there, so whoever
 * owns the cache passes a predicate that accepts the entrance tile. Steps go to the four
 * neighbours, never diagonally and never across the end of a row, and ignore height.
 *
 * Fields are keyed by target and kept until the paths change. Call `sync(world)` before using the
 * cache on each tick: it compares `world.pathVersion` with the one it last saw and throws every
 * field away when they differ. Nothing here makes a command bump `pathVersion`; that is up to the
 * commands that change paths or the entrance.
 *
 * A field is allocated when it is first asked for, once per target and path version, and is never
 * modified or reused afterwards, so one a caller still holds after the cache has dropped it is
 * simply out of date. Treat fields as read-only. Once a field is cached, asking for it again,
 * `nextStep` and `reachable` on it, and `nearestPathTile` allocate nothing. How many fields are
 * kept depends on the size of the map (see `fieldCacheCapacity`).
 *
 * Two more kinds of answer share the flood: `multiSourceField` floods from many targets at once
 * (the guests' way to the nearest of many stalls, without a field for each), and `component`
 * labels the connected pieces of the network, so whether one tile can reach another is a lookup.
 */
export class RouteCache {
  private terrain: Terrain;
  private extraWalkable: ((index: number) => boolean) | null;
  /** Breadth-first search queue; every tile goes on it at most once per flood fill. */
  private queue: Int32Array;
  private readonly fields = new Map<number, CachedField>();
  /** Counts uses of fields, to find the least recent one. */
  private clock = 0;
  private seenVersion = -1;
  /** What `distanceField` answers for a target that is not walkable; built when first needed. */
  private unreachableField: Uint16Array | null = null;
  /** Fields kept at most; fixed if the constructor was given it, else from the map's size. */
  private readonly fixedCapacity: number | null;
  private fieldCapacity: number;
  /** Connected pieces of the walkable tiles (see `component`); built when first needed. */
  private components: Int32Array | null = null;

  /**
   * @param terrain The terrain whose `path` layer to route over. `sync` re-points the cache at a
   * replaced world's terrain.
   * @param extraWalkable Tiles to treat as walkable although they have no path, by flat index.
   * Normally the park entrance.
   * @param capacity Fields to keep at most. Defaults to `fieldCacheCapacity` for the map, and
   * follows the map when `sync` swaps in another.
   */
  constructor(terrain: Terrain, extraWalkable?: (index: number) => boolean, capacity?: number) {
    this.terrain = terrain;
    this.extraWalkable = extraWalkable ?? null;
    this.queue = new Int32Array(terrain.width * terrain.height);
    this.fixedCapacity = capacity ?? null;
    this.fieldCapacity = capacity ?? fieldCacheCapacity(terrain.width, terrain.height);
  }

  /** Most fields the cache keeps at once. */
  get capacity(): number {
    return this.fieldCapacity;
  }

  /**
   * The `world.pathVersion` the cache last synced to, or -1 if it has not synced yet. Fields asked
   * for before the first sync are dropped by it.
   */
  get pathVersion(): number {
    return this.seenVersion;
  }

  /** How many fields are cached. */
  get size(): number {
    return this.fields.size;
  }

  /**
   * Brings the cache up to date with `world`: drops every field if the paths or the entrance have
   * changed since the last sync, or if the world has a different terrain (as after `replaceWorld`
   * in the sim). Cheap when nothing changed. A predicate given here replaces the one the cache had;
   * it does not by itself drop anything, because a changed entrance bumps `pathVersion` anyway and
   * a caller may well pass a new closure on every tick.
   */
  sync(world: World, extraWalkable?: (index: number) => boolean): void {
    if (extraWalkable !== undefined) this.extraWalkable = extraWalkable;
    if (world.terrain !== this.terrain) {
      this.terrain = world.terrain;
      const tiles = world.terrain.width * world.terrain.height;
      if (this.queue.length !== tiles) this.queue = new Int32Array(tiles);
      this.unreachableField = null;
      this.fieldCapacity =
        this.fixedCapacity ?? fieldCacheCapacity(world.terrain.width, world.terrain.height);
      this.invalidate();
    }
    if (world.pathVersion !== this.seenVersion) {
      this.seenVersion = world.pathVersion;
      this.invalidate();
    }
  }

  /**
   * Drops every cached field, and the components. For a path change `sync` could not see, such as
   * a test's own edit.
   */
  invalidate(): void {
    this.fields.clear();
    this.components = null;
  }

  /** Whether the field for `targetIndex` is cached. Does not count as a use. */
  has(targetIndex: number): boolean {
    return this.fields.has(targetIndex);
  }

  /**
   * For every tile, in row-major order, the number of steps to `targetIndex` along walkable
   * tiles, or `UNREACHABLE` if there is no way. The target itself is 0. A target that is not
   * walkable, or not on the map, gives a field that is `UNREACHABLE` everywhere; that one is not
   * cached.
   */
  distanceField(targetIndex: number): Uint16Array {
    const cached = this.fields.get(targetIndex);
    if (cached !== undefined) {
      cached.used = ++this.clock;
      return cached.field;
    }
    if (!this.isWalkable(targetIndex)) return this.emptyField();
    while (this.fields.size >= this.fieldCapacity) this.evictLeastRecentlyUsed();
    const field = this.flood(targetIndex);
    this.fields.set(targetIndex, { field, used: ++this.clock });
    return field;
  }

  /**
   * The neighbour of `fromIndex` one step closer to `targetIndex`: the one with the smallest
   * distance, which must be less than that of `fromIndex`. Ties go to the first of north, east,
   * south, west. -1 if `fromIndex` is already at the target, cannot reach it, or is not on the map.
   */
  nextStep(fromIndex: number, targetIndex: number): number {
    return this.downhill(this.distanceField(targetIndex), fromIndex);
  }

  /**
   * The neighbour of `fromIndex` one step down `field` (a distance field, or the `dist` of a
   * multi-source one): the one with the smallest distance, which must be less than that of
   * `fromIndex`. Ties go to the first of north, east, south, west. -1 if `fromIndex` is at a
   * target (0), cannot reach one, or is not on the map.
   */
  downhill(field: Uint16Array, fromIndex: number): number {
    if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= field.length) return -1;
    const own = field[fromIndex] as number;
    if (own === UNREACHABLE || own === 0) return -1;

    const { width, height } = this.terrain;
    const y = Math.floor(fromIndex / width);
    const x = fromIndex - y * width;
    let best = -1;
    let bestDistance = own;
    if (y > 0) {
      const d = field[fromIndex - width] as number;
      if (d < bestDistance) {
        best = fromIndex - width;
        bestDistance = d;
      }
    }
    if (x < width - 1) {
      const d = field[fromIndex + 1] as number;
      if (d < bestDistance) {
        best = fromIndex + 1;
        bestDistance = d;
      }
    }
    if (y < height - 1) {
      const d = field[fromIndex + width] as number;
      if (d < bestDistance) {
        best = fromIndex + width;
        bestDistance = d;
      }
    }
    if (x > 0) {
      const d = field[fromIndex - 1] as number;
      if (d < bestDistance) best = fromIndex - 1;
    }
    return best;
  }

  /** Whether there is a way from `fromIndex` to `targetIndex`. A walkable tile reaches itself. */
  reachable(fromIndex: number, targetIndex: number): boolean {
    const field = this.distanceField(targetIndex);
    if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= field.length) return false;
    return field[fromIndex] !== UNREACHABLE;
  }

  /**
   * Which connected piece of the walkable tiles tile `index` is in: two walkable tiles have the
   * same number exactly when there is a way between them. -1 for a tile that is not walkable or not
   * on the map. The labels are worked out once (one pass over the map) and kept until the paths
   * change, so this is the cheap way to ask whether one tile can reach another without a field.
   */
  component(index: number): number {
    if (!this.isWalkable(index)) return -1;
    if (this.components === null) this.components = this.label();
    return this.components[index] as number;
  }

  /**
   * One flood from several targets at once: `targets[k]` is claimed for `owners[k]`, and every
   * walkable tile gets the steps to the nearest target and the owner of the one it is nearest to.
   * Targets that are not walkable are skipped. The flood is breadth-first and seeded in the order
   * given, so where two targets are equally near the one given first claims the tile: given in
   * ascending owner order, a tie goes to the lowest owner. (Each ring of the flood is in owner
   * order, because each tile's neighbours are queued in the order the tile came off the queue.)
   * The result is new and is not cached here; the caller keeps it as long as it holds.
   */
  multiSourceField(targets: ArrayLike<number>, owners: ArrayLike<number>): MultiSourceField {
    const { width, height } = this.terrain;
    const dist = new Uint16Array(width * height).fill(UNREACHABLE);
    const owner = new Int32Array(width * height);
    const queue = this.queue;
    let tail = 0;
    for (let k = 0; k < targets.length; k++) {
      const target = targets[k] as number;
      if (!this.isWalkable(target) || dist[target] !== UNREACHABLE) continue;
      dist[target] = 0;
      owner[target] = owners[k] as number;
      queue[tail++] = target;
    }
    this.spread(dist, owner, tail);
    return { dist, owner };
  }

  /**
   * The flat index of the walkable tile nearest to tile (x, y), searching square rings of
   * increasing Chebyshev radius from 0 to `maxRadius`. Within a ring the first tile in row-major
   * order wins. -1 if there is none, or if x or y is not an integer. (x, y) may be off the map.
   */
  nearestPathTile(x: number, y: number, maxRadius = 8): number {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return -1;
    const { width, height } = this.terrain;
    // No ring beyond the farthest corner of the map holds a tile, so an infinite radius ends.
    const farthest = Math.max(
      Math.abs(x),
      Math.abs(x - (width - 1)),
      Math.abs(y),
      Math.abs(y - (height - 1)),
    );
    const limit = Math.min(maxRadius, farthest);
    for (let r = 0; r <= limit; r++) {
      for (let ty = Math.max(y - r, 0); ty <= Math.min(y + r, height - 1); ty++) {
        // The top and bottom rows of a ring are whole; the rows between have only the two ends.
        const wholeRow = ty === y - r || ty === y + r;
        const stride = wholeRow ? 1 : 2 * r;
        for (let tx = x - r; tx <= x + r; tx += stride) {
          if (tx < 0 || tx >= width) continue;
          const index = ty * width + tx;
          if (this.isWalkable(index)) return index;
        }
      }
    }
    return -1;
  }

  /** Whether tile `index` is on the map and has a path on it or is accepted by the predicate. */
  private isWalkable(index: number): boolean {
    const { path, width, height } = this.terrain;
    if (!Number.isInteger(index) || index < 0 || index >= width * height) return false;
    return isOpen(path, this.extraWalkable, index);
  }

  /** The field for a target nobody can walk to: `UNREACHABLE` on every tile, shared by all of them. */
  private emptyField(): Uint16Array {
    if (this.unreachableField === null) {
      const { width, height } = this.terrain;
      this.unreachableField = new Uint16Array(width * height).fill(UNREACHABLE);
    }
    return this.unreachableField;
  }

  private evictLeastRecentlyUsed(): void {
    let oldestKey = -1;
    let oldestUse = Number.POSITIVE_INFINITY;
    for (const [key, cached] of this.fields) {
      if (cached.used < oldestUse) {
        oldestKey = key;
        oldestUse = cached.used;
      }
    }
    this.fields.delete(oldestKey);
  }

  /**
   * Breadth-first search outward from `target`, which must be walkable. A tile is claimed the first
   * time it is reached, so its distance is its shortest. The longest shortest path on a 256x256
   * map is well under 65535 steps, so `UNREACHABLE` is never a real distance.
   */
  private flood(target: number): Uint16Array {
    const { width, height } = this.terrain;
    const field = new Uint16Array(width * height).fill(UNREACHABLE);
    field[target] = 0;
    this.queue[0] = target;
    this.spread(field, null, 1);
    return field;
  }

  /**
   * The breadth-first search behind every flood: `queue[0..tail)` holds the tiles already claimed
   * (distance 0), and each tile taken off the queue claims its unclaimed walkable neighbours, north,
   * east, south, west, at one step more, for the same owner if there are owners. Returns how many
   * tiles the queue ended with: every tile claimed, the first ones included.
   */
  private spread(field: Uint16Array, owner: Int32Array | null, tail: number): number {
    const { path, width, height } = this.terrain;
    const extra = this.extraWalkable;
    const queue = this.queue;
    let head = 0;
    while (head < tail) {
      const i = queue[head++] as number;
      const next = (field[i] as number) + 1;
      const who = owner === null ? 0 : (owner[i] as number);
      const y = Math.floor(i / width);
      const x = i - y * width;
      // North, east, south, west. An unclaimed tile is `UNREACHABLE` until it is claimed.
      let n = i - width;
      if (y > 0 && field[n] === UNREACHABLE && isOpen(path, extra, n)) {
        field[n] = next;
        if (owner !== null) owner[n] = who;
        queue[tail++] = n;
      }
      n = i + 1;
      if (x < width - 1 && field[n] === UNREACHABLE && isOpen(path, extra, n)) {
        field[n] = next;
        if (owner !== null) owner[n] = who;
        queue[tail++] = n;
      }
      n = i + width;
      if (y < height - 1 && field[n] === UNREACHABLE && isOpen(path, extra, n)) {
        field[n] = next;
        if (owner !== null) owner[n] = who;
        queue[tail++] = n;
      }
      n = i - 1;
      if (x > 0 && field[n] === UNREACHABLE && isOpen(path, extra, n)) {
        field[n] = next;
        if (owner !== null) owner[n] = who;
        queue[tail++] = n;
      }
    }
    return tail;
  }

  /** Labels every walkable tile with its connected piece (numbered from 0 in tile order), -1 else. */
  private label(): Int32Array {
    const { width, height } = this.terrain;
    const tiles = width * height;
    const labels = new Int32Array(tiles).fill(-1);
    // A scratch field for the floods: each piece is flooded once, and its tiles stay claimed.
    const field = new Uint16Array(tiles).fill(UNREACHABLE);
    const queue = this.queue;
    let piece = 0;
    for (let start = 0; start < tiles; start++) {
      if (field[start] !== UNREACHABLE || !this.isWalkable(start)) continue;
      field[start] = 0;
      queue[0] = start;
      // The flood leaves the tiles it claimed, this piece and only this piece, on the queue.
      const claimed = this.spread(field, null, 1);
      for (let k = 0; k < claimed; k++) labels[queue[k] as number] = piece;
      piece++;
    }
    return labels;
  }
}
