import { parseArgs } from "node:util";
import { MAX_ADVANCE_DAYS, Sim } from "@coasterworks/sim";
import { integerOption, parseOrUsage, requireOption } from "../args.js";
import { printJson, queryOrThrow, readPark, writePark, type CliIO } from "../io.js";

/** `run --save <file> --days <n> [--out <file>]`: advances a park and prints its status. */
export async function runCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        save: { type: "string" },
        days: { type: "string" },
        out: { type: "string" },
      },
      allowPositionals: false,
    }),
  );
  const save = requireOption("save", values.save);
  const days = integerOption("days", requireOption("days", values.days), {
    min: 1,
    max: MAX_ADVANCE_DAYS,
  });

  const sim = new Sim(await readPark(save));
  // Through `execute`, not `advanceDays`, so the log records that time passed.
  const advanced = sim.execute("sim_advance", { days }, "system");
  if (!advanced.ok) throw new Error(advanced.error);

  if (values.out !== undefined) await writePark(values.out, sim.world);
  printJson(io, queryOrThrow(sim, "park_status", {}));
  return 0;
}
