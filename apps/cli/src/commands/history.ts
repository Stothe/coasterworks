import { parseArgs } from "node:util";
import { Sim } from "@coasterworks/sim";
import { parseOrUsage, requireOption } from "../args.js";
import { printJson, readPark, writePark, type CliIO } from "../io.js";

/**
 * Undoes or redoes one command as the agent, writes the park to `--out`, and prints the result. A
 * park changed only in memory is not worth keeping, so `--out` is required. Exits 1 if there is
 * nothing to undo (or redo) or the sim refuses, and then writes nothing.
 */
async function historyStep(step: "undo" | "redo", args: string[], io: CliIO): Promise<number> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { save: { type: "string" }, out: { type: "string" } },
      allowPositionals: false,
    }),
  );
  const save = requireOption("save", values.save);
  const out = requireOption("out", values.out);

  const sim = new Sim(await readPark(save));
  const result = step === "undo" ? sim.undo("agent") : sim.redo("agent");
  if (result.ok) {
    await writePark(out, sim.world);
    printJson(io, result);
    return 0;
  }
  printJson(io, result);
  io.stderr(`error: ${result.error}\n`);
  return 1;
}

/** `undo --save <file> --out <file>`: undoes the most recent undoable command. */
export const undoCommand = (args: string[], io: CliIO): Promise<number> =>
  historyStep("undo", args, io);

/** `redo --save <file> --out <file>`: redoes the command that was last undone. */
export const redoCommand = (args: string[], io: CliIO): Promise<number> =>
  historyStep("redo", args, io);
