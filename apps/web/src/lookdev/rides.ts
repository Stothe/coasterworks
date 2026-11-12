import type { RideStatusSection } from "@coasterworks/protocol";
import type { RidePlace } from "@coasterworks/render";
import { Sim, type World } from "@coasterworks/sim";

/**
 * One of every ride and stall type on the sample park, for the look-dev page: each is built by
 * the sim itself (`ride_build` / `stall_build`), so it stands only where the sim would let a
 * player put it, on the first free spot found spiralling out from where it is wanted. The rides
 * are shown running and the stalls open.
 */

/** Where each type is wanted on the 64 by 64 sample park: around the plaza south of the pond. */
const WANTED: readonly [type: string, command: string, x: number, y: number, rot: 0 | 1 | 2 | 3][] =
  [
    ["carousel", "ride_build", 25, 40, 0],
    ["big_wheel", "ride_build", 40, 40, 1],
    ["swing_tower", "ride_build", 34, 46, 0],
    ["snack_stand", "stall_build", 29, 46, 0],
    ["drinks_stand", "stall_build", 31, 46, 0],
    ["restrooms", "stall_build", 30, 50, 0],
  ];

/** Tiles tried from the wanted spot outward, nearest first. */
function* spiral(x: number, y: number, reach: number): Generator<[number, number]> {
  yield [x, y];
  for (let r = 1; r <= reach; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) yield [x + dx, y + dy];
      }
    }
  }
}

export interface LookdevRides {
  rides: RidePlace[];
  status: RideStatusSection;
}

/** Builds one of each type on `world` (which it changes) and returns them as the scene wants. */
export function placeEveryRide(world: World): LookdevRides {
  // Look development, not a game: the money is no object.
  world.finance.cash = 100_000_000;
  const sim = new Sim(world);
  for (const [type, command, x, y, rot] of WANTED) {
    for (const [tx, ty] of spiral(x, y, 12)) {
      if (sim.execute(command, { type, x: tx, y: ty, rot }).ok) break;
    }
  }
  const rides: RidePlace[] = sim.world.rides.map((r) => ({
    id: r.id,
    type: r.type,
    x: r.x,
    y: r.y,
    rot: r.rot,
    open: true,
  }));
  const count = rides.length;
  const status: RideStatusSection = {
    count,
    id: Int32Array.from(rides, (r) => r.id),
    phase: Uint8Array.from(sim.world.rides, (r) => (r.kind === "ride" ? 2 : 0)),
    phaseTicks: new Uint16Array(count),
    riders: new Uint8Array(count),
    queue: new Uint16Array(count),
  };
  return { rides, status };
}
