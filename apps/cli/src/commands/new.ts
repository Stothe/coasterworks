import { parseArgs } from "node:util";
import { MAX_MAP, Sim, createWorld } from "@coasterworks/sim";
import { integerOption, parseOrUsage, requireOption } from "../args.js";
import { printJson, queryOrThrow, writePark, type CliIO } from "../io.js";

/** `new --out <file> [--width 64] [--height 64] [--seed <n>] [--name <s>]`: creates a park. */
export async function newCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        out: { type: "string" },
        width: { type: "string" },
        height: { type: "string" },
        seed: { type: "string" },
        name: { type: "string" },
      },
      allowPositionals: false,
    }),
  );
  const out = requireOption("out", values.out);
  const size = { min: 1, max: MAX_MAP };
  const width = integerOption("width", values.width, size) ?? 64;
  const height = integerOption("height", values.height, size) ?? 64;
  // The sim never reads a clock or a random source; the CLI is where a new park gets both.
  const seed = integerOption("seed", values.seed) ?? Math.floor(Math.random() * 2 ** 31);

  const world = createWorld({
    width,
    height,
    seed,
    name: values.name ?? "New Park",
    createdIso: new Date().toISOString(),
  });
  await writePark(out, world);
  printJson(io, queryOrThrow(new Sim(world), "park_status", {}));
  return 0;
}
