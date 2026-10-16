import type { World } from "../world/types.js";

/** A part of the simulation that runs once every tick, after the tick counter has advanced. */
export interface System {
  name: string;
  /** Must depend only on the world, never on the clock. A system draws randomness from `world.rng`. */
  tick(world: World): void;
}
