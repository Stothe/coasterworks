import type { Entrance } from "../park/types.js";
import type { Rng } from "../rng.js";
import type { World } from "../world/types.js";
import {
  GUEST_ARRAYS,
  GUEST_CAP,
  GUEST_COLORS,
  GuestState,
  NO_TILE,
  type GuestArray,
  type GuestStore,
} from "./types.js";

/** Units in a tile; a guest's position is in these. */
export const TILE_UNITS = 32;
/** Half a tile: the offset from a tile's corner to its middle. */
const HALF_TILE = 16;

/** Units a guest walks in one tick. */
export const WALK_SPEED = 2;

/** An empty store: no guests, every slot free, the first guest to come will be number 1. */
export function createGuestStore(): GuestStore {
  const free = new Int32Array(GUEST_CAP);
  for (let i = 0; i < GUEST_CAP; i++) free[i] = GUEST_CAP - 1 - i;
  return {
    count: 0,
    nextGuestId: 1,
    fragmented: false,
    free,
    freeCount: GUEST_CAP,
    live: new Uint8Array(GUEST_CAP),
    id: new Int32Array(GUEST_CAP),
    x: new Int32Array(GUEST_CAP),
    y: new Int32Array(GUEST_CAP),
    tx: new Int32Array(GUEST_CAP),
    ty: new Int32Array(GUEST_CAP),
    dest: new Int32Array(GUEST_CAP),
    state: new Uint8Array(GUEST_CAP),
    happiness: new Uint8Array(GUEST_CAP),
    energy: new Uint8Array(GUEST_CAP),
    hunger: new Uint8Array(GUEST_CAP),
    thirst: new Uint8Array(GUEST_CAP),
    bathroom: new Uint8Array(GUEST_CAP),
    nausea: new Uint8Array(GUEST_CAP),
    cash: new Int32Array(GUEST_CAP),
    color: new Uint8Array(GUEST_CAP),
    name: new Uint16Array(GUEST_CAP),
    thought: new Uint8Array(GUEST_CAP),
    thoughtTick: new Int32Array(GUEST_CAP),
    sinceAction: new Int32Array(GUEST_CAP),
    lostTicks: new Int32Array(GUEST_CAP),
  };
}

/** The x of the lane tile outside the map next to the entrance: the one a guest comes in from. */
export function laneTileX(entrance: Entrance): number {
  return entrance.side === 1 ? entrance.x + 1 : entrance.side === 3 ? entrance.x - 1 : entrance.x;
}

/** The y of the lane tile outside the map next to the entrance. */
export function laneTileY(entrance: Entrance): number {
  return entrance.side === 0 ? entrance.y - 1 : entrance.side === 2 ? entrance.y + 1 : entrance.y;
}

/**
 * Starts a guest at the entrance: in the middle of the lane tile just outside the map on the
 * entrance's side, ENTERING, heading for the entrance tile, with needs drawn from `rng` in bands
 * (a little hungry or thirsty, well rested, in a fair mood), $20 to $80 in cash, a clothes colour,
 * and a name. Always draws the same number of values from `rng`. Returns the guest's slot, or -1 if
 * the park has no entrance or is already full.
 */
export function spawnGuest(world: World, rng: Rng): number {
  const g = world.guests;
  const entrance = world.park.entrance;
  if (entrance === null || g.count >= GUEST_CAP) return -1;

  const slot = g.free[--g.freeCount] as number;
  g.live[slot] = 1;
  g.count++;
  g.id[slot] = g.nextGuestId++;
  g.x[slot] = laneTileX(entrance) * TILE_UNITS + HALF_TILE;
  g.y[slot] = laneTileY(entrance) * TILE_UNITS + HALF_TILE;
  g.tx[slot] = entrance.x;
  g.ty[slot] = entrance.y;
  g.dest[slot] = entrance.y * world.terrain.width + entrance.x;
  g.state[slot] = GuestState.ENTERING;
  g.hunger[slot] = rng.int(80);
  g.thirst[slot] = rng.int(80);
  g.bathroom[slot] = rng.int(60);
  g.energy[slot] = 160 + rng.int(96);
  g.nausea[slot] = 0;
  g.happiness[slot] = 150 + rng.int(81);
  g.cash[slot] = 20_00 + rng.int(60_00 + 1);
  g.color[slot] = rng.int(GUEST_COLORS);
  g.name[slot] = rng.int(64) * 32 + rng.int(32);
  g.thought[slot] = 0;
  g.thoughtTick[slot] = 0;
  g.sinceAction[slot] = 0;
  g.lostTicks[slot] = 0;
  return slot;
}

/**
 * Takes a guest out of the store: its slot is free for the next arrival and `count` drops. The
 * slot's old values are left where they are and ignored. A slot that holds no guest is left alone.
 * This leaves the store `fragmented`, which the next tick of the guest system puts right.
 */
export function removeGuest(world: World, slot: number): void {
  const g = world.guests;
  if (g.live[slot] !== 1) return;
  g.live[slot] = 0;
  g.state[slot] = GuestState.GONE;
  g.free[g.freeCount++] = slot;
  g.count--;
  g.fragmented = true;
}

/**
 * Calls `fn(slot)` for every live guest, in slot order. `fn` may remove the guest it was called
 * for, or one it has not reached; it must not add guests.
 */
export function forEachGuest(world: World, fn: (slot: number) => void): void {
  const live = world.guests.live;
  for (let slot = 0; slot < GUEST_CAP; slot++) {
    if (live[slot] === 1) fn(slot);
  }
}

/** The tile the guest is on, rounded down: tile -1 is the lane outside the north or west edge. */
export function guestTile(world: World, slot: number): { x: number; y: number } {
  const g = world.guests;
  return { x: (g.x[slot] as number) >> 5, y: (g.y[slot] as number) >> 5 };
}

/**
 * Walks the guest `speed` units towards the middle of its target tile `(tx, ty)`: along x until it
 * is level, then along y, so guests walk down the middles of tiles. A step that would go past the
 * middle stops on it, and what is left of the step carries on along y. A guest with no target
 * (`tx` and `ty` both -1) stays where it is.
 */
export function moveToward(world: World, slot: number, speed = WALK_SPEED): void {
  const g = world.guests;
  const tx = g.tx[slot] as number;
  const ty = g.ty[slot] as number;
  if (tx === NO_TILE && ty === NO_TILE) return;
  let x = g.x[slot] as number;
  let y = g.y[slot] as number;
  let left = speed;

  const dx = tx * TILE_UNITS + HALF_TILE - x;
  if (dx !== 0) {
    const step = dx < 0 ? Math.min(-dx, left) : Math.min(dx, left);
    x += dx < 0 ? -step : step;
    left -= step;
    g.x[slot] = x;
  }
  if (left > 0) {
    const dy = ty * TILE_UNITS + HALF_TILE - y;
    if (dy !== 0) {
      const step = dy < 0 ? Math.min(-dy, left) : Math.min(dy, left);
      y += dy < 0 ? -step : step;
      g.y[slot] = y;
    }
  }
}

/** The arrays of a store as one list, in save order, for code that treats every field alike. */
export function guestArrays(g: GuestStore): GuestArray[] {
  return GUEST_ARRAYS.map(([name]) => g[name]);
}

/**
 * Packs the store: live guests move down to fill the gaps, keeping their order, so they sit in
 * slots `0..count-1`, and the free stack is rebuilt so the next arrival takes slot `count`. Does
 * nothing to a store that is already packed. Slot numbers change, so do not hold one across a call.
 */
export function compactGuests(world: World): void {
  const g = world.guests;
  if (!g.fragmented) return;
  const arrays = guestArrays(g);
  let to = 0;
  for (let from = 0; from < GUEST_CAP; from++) {
    if (g.live[from] !== 1) continue;
    if (to !== from) {
      for (const array of arrays) array[to] = array[from] as number;
    }
    to++;
  }
  g.live.fill(1, 0, to);
  g.live.fill(0, to);
  g.state.fill(GuestState.GONE, to);
  for (let i = 0; i < GUEST_CAP - to; i++) g.free[i] = GUEST_CAP - 1 - i;
  g.freeCount = GUEST_CAP - to;
  g.fragmented = false;
}

/** The slot of the live guest with `id`, or -1. A scan: for queries, not for the tick loop. */
export function findGuest(world: World, id: number): number {
  const g = world.guests;
  for (let slot = 0; slot < GUEST_CAP; slot++) {
    if (g.live[slot] === 1 && g.id[slot] === id) return slot;
  }
  return -1;
}
