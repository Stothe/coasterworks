import { z } from "zod";
import { defineQuery } from "../commands/define.js";

// The ES2022 lib has no `structuredClone` and this package builds with `types: []`, but Node 22
// and every browser provide it.
declare function structuredClone<T>(value: T): T;

/** The latest commands, newest first. */
export const logRecent = defineQuery({
  name: "log_recent",
  description:
    "Returns the most recent log entries, newest first. Includes undo and redo entries. The data used to undo a command is left out.",
  category: "sim",
  input: z.object({ limit: z.int().min(1).max(200).default(20) }),
  // The entries are copies, input included, so a caller cannot change the log through the result.
  run: (world, { limit }) =>
    world.log
      .slice(-limit)
      .reverse()
      .map(({ undo: _undo, ...entry }) => ({ ...entry, input: structuredClone(entry.input) })),
});

/** Whether undo and redo have anything to do. */
export const undoState = defineQuery({
  name: "undo_state",
  description:
    "Returns whether undo and redo are available, and how many commands are waiting on each stack.",
  category: "sim",
  input: z.object({}),
  run: (world) => ({
    canUndo: world.undoStack.length > 0,
    canRedo: world.redoStack.length > 0,
    undoCount: world.undoStack.length,
    redoCount: world.redoStack.length,
  }),
});
