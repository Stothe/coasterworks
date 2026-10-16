import { lstat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { MAX_MAP, Sim, createWorld } from "@coasterworks/sim";
import { integerOption, parseOrUsage, requireOption } from "../args.js";
import { printJson, queryOrThrow, writePark, type CliIO } from "../io.js";

/** True if anything is at `path`, including a symlink whose target is gone. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/**
 * `new --out <file> [--width 64] [--height 64] [--seed <n>] [--name <s>] [--force]`: creates a park.
 * It will not replace a file that is already at `--out` unless `--force` says to.
 */
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
        force: { type: "boolean" },
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

  if (values.force !== true && (await exists(out))) {
    throw new Error(`${out} already exists (use --force to overwrite)`);
  }

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
