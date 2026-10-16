import { parseArgs } from "node:util";
import { Sim } from "@coasterworks/sim";
import { UsageError, parseOrUsage } from "../args.js";
import { printJson, queryOrThrow, readPark, type CliIO } from "../io.js";

/** `inspect <file>`: prints the park's status and its 20 most recent log entries. */
export async function inspectCommand(args: string[], io: CliIO): Promise<number> {
  const { positionals } = parseOrUsage(() =>
    parseArgs({ args, options: {}, allowPositionals: true }),
  );
  const [file, ...extra] = positionals;
  if (file === undefined) throw new UsageError("missing <file>");
  if (extra.length > 0) throw new UsageError(`unexpected argument: ${extra[0]}`);

  const sim = new Sim(await readPark(file));
  printJson(io, {
    status: queryOrThrow(sim, "park_status", {}),
    log: queryOrThrow(sim, "log_recent", { limit: 20 }),
  });
  return 0;
}
