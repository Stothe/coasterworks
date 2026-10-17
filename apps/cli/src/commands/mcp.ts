import { parseArgs } from "node:util";
import { serveHttp, serveStdio, type McpServerOptions } from "@coasterworks/mcp";
import { Sim } from "@coasterworks/sim";
import { UsageError, integerOption, parseOrUsage, requireOption } from "../args.js";
import { printJson, readPark, untilAborted, writePark, type CliIO } from "../io.js";
import { resolveToken } from "../token.js";
import { createWriteQueue } from "../write-queue.js";

/**
 * `mcp --save <file> [--out <file>] [--http <port> [--token <token>] [--allow-files]]`: serves the
 * park to an MCP client until it hangs up (stdio) or the user stops it (`io.signal`). Stdio is the
 * default; its stdout carries only the protocol, so this prints nothing there. With `--http` it
 * listens on 127.0.0.1 and prints `{ url, port }` once it is ready.
 *
 * The token comes from `--token`, or else from `COASTERWORKS_MCP_TOKEN`, so it need not appear in
 * a process list. With neither, a random one is made (32 bytes from `node:crypto`, base64url, 43
 * characters) and printed too, as `{ url, port, token }`, because the client has no other way to
 * learn it. A token the caller supplied is never printed back.
 *
 * The `save_write` and `save_load` tools read and write `.park` files as the user. Over stdio the
 * client is the local process that launched this one, so they are on. Over HTTP anyone with the
 * token could use them, so they stay off unless `--allow-files` asks for them.
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
        "allow-files": { type: "boolean" },
      },
      allowPositionals: false,
    }),
  );
  const save = requireOption("save", values.save);
  if (values.http === undefined && values.token !== undefined) {
    throw new UsageError("--token needs --http");
  }
  // Stdio has no token to make or print.
  const { token, generated } =
    values.http === undefined ? { token: undefined, generated: false } : resolveToken(values.token);
  const port = integerOption("http", values.http, { min: 0, max: 65535 });

  const sim = new Sim(await readPark(save));

  // `--out` and the `save_write` tool both go through this queue; see `createWriteQueue`.
  const { enqueue } = createWriteQueue();

  // Stdio always has the file tools. Over HTTP they are opt-in; see the doc comment above.
  const options: McpServerOptions = {
    allowFiles: port === undefined || values["allow-files"] === true,
    writePark: (path, world) => enqueue(() => writePark(path, world)),
  };
  const out = values.out;
  const writeOut = out === undefined ? undefined : () => enqueue(() => writePark(out, sim.world));
  if (writeOut !== undefined) options.onMutate = writeOut;

  if (port === undefined) {
    await serveStdio(sim, io.signal === undefined ? options : { ...options, signal: io.signal });
  } else {
    const http = await serveHttp(sim, { ...options, port, token: token ?? "" });
    try {
      printJson(
        io,
        generated ? { url: http.url, port: http.port, token } : { url: http.url, port: http.port },
      );
      await untilAborted(io.signal);
    } finally {
      await http.close();
    }
  }
  await writeOut?.();
  return 0;
}
