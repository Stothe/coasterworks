import { parseArgs } from "node:util";
import { Sim } from "@coasterworks/sim";
import { parseOrUsage, requireOption } from "../args.js";
import { printJson, readPark, writePark, type CliIO } from "../io.js";

/**
 * `exec --save <file> --command <name> --input <json> [--out <file>]`: runs one command as the
 * agent and prints its result. Exits 1 if the command fails, and then writes nothing.
 */
export async function execCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        save: { type: "string" },
        command: { type: "string" },
        input: { type: "string" },
        out: { type: "string" },
      },
      allowPositionals: false,
    }),
  );
  const save = requireOption("save", values.save);
  const command = requireOption("command", values.command);
  let input: unknown;
  try {
    input = JSON.parse(values.input ?? "{}");
  } catch {
    throw new Error("--input is not valid JSON");
  }

  const sim = new Sim(await readPark(save));
  const result = sim.execute(command, input, "agent");
  if (result.ok) {
    if (values.out !== undefined) await writePark(values.out, sim.world);
    printJson(io, result);
    return 0;
  }
  printJson(io, result);
  io.stderr(`error: ${result.error}\n`);
  return 1;
}
