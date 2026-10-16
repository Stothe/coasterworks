import { z } from "zod";
import { defineCommand } from "./define.js";

/** Most days a single `sim_advance` can run: ten years. */
export const MAX_ADVANCE_DAYS = 3650;

/**
 * Runs the simulation forward. The command changes nothing itself: `Sim.execute` does the
 * stepping once the command has been parsed, validated, and logged like any other. It cannot be
 * undone, because time does not run backward.
 */
export const simAdvance = defineCommand({
  name: "sim_advance",
  description: `Advances the simulation by a number of days (1 to ${MAX_ADVANCE_DAYS}). A day is 400 ticks. Interest is charged and the month rolls over along the way.`,
  category: "sim",
  input: z.object({ days: z.int().min(1).max(MAX_ADVANCE_DAYS) }),
  undoable: false,
  validate: () => null,
  apply: () => {},
  revert: () => {},
});
