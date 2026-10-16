#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { UsageError } from "./args.js";
import { execCommand } from "./commands/exec.js";
import { redoCommand, undoCommand } from "./commands/history.js";
import { inspectCommand } from "./commands/inspect.js";
import { mcpCommand } from "./commands/mcp.js";
import { newCommand } from "./commands/new.js";
import { queryCommand } from "./commands/query.js";
import { runCommand } from "./commands/run.js";
import type { CliIO } from "./io.js";

export type { CliIO } from "./io.js";

const USAGE = `Usage: coasterworks <command> [options]

Commands:
  new      --out <file> [--width 64] [--height 64] [--seed <n>] [--name <s>] [--force]
  run      --save <file> --days <n> [--out <file>]
  inspect  <file>
  exec     --save <file> --command <name> [--input <json>] [--out <file>]
  query    --save <file> --name <query> [--input <json>]
  undo     --save <file> --out <file>
  redo     --save <file> --out <file>
  mcp      --save <file> [--out <file>] [--http <port> [--token <token>] [--allow-files]]

Output is one line of JSON on stdout. Exit codes: 0 ok, 1 failed, 2 bad usage.
Without --out, run and exec do not modify the save.
new refuses to replace an existing file unless given --force.
query reads and never modifies the save. undo and redo run as the agent and need --out.
mcp serves the park to an MCP client over stdio, or over HTTP with --http (0 picks a port).
Stdio carries only the protocol; HTTP prints {"url","port"} once it is listening. Ctrl-C stops it.
--http takes its bearer token from --token, or else the COASTERWORKS_MCP_TOKEN environment
  variable. With neither, it makes a random token and prints it too: {"url","port","token"}.
--allow-files adds the save_write and save_load file tools over HTTP; stdio always has them.
  They take only paths that end in .park.
  Warning: it lets any holder of the token read and write files as you.
`;

type Command = (args: string[], io: CliIO) => Promise<number>;

const COMMANDS = new Map<string, Command>([
  ["new", newCommand],
  ["run", runCommand],
  ["inspect", inspectCommand],
  ["exec", execCommand],
  ["query", queryCommand],
  ["undo", undoCommand],
  ["redo", redoCommand],
  ["mcp", mcpCommand],
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
  const argv = process.argv.slice(2);
  // Only `mcp` handles Ctrl-C itself, to save the park and close cleanly. A second Ctrl-C, with
  // the handler spent, ends the process as usual.
  if (argv[0] === "mcp") {
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
    io.signal = stop.signal;
  }
  // `exitCode`, not `exit()`, so output piped to a slow reader is not cut off.
  process.exitCode = await main(argv, io);
}
