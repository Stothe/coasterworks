import type { ClientKind, LogEntry, World } from "../world/types.js";
import { appendLog, checkCash, type ExecResult } from "./execute.js";
import type { Registry } from "./registry.js";

/** Finds a log entry by id. Recent entries are the likely ones, so this scans from the end. */
function findEntry(world: World, id: number): LogEntry | undefined {
  for (let i = world.log.length - 1; i >= 0; i--) {
    const entry = world.log[i];
    if (entry && entry.id === id) return entry;
  }
  return undefined;
}

/** `-n`, but 0 stays 0 rather than becoming -0. */
function negate(n: number): number {
  return n === 0 ? 0 : -n;
}

/**
 * Undoes the most recent undoable command: reverts it, refunds what it cost, and logs an `undo`
 * entry whose cost is the refund as a negative number. The command moves to the redo stack.
 * On any error the world, the stacks, and the log are left as they were.
 */
export function undoLast(world: World, registry: Registry, client: ClientKind): ExecResult {
  const id = world.undoStack[world.undoStack.length - 1];
  if (id === undefined) return { ok: false, error: "Nothing to undo" };
  const entry = findEntry(world, id);
  if (!entry) return { ok: false, error: `Log entry ${id} not found` };
  const def = registry.command(entry.name);
  if (!def) return { ok: false, error: `Unknown command: ${entry.name}` };
  if (!def.undoable) return { ok: false, error: `Command ${entry.name} cannot be undone` };

  const reason = def.validateRevert ? def.validateRevert(world, entry.input, entry.undo) : null;
  if (reason !== null) return { ok: false, error: reason };

  def.revert(world, entry.input, entry.undo);
  world.finance.cash += entry.cost;
  world.undoStack.pop();
  world.redoStack.push(id);
  const cost = negate(entry.cost);
  const undone = appendLog(world, client, "undo", { target: id }, cost);
  entry.undoneBy = undone.id;
  return { ok: true, id: undone.id, cost };
}

/**
 * Redoes the most recently undone command. The command is validated again and the original cost
 * is charged again, so redo can fail where the first run succeeded. It logs a `redo` entry and
 * moves the command back to the undo stack. On any error nothing changes.
 */
export function redoLast(world: World, registry: Registry, client: ClientKind): ExecResult {
  const id = world.redoStack[world.redoStack.length - 1];
  if (id === undefined) return { ok: false, error: "Nothing to redo" };
  const entry = findEntry(world, id);
  if (!entry) return { ok: false, error: `Log entry ${id} not found` };
  const def = registry.command(entry.name);
  if (!def) return { ok: false, error: `Unknown command: ${entry.name}` };

  const reason = def.validate(world, entry.input);
  if (reason !== null) return { ok: false, error: reason };
  const lacking = checkCash(world, entry.cost);
  if (lacking !== null) return { ok: false, error: lacking };

  // Same as `executeCommand`: a command with nothing to undo leaves no `undo` key at all.
  const undo = def.apply(world, entry.input);
  if (undo !== undefined) entry.undo = undo;
  else delete entry.undo;
  world.finance.cash -= entry.cost;
  delete entry.undoneBy;
  world.redoStack.pop();
  world.undoStack.push(id);
  const redone = appendLog(world, client, "redo", { target: id }, entry.cost);
  return { ok: true, id: redone.id, cost: entry.cost };
}
