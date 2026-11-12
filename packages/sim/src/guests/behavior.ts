import { typeById } from "@coasterworks/content";
import { PATH_FOOT } from "../paths/paths.js";
import { RouteCache, UNREACHABLE, type MultiSourceField } from "../paths/routing.js";
import { queueCapacity, queueInfo, queueSlotTile } from "../rides/queue.js";
import { findRide } from "../rides/rides.js";
import type { RideRecord } from "../rides/types.js";
import type { Rng } from "../rng.js";
import { inBounds, tileBase } from "../terrain/terrain.js";
import { TICKS_PER_DAY } from "../time.js";
import type { Terrain, World } from "../world/types.js";
import { TILE_UNITS, forEachGuest, laneTileX, laneTileY, removeGuest } from "./guests.js";
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
/**
 * A guest that has spent this many ticks lost (six game days) without finding a way to the exit
 * gives up on the park and is gone: thinking it is going home, and not refunded. Without this a
 * guest cut off from the gate could be lost for ever, and drag the rating down with it.
 */
export const LOST_GIVE_UP = 2400;

/** A guest that has queued this many ticks (six game days) gives up on the ride and wanders. */
export const QUEUE_PATIENCE = 2400;

/*
 * Need pacing (Plan D3 ruling; the measurements are in the D2 ledger). A guest comes in with hunger
 * and thirst under 80 and a need for the toilet under 60, rising a point every 40 and 80 ticks. It
 * goes looking for food or drink at `NEED_SEEK_LEVEL` (80), so about a quarter of guests want one
 * within a day of coming in and more than two in five within two; and for the toilets at
 * `BATHROOM_SEEK_LEVEL` (56), so the Restrooms see use in the first few days. Both sit well below
 * where needs start to hurt a guest's mood (128), so a park with stalls keeps its guests from ever
 * feeling it. It only complains that there is nothing for a need at `NEED_COMPLAIN_LEVEL` (160, the
 * old seek level), and needs only ever send a guest to a stall, so a park without stalls plays
 * exactly as before: same thoughts, same mood, same rating. (The other candidates measured, wider
 * arrival needs and faster need rates, cost a park without stalls 8 to 10% of its month-end rating
 * and still had stalls idle for most of a week.)
 */

/**
 * A hunger or thirst at this level or more sends a wandering guest, or one walking about, to the
 * nearest open stall that meets it.
 */
export const NEED_SEEK_LEVEL = 80;

/** The same for the need for the toilet. */
export const BATHROOM_SEEK_LEVEL = 56;

/**
 * A guest whose most pressing need is at this level or more, and finds no stall for it, thinks so
 * (see `nothingFor`).
 */
export const NEED_COMPLAIN_LEVEL = 160;

/**
 * A guest that finds nothing to meet its need thinks so, and not again for this many ticks (a day)
 * unless it has thought something else meanwhile.
 */
export const NEED_SEEK_THOUGHT_INTERVAL = TICKS_PER_DAY;

/**
 * A guest likes a ride whose intensity is within this many rating points of its preference
 * (`intensityPref * 4`); a ride more intense than that is too intense for it.
 */
export const INTENSITY_WINDOW = 300;

/** Happiness a guest gains when it is served at a stall. */
export const STALL_HAPPINESS = 10;

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

/** Puts `thought` in the guest's head, stamped with the current tick. */
export function think(world: World, slot: number, thought: number): void {
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
export function setTarget(world: World, slot: number, index: number): void {
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
 *  - WANDERING: on its turn (every 120 ticks, staggered by id), goes to a stall if it needs one,
 *    or maybe to a ride (see `seekStallOrRide`), or else picks one of a few waypoints.
 *  - HEADING: takes the next step along the route to `dest`, or arrives. One walking about turns
 *    for a stall if it needs one (see `turnToStall`).
 *  - LEAVING: follows the route to the entrance, then walks out along the lane and is gone.
 *  - LOST: on its turn (every 200 ticks), looks again for a way out, or about.
 *  - QUEUING: counts its time in the queue (giving up at `QUEUE_PATIENCE`), and walks up the
 *    queue to the tile its place in the line belongs on; if the tile it stands on is no longer part
 *    of the queue (the line was broken), it steps out of it.
 *  - RIDING: nothing; the ride system takes it off again.
 *  - BUYING: stands at the stall until it has been served, then pays and wanders (see `buying`).
 *
 * A guest whose ride has gone, or closed while it was on its way, goes back to wandering.
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
    case GuestState.QUEUING:
      queueing(world, slot, routes);
      break;
    case GuestState.RIDING:
      riding(world, slot);
      break;
    case GuestState.BUYING:
      buying(world, slot);
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
  // A park with no rides or stalls skips this altogether, so it plays exactly as it did before
  // there were any.
  if (world.rides.length > 0 && seekStallOrRide(world, slot, rng, routes)) return;
  if (pickDestination(world, slot, rng, routes)) return;
  // Nowhere to go. If the tile it stands on has lost its path, it is lost; if not, it just waits.
  if (!walkable(world, ownIndex(world, slot))) goLost(world, slot, routes);
}

function head(world: World, slot: number, routes: RouteCache): void {
  const g = world.guests;
  const rideId = g.ride[slot] as number;
  let ride: RideRecord | undefined;
  if (rideId !== 0) {
    ride = findRide(world, rideId);
    if (
      ride === undefined ||
      !ride.open ||
      (ride.kind === "ride" ? ride.entrance === null : ride.service === null)
    ) {
      clearRide(world, slot);
      return;
    }
  }
  if (shouldLeave(g, slot) && startLeaving(world, slot, routes)) return;
  if (!atTarget(g, slot)) return;

  const here = ownIndex(world, slot);
  if (ride === undefined && turnToStall(world, slot, here, routes)) return;
  if (ride !== undefined && ride.kind === "stall") {
    headForStall(world, slot, ride, here, routes);
    return;
  }
  if (ride !== undefined && queueInfo(world, ride).dist.has(here)) {
    joinQueue(world, slot, ride);
    return;
  }
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

/**
 * A guest walking about (HEADING for a waypoint, not a ride or stall) that comes to the middle of a
 * tile with a pressing need (see `pressingNeed`) turns for the nearest open stall that meets it, if
 * there is one it can reach and afford and it has not lately found it could not afford something
 * (see `shortOfMoney`), and takes its first step. Without this a guest would only notice its need
 * once it got where it was going. It thinks nothing when there is no such stall, and draws nothing
 * from the rng, so a park without stalls plays exactly as before. Returns true if it turned.
 */
function turnToStall(world: World, slot: number, here: number, routes: RouteCache): boolean {
  if (world.rides.length === 0) return false;
  const g = world.guests;
  const need = pressingNeed(g, slot);
  if (need === null || shortOfMoney(world, slot)) return false;
  const stall = nearestStall(world, here, need, routes);
  if (stall === undefined || stall.service === null || stall.price > (g.cash[slot] as number)) {
    return false;
  }
  g.ride[slot] = stall.id;
  g.dest[slot] = stall.service.y * world.terrain.width + stall.service.x;
  g.sinceAction[slot] = 0;
  head(world, slot, routes);
  return true;
}

/** Turns a guest for the exit. False, and nothing changes, if the park has no entrance. */
function startLeaving(world: World, slot: number, routes: RouteCache): boolean {
  const exit = entranceIndex(world);
  if (exit < 0) return false;
  const g = world.guests;
  g.state[slot] = GuestState.LEAVING;
  g.dest[slot] = exit;
  g.ride[slot] = 0;
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
  if (next < 0) {
    goLost(world, slot, routes);
  } else {
    // There is a way out, so whatever time it spent lost before no longer counts against it.
    g.lostTicks[slot] = 0;
    setTarget(world, slot, next);
  }
}

/**
 * Sends every guest inside the park home, as when the park closes: each one wandering, heading
 * somewhere (a ride included), queuing (it steps out of the queue), buying at a stall (it goes
 * without being served or paying), or lost starts LEAVING for the
 * entrance, thinking the park is closed. A guest keeps walking to the tile it is already heading
 * for, and then follows the route out. Guests on a ride finish it and leave when it unloads.
 * Guests already leaving are left alone, and so are guests still outside the gate, who are turned
 * away when they reach it. Nobody is charged or refunded: ENTERING is the only state that pays. Does nothing if
 * the park has no entrance to send them to.
 */
export function sendGuestsHome(world: World): void {
  const exit = entranceIndex(world);
  if (exit < 0) return;
  const g = world.guests;
  forEachGuest(world, (slot) => {
    const state = g.state[slot];
    if (
      state !== GuestState.WANDERING &&
      state !== GuestState.HEADING &&
      state !== GuestState.LOST &&
      state !== GuestState.QUEUING &&
      state !== GuestState.BUYING
    ) {
      return;
    }
    if (state === GuestState.QUEUING) leaveQueue(world, slot);
    g.state[slot] = GuestState.LEAVING;
    g.dest[slot] = exit;
    g.ride[slot] = 0;
    g.queueTicks[slot] = 0;
    g.lostTicks[slot] = 0;
    think(world, slot, THOUGHT.PARK_CLOSED);
  });
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
  g.ride[slot] = 0;
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

/**
 * A lost guest counts every tick it is lost, and at `LOST_GIVE_UP` it gives up and is removed. The
 * count is not cleared when it goes back to wandering because it can get about but not out: it is
 * still cut off, and when it tries to leave it is lost again. It is cleared when the guest finds a
 * step towards the exit (see `leave`), so a guest that was only lost for a while starts afresh.
 */
function lost(world: World, slot: number, routes: RouteCache): void {
  const g = world.guests;
  const lostFor = (g.lostTicks[slot] as number) + 1;
  if (lostFor >= LOST_GIVE_UP) {
    think(world, slot, THOUGHT.GOING_HOME);
    removeGuest(world, slot);
    return;
  }
  g.lostTicks[slot] = lostFor;
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

/**
 * Sends a guest to a ride: a guest wandering or heading somewhere in the park sets `ride` and heads
 * for the ride's entrance tile along the paths; when it steps onto one of the ride's queue tiles
 * (or the entrance) it joins the queue. Returns false, and changes nothing, if the guest is doing
 * anything else, if `rideId` is not an open ride (a stall has no queue), or if the entrance cannot
 * be reached from where the guest stands.
 */
export function sendGuestToRide(world: World, slot: number, rideId: number): boolean {
  const g = world.guests;
  if (g.live[slot] !== 1) return false;
  const state = g.state[slot];
  if (state !== GuestState.WANDERING && state !== GuestState.HEADING) return false;
  const ride = findRide(world, rideId);
  if (ride === undefined || ride.kind !== "ride" || !ride.open || ride.entrance === null) {
    return false;
  }
  const routes = guestRoutes(world);
  const here = ownIndex(world, slot);
  const target = ride.entrance.y * world.terrain.width + ride.entrance.x;
  if (here < 0 || !routes.reachable(here, target)) return false;
  g.ride[slot] = rideId;
  g.dest[slot] = target;
  g.state[slot] = GuestState.HEADING;
  g.sinceAction[slot] = 0;
  return true;
}

/**
 * Lets go of the guest's ride: it is WANDERING with no ride and no destination, from where it
 * stands (it finishes the step it is on). Does not touch the ride's queue or riders.
 */
export function clearRide(world: World, slot: number): void {
  const g = world.guests;
  g.ride[slot] = 0;
  g.queueTicks[slot] = 0;
  g.state[slot] = GuestState.WANDERING;
  g.dest[slot] = NO_DEST;
}

/** Takes a guest out of the queue of the ride in its `ride`, if it is in it. */
function leaveQueue(world: World, slot: number): void {
  const ride = findRide(world, world.guests.ride[slot] as number);
  if (ride === undefined) return;
  const position = ride.queue.indexOf(world.guests.id[slot] as number);
  if (position >= 0) ride.queue.splice(position, 1);
}

/**
 * A guest that has stepped onto `ride`'s queue joins the back of it, or finds it full, or (if it
 * was sent to a ride more intense than it likes, which it never chooses by itself) thinks the ride
 * is too intense and wanders off.
 */
function joinQueue(world: World, slot: number, ride: RideRecord): void {
  const g = world.guests;
  const type = typeById(ride.type);
  if (
    type !== undefined &&
    type.kind === "ride" &&
    type.intensity > (g.intensityPref[slot] as number) * 4 + INTENSITY_WINDOW
  ) {
    think(world, slot, THOUGHT.TOO_INTENSE);
    clearRide(world, slot);
    return;
  }
  if (ride.queue.length >= queueCapacity(world, ride)) {
    think(world, slot, THOUGHT.QUEUE_TOO_LONG);
    clearRide(world, slot);
    return;
  }
  ride.queue.push(g.id[slot] as number);
  g.state[slot] = GuestState.QUEUING;
  g.queueTicks[slot] = 0;
  g.sinceAction[slot] = 0;
}

/**
 * A queuing guest counts its time in the queue, and gives up at `QUEUE_PATIENCE`. Its place in the
 * line is its index in `ride.queue`; it belongs on `queueSlotTile(info, place)` (the entrance tile for
 * the first platform's worth of guests, then `QUEUE_PER_TILE` a tile behind it), and
 * walks there through the queue tiles, one step nearer the entrance at a time. It never walks back
 * down the line or off it: a guest nearer the front than its tile waits where it is.
 *
 * A guest standing still on a tile that is not one of the ride's queue tiles (a queue tile between
 * it and the entrance was taken away) steps out of the queue: it wanders from where it is, or, if
 * there is no path under it, it is lost.
 */
function queueing(world: World, slot: number, routes: RouteCache): void {
  const g = world.guests;
  const ride = findRide(world, g.ride[slot] as number);
  const position = ride === undefined ? -1 : ride.queue.indexOf(g.id[slot] as number);
  if (ride === undefined || position < 0 || !ride.open) {
    if (ride !== undefined && position >= 0) ride.queue.splice(position, 1);
    clearRide(world, slot);
    return;
  }
  const ticks = (g.queueTicks[slot] as number) + 1;
  if (ticks >= QUEUE_PATIENCE) {
    ride.queue.splice(position, 1);
    think(world, slot, THOUGHT.QUEUE_TOO_LONG);
    clearRide(world, slot);
    return;
  }
  g.queueTicks[slot] = ticks;
  if (!atTarget(g, slot)) return;

  const info = queueInfo(world, ride);
  const here = ownIndex(world, slot);
  const own = info.dist.get(here);
  if (own === undefined) {
    // Cut off from the entrance: out of the line.
    ride.queue.splice(position, 1);
    clearRide(world, slot);
    if (!walkable(world, here)) goLost(world, slot, routes);
    return;
  }
  const target = queueSlotTile(info, position);
  if (here === target) return;
  const want = info.dist.get(target) as number;
  if (own <= want) return;
  const { width, height } = world.terrain;
  const y = Math.floor(here / width);
  const x = here - y * width;
  // North, east, south, west: the first queue tile a step nearer the entrance.
  const step = own - 1;
  if (y > 0 && info.dist.get(here - width) === step) setTarget(world, slot, here - width);
  else if (x < width - 1 && info.dist.get(here + 1) === step) setTarget(world, slot, here + 1);
  else if (y < height - 1 && info.dist.get(here + width) === step) {
    setTarget(world, slot, here + width);
  } else if (x > 0 && info.dist.get(here - 1) === step) setTarget(world, slot, here - 1);
}

/** A riding guest waits for the ride system to let it off; if its ride has gone, it wanders. */
function riding(world: World, slot: number): void {
  const g = world.guests;
  const ride = findRide(world, g.ride[slot] as number);
  if (ride === undefined || !ride.riders.includes(g.id[slot] as number)) clearRide(world, slot);
}

/** The needs a stall can meet, as content names them. */
export type Need = "hunger" | "thirst" | "bathroom";

/**
 * The guest's most pressing need: the highest of those at their seek level or more (hunger and
 * thirst at `NEED_SEEK_LEVEL`, the toilet at `BATHROOM_SEEK_LEVEL`; hunger, then thirst, then the
 * toilet, on a tie), or null if none is that pressing.
 */
function pressingNeed(g: GuestStore, slot: number): Need | null {
  const hunger = g.hunger[slot] as number;
  const thirst = g.thirst[slot] as number;
  const bathroom = g.bathroom[slot] as number;
  let need: Need | null = null;
  let level = -1;
  if (hunger >= NEED_SEEK_LEVEL) {
    need = "hunger";
    level = hunger;
  }
  if (thirst >= NEED_SEEK_LEVEL && thirst > level) {
    need = "thirst";
    level = thirst;
  }
  if (bathroom >= BATHROOM_SEEK_LEVEL && bathroom > level) need = "bathroom";
  return need;
}

/** What a guest thinks when it cannot find a stall for `need`. */
function nothingFor(need: Need): number {
  return need === "hunger"
    ? THOUGHT.NOTHING_TO_EAT
    : need === "thirst"
      ? THOUGHT.NOTHING_TO_DRINK
      : THOUGHT.NO_TOILETS;
}

/** What a guest thinks when it has been served at a stall that meets `need`. */
function servedFor(need: Need): number {
  return need === "hunger"
    ? THOUGHT.GOOD_FOOD
    : need === "thirst"
      ? THOUGHT.REFRESHING
      : THOUGHT.BETTER_NOW;
}

/**
 * The stalls of each need, as one multi-source distance field over the paths per need: for every
 * tile, the steps to the nearest service tile of an open stall meeting that need, and which stall
 * that is. Kept on the world beside the route cache and rebuilt (one flood per need, when first
 * asked for) whenever the paths, the entrance or the rides change. Runtime only: never saved or
 * hashed, since it is worked out again from the paths and the rides.
 */
export interface StallFields {
  terrain: Terrain;
  pathVersion: number;
  rideVersion: number;
  hunger: MultiSourceField | null;
  thirst: MultiSourceField | null;
  bathroom: MultiSourceField | null;
}

/**
 * The field for `need` (see `StallFields`): `dist` is the steps from each tile to the service tile
 * of the nearest open stall that meets it (`UNREACHABLE` if none can be reached), and `owner` that
 * stall's id (0 for none). The stalls are seeded in ascending id order, so a tile equally near two
 * of them belongs to the lower id. A stall whose service tile has no path is not in it.
 */
export function stallField(
  world: World,
  need: Need,
  routes: RouteCache = guestRoutes(world),
): MultiSourceField {
  let fields = world.stallFields;
  if (
    fields === undefined ||
    fields.terrain !== world.terrain ||
    fields.pathVersion !== world.pathVersion ||
    fields.rideVersion !== world.rideVersion
  ) {
    fields = {
      terrain: world.terrain,
      pathVersion: world.pathVersion,
      rideVersion: world.rideVersion,
      hunger: null,
      thirst: null,
      bathroom: null,
    };
    world.stallFields = fields;
  }
  const cached = fields[need];
  if (cached !== null) return cached;
  const width = world.terrain.width;
  const targets: number[] = [];
  const owners: number[] = [];
  // `world.rides` is in id order, so the seeds are too.
  for (const ride of world.rides) {
    if (ride.kind !== "stall" || !ride.open || ride.service === null) continue;
    const type = typeById(ride.type);
    if (type === undefined || type.kind !== "stall" || type.meets !== need) continue;
    targets.push(ride.service.y * width + ride.service.x);
    owners.push(ride.id);
  }
  const field = routes.multiSourceField(targets, owners);
  fields[need] = field;
  return field;
}

/**
 * The open stall meeting `need` that a guest on tile `here` can walk to in the fewest steps along
 * the paths (to its service tile), the lowest id on a tie, or undefined if it can reach none: a
 * look-up in the need's `stallField`. A stall whose service tile has no path cannot be reached.
 */
export function nearestStall(
  world: World,
  here: number,
  need: Need,
  routes: RouteCache,
): RideRecord | undefined {
  const field = stallField(world, need, routes);
  if (here < 0 || here >= field.dist.length || field.dist[here] === UNREACHABLE) return undefined;
  return findRide(world, field.owner[here] as number);
}

/**
 * A guest heading for the stall `stall` walks down the field of the need the stall meets, a step
 * at a time (the neighbour nearest a stall; north, east, south, west on a tie), rather than along a
 * field of its own for that one stall. The tile it stands on says which stall it is now nearest:
 * if that is another (one opened nearer, or this one closed), the guest heads for that one instead
 * (`ride` and `dest` follow it, so closing or demolishing it lets the guest go). On a service tile
 * it is there, and buys. With no stall it can reach it is lost.
 */
function headForStall(
  world: World,
  slot: number,
  stall: RideRecord,
  here: number,
  routes: RouteCache,
): void {
  const type = typeById(stall.type);
  if (type === undefined || type.kind !== "stall") {
    clearRide(world, slot);
    return;
  }
  const field = stallField(world, type.meets, routes);
  const steps = here < 0 ? UNREACHABLE : (field.dist[here] as number);
  if (steps === UNREACHABLE) {
    goLost(world, slot, routes);
    return;
  }
  const g = world.guests;
  const owner = field.owner[here] as number;
  if (owner !== stall.id) {
    const nearer = findRide(world, owner);
    if (nearer === undefined || nearer.service === null) {
      clearRide(world, slot);
      return;
    }
    g.ride[slot] = owner;
    g.dest[slot] = nearer.service.y * world.terrain.width + nearer.service.x;
  }
  if (steps === 0) {
    startBuying(world, slot);
    return;
  }
  setTarget(world, slot, routes.downhill(field.dist, here));
}

/**
 * The ride the guest in `slot`, standing on tile `here`, would most like to go on, or undefined if
 * none will do. A ride will do if it is open, its entrance can be reached along the paths (it is
 * in the same connected piece of path as the guest: see `RouteCache.component`), the guest can pay
 * its price, it is not the guest's `lastRide`, its intensity is within `INTENSITY_WINDOW` of the
 * guest's preference (`intensityPref * 4`), and its queue is not full. Of those, the best scores
 * `excitement - |intensity - preference| / 2 - 4 * the Manhattan distance to the entrance` (the
 * halving rounds down); the lowest id wins a tie. Measuring as the crow flies (in whole tiles,
 * along the grid) keeps the choice to a few sums a ride; only the ride chosen needs a distance
 * field, to walk there by.
 */
export function bestRide(
  world: World,
  slot: number,
  here: number,
  routes: RouteCache,
): RideRecord | undefined {
  const g = world.guests;
  const width = world.terrain.width;
  const piece = routes.component(here);
  if (piece < 0) return undefined;
  const hy = Math.floor(here / width);
  const hx = here - hy * width;
  const preference = (g.intensityPref[slot] as number) * 4;
  const last = g.lastRide[slot] as number;
  const cash = g.cash[slot] as number;
  let best: RideRecord | undefined;
  let bestScore = 0;
  for (const ride of world.rides) {
    if (ride.kind !== "ride" || !ride.open || ride.entrance === null || ride.id === last) continue;
    if (ride.price > cash) continue;
    const type = typeById(ride.type);
    if (type === undefined || type.kind !== "ride") continue;
    const gap = Math.abs(type.intensity - preference);
    if (gap > INTENSITY_WINDOW) continue;
    if (ride.queue.length >= queueCapacity(world, ride)) continue;
    const { x, y } = ride.entrance;
    if (routes.component(y * width + x) !== piece) continue;
    const steps = Math.abs(x - hx) + Math.abs(y - hy);
    const score = type.excitement - (gap >> 1) - steps * 4;
    if (best === undefined || score > bestScore) {
      best = ride;
      bestScore = score;
    }
  }
  return best;
}

/** Whether the park has a ride (not a stall) open. */
function anyRideOpen(world: World): boolean {
  for (const ride of world.rides) if (ride.kind === "ride" && ride.open) return true;
  return false;
}

/**
 * A wandering guest's turn, in a park with rides or stalls, before it thinks of walking about:
 *
 *  1. If hunger, thirst or the need for the toilet is at its seek level or more (see
 *     `pressingNeed`), it heads for the nearest open stall that meets the most pressing of them (see
 *     `nearestStall`). If there is none, it carries on, and if that need is at
 *     `NEED_COMPLAIN_LEVEL` or more it thinks so (at most once a `NEED_SEEK_THOUGHT_INTERVAL`,
 *     unless it has thought of something else since). If that stall costs more than it has, it thinks it
 *     cannot afford it and carries on; and a guest that has thought so (here, at a stall's counter
 *     or at a ride's entrance) in the last `NEED_SEEK_THOUGHT_INTERVAL` does not look for a stall
 *     at all (see `shortOfMoney`), so it does not keep walking to one it cannot pay.
 *  2. If any ride is open, it draws one number from `rng`: on one draw in two it goes for the ride
 *     it likes best (see `bestRide`), if any will do.
 *
 * Returns true if the guest is now HEADING for a stall or ride (and has taken its first step).
 * Draws nothing in a park with no open ride, so stalls alone leave the guest stream as it was.
 */
function seekStallOrRide(world: World, slot: number, rng: Rng, routes: RouteCache): boolean {
  const here = ownIndex(world, slot);
  if (here < 0) return false;
  const g = world.guests;
  const need = pressingNeed(g, slot);
  if (need !== null && !shortOfMoney(world, slot)) {
    const stall = nearestStall(world, here, need, routes);
    if (stall !== undefined && stall.service !== null) {
      if (stall.price > (g.cash[slot] as number)) {
        think(world, slot, THOUGHT.CANT_AFFORD_RIDE);
      } else {
        g.ride[slot] = stall.id;
        g.dest[slot] = stall.service.y * world.terrain.width + stall.service.x;
        g.state[slot] = GuestState.HEADING;
        g.sinceAction[slot] = 0;
        head(world, slot, routes);
        return true;
      }
    } else if ((g[need][slot] as number) >= NEED_COMPLAIN_LEVEL) {
      const thought = nothingFor(need);
      if (
        g.thought[slot] !== thought ||
        world.tick - (g.thoughtTick[slot] as number) >= NEED_SEEK_THOUGHT_INTERVAL
      ) {
        think(world, slot, thought);
      }
    }
  }
  if (!anyRideOpen(world) || rng.int(2) !== 0) return false;
  const ride = bestRide(world, slot, here, routes);
  if (ride === undefined || !sendGuestToRide(world, slot, ride.id)) return false;
  head(world, slot, routes);
  return true;
}

/**
 * Whether the guest has found it could not afford something in the last
 * `NEED_SEEK_THOUGHT_INTERVAL` (a day): its last thought is that one. A guest's cash only changes
 * when it pays, and paying always gives it another thought (served, or the ride was fun), so the
 * thought it has is a record of whether its cash has changed since, with no field of its own.
 */
function shortOfMoney(world: World, slot: number): boolean {
  const g = world.guests;
  return (
    g.thought[slot] === THOUGHT.CANT_AFFORD_RIDE &&
    world.tick - (g.thoughtTick[slot] as number) < NEED_SEEK_THOUGHT_INTERVAL
  );
}

/** A guest that has reached its stall's service tile stands there to be served. */
function startBuying(world: World, slot: number): void {
  const g = world.guests;
  g.state[slot] = GuestState.BUYING;
  g.dest[slot] = NO_DEST;
  g.queueTicks[slot] = 0;
  g.sinceAction[slot] = 0;
}

/**
 * A guest buying at a stall stands still for the stall type's `serveTicks`, then pays its price
 * if it can: out of its cash into the park's, `park.income.shops`, `park.monthly.shops` and the
 * stall's stats; the need the stall meets drops by the type's `amount` (not below 0), it is
 * `STALL_HAPPINESS` happier, and it thinks well of it. A guest that cannot pay thinks it cannot
 * afford it and is not served. Either way it then wanders. If the stall has gone or closed, the
 * guest wanders without being served or paying (closing and demolishing let such guests go at
 * once; this is the same rule, for safety).
 */
function buying(world: World, slot: number): void {
  const g = world.guests;
  const stall = findRide(world, g.ride[slot] as number);
  const type = stall === undefined ? undefined : typeById(stall.type);
  if (stall === undefined || !stall.open || type === undefined || type.kind !== "stall") {
    clearRide(world, slot);
    return;
  }
  const ticks = (g.queueTicks[slot] as number) + 1;
  if (ticks < type.serveTicks) {
    g.queueTicks[slot] = ticks;
    return;
  }
  const price = stall.price;
  if ((g.cash[slot] as number) < price) {
    think(world, slot, THOUGHT.CANT_AFFORD_RIDE);
    clearRide(world, slot);
    return;
  }
  const { park } = world;
  g.cash[slot] = (g.cash[slot] as number) - price;
  world.finance.cash += price;
  park.income.shops += price;
  park.monthly.shops += price;
  stall.stats.income += price;
  stall.stats.monthIncome += price;
  stall.stats.customers++;
  stall.stats.monthCustomers++;
  const need = g[type.meets];
  need[slot] = Math.max(0, (need[slot] as number) - type.amount);
  g.happiness[slot] = Math.min(255, (g.happiness[slot] as number) + STALL_HAPPINESS);
  think(world, slot, servedFor(type.meets));
  clearRide(world, slot);
}
