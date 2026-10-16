import { parseArgs } from "node:util";
import { Sim } from "@coasterworks/sim";
import { jsonInputOption, parseOrUsage, requireOption } from "../args.js";
import { printJson, readPark, type CliIO } from "../io.js";

/**
 * `query --save <file> --name <query> [--input <json>]`: runs one read-only query and prints its
 * result, `{ ok: true, result }` or `{ ok: false, error }`. Exits 1 if the query fails. A query
 * changes nothing and is not logged, so there is no `--out`, and the save is never modified.
 */
export async function queryCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        save: { type: "string" },
        name: { type: "string" },
        input: { type: "string" },
      },
      allowPositionals: false,
    }),
  );
  const save = requireOption("save", values.save);
  const name = requireOption("name", values.name);
  const input = jsonInputOption(values.input);

  const sim = new Sim(await readPark(save));
  const result = sim.query(name, input);
  printJson(io, result);
  if (result.ok) return 0;
  io.stderr(`error: ${result.error}\n`);
  return 1;
}
