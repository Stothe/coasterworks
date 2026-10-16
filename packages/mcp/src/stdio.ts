import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Sim } from "@coasterworks/sim";
import { createMcpServer, whenIdle, type McpServerOptions } from "./server.js";

export interface StdioOptions extends McpServerOptions {
  /** Where requests come from. Defaults to the process's stdin. */
  stdin?: Readable;
  /** Where responses go. Defaults to the process's stdout, which then carries nothing but them. */
  stdout?: Writable;
  /** Stops the server when aborted, as a signal handler would. */
  signal?: AbortSignal;
}

/**
 * Serves `sim` over stdio: newline-delimited JSON-RPC in on stdin, out on stdout. Resolves when
 * the client closes stdin or `opts.signal` aborts, after answering the calls still running. Both
 * streams are let go by then, so nothing here keeps the process alive.
 */
export async function serveStdio(sim: Sim, opts: StdioOptions = {}): Promise<void> {
  const { stdin = process.stdin, stdout = process.stdout, signal, ...serverOptions } = opts;
  const server = createMcpServer(sim, serverOptions);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      await whenIdle(server);
      // Let the answers to those calls reach the stream before it closes.
      await new Promise((resolve) => setImmediate(resolve));
      await server.close();
    })();
  };

  // The transport itself never notices stdin ending.
  stdin.once("end", stop);
  stdin.once("close", stop);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await server.connect(new StdioServerTransport(stdin, stdout));
    if (signal?.aborted) stop();
    await closed;
  } finally {
    stdin.off("end", stop);
    stdin.off("close", stop);
    signal?.removeEventListener("abort", stop);
  }
}
