import { typeById } from "@coasterworks/content";
import { boardRide, unloadRide } from "../rides/operation.js";
import { RidePhase, type RideRecord } from "../rides/types.js";
import type { World } from "../world/types.js";
import type { System } from "./types.js";

/**
 * Runs one ride through a tick of its cycle:
 *
 *  - IDLE: if the ride is open, boards up to `capacity` guests standing on the entrance tile at
 *    the front of the queue (see `boardRide`) and, if anyone got on, starts LOADING.
 *  - LOADING for `loadTicks`: while the ride is open and has seats left, it keeps boarding the
 *    guests who walk up onto the platform, so a ride fed by a queue fills.
 *  - Then RUNNING for `cycleTicks`, then UNLOADING.
 *  - UNLOADING (one tick): lets the riders off at the exit (see `unloadRide`) and goes back to IDLE.
 *
 * A closed ride finishes the cycle it is in but boards nobody new.
 */
function tickRide(world: World, ride: RideRecord): void {
  const type = typeById(ride.type);
  if (type === undefined || type.kind !== "ride") return;
  switch (ride.phase) {
    case RidePhase.IDLE:
      if (ride.open && boardRide(world, ride, type.capacity) > 0) {
        ride.phase = RidePhase.LOADING;
        ride.phaseTicks = 0;
      }
      break;
    case RidePhase.LOADING:
      if (ride.open && ride.riders.length < type.capacity) {
        boardRide(world, ride, type.capacity - ride.riders.length);
      }
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
