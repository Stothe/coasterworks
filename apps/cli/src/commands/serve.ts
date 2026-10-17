import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { parseArgs } from "node:util";
import { allowedHostsFor, createMcpRequestHandler, tokenMatches } from "@coasterworks/mcp";
import { SimHostServer, type HostTimers, type Speed } from "@coasterworks/protocol";
import { Sim } from "@coasterworks/sim";
import { WebSocketServer, type WebSocket } from "ws";
import { UsageError, integerOption, parseOrUsage, requireOption } from "../args.js";
import { printJson, readPark, untilAborted, writePark, type CliIO } from "../io.js";
import { resolveToken } from "../token.js";
import { createWriteQueue } from "../write-queue.js";
import { wsTransport } from "../ws-transport.js";

const SPEEDS = ["0", "1", "2", "4", "8"];
/** The largest message a window may send. Its commands are a few hundred bytes. */
const MAX_MESSAGE_BYTES = 1 << 20;
/** How long a stopping server waits for a window to answer its close frame before dropping it. */
const CLOSE_GRACE_MS = 500;
const CLOSE_GOING_AWAY = 1001;

const timers: HostTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  now: () => performance.now(),
};

function speedOption(value: string | undefined): Speed {
  if (value === undefined) return 1;
  if (!SPEEDS.includes(value)) throw new UsageError("--speed must be one of 0, 1, 2, 4, 8");
  return Number(value) as Speed;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** The URL a request asked for, or undefined for a target that is not one. */
function parseUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

/** Turns away an upgrade request: the status line, then the connection is dropped. */
function refuse(socket: Duplex, status: string): void {
  // The socket belongs to us until `ws` takes it; a reset must not become an uncaught error.
  socket.on("error", () => {});
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
}

/**
 * Closes every window with 1001 (going away) and gives each a moment to answer, then drops any
 * that did not, so a stuck page cannot hold up the stop.
 */
async function closeWindows(wss: WebSocketServer): Promise<void> {
  const open = [...wss.clients];
  const answered = Promise.all(
    open.map((client) => new Promise<void>((resolve) => client.once("close", () => resolve()))),
  );
  for (const client of open) client.close(CLOSE_GOING_AWAY, "server stopping");
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_GRACE_MS)));
  await Promise.race([answered, gaveUp]);
  clearTimeout(timer);
  for (const client of open) client.terminate();
  wss.close();
}

/**
 * `serve --save <file> [--out <file>] [--port 0] [--host 127.0.0.1] [--token <token>]
 * [--allow-files] [--speed 1]`: hosts the park for the desktop app. One HTTP server carries a
 * WebSocket at `/ws` for the window (the player), MCP at `/mcp` for agents, and `GET /health`.
 * They share one sim, so what an agent builds appears in the window as it happens. Once it is
 * listening it prints `{ wsUrl, mcpUrl, port, token }` as one line of JSON, and it runs until the
 * user stops it (`io.signal`).
 *
 * The token works as it does for `mcp --http`: `--token`, else `COASTERWORKS_MCP_TOKEN`, else a
 * random one. Both `/mcp` (as `Authorization: Bearer <token>`) and `/ws` (as `?token=<token>`)
 * need it. A request for `/health`, `/mcp` or `/ws` must also name this machine in its `Host`
 * header, so a web page cannot reach the server through a rebound DNS name. The file tools are off
 * for MCP unless `--allow-files` is given; see `mcp`.
 *
 * `--speed` is the speed the clock starts at: 0 (paused), 1, 2, 4 or 8. The window can change it.
 *
 * With `--out` the park is written when a command, undo or redo changes it, from the window or an
 * agent, and once more on the way out. Time passing is not such a change, so a clock that only
 * ticks writes nothing until the next one. Writes that pile up while one is running become one.
 */
export async function serveCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        save: { type: "string" },
        out: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        token: { type: "string" },
        "allow-files": { type: "boolean" },
        speed: { type: "string" },
      },
      allowPositionals: false,
    }),
  );
  const save = requireOption("save", values.save);
  const speed = speedOption(values.speed);
  const host = values.host ?? "127.0.0.1";
  if (host === "") throw new UsageError("--host must not be empty");
  const { token } = resolveToken(values.token);
  const port = integerOption("port", values.port, { min: 0, max: 65535 }) ?? 0;

  const sim = new Sim(await readPark(save));

  // `--out` and the `save_write` tool both go through this queue; see `createWriteQueue`.
  const queue = createWriteQueue();
  const out = values.out;
  // The write that has been asked for and not yet started. It saves the park as it is when it
  // starts, so anything that changes the park before then is covered by it.
  let waiting: Promise<void> | undefined;
  const writeOut =
    out === undefined
      ? undefined
      : (): Promise<void> =>
          (waiting ??= queue.enqueue(async () => {
            waiting = undefined;
            await writePark(out, sim.world);
          }));
  const autosave = (): void => {
    writeOut?.().catch((err: unknown) => {
      io.stderr(`warning: could not write ${out}: ${err instanceof Error ? err.message : err}\n`);
    });
  };

  const hostServer = new SimHostServer(sim, { timers, onMutate: autosave });

  // Known once the server is listening, and always set before the first request is handled.
  let allowedHosts: string[] = [];
  const hostAllowed = (req: IncomingMessage): boolean =>
    allowedHosts.includes(req.headers.host ?? "");

  const mcp = createMcpRequestHandler(sim, {
    allowFiles: values["allow-files"] === true,
    writePark: (path, world) => queue.enqueue(() => writePark(path, world)),
    // The window hears of the agent's command at once; the tool waits for the park to be saved.
    onMutate: () => {
      hostServer.notifyExternalMutation();
      return writeOut?.();
    },
    token,
    allowedHosts: () => allowedHosts,
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (await mcp(req, res)) return;
    if (parseUrl(req)?.pathname === "/health") {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET" });
      }
      if (!hostAllowed(req)) return sendJson(res, 403, { error: "forbidden" });
      return sendJson(res, 200, { ok: true, name: sim.world.meta.name, tick: sim.world.tick });
    }
    sendJson(res, 404, { error: "not found" });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: "internal error" });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const url = parseUrl(req);
    if (url?.pathname !== "/ws") return refuse(socket, "404 Not Found");
    const given = url.searchParams.get("token");
    if (given === null || !tokenMatches(token, given)) return refuse(socket, "401 Unauthorized");
    if (!hostAllowed(req)) return refuse(socket, "403 Forbidden");
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      // The host detaches the transport when it closes.
      hostServer.attach(wsTransport(ws));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo).port;
  allowedHosts = allowedHostsFor(host, bound);

  hostServer.setSpeed(speed);
  hostServer.start();
  try {
    const name = host.includes(":") ? `[${host}]` : host;
    printJson(io, {
      wsUrl: `ws://${name}:${bound}/ws`,
      mcpUrl: `http://${name}:${bound}/mcp`,
      port: bound,
      token,
    });
    await untilAborted(io.signal);
  } finally {
    hostServer.stop();
    // Stop listening first, so nothing new arrives while the windows are told to go.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await closeWindows(wss);
    server.closeAllConnections();
    await closed;
  }
  // A command that was running when the connections dropped may still be writing.
  await queue.idle();
  await writeOut?.();
  return 0;
}
