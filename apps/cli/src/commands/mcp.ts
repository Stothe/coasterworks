import { parseArgs } from "node:util";
import { serveHttp, serveStdio, type McpServerOptions } from "@coasterworks/mcp";
import { Sim } from "@coasterworks/sim";
import { UsageError, integerOption, parseOrUsage, requireOption } from "../args.js";
import { printJson, readPark, writePark, type CliIO } from "../io.js";

/** Resolves when `signal` aborts, or never if there is no signal. */
function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * `mcp --save <file> [--out <file>] [--http <port> --token <token>]`: serves the park to an MCP
 * client until it hangs up (stdio) or the user stops it (`io.signal`). Stdio is the default; its
 * stdout carries only the protocol, so this prints nothing there. With `--http` it listens on
 * 127.0.0.1 and prints `{ url, port }` once it is ready.
 *
 * With `--out` the park is written after every call that changes it and once more on the way
 * out, never over `--save` unless asked.
 */
export async function mcpCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        save: { type: "string" },
        out: { type: "string" },
        http: { type: "string" },
        token: { type: "string" },
      },
      allowPositionals: false,
    }),
  );
  const save = requireOption("save", values.save);
  if (values.http !== undefined && values.token === undefined) {
    throw new UsageError("--http needs --token");
  }
  if (values.http === undefined && values.token !== undefined) {
    throw new UsageError("--token needs --http");
  }
  if (values.token === "") throw new UsageError("--token must not be empty");
  const port = integerOption("http", values.http, { min: 0, max: 65535 });

  const sim = new Sim(await readPark(save));
  const options: McpServerOptions = { allowFiles: true };

  // One write at a time: they share a temporary file, and a later one has the newer park anyway.
  let writing: Promise<void> = Promise.resolve();
  const out = values.out;
  const writeOut =
    out === undefined
      ? undefined
      : () => {
          const next = writing.then(() => writePark(out, sim.world));
          writing = next.catch(() => {});
          return next;
        };
  if (writeOut !== undefined) options.onMutate = writeOut;

  if (port === undefined) {
    await serveStdio(sim, io.signal === undefined ? options : { ...options, signal: io.signal });
  } else {
    const http = await serveHttp(sim, { ...options, port, token: values.token ?? "" });
    try {
      printJson(io, { url: http.url, port: http.port });
      await untilAborted(io.signal);
    } finally {
      await http.close();
    }
  }
  await writeOut?.();
  return 0;
}
