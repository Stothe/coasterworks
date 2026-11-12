import { typeById } from "@coasterworks/content";
import { clearRide, guestRoutes, setTarget, think } from "../guests/behavior.js";
import { TILE_UNITS, forEachGuest, slotOfGuest } from "../guests/guests.js";
import { THOUGHT } from "../guests/thoughts.js";
import { GuestState, NO_DEST, NO_TILE } from "../guests/types.js";
import type { World } from "../world/types.js";
import { rideFootprint } from "./rides.js";
import { RidePhase, type RideRecord } from "./types.js";

/** Happiness a ride gives: an eighth of its excitement rating, at most 255. */
export function rideHappiness(excitement: number): number {
  return Math.min(255, Math.floor(excitement / 8));
}

/** Nausea a ride gives: a tenth of its nausea rating. */
export function rideNausea(nausea: number): number {
  return Math.floor(nausea / 10);
}

/** A guest whose nausea reaches this after a ride feels sick rather than thrilled. */
export const SICK_NAUSEA = 160;

/** The middle of tile `index`, in guest position units. */
function placeOnTile(world: World, slot: number, index: number): void {
  const g = world.guests;
  const width = world.terrain.width;
  const y = Math.floor(index / width);
  const x = index - y * width;
  g.x[slot] = x * TILE_UNITS + TILE_UNITS / 2;
  g.y[slot] = y * TILE_UNITS + TILE_UNITS / 2;
  setTarget(world, slot, index);
}

/**
 * Boards `ride` from the front of its queue: guest by guest, as long as the guest at the front
 * stands on the entrance tile and fewer than `capacity` have got on, each pays the price and gets
 * on, or, if it cannot pay, steps out of the queue thinking it cannot afford it, is not charged,
 * and boarding goes on with the next. The first guest not on the entrance tile stops it, which
 * keeps the line first come, first served. Riders become RIDING, out of sight at the middle of the
 * footprint. Takings go to the park's cash, `park.income.rides`, `park.monthly.rides`, and the
 * ride's stats. Returns how many got on.
 */
export function boardRide(world: World, ride: RideRecord, capacity: number): number {
  const entrance = ride.entrance;
  if (entrance === null) return 0;
  const g = world.guests;
  const rect = rideFootprint(ride);
  const cx = rect.x * TILE_UNITS + rect.w * (TILE_UNITS / 2);
  const cy = rect.y * TILE_UNITS + rect.h * (TILE_UNITS / 2);
  const { park, finance } = world;
  const price = ride.price;
  const queue = ride.queue;
  let taken = 0;
  let boarded = 0;
  while (boarded < capacity && taken < queue.length) {
    const id = queue[taken] as number;
    const slot = slotOfGuest(world, id);
    if (
      slot >= 0 &&
      ((g.x[slot] as number) >> 5 !== entrance.x || (g.y[slot] as number) >> 5 !== entrance.y)
    ) {
      break;
    }
    taken++;
    if (slot < 0) continue;
    if ((g.cash[slot] as number) < price) {
      think(world, slot, THOUGHT.CANT_AFFORD_RIDE);
      clearRide(world, slot);
      continue;
    }
    g.cash[slot] = (g.cash[slot] as number) - price;
    finance.cash += price;
    park.income.rides += price;
    park.monthly.rides += price;
    ride.stats.income += price;
    ride.stats.monthIncome += price;
    ride.stats.customers++;
    ride.stats.monthCustomers++;
    ride.riders.push(id);
    boarded++;
    g.state[slot] = GuestState.RIDING;
    g.x[slot] = cx;
    g.y[slot] = cy;
    g.tx[slot] = NO_TILE;
    g.ty[slot] = NO_TILE;
    g.dest[slot] = NO_DEST;
    g.queueTicks[slot] = 0;
    g.sinceAction[slot] = 0;
  }
  if (taken > 0) queue.splice(0, taken);
  return boarded;
}

/**
 * Where guests leaving `ride` are put: its exit tile if that has a path, or else the walkable tile
 * nearest the middle of the footprint (the route cache's ring search), or -1 if there is none.
 */
function landingTile(world: World, ride: RideRecord): number {
  const { terrain } = world;
  if (ride.exit !== null) {
    const exit = ride.exit.y * terrain.width + ride.exit.x;
    if ((terrain.path[exit] as number) !== 0) return exit;
  }
  const rect = rideFootprint(ride);
  return guestRoutes(world).nearestPathTile(
    rect.x + (rect.w >> 1),
    rect.y + (rect.h >> 1),
    Math.max(terrain.width, terrain.height),
  );
}

/** Puts a guest that has nowhere to stand LOST where it is. */
function strand(world: World, slot: number): void {
  const g = world.guests;
  g.state[slot] = GuestState.LOST;
  g.tx[slot] = NO_TILE;
  g.ty[slot] = NO_TILE;
  think(world, slot, THOUGHT.LOST);
}

/**
 * Lets every rider off where `landingTile` says (the exit tile if it has a path, else the nearest
 * path tile): each is WANDERING again (LEAVING if the park has closed meanwhile), happier by the
 * ride's excitement and queasier by its nausea, remembers the ride as its last, and thinks it was
 * fun (or that it feels sick, at `SICK_NAUSEA` or more). With no path anywhere near, a rider is
 * LOST where it is.
 */
export function unloadRide(world: World, ride: RideRecord): void {
  if (ride.riders.length === 0) return;
  const g = world.guests;
  const type = typeById(ride.type);
  const happy = type !== undefined && type.kind === "ride" ? rideHappiness(type.excitement) : 0;
  const queasy = type !== undefined && type.kind === "ride" ? rideNausea(type.nausea) : 0;
  const landing = landingTile(world, ride);
  const width = world.terrain.width;
  const entrance = world.park.entrance;
  for (const id of ride.riders) {
    const slot = slotOfGuest(world, id);
    if (slot < 0) continue;
    clearRide(world, slot);
    g.happiness[slot] = Math.min(255, (g.happiness[slot] as number) + happy);
    const nausea = Math.min(255, (g.nausea[slot] as number) + queasy);
    g.nausea[slot] = nausea;
    g.lastRide[slot] = ride.id;
    g.sinceAction[slot] = 0;
    if (landing < 0) {
      strand(world, slot);
      continue;
    }
    placeOnTile(world, slot, landing);
    think(world, slot, nausea >= SICK_NAUSEA ? THOUGHT.RIDE_SICK : THOUGHT.RIDE_FUN);
    if (!world.park.open && entrance !== null) {
      g.state[slot] = GuestState.LEAVING;
      g.dest[slot] = entrance.y * width + entrance.x;
    }
  }
  ride.riders = [];
}

/**
 * Every guest in `ride`'s queue steps out of it and wanders; the queue is empty after. For a stall,
 * which has no queue, every guest buying at it or on its way to it wanders instead, unserved and
 * not charged.
 */
export function releaseQueue(world: World, ride: RideRecord): void {
  if (ride.kind === "stall") {
    const g = world.guests;
    forEachGuest(world, (slot) => {
      const state = g.state[slot];
      if (
        (state === GuestState.BUYING || state === GuestState.HEADING) &&
        g.ride[slot] === ride.id
      ) {
        clearRide(world, slot);
      }
    });
  }
  for (const id of ride.queue) {
    const slot = slotOfGuest(world, id);
    if (slot >= 0) clearRide(world, slot);
  }
  ride.queue = [];
}

/**
 * Makes the guests forget ride `id`, which is going: none has it as its last ride, and a guest
 * heading for it wanders instead. An undone `ride_build` hands its id back, so a later ride may
 * take the same id, and must not be mistaken for this one.
 */
function forgetRide(world: World, id: number): void {
  const g = world.guests;
  forEachGuest(world, (slot) => {
    if (g.lastRide[slot] === id) g.lastRide[slot] = 0;
    if (g.state[slot] === GuestState.HEADING && g.ride[slot] === id) clearRide(world, slot);
  });
}

/**
 * Empties a ride that is about to go: the queue is let go, and the riders are put at once where
 * `landingTile` says, wandering, without the ride counting as their last; a rider with no path
 * anywhere near is LOST where it is. Guests forget the ride (see `forgetRide`). The ride is left
 * idle with no riders.
 */
export function ejectGuests(world: World, ride: RideRecord): void {
  releaseQueue(world, ride);
  const landing = ride.riders.length > 0 ? landingTile(world, ride) : -1;
  for (const id of ride.riders) {
    const slot = slotOfGuest(world, id);
    if (slot < 0) continue;
    clearRide(world, slot);
    if (landing >= 0) placeOnTile(world, slot, landing);
    else strand(world, slot);
  }
  ride.riders = [];
  ride.phase = RidePhase.IDLE;
  ride.phaseTicks = 0;
  forgetRide(world, ride.id);
}
