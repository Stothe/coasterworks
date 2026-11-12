import { typeById } from "@coasterworks/content";
import { TILE_UNITS, slotOfGuest } from "../guests/guests.js";
import { boardRide, unloadRide } from "../rides/operation.js";
import { RidePhase, type RideRecord } from "../rides/types.js";
import type { World } from "../world/types.js";
import type { System } from "./types.js";

/** Whether the guest at the front of `ride`'s queue is standing in the middle of the entrance. */
function frontAtEntrance(world: World, ride: RideRecord): boolean {
  const entrance = ride.entrance;
  const front = ride.queue[0];
  if (entrance === null || front === undefined) return false;
  const slot = slotOfGuest(world, front);
  if (slot < 0) return false;
  const g = world.guests;
  return (
    g.x[slot] === entrance.x * TILE_UNITS + TILE_UNITS / 2 &&
    g.y[slot] === entrance.y * TILE_UNITS + TILE_UNITS / 2
  );
}

/**
 * Runs one ride through a tick of its cycle:
 *
 *  - IDLE: if the ride is open and the guest at the front of the queue stands on the entrance,
 *    boards up to `capacity` guests from the front (see `boardRide`) and, if anyone got on, starts
 *    LOADING.
 *  - LOADING for `loadTicks`, then RUNNING for `cycleTicks`, then UNLOADING.
 *  - UNLOADING (one tick): lets the riders off at the exit (see `unloadRide`) and goes back to IDLE.
 *
 * A closed ride finishes the cycle it is in but boards nobody new.
 */
function tickRide(world: World, ride: RideRecord): void {
  const type = typeById(ride.type);
  if (type === undefined || type.kind !== "ride") return;
  switch (ride.phase) {
    case RidePhase.IDLE:
      if (ride.open && frontAtEntrance(world, ride) && boardRide(world, ride, type.capacity) > 0) {
        ride.phase = RidePhase.LOADING;
        ride.phaseTicks = 0;
      }
      break;
    case RidePhase.LOADING:
      ride.phaseTicks++;
      if (ride.phaseTicks >= type.loadTicks) {
        ride.phase = RidePhase.RUNNING;
        ride.phaseTicks = 0;
      }
      break;
    case RidePhase.RUNNING:
      ride.phaseTicks++;
      if (ride.phaseTicks >= type.cycleTicks) {
        ride.phase = RidePhase.UNLOADING;
        ride.phaseTicks = 0;
      }
      break;
    case RidePhase.UNLOADING:
      unloadRide(world, ride);
      ride.phase = RidePhase.IDLE;
      ride.phaseTicks = 0;
      break;
  }
}

/**
 * The rides. Each tick, every ride in id order takes a step of its load, run, unload cycle (stalls
 * are left alone). Runs after the finance system and before the guests, so guests boarded this
 * tick are RIDING when the guest system sees them, and guests let off are WANDERING.
 */
export const rideSystem: System = {
  name: "rides",
  tick(world) {
    for (const ride of world.rides) tickRide(world, ride);
  },
};
