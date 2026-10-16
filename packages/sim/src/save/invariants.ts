import { MAX_HEIGHT, type World } from "../world/types.js";

/** Highest `Surface` value: grass, sand, dirt, rock, snow. */
const MAX_SURFACE = 4;

/**
 * Checks what the save schema cannot: the rules every world the sim builds obeys, which a damaged
 * or badly migrated save may not. Returns the first problem found, as a sentence, or null.
 *
 *   - every corner height is 0 to `MAX_HEIGHT`, every surface 0 to 4, every water level 0 to
 *     `MAX_HEIGHT`
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
