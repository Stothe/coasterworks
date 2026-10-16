#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { UsageError } from "./args.js";
import { execCommand } from "./commands/exec.js";
import { inspectCommand } from "./commands/inspect.js";
import { newCommand } from "./commands/new.js";
import { runCommand } from "./commands/run.js";
import type { CliIO } from "./io.js";

export type { CliIO } from "./io.js";

const USAGE = `Usage: coasterworks <command> [options]

Commands:
  new      --out <file> [--width 64] [--height 64] [--seed <n>] [--name <s>]
  run      --save <file> --days <n> [--out <file>]
  inspect  <file>
  exec     --save <file> --command <name> [--input <json>] [--out <file>]

Output is one line of JSON on stdout. Exit codes: 0 ok, 1 failed, 2 bad usage.
`;

type Command = (args: string[], io: CliIO) => Promise<number>;

const COMMANDS = new Map<string, Command>([
  ["new", newCommand],
  ["run", runCommand],
  ["inspect", inspectCommand],
  ["exec", execCommand],
  // Reserved; the MCP server arrives in a later task.
  [
    "mcp",
    async () => {
      throw new Error("mcp is not available yet");
    },
  ],
]);

/** Runs the CLI and returns its exit code: 0 on success, 1 on failure, 2 on a usage error. */
export async function main(argv: string[], io: CliIO): Promise<number> {
  try {
    const [name, ...args] = argv;
    if (name === undefined) throw new UsageError("missing command");
    const command = COMMANDS.get(name);
    if (command === undefined) throw new UsageError(`unknown subcommand: ${name}`);
    return await command(args, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}\n${USAGE}`);
      return 2;
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** True when this file is the program being run, not a module something else imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // `import.meta.url` is the real path, so resolve a symlinked bin before comparing.
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const io: CliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  // `exitCode`, not `exit()`, so output piped to a slow reader is not cut off.
  process.exitCode = await main(process.argv.slice(2), io);
}
