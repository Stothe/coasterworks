/** Most guests the park holds at once. */
export const GUEST_CAP = 2000;

/** What a guest is doing. Stored as a byte per guest. */
export const GuestState = {
  /** In the lane outside the map, walking in to the entrance tile to pay. */
  ENTERING: 0,
  /** Inside, standing on a tile and waiting for its next turn to pick somewhere to go. */
  WANDERING: 1,
  /** Inside, walking to `dest`, a tile it chose. */
  HEADING: 2,
  /** On its way out: to the entrance tile, then out along the lane. */
  LEAVING: 3,
  /** Cannot reach where it meant to go; looks for a way again every 200 ticks. */
  LOST: 4,
  /** Left the park. A removed guest holds this until its slot is reused. */
  GONE: 5,
  /** In the queue of the ride `ride`, walking up to its place in the line or standing in it. */
  QUEUING: 6,
  /** On the ride `ride`, out of sight at the middle of its footprint until the ride unloads. */
  RIDING: 7,
} as const;

export type GuestState = (typeof GuestState)[keyof typeof GuestState];

/** Highest value of `GuestState`. */
export const MAX_GUEST_STATE = GuestState.RIDING;

/** The value of both `tx` and `ty` when a guest has no tile it is walking to. */
export const NO_TILE = -1;

/** The guest has no destination (and, with `tx` and `ty` both -1, no tile it is walking to). */
export const NO_DEST = -1;

/** A LEAVING guest who has reached the entrance is walking out along the lane. */
export const DEST_EXIT = -1;

/**
 * A LEAVING guest who was turned away at the gate (could not pay, or the park was closed). It was
 * never admitted, so it does not count as being in the park while it walks back out.
 */
export const DEST_TURNED_AWAY = -2;

/** Colours a guest's clothes can be, as an index into the renderer's palette. */
export const GUEST_COLORS = 9;

/** Names are `first * 32 + last`: 64 first names by 32 last names. */
export const NAME_COUNT = 64 * 32;

/**
 * The per-guest arrays, in the order they are saved, with the typed array each one is. Anything
 * that has to treat every field alike (compaction, hashing, the save) goes through this list, so a
 * field added here is added everywhere.
 */
export const GUEST_ARRAYS = [
  ["id", "Int32Array"],
  ["x", "Int32Array"],
  ["y", "Int32Array"],
  ["tx", "Int32Array"],
  ["ty", "Int32Array"],
  ["dest", "Int32Array"],
  ["state", "Uint8Array"],
  ["happiness", "Uint8Array"],
  ["energy", "Uint8Array"],
  ["hunger", "Uint8Array"],
  ["thirst", "Uint8Array"],
  ["bathroom", "Uint8Array"],
  ["nausea", "Uint8Array"],
  ["cash", "Int32Array"],
  ["color", "Uint8Array"],
  ["name", "Uint16Array"],
  ["thought", "Uint8Array"],
  ["thoughtTick", "Int32Array"],
  ["sinceAction", "Int32Array"],
  ["lostTicks", "Int32Array"],
  ["ride", "Int32Array"],
  ["intensityPref", "Uint8Array"],
  ["lastRide", "Int32Array"],
  ["queueTicks", "Int32Array"],
] as const;

export type GuestArrayName = (typeof GUEST_ARRAYS)[number][0];
export type GuestArrayKind = (typeof GUEST_ARRAYS)[number][1];
export type GuestArray = Int32Array | Uint16Array | Uint8Array;

/**
 * Every guest in the park, as parallel arrays indexed by slot: struct-of-arrays, so the tick loop
 * walks plain typed arrays and allocates nothing. Slot `i` of every array describes one guest.
 *
 * Positions are in 1/32 of a tile, so the tile a guest is on is `x >> 5` by `y >> 5` (an
 * arithmetic shift, so the off-map lane at tile -1 comes out as -1). The middle of tile `t` is
 * `t * 32 + 16`.
 *
 * Which slots are live is `live`. A slot a guest left is free for the next arrival, taken from the
 * `free` stack, and the store is then `fragmented`: live guests no longer fill slots
 * `0..count-1`. The guest system packs the store at the start and the end of every tick (see
 * `compactGuests`), so between ticks live guests are in slot order, which is the order they
 * arrived in, with no gaps. That keeps what the sim does next a function of the guests alone, not
 * of which slots history left them in, and it is why a saved and reloaded park carries on exactly
 * as the original would have.
 */
export interface GuestStore {
  /** Live guests. */
  count: number;
  /** The id the next guest gets. Ids start at 1, only go up, and are never reused. */
  nextGuestId: number;
  /** Whether a slot has been freed since the store was last packed. Runtime only. */
  fragmented: boolean;
  /** Stack of free slots; the next arrival takes `free[freeCount - 1]`. Runtime only. */
  free: Int32Array;
  freeCount: number;
  /** 1 for a slot holding a guest, 0 for a free one. Runtime only. */
  live: Uint8Array;

  id: Int32Array;
  x: Int32Array;
  y: Int32Array;
  /** The tile the guest is walking to next, or both -1 for none. May be the off-map lane tile. */
  tx: Int32Array;
  ty: Int32Array;
  /** Flat index of the tile the guest is heading for, or `NO_DEST` / `DEST_EXIT` / `DEST_TURNED_AWAY`. */
  dest: Int32Array;
  state: Uint8Array;
  /** Needs and moods, 0 to 255. */
  happiness: Uint8Array;
  energy: Uint8Array;
  hunger: Uint8Array;
  thirst: Uint8Array;
  bathroom: Uint8Array;
  nausea: Uint8Array;
  /** Cents in the guest's pocket. */
  cash: Int32Array;
  /** Index into the renderer's palette, 0 to 8. */
  color: Uint8Array;
  /** `first * 32 + last`, an index into the name tables. */
  name: Uint16Array;
  /** The id of the last thing the guest thought; 0 for nothing yet. */
  thought: Uint8Array;
  /** The tick it thought it. */
  thoughtTick: Int32Array;
  /** Ticks since the guest last did something that counts: got in, or chose somewhere new to go. */
  sinceAction: Int32Array;
  /**
   * Ticks the guest has spent LOST since it last found a way to the exit. At `LOST_GIVE_UP` it
   * gives up and goes home. 0 for a guest that is not lost.
   */
  lostTicks: Int32Array;
  /** Id of the ride the guest is heading for, queuing for, or riding; 0 for none. */
  ride: Int32Array;
  /**
   * The ride intensity the guest likes, in units of 4 rating points: the preference is
   * `intensityPref * 4`, so a byte covers the 0 to 999 ratings.
   */
  intensityPref: Uint8Array;
  /** Id of the last ride the guest got off; 0 for none yet. */
  lastRide: Int32Array;
  /** Ticks the guest has spent in its current queue; 0 when it is not queuing. */
  queueTicks: Int32Array;
}

/** A set of path tiles the guests choose their walks from. Runtime only. */
export interface Waypoints {
  /** The `pathVersion` the list was built for. */
  version: number;
  count: number;
  /** Flat tile indices, `count` of them. */
  tiles: Int32Array;
}
