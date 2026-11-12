import { Sim, createWorld, type World } from "../../src/index.js";
import { spawnGuest } from "../../src/guests/guests.js";

export const CASH = 1_000_000_00;

/** The entrance of `makePark`: the south edge of a 16 by 24 map. */
export const ENTRANCE = { x: 8, y: 23 };
/** The footpath of `makePark` runs along x = 8 from this row... */
export const PATH_TOP = 4;
/** ...to this one, the tile next to the entrance. */
export const PATH_BOTTOM = 22;

/** Reads element `index` of a typed array, which the caller knows is in range. */
export function at(array: ArrayLike<number>, index: number): number {
  return array[index] as number;
}

/** Runs a command as the player and fails loudly. */
export function run(sim: Sim, name: string, input: unknown): void {
  const result = sim.execute(name, input);
  if (!result.ok) throw new Error(`${name} failed: ${result.error}`);
}

export interface ParkOptions {
  seed?: number;
  /** Entry fee in cents. Defaults to $3.00. */
  fee?: number;
  /** Whether to open the park. Defaults to true. */
  open?: boolean;
  /** Park rating. Defaults to 0, so nobody arrives unless a test says so. */
  rating?: number;
}

/**
 * A 16 by 24 park with the entrance at (8, 23) on the south edge and a footpath from (8, 4) down
 * to (8, 22), a $3.00 entry fee, open, and a rating of 0 so no guest arrives by itself (the
 * rating moves every 400 ticks, so a test that runs longer than that has to expect arrivals).
 * Built with the same commands a player uses.
 */
export function makePark(options: ParkOptions = {}): Sim {
  const world = createWorld({
    width: 16,
    height: 24,
    seed: options.seed ?? 1,
    name: "Test Park",
    cash: CASH,
  });
  const sim = new Sim(world);
  run(sim, "park_set_entrance", ENTRANCE);
  run(sim, "path_build", { x: 8, y: PATH_TOP, w: 1, h: PATH_BOTTOM - PATH_TOP + 1, kind: "foot" });
  run(sim, "park_set_entry_fee", { cents: options.fee ?? 3_00 });
  if (options.open ?? true) run(sim, "park_open", {});
  world.park.rating = options.rating ?? 0;
  return sim;
}

export function tileIndexOf(world: World, x: number, y: number): number {
  return y * world.terrain.width + x;
}

export interface Placement {
  dest?: number;
  happiness?: number;
  energy?: number;
  hunger?: number;
  thirst?: number;
  bathroom?: number;
  cash?: number;
  sinceAction?: number;
}

/**
 * Spawns a guest from the world's own guest stream, then puts it in the middle of `tile` in
 * `state`, as if it had been there all along. Returns its slot.
 */
export function placeGuest(
  world: World,
  tile: { x: number; y: number },
  state: number,
  patch: Placement = {},
): number {
  const slot = spawnGuest(world, world.rngStreams.guests);
  if (slot < 0) throw new Error("no room for a guest");
  const g = world.guests;
  g.x[slot] = tile.x * 32 + 16;
  g.y[slot] = tile.y * 32 + 16;
  g.tx[slot] = tile.x;
  g.ty[slot] = tile.y;
  g.state[slot] = state;
  g.dest[slot] = patch.dest ?? -1;
  if (patch.happiness !== undefined) g.happiness[slot] = patch.happiness;
  if (patch.energy !== undefined) g.energy[slot] = patch.energy;
  if (patch.hunger !== undefined) g.hunger[slot] = patch.hunger;
  if (patch.thirst !== undefined) g.thirst[slot] = patch.thirst;
  if (patch.bathroom !== undefined) g.bathroom[slot] = patch.bathroom;
  if (patch.cash !== undefined) g.cash[slot] = patch.cash;
  if (patch.sinceAction !== undefined) g.sinceAction[slot] = patch.sinceAction;
  return slot;
}

/** Steps one tick at a time until `done()`; throws if it takes more than `max` ticks. */
export function stepUntil(sim: Sim, done: () => boolean, max: number): number {
  for (let ticks = 0; ticks <= max; ticks++) {
    if (done()) return ticks;
    sim.step(1);
  }
  throw new Error(`condition not met within ${max} ticks`);
}

/** Number of live guests, counted from the live flags rather than trusting `count`. */
export function liveCount(world: World): number {
  let n = 0;
  for (let slot = 0; slot < world.guests.live.length; slot++) n += at(world.guests.live, slot);
  return n;
}
