import { lstat } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  MAX_MAP,
  SAMPLE_SIZE,
  Sim,
  createSamplePark,
  createWorld,
  type World,
} from "@coasterworks/sim";
import { UsageError, integerOption, parseOrUsage, requireOption } from "../args.js";
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
 * `new --out <file> [--width 64] [--height 64] [--seed <n>] [--name <s>] [--sample] [--force]`:
 * creates a park. `--sample` makes the demo park, "Leafy Lake" (a hill and a pond, 64 by 64 tiles),
 * instead of a flat one; `--name` still renames it, and `--width` and `--height` do not apply to it.
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
        sample: { type: "boolean" },
        force: { type: "boolean" },
      },
      allowPositionals: false,
    }),
  );
  const out = requireOption("out", values.out);
  const sample = values.sample === true;
  if (sample && (values.width !== undefined || values.height !== undefined)) {
    throw new UsageError(
      `--sample makes a ${SAMPLE_SIZE} by ${SAMPLE_SIZE} park; it cannot be combined with --width or --height`,
    );
  }
  const size = { min: 1, max: MAX_MAP };
  const width = integerOption("width", values.width, size) ?? 64;
  const height = integerOption("height", values.height, size) ?? 64;
  // The sim never reads a clock or a random source; the CLI is where a new park gets both.
  const seed = integerOption("seed", values.seed) ?? Math.floor(Math.random() * 2 ** 31);

  if (values.force !== true && (await exists(out))) {
    throw new Error(`${out} already exists (use --force to overwrite)`);
  }

  const createdIso = new Date().toISOString();
  let world: World;
  if (sample) {
    world = createSamplePark(seed);
    if (values.name !== undefined) world.meta.name = values.name;
    world.meta.created = createdIso;
  } else {
    world = createWorld({ width, height, seed, name: values.name ?? "New Park", createdIso });
  }
  await writePark(out, world);
  printJson(io, queryOrThrow(new Sim(world), "park_status", {}));
  return 0;
}
