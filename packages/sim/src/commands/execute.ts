import type { ClientKind, LogEntry, World } from "../world/types.js";
import { parseInput } from "./define.js";
import type { Registry } from "./registry.js";

/** `id` is the id of the log entry the call added. */
export type ExecResult = { ok: true; id: number; cost: number } | { ok: false; error: string };

/** Formats integer cents as dollars with two decimals and no separators, such as `-$3.50`. */
function formatMoney(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}$${dollars}.${rest}`;
}

/** The error for a charge of `cost` cents, or null if the park can pay it. Charges of 0 always pass. */
export function checkCash(world: World, cost: number): string | null {
  if (cost <= 0 || cost <= world.finance.cash) return null;
  return `Not enough cash: need ${formatMoney(cost)}, have ${formatMoney(world.finance.cash)}`;
}

/** Adds an entry to the log with the next id. */
export function appendLog(
  world: World,
  client: ClientKind,
  name: string,
  input: unknown,
  cost: number,
): LogEntry {
  const entry: LogEntry = { id: world.nextId++, tick: world.tick, client, name, input, cost };
  world.log.push(entry);
  return entry;
}

/**
 * Runs a command: parse, validate, check cash, apply, charge, log. Any failure returns an error
 * and leaves the world untouched. A command that succeeds clears the redo stack, and joins the
 * undo stack if it is undoable.
 *
 * Throws if the command's cost is not a non-negative integer of cents, which is a bug in the command.
 */
export function executeCommand(
  world: World,
  registry: Registry,
  name: string,
  rawInput: unknown,
  client: ClientKind,
): ExecResult {
  const def = registry.command(name);
  if (!def) return { ok: false, error: `Unknown command: ${name}` };

  const parsed = parseInput(def.input, rawInput);
  if (!parsed.ok) return parsed;
  const input = parsed.data;

  const reason = def.validate(world, input);
  if (reason !== null) return { ok: false, error: reason };

  const cost = def.cost ? def.cost(world, input) : 0;
  if (!Number.isInteger(cost) || cost < 0) {
    throw new RangeError(
      `Command ${name} computed cost ${cost}; expected non-negative integer cents`,
    );
  }
  const lacking = checkCash(world, cost);
  if (lacking !== null) return { ok: false, error: lacking };

  const undo = def.apply(world, input);
  world.finance.cash -= cost;
  const entry = appendLog(world, client, name, input, cost);
  if (def.undoable) {
    if (undo !== undefined) entry.undo = undo;
    world.undoStack.push(entry.id);
  }
  world.redoStack.length = 0;
  return { ok: true, id: entry.id, cost };
}
