import { PATH_FOOT } from "../paths/paths.js";
import { RouteCache, UNREACHABLE } from "../paths/routing.js";
import type { Rng } from "../rng.js";
import { inBounds, tileBase } from "../terrain/terrain.js";
import type { World } from "../world/types.js";
import { TILE_UNITS, laneTileX, laneTileY, removeGuest } from "./guests.js";
import { THOUGHT } from "./thoughts.js";
import {
  DEST_EXIT,
  DEST_TURNED_AWAY,
  GuestState,
  NO_DEST,
  NO_TILE,
  type GuestStore,
  type Waypoints,
} from "./types.js";

/** Ticks between the times a waiting guest picks somewhere new to go. */
export const WANDER_INTERVAL = 120;
/** A new destination is chosen within this many steps when one can be found. */
export const WANDER_RANGE = 12;
/** How many waypoints a guest looks at before settling for the nearest it found. */
export const WANDER_TRIES = 3;
/** Most waypoints the guests choose from; few enough for every route to stay in the cache. */
export const MAX_WAYPOINTS = 32;

/** Ticks between a lost guest's looks for a way. */
export const LOST_RETRY_INTERVAL = 200;
/** How far, in tiles, a lost guest looks for a path to walk to. */
export const LOST_SEARCH_RADIUS = 8;

/** Ticks between one point of hunger, and of thirst, and of a step of mood. */
export const HUNGER_INTERVAL = 40;
export const THIRST_INTERVAL = 40;
export const MOOD_INTERVAL = 40;
/** Ticks between one point of energy lost. */
export const ENERGY_INTERVAL = 60;
/** Ticks between one point of bathroom need. */
export const BATHROOM_INTERVAL = 80;

/** A need that reaches this makes the guest think about it (energy: this much tiredness). */
export const NEED_THOUGHT_LEVEL = 200;

/** A guest with happiness under this, energy under `LEAVE_ENERGY`, or idle longer, goes home. */
export const LEAVE_HAPPINESS = 60;
export const LEAVE_ENERGY = 30;
export const LEAVE_IDLE_TICKS = 6000;

/** A tile whose lowest corner is this high, or more, has a view. */
export const VIEW_HEIGHT = 12;
/** More guests than this in the park makes it feel crowded. */
export const CROWDED_GUESTS = 1500;

/*
 * Ambient thoughts share one roll a tick out of this many: 6 of them are a view (1 in 4,000), then
 * 4 are pride in the park and 4 are a crowd (each 1 in 6,000). A roll that lands on one whose
 * condition does not hold does nothing, so the chance is that of the condition and the roll
 * together, and a guest always draws exactly one number.
 */
const AMBIENT_ROLLS = 24_000;
const VIEW_ROLLS = 6;
const PRIDE_ROLLS = 4;
const CROWD_ROLLS = 4;

/** A mood of this or more can think the park is great. */
const PRIDE_HAPPINESS = 220;

/** Flat index of the entrance tile, or -1 if the park has none. */
function entranceIndex(world: World): number {
  const entrance = world.park.entrance;
  return entrance === null ? -1 : entrance.y * world.terrain.width + entrance.x;
}

/**
 * Picks the path tiles guests may walk to: footpaths only (a queue is for waiting in), taking one
 * in every `stride` of them in tile order, where `stride` is chosen so there are at most
 * `MAX_WAYPOINTS`. Which one of each stride is a fixed scatter, not the first, so that on a big
 * block of path they do not all line up down one edge. A few waypoints means a few distance
 * fields, which the route cache can hold at once; that is what lets 2,000 guests share the work
 * of finding their way.
 */
function buildWaypoints(world: World): Waypoints {
  const path = world.terrain.path;
  let total = 0;
  for (let i = 0; i < path.length; i++) if (path[i] === PATH_FOOT) total++;
  const stride = Math.max(1, Math.ceil(total / MAX_WAYPOINTS));
  const count = total === 0 ? 0 : Math.ceil(total / stride);
  const tiles = new Int32Array(count);
  const rankOf = (k: number) => Math.min(total - 1, k * stride + ((k * 37) % stride));

  let k = 0;
  let rank = 0;
  let want = count > 0 ? rankOf(0) : -1;
  for (let i = 0; i < path.length && k < count; i++) {
    if (path[i] !== PATH_FOOT) continue;
    if (rank === want) {
      tiles[k++] = i;
      want = rankOf(k);
    }
    rank++;
  }
  return { version: world.pathVersion, count, tiles };
}

/**
 * The route cache the guests of `world` find their way with, created on first use and kept on the
 * world, brought up to date with the paths and the entrance (and with the waypoints guests pick
 * walks from). Neither is saved or hashed: they are only a speed-up, rebuilt from the paths.
 */
export function guestRoutes(world: World): RouteCache {
  let routes = world.routes;
  if (routes === undefined) {
    // The entrance is walkable although nothing is laid on it: guests start and end their visit there.
    routes = new RouteCache(world.terrain, (index) => index === entranceIndex(world));
    world.routes = routes;
  }
  routes.sync(world);
  if (world.waypoints === undefined || world.waypoints.version !== world.pathVersion) {
    world.waypoints = buildWaypoints(world);
  }
  return routes;
}

function think(world: World, slot: number, thought: number): void {
  world.guests.thought[slot] = thought;
  world.guests.thoughtTick[slot] = world.tick;
}

/** Whether the guest is in the middle of the tile it is walking to (or has none to walk to). */
function atTarget(g: GuestStore, slot: number): boolean {
  const tx = g.tx[slot] as number;
  const ty = g.ty[slot] as number;
  if (tx === NO_TILE && ty === NO_TILE) return true;
  return g.x[slot] === tx * TILE_UNITS + 16 && g.y[slot] === ty * TILE_UNITS + 16;
}

/** Flat index of the tile the guest is on, or -1 if that is off the map. */
function ownIndex(world: World, slot: number): number {
  const g = world.guests;
  const { width, height } = world.terrain;
  const x = (g.x[slot] as number) >> 5;
  const y = (g.y[slot] as number) >> 5;
  return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
}

/** Points the guest at the tile with flat index `index`. */
function setTarget(world: World, slot: number, index: number): void {
  const g = world.guests;
  const width = world.terrain.width;
  const y = Math.floor(index / width);
  g.tx[slot] = index - y * width;
  g.ty[slot] = y;
}

/** Whether a guest can stand on tile `index`: it has a path, or it is the entrance. */
function walkable(world: World, index: number): boolean {
  return (
    index >= 0 && ((world.terrain.path[index] as number) !== 0 || index === entranceIndex(world))
  );
}

/**
 * Ages one guest's needs by a tick. Hunger and thirst rise one point every 40 ticks, energy falls
 * one every 60, the need for the toilet rises one every 80, and every 40 ticks mood moves a point
 * towards a baseline of `200 - (hunger over 128 + thirst over 128 + tiredness under 128) / 2`.
 * Guests are staggered by id so they do not all change on one tick. A need reaching 200 (energy 55)
 * puts a thought in the guest's head, once, as it crosses. Guests inside the park may also have a
 * thought of their own: a view from high ground, pride in the park, the crowd.
 *
 * A guest still outside the gate has no needs yet. Draws one number from `rng` for a guest inside
 * the park and none for one outside.
 */
export function tickNeeds(world: World, slot: number, rng: Rng): void {
  const g = world.guests;
  const state = g.state[slot] as number;
  if (state === GuestState.ENTERING) return;
  g.sinceAction[slot] = (g.sinceAction[slot] as number) + 1;
  const phase = world.tick + (g.id[slot] as number);

  if (phase % HUNGER_INTERVAL === 0) {
    const hunger = g.hunger[slot] as number;
    if (hunger < 255) {
      g.hunger[slot] = hunger + 1;
      if (hunger + 1 === NEED_THOUGHT_LEVEL) think(world, slot, THOUGHT.HUNGRY);
    }
  }
  if (phase % THIRST_INTERVAL === 0) {
    const thirst = g.thirst[slot] as number;
    if (thirst < 255) {
      g.thirst[slot] = thirst + 1;
      if (thirst + 1 === NEED_THOUGHT_LEVEL) think(world, slot, THOUGHT.THIRSTY);
    }
  }
  if (phase % ENERGY_INTERVAL === 0) {
    const energy = g.energy[slot] as number;
    if (energy > 0) {
      g.energy[slot] = energy - 1;
      if (energy - 1 === 255 - NEED_THOUGHT_LEVEL) think(world, slot, THOUGHT.TIRED);
    }
  }
  if (phase % BATHROOM_INTERVAL === 0) {
    const bathroom = g.bathroom[slot] as number;
    if (bathroom < 255) {
      g.bathroom[slot] = bathroom + 1;
      if (bathroom + 1 === NEED_THOUGHT_LEVEL) think(world, slot, THOUGHT.NEED_TOILET);
    }
  }
  if (phase % MOOD_INTERVAL === 0) {
    const hunger = g.hunger[slot] as number;
    const thirst = g.thirst[slot] as number;
    const energy = g.energy[slot] as number;
    const misery =
      (Math.max(0, hunger - 128) + Math.max(0, thirst - 128) + Math.max(0, 128 - energy)) >> 1;
    const baseline = Math.min(255, Math.max(0, 200 - misery));
    const happiness = g.happiness[slot] as number;
    if (happiness < baseline) g.happiness[slot] = happiness + 1;
    else if (happiness > baseline) g.happiness[slot] = happiness - 1;
  }

  if (state === GuestState.WANDERING || state === GuestState.HEADING) {
    const roll = rng.int(AMBIENT_ROLLS);
    if (roll < VIEW_ROLLS) {
      const terrain = world.terrain;
      const x = (g.x[slot] as number) >> 5;
      const y = (g.y[slot] as number) >> 5;
      if (inBounds(terrain, x, y) && tileBase(terrain, x, y) >= VIEW_HEIGHT) {
        think(world, slot, THOUGHT.NICE_VIEW);
      }
    } else if (roll < VIEW_ROLLS + PRIDE_ROLLS) {
      if ((g.happiness[slot] as number) >= PRIDE_HAPPINESS) think(world, slot, THOUGHT.GREAT_PARK);
    } else if (roll < VIEW_ROLLS + PRIDE_ROLLS + CROWD_ROLLS) {
      if (world.park.guestsInPark > CROWDED_GUESTS) think(world, slot, THOUGHT.CROWDED);
    }
  }
}

/** Whether the guest has had enough: low spirits, no energy, or too long with nothing to do. */
function shouldLeave(g: GuestStore, slot: number): boolean {
  return (
    (g.happiness[slot] as number) < LEAVE_HAPPINESS ||
    (g.energy[slot] as number) < LEAVE_ENERGY ||
    (g.sinceAction[slot] as number) > LEAVE_IDLE_TICKS
  );
}

/**
 * Lets one guest decide what to do this tick; the caller then moves it. A guest only decides
 * anything on a tick when it has come to the middle of the tile it was walking to (or is standing
 * still), so it always walks whole tiles.
 *
 *  - ENTERING: at the entrance tile, pays the fee and comes in, or is turned away if the park is
 *    shut or it cannot pay. If the entrance has gone or moved, it turns back before paying.
 *  - WANDERING: on its turn (every 120 ticks, staggered by id), picks one of a few waypoints.
 *  - HEADING: takes the next step along the route to `dest`, or arrives.
 *  - LEAVING: follows the route to the entrance, then walks out along the lane and is gone.
 *  - LOST: on its turn (every 200 ticks), looks again for a way out, or about.
 *
 * Guests inside who are unhappy, worn out, or have been idle too long start LEAVING.
 * `routes` must be the cache from `guestRoutes(world)` for this tick.
 */
export function decide(world: World, slot: number, rng: Rng, routes: RouteCache): void {
  switch (world.guests.state[slot]) {
    case GuestState.ENTERING:
      enter(world, slot, rng, routes);
      break;
    case GuestState.WANDERING:
      wander(world, slot, rng, routes);
      break;
    case GuestState.HEADING:
      head(world, slot, routes);
      break;
    case GuestState.LEAVING:
      leave(world, slot, routes);
      break;
    case GuestState.LOST:
      lost(world, slot, routes);
      break;
  }
}

function enter(world: World, slot: number, rng: Rng, routes: RouteCache): void {
  const g = world.guests;
  const entrance = world.park.entrance;
  if (entrance === null || g.tx[slot] !== entrance.x || g.ty[slot] !== entrance.y) {
    // The gate it came to is gone or has moved; it never got in, so it just goes away.
    removeGuest(world, slot);
    return;
  }
  if (!atTarget(g, slot)) return;

  const { park } = world;
  const fee = park.entryFee;
  if (!park.open) {
    turnAway(world, slot, THOUGHT.PARK_CLOSED);
  } else if ((g.cash[slot] as number) < fee) {
    turnAway(world, slot, THOUGHT.TOO_EXPENSIVE);
  } else {
    g.cash[slot] = (g.cash[slot] as number) - fee;
    park.income.entry += fee;
    park.monthly.entry += fee;
    park.totalAdmissions++;
    world.finance.cash += fee;
    g.state[slot] = GuestState.WANDERING;
    g.dest[slot] = NO_DEST;
    g.sinceAction[slot] = 0;
    // Straight into the park, rather than standing in the gate until its turn comes round.
    pickDestination(world, slot, rng, routes);
  }
}

/** Sends a guest who has just reached the gate back out along the lane, thinking `thought`. */
function turnAway(world: World, slot: number, thought: number): void {
  const g = world.guests;
  think(world, slot, thought);
  g.state[slot] = GuestState.LEAVING;
  g.dest[slot] = DEST_TURNED_AWAY;
  walkOutLane(world, slot);
}

/** Aims the guest at the lane tile outside the entrance. */
function walkOutLane(world: World, slot: number): void {
  const entrance = world.park.entrance;
  if (entrance === null) return;
  world.guests.tx[slot] = laneTileX(entrance);
  world.guests.ty[slot] = laneTileY(entrance);
}

/**
 * Chooses where a guest standing still walks to: up to `WANDER_TRIES` random waypoints, taking the
 * first one it can reach in `WANDER_RANGE` steps, or failing that the nearest one it could reach.
 * If it finds one, it is HEADING and has taken its first step. Draws from `rng` once per waypoint
 * it looks at, and not at all when there are none.
 */
function pickDestination(world: World, slot: number, rng: Rng, routes: RouteCache): boolean {
  const waypoints = world.waypoints;
  if (waypoints === undefined || waypoints.count === 0) return false;
  const here = ownIndex(world, slot);
  if (here < 0) return false;

  let best = -1;
  let bestSteps = UNREACHABLE;
  for (let attempt = 0; attempt < WANDER_TRIES; attempt++) {
    const candidate = waypoints.tiles[rng.int(waypoints.count)] as number;
    const steps = routes.distanceField(candidate)[here] as number;
    if (steps === 0 || steps === UNREACHABLE) continue;
    if (steps <= WANDER_RANGE) {
      best = candidate;
      break;
    }
    if (steps < bestSteps) {
      best = candidate;
      bestSteps = steps;
    }
  }
  if (best < 0) return false;

  const g = world.guests;
  g.dest[slot] = best;
  g.state[slot] = GuestState.HEADING;
  g.sinceAction[slot] = 0;
  head(world, slot, routes);
  return true;
}

function wander(world: World, slot: number, rng: Rng, routes: RouteCache): void {
  const g = world.guests;
  if (shouldLeave(g, slot) && startLeaving(world, slot, routes)) return;
  if ((world.tick + (g.id[slot] as number)) % WANDER_INTERVAL !== 0) return;
  if (pickDestination(world, slot, rng, routes)) return;
  // Nowhere to go. If the tile it stands on has lost its path, it is lost; if not, it just waits.
  if (!walkable(world, ownIndex(world, slot))) goLost(world, slot, routes);
}

function head(world: World, slot: number, routes: RouteCache): void {
  const g = world.guests;
  if (shouldLeave(g, slot) && startLeaving(world, slot, routes)) return;
  if (!atTarget(g, slot)) return;

  const here = ownIndex(world, slot);
  const dest = g.dest[slot] as number;
  if (here === dest) {
    g.state[slot] = GuestState.WANDERING;
    g.dest[slot] = NO_DEST;
    return;
  }
  const next = routes.nextStep(here, dest);
  if (next < 0) goLost(world, slot, routes);
  else setTarget(world, slot, next);
}

/** Turns a guest for the exit. False, and nothing changes, if the park has no entrance. */
function startLeaving(world: World, slot: number, routes: RouteCache): boolean {
  const exit = entranceIndex(world);
  if (exit < 0) return false;
  const g = world.guests;
  g.state[slot] = GuestState.LEAVING;
  g.dest[slot] = exit;
  think(world, slot, THOUGHT.GOING_HOME);
  leave(world, slot, routes);
  return true;
}

function leave(world: World, slot: number, routes: RouteCache): void {
  const g = world.guests;
  if ((g.dest[slot] as number) < 0) {
    // Out along the lane; once it is on the lane tile it is gone.
    if (atTarget(g, slot)) removeGuest(world, slot);
    return;
  }
  if (!atTarget(g, slot)) return;

  // The entrance may have moved since the guest set out; head for the one there is now.
  const exit = entranceIndex(world);
  if (exit < 0) {
    goLost(world, slot, routes);
    return;
  }
  g.dest[slot] = exit;
  const here = ownIndex(world, slot);
  if (here === exit) {
    g.dest[slot] = DEST_EXIT;
    walkOutLane(world, slot);
    return;
  }
  const next = routes.nextStep(here, exit);
  if (next < 0) goLost(world, slot, routes);
  else setTarget(world, slot, next);
}

/**
 * The guest cannot find its way. It thinks so, gives up on where it was going, and walks to the
 * nearest path or entrance within `LOST_SEARCH_RADIUS` tiles, or stays where it is if there is
 * none.
 */
function goLost(world: World, slot: number, routes: RouteCache): void {
  const g = world.guests;
  g.state[slot] = GuestState.LOST;
  g.dest[slot] = NO_DEST;
  think(world, slot, THOUGHT.LOST);
  const near = routes.nearestPathTile(
    (g.x[slot] as number) >> 5,
    (g.y[slot] as number) >> 5,
    LOST_SEARCH_RADIUS,
  );
  if (near >= 0) {
    setTarget(world, slot, near);
  } else {
    g.tx[slot] = NO_TILE;
    g.ty[slot] = NO_TILE;
  }
}

function lost(world: World, slot: number, routes: RouteCache): void {
  const g = world.guests;
  if (!atTarget(g, slot)) return;
  if ((world.tick + (g.id[slot] as number)) % LOST_RETRY_INTERVAL !== 0) return;

  const here = ownIndex(world, slot);
  const exit = entranceIndex(world);
  if (exit >= 0 && routes.reachable(here, exit)) {
    // A way out: take it.
    g.state[slot] = GuestState.LEAVING;
    g.dest[slot] = exit;
    think(world, slot, THOUGHT.GOING_HOME);
    leave(world, slot, routes);
    return;
  }
  const waypoints = world.waypoints;
  if (waypoints === undefined) return;
  for (let i = 0; i < waypoints.count; i++) {
    const waypoint = waypoints.tiles[i] as number;
    if (waypoint !== here && routes.reachable(here, waypoint)) {
      // No way out, but somewhere to go.
      g.state[slot] = GuestState.WANDERING;
      g.dest[slot] = NO_DEST;
      return;
    }
  }
}
