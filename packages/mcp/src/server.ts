import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { deserializeWorld, serializeWorld, type Sim, type World } from "@coasterworks/sim";
import { z } from "zod";
import { VERSION } from "./version.js";

export interface McpServerOptions {
  /** The server name clients see. Defaults to `coasterworks`. */
  name?: string;
  /** The server version clients see. Defaults to this package's version. */
  version?: string;
  /**
   * Adds the `save_write` and `save_load` tools, which let a client read and write any file this
   * process can. Off by default; turn it on only for a client you trust.
   */
  allowFiles?: boolean;
  /**
   * Called after a tool call has changed the park: a command, undo, redo, or `save_load` that
   * succeeded. The CLI uses it to write the park to `--out`. It is awaited, and if it throws the
   * tool result still reports that the call ran, with the failure in `saveError`.
   */
  onMutate?: (sim: Sim) => void | Promise<unknown>;
  /**
   * How `save_write` puts the park on disk. It must create the folder of `path` if needed, and
   * either leave a whole file at `path` or throw; its rejection becomes the tool's error. A caller
   * that also writes files itself, as the CLI does for `--out`, passes the writer it shares with
   * that code so the two cannot trample each other. The default writes `path` atomically.
   */
  writePark?: (path: string, world: World) => Promise<void>;
}

/** The end of the chain of writes the default `writePark` has queued; see there. */
let defaultWrites: Promise<void> = Promise.resolve();

/**
 * The default `writePark`: makes the folder, writes the park beside `path` and renames it into
 * place, so a crash or a full disk never leaves a half-written save. The temporary file is named
 * for the process, so writes run one at a time (across every server in the process, because the
 * HTTP transport builds a server per request); a later write has the newer park anyway.
 */
function writeParkAtomically(path: string, world: World): Promise<void> {
  const next = defaultWrites.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    try {
      await writeFile(temp, serializeWorld(world));
      await rename(temp, path);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  });
  defaultWrites = next.catch(() => {});
  return next;
}

/** Tool calls in progress on each server; see `whenIdle`. */
const inProgress = new WeakMap<McpServer, Set<Promise<unknown>>>();

/** Resolves once every tool call now running on `server` has finished and been answered. */
export async function whenIdle(server: McpServer): Promise<void> {
  const calls = inProgress.get(server);
  while (calls !== undefined && calls.size > 0) await Promise.allSettled([...calls]);
}

/** `terrain_raise` becomes `Terrain raise`. */
function titleOf(name: string): string {
  const words = name.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every tool answers with its result as one block of JSON; a failure is `{ ok: false, error }`. */
function toolResult<T extends { ok: boolean }>(result: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok };
}

function reasonOf(err: unknown): string {
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return "file not found";
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds an MCP server for `sim`: a tool for every command and query in its registry, plus `undo`
 * and `redo`, the `park://status` resource, and with `allowFiles` the `save_write` and `save_load`
 * tools. Calls from the model run as the `agent` client. The server does not listen anywhere; give
 * it to `serveStdio` or `serveHttp`, or `connect` a transport yourself.
 */
export function createMcpServer(sim: Sim, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: opts.name ?? "coasterworks",
    version: opts.version ?? VERSION,
  });
  const running = new Set<Promise<unknown>>();
  inProgress.set(server, running);

  /** Wraps a tool handler so `whenIdle` can wait for it. */
  function tracked<A extends unknown[]>(
    handler: (...args: A) => Promise<CallToolResult>,
  ): (...args: A) => Promise<CallToolResult> {
    return (...args) => {
      const call = handler(...args);
      running.add(call);
      const done = () => void running.delete(call);
      call.then(done, done);
      return call;
    };
  }

  /** The result of a call that succeeded, once `onMutate` has seen the changed park. */
  async function mutated<T extends { ok: true }>(result: T): Promise<CallToolResult> {
    try {
      await opts.onMutate?.(sim);
    } catch (err) {
      return toolResult({ ...result, saveError: reasonOf(err) });
    }
    return toolResult(result);
  }

  for (const def of sim.registry.commands()) {
    server.registerTool(
      def.name,
      {
        title: titleOf(def.name),
        description: def.description,
        inputSchema: def.input.shape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: def.category !== "sim",
          idempotentHint: false,
        },
      },
      tracked(async (input: unknown) => {
        const result = sim.execute(def.name, input, "agent");
        return result.ok ? mutated(result) : toolResult(result);
      }),
    );
  }

  for (const def of sim.registry.queries()) {
    server.registerTool(
      def.name,
      {
        title: titleOf(def.name),
        description: def.description,
        inputSchema: def.input.shape,
        annotations: { readOnlyHint: true },
      },
      tracked(async (input: unknown) => toolResult(sim.query(def.name, input))),
    );
  }

  server.registerTool(
    "undo",
    {
      title: "Undo",
      description: "Undoes the most recent undoable command and refunds what it cost.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tracked(async () => {
      const result = sim.undo("agent");
      return result.ok ? mutated(result) : toolResult(result);
    }),
  );

  server.registerTool(
    "redo",
    {
      title: "Redo",
      description: "Redoes the command that was last undone, if nothing has changed since.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tracked(async () => {
      const result = sim.redo("agent");
      return result.ok ? mutated(result) : toolResult(result);
    }),
  );

  if (opts.allowFiles === true) {
    const writePark = opts.writePark ?? writeParkAtomically;
    server.registerTool(
      "save_write",
      {
        title: "Save write",
        description: "Writes the park to a .park file at `path`, creating its folder if needed.",
        inputSchema: { path: z.string().min(1).describe("Where to write the file") },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      tracked(async ({ path }) => {
        try {
          await writePark(path, sim.world);
          return toolResult({ ok: true, path });
        } catch (err) {
          return toolResult({
            ok: false,
            error: `Cannot write park file ${path}: ${reasonOf(err)}`,
          });
        }
      }),
    );

    server.registerTool(
      "save_load",
      {
        title: "Save load",
        description: "Replaces the park, and its undo history, with the .park file at `path`.",
        inputSchema: { path: z.string().min(1).describe("The file to read") },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      tracked(async ({ path }) => {
        let world;
        try {
          world = deserializeWorld(await readFile(path));
        } catch (err) {
          return toolResult({
            ok: false,
            error: `Cannot read park file ${path}: ${reasonOf(err)}`,
          });
        }
        sim.replaceWorld(world);
        return mutated({ ok: true, path });
      }),
    );
  }

  server.registerResource(
    "park-status",
    "park://status",
    {
      title: "Park status",
      description: "The same JSON the park_status tool returns.",
      mimeType: "application/json",
    },
    () => ({
      contents: [
        {
          uri: "park://status",
          mimeType: "application/json",
          text: JSON.stringify(sim.query("park_status", {})),
        },
      ],
    }),
  );

  return server;
}
