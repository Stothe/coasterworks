import { THOUGHTS } from "../guests/thoughts.js";
import {
  DEST_TURNED_AWAY,
  GUEST_CAP,
  GUEST_COLORS,
  MAX_GUEST_STATE,
  NAME_COUNT,
  NO_TILE,
} from "../guests/types.js";
import { HISTORY_MONTHS, MAX_ENTRY_FEE, MAX_RATING, type ParkState } from "../park/types.js";
import { PATH_QUEUE, edgeSide } from "../paths/paths.js";
import { inBounds } from "../terrain/terrain.js";
import { MONTHS_PER_YEAR } from "../time.js";
import { MAX_HEIGHT, type World } from "../world/types.js";

/** Highest `Surface` value: grass, sand, dirt, rock, snow. */
const MAX_SURFACE = 4;

/**
 * Checks what the save schema cannot: the rules every world the sim builds obeys, which a damaged
 * or badly migrated save may not. Returns the first problem found, as a sentence, or null.
 *
 *   - every corner height is 0 to `MAX_HEIGHT`, every surface 0 to 4, every water level 0 to
 *     `MAX_HEIGHT`, every path value 0 to 2
 *   - the park's entrance, if it has one, is on the map and on its edge; the entry fee is 0 to
 *     $100.00, the rating 0 to 999, and the guest, admission, income, and expense counters are not
 *     negative; its history holds at most 12 months, each a year from 1, a month 0 to 7, and whole
 *     numbers of cents, with the income and costs not negative
 *   - every live guest has an id that is above 0, below `nextGuestId`, and used by no other guest;
 *     a state 0 to 5, a colour 0 to 8, a name and a thought that exist, cash, idle times, and lost
 *     times that are not negative; a position and a target tile on the map or one tile outside it
 *     (the entrance lane); and a destination that is a tile on the map or one of the two "walking
 *     out" markers
 *   - log ids start above 0, strictly increase, and are all below `nextId`
 *   - every id on the undo and redo stacks names a log entry, and no id is on the stacks twice,
 *     which covers an id on both
 *
 * A stack id is not required to name an entry with `undo` data. A command whose `apply` returns
 * nothing, such as `finance_take_loan`, is undoable and sits on the stack with no `undo` key.
 */
export function validateWorldInvariants(world: World): string | null {
  const { terrain, log } = world;

  for (let i = 0; i < terrain.corners.length; i++) {
    const height = terrain.corners[i] as number;
    if (height < 0 || height > MAX_HEIGHT) {
      return `corner ${i} has height ${height}, outside 0 to ${MAX_HEIGHT}`;
    }
  }
  for (let i = 0; i < terrain.surface.length; i++) {
    const surface = terrain.surface[i] as number;
    if (surface > MAX_SURFACE)
      return `tile ${i} has surface ${surface}, outside 0 to ${MAX_SURFACE}`;
  }
  for (let i = 0; i < terrain.water.length; i++) {
    const level = terrain.water[i] as number;
    if (level > MAX_HEIGHT) return `tile ${i} has water level ${level}, outside 0 to ${MAX_HEIGHT}`;
  }

  for (let i = 0; i < terrain.path.length; i++) {
    const path = terrain.path[i] as number;
    if (path > PATH_QUEUE) return `tile ${i} has path ${path}, outside 0 to ${PATH_QUEUE}`;
  }

  const problem = parkProblem(world);
  if (problem !== null) return problem;

  const guestIssue = guestProblem(world);
  if (guestIssue !== null) return guestIssue;

  const ids = new Set<number>();
  let previous = 0;
  for (const entry of log) {
    if (entry.id <= previous) {
      return `log id ${entry.id} does not come after ${previous}; ids start at 1 and increase`;
    }
    previous = entry.id;
    ids.add(entry.id);
  }
  if (previous >= world.nextId) return `log id ${previous} is not below nextId ${world.nextId}`;

  const stackOf = new Map<number, string>();
  for (const [name, stack] of [
    ["undo stack", world.undoStack],
    ["redo stack", world.redoStack],
  ] as const) {
    for (const id of stack) {
      if (!ids.has(id)) return `${name} id ${id} names no log entry`;
      const earlier = stackOf.get(id);
      if (earlier === name) return `${name} id ${id} appears more than once`;
      if (earlier !== undefined) return `id ${id} is on both the undo stack and the redo stack`;
      stackOf.set(id, name);
    }
  }
  return null;
}

/** The first thing wrong with the park state, as a sentence, or null. */
function parkProblem(world: World): string | null {
  const { park, terrain } = world;
  const { entrance } = park;
  if (entrance !== null) {
    if (!inBounds(terrain, entrance.x, entrance.y)) {
      return `entrance (${entrance.x}, ${entrance.y}) is outside the ${terrain.width}x${terrain.height} map`;
    }
    if (edgeSide(terrain, entrance.x, entrance.y) === -1) {
      return `entrance (${entrance.x}, ${entrance.y}) is not on the map edge`;
    }
  }
  if (park.entryFee < 0 || park.entryFee > MAX_ENTRY_FEE) {
    return `entry fee ${park.entryFee} is outside 0 to ${MAX_ENTRY_FEE}`;
  }
  if (park.rating < 0 || park.rating > MAX_RATING) {
    return `rating ${park.rating} is outside 0 to ${MAX_RATING}`;
  }
  const counters: Array<[string, number]> = [
    ["guestsInPark", park.guestsInPark],
    ["totalAdmissions", park.totalAdmissions],
    ...Object.entries(park.income).map(([k, v]): [string, number] => [`income.${k}`, v]),
    ...Object.entries(park.expenses).map(([k, v]): [string, number] => [`expenses.${k}`, v]),
    ...Object.entries(park.monthly).map(([k, v]): [string, number] => [`monthly.${k}`, v]),
  ];
  for (const [label, value] of counters) {
    if (value < 0) return `${label} is ${value}, which is below 0`;
  }
  return historyProblem(park.history);
}

/** The first thing wrong with the months of history, as a sentence, or null. */
function historyProblem(history: ParkState["history"]): string | null {
  if (history.length > HISTORY_MONTHS) {
    return `history holds ${history.length} months, more than ${HISTORY_MONTHS}`;
  }
  for (const [i, record] of history.entries()) {
    for (const [key, value] of Object.entries(record)) {
      if (!Number.isInteger(value)) {
        return `history[${i}].${key} is ${value}, which is not a whole number`;
      }
    }
    if (record.year < 1) return `history[${i}].year is ${record.year}, which is below 1`;
    if (record.month < 0 || record.month >= MONTHS_PER_YEAR) {
      return `history[${i}].month is ${record.month}, outside 0 to ${MONTHS_PER_YEAR - 1}`;
    }
    for (const key of ["entry", "rides", "shops", "running", "wages"] as const) {
      if (record[key] < 0) return `history[${i}].${key} is ${record[key]}, which is below 0`;
    }
  }
  return null;
}

/** The first thing wrong with the guests, as a sentence, or null. */
function guestProblem(world: World): string | null {
  const g = world.guests;
  const { width, height } = world.terrain;
  if (g.count < 0 || g.count > GUEST_CAP)
    return `guest count ${g.count} is outside 0 to ${GUEST_CAP}`;
  if (g.nextGuestId < 1) return `nextGuestId ${g.nextGuestId} is below 1`;

  const tiles = width * height;
  const seen = new Set<number>();
  let live = 0;
  for (let slot = 0; slot < GUEST_CAP; slot++) {
    if (g.live[slot] !== 1) continue;
    live++;
    const id = g.id[slot] as number;
    if (id < 1) return `guest id ${id} is not above 0`;
    if (id >= g.nextGuestId) return `guest id ${id} is not below nextGuestId ${g.nextGuestId}`;
    if (seen.has(id)) return `guest id ${id} is used by two guests`;
    seen.add(id);

    const label = `guest ${id}`;
    const state = g.state[slot] as number;
    if (state > MAX_GUEST_STATE)
      return `${label} has state ${state}, outside 0 to ${MAX_GUEST_STATE}`;
    const color = g.color[slot] as number;
    if (color >= GUEST_COLORS)
      return `${label} has color ${color}, outside 0 to ${GUEST_COLORS - 1}`;
    const name = g.name[slot] as number;
    if (name >= NAME_COUNT) return `${label} has name ${name}, outside 0 to ${NAME_COUNT - 1}`;
    const thought = g.thought[slot] as number;
    if (thought >= THOUGHTS.length) return `${label} has thought ${thought}, which does not exist`;
    if ((g.cash[slot] as number) < 0) return `${label} has cash ${g.cash[slot]}, which is below 0`;
    if ((g.sinceAction[slot] as number) < 0) {
      return `${label} has sinceAction ${g.sinceAction[slot]}, which is below 0`;
    }
    if ((g.thoughtTick[slot] as number) < 0) {
      return `${label} has thoughtTick ${g.thoughtTick[slot]}, which is below 0`;
    }
    if ((g.lostTicks[slot] as number) < 0) {
      return `${label} has lostTicks ${g.lostTicks[slot]}, which is below 0`;
    }

    // A guest is on the map or one tile outside it, where the entrance lane is.
    const tileX = (g.x[slot] as number) >> 5;
    const tileY = (g.y[slot] as number) >> 5;
    if (tileX < -1 || tileX > width || tileY < -1 || tileY > height) {
      return `${label} has position (${g.x[slot]}, ${g.y[slot]}), too far off the ${width}x${height} map`;
    }
    const tx = g.tx[slot] as number;
    const ty = g.ty[slot] as number;
    if (!(tx === NO_TILE && ty === NO_TILE) && (tx < -1 || tx > width || ty < -1 || ty > height)) {
      return `${label} has target (${tx}, ${ty}), too far off the ${width}x${height} map`;
    }
    const dest = g.dest[slot] as number;
    if (dest < DEST_TURNED_AWAY || dest >= tiles) {
      return `${label} has destination ${dest}, which is not a tile of the ${width}x${height} map`;
    }
  }
  if (live !== g.count) return `guest count ${g.count} does not match the ${live} live guests`;
  return null;
}
