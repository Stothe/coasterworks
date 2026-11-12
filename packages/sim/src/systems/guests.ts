import { compactGuests, moveToward, spawnGuest } from "../guests/guests.js";
import { decide, guestRoutes, tickNeeds } from "../guests/behavior.js";
import { DEST_TURNED_AWAY, GUEST_CAP, GuestState } from "../guests/types.js";
import { DEFAULT_RATING, MAX_ENTRY_FEE, MAX_RATING } from "../park/types.js";
import type { Rng } from "../rng.js";
import { TICKS_PER_DAY } from "../time.js";
import type { World } from "../world/types.js";
import type { System } from "./types.js";

/** Ticks between recomputations of the park rating: once a day. */
export const RATING_INTERVAL = TICKS_PER_DAY;

/** A rating moves this fraction (1/16) of the way to its target each time. */
const RATING_STEP_DIVISOR = 16;

/** Guests over this many in the park start to bring the rating down, a point for every 5. */
const CROWDING_FREE_GUESTS = 1500;
const CROWDING_PER_POINT = 5;
const CROWDING_MAX_PENALTY = 100;

/*
 * Each tick an open park has this chance of a group of guests arriving:
 * `rating / 999 * (1 - fee / $100.00) * 2%`. To keep it in integers, a roll `r` from
 * `0..ARRIVAL_ROLLS-1` is a hit when `r * denom < numer`, where `numer / denom` is the chance
 * scaled up to `ARRIVAL_ROLLS`.
 */
const ARRIVAL_ROLLS = 1_000_000;
/** 2% of `ARRIVAL_ROLLS`. */
const ARRIVAL_SCALE = 20_000;
const MOST_IN_A_GROUP = 3;

/**
 * The park rating one day on: 1/16 of the way (at least a point, so it gets there) from `rating`
 * to a target that is the guests' average happiness scaled to 999, less a point for every 5 guests
 * past 1,500 (at most 100). With no guests in the park the target is the default 500. Clamped to
 * 0..999. `happinessSum` is the total happiness of the `inPark` guests.
 */
export function nextRating(rating: number, inPark: number, happinessSum: number): number {
  let target = DEFAULT_RATING;
  if (inPark > 0) {
    const crowding = Math.min(
      CROWDING_MAX_PENALTY,
      Math.floor(Math.max(0, inPark - CROWDING_FREE_GUESTS) / CROWDING_PER_POINT),
    );
    target = Math.floor((happinessSum * MAX_RATING) / (255 * inPark)) - crowding;
  }
  target = Math.min(MAX_RATING, Math.max(0, target));
  const gap = target - rating;
  let step = Math.trunc(gap / RATING_STEP_DIVISOR);
  if (step === 0 && gap !== 0) step = gap < 0 ? -1 : 1;
  return Math.min(MAX_RATING, Math.max(0, rating + step));
}

/** With the chance the rating and fee give, brings a group of one to three guests to the gate. */
function admitArrivals(world: World, rng: Rng): void {
  const { park, guests } = world;
  if (!park.open || park.entrance === null || guests.count >= GUEST_CAP) return;
  const numer = park.rating * (MAX_ENTRY_FEE - park.entryFee) * ARRIVAL_SCALE;
  const denom = MAX_RATING * MAX_ENTRY_FEE;
  if (rng.int(ARRIVAL_ROLLS) * denom >= numer) return;
  const group = 1 + rng.int(MOST_IN_A_GROUP);
  for (let i = 0; i < group; i++) spawnGuest(world, rng);
}

/**
 * The guests. Each tick, in this order:
 *
 *  1. If the store has gaps from guests removed since the last tick, packs it.
 *  2. Maybe brings a group of guests to the gate.
 *  3. For every guest in slot order: ages its needs, lets it decide, and walks it a step.
 *  4. Counts the guests in the park (and their happiness), and once a day moves the park rating.
 *  5. Packs the store again if guests left during the tick.
 *
 * All the randomness is drawn, in that order, from the world's guest stream, so the same park
 * always does the same things. `park.guestsInPark` is recounted from the guests every tick, not
 * incremented, so it cannot drift from them.
 */
export const guestSystem: System = {
  name: "guests",
  tick(world) {
    const g = world.guests;
    const rng = world.rngStreams.guests;
    const routes = guestRoutes(world);

    if (g.fragmented) compactGuests(world);
    admitArrivals(world, rng);

    let inPark = 0;
    let happinessSum = 0;
    // Guests sit in slots 0..count-1 here (the store was packed and arrivals go on the end), and a
    // guest that leaves during the loop only frees its own slot.
    const last = g.count;
    for (let slot = 0; slot < last; slot++) {
      if (g.live[slot] === 0) continue;
      tickNeeds(world, slot, rng);
      decide(world, slot, rng, routes);
      if (g.live[slot] === 0) continue;
      moveToward(world, slot);

      const state = g.state[slot];
      if (
        state === GuestState.WANDERING ||
        state === GuestState.HEADING ||
        state === GuestState.LOST ||
        (state === GuestState.LEAVING && g.dest[slot] !== DEST_TURNED_AWAY)
      ) {
        inPark++;
        happinessSum += g.happiness[slot] as number;
      }
    }
    world.park.guestsInPark = inPark;
    if (world.tick % RATING_INTERVAL === 0) {
      world.park.rating = nextRating(world.park.rating, inPark, happinessSum);
    }
    if (g.fragmented) compactGuests(world);
  },
};
