import { MAX_ENTRY_FEE, MAX_RATING } from "../park/types.js";
import { PATH_QUEUE, edgeSide } from "../paths/paths.js";
import { inBounds } from "../terrain/terrain.js";
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
 *     negative
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
  return null;
}
