import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  SaveError,
  deserializeWorld,
  serializeWorld,
  type Sim,
  type World,
} from "@coasterworks/sim";

/** Where a command sends its output. Tests pass their own; the bin passes the process streams. */
export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Aborts when the user asks a long-running command, such as `mcp`, to stop. */
  signal?: AbortSignal;
}

/** Writes `value` to stdout as one line of JSON. Every successful command's output is this. */
export function printJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

/** Resolves when `signal` aborts, or never if there is no signal. */
export function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Runs a query and returns its result, or throws the query's error. */
export function queryOrThrow(sim: Sim, name: string, input: unknown): unknown {
  const result = sim.query(name, input);
  if (!result.ok) throw new Error(result.error);
  return result.result;
}

function reasonOf(err: unknown): string {
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return "file not found";
  return err instanceof Error ? err.message : String(err);
}

/** Loads a park from a `.park` file. Throws an error that names the file if it cannot be read. */
export async function readPark(path: string): Promise<World> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(`Cannot read park file ${path}: ${reasonOf(err)}`, { cause: err });
  }
  try {
    return deserializeWorld(bytes);
  } catch (err) {
    if (err instanceof SaveError) {
      throw new Error(`Cannot read park file ${path}: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Saves a park to `path`, creating its directory if needed. The file is written beside `path` and
 * renamed over it, so a crash or a full disk never leaves a half-written save. Two writes to one
 * path at once would share that temporary file; callers must not overlap them.
 */
export async function writePark(path: string, world: World): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temp, serializeWorld(world));
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
