import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PROTOCOL_VERSION, decodeSnapshot, type DecodedSnapshot } from "@coasterworks/protocol";
import WebSocket from "ws";
import { main, type CliIO } from "../src/index.js";
import { readPark } from "../src/io.js";

let dir: string;
const stoppers: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coasterworks-serve-"));
  // A token in the developer's own environment must not change what these tests see.
  vi.stubEnv("COASTERWORKS_MCP_TOKEN", undefined);
});

afterEach(async () => {
  // Whatever a failed test left running, so no server or socket outlives it.
  for (const stop of stoppers.splice(0).reverse()) await stop().catch(() => {});
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `main` in-process with captured output; for commands that return on their own. */
async function cli(...argv: string[]): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
  const code = await main(argv, io);
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** Makes a flat 16 by 16 park (every corner at height 8) and returns its path. */
async function makePark(name = "a.park"): Promise<string> {
  const file = join(dir, name);
  const made = await cli("new", "--out", file, "--width", "16", "--height", "16", "--seed", "1");
  expect(made.code).toBe(0);
  return file;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a value, for the things that happen after a reply. */
async function eventually<T>(check: () => Promise<T | undefined> | T | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(15);
  }
  throw new Error("timed out waiting");
}

interface ServeInfo {
  wsUrl: string;
  mcpUrl: string;
  port: number;
  token: string;
}

/** Starts `serve` in the background; `stop` aborts it, as SIGINT does, and waits for exit. */
const startServe = (...args: string[]) => startServeWith({}, ...args);

/** `startServe` with more of `CliIO` than the output and the signal, such as a `stdin`. */
async function startServeWith(extra: Partial<CliIO>, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const abort = new AbortController();
  let listening: (line: string) => void = () => {};
  const firstLine = new Promise<string>((resolve) => (listening = resolve));
  const io: CliIO = {
    stdout: (s) => {
      out.push(s);
      listening(out.join(""));
    },
    stderr: (s) => err.push(s),
    signal: abort.signal,
    ...extra,
  };
  const done = main(["serve", ...args], io);
  const printed = await Promise.race([
    firstLine,
    done.then((code) => {
      throw new Error(`serve exited with ${code} before listening: ${err.join("")}`);
    }),
  ]);
  const info = JSON.parse(printed) as ServeInfo;
  const server = {
    info,
    http: `http://127.0.0.1:${info.port}`,
    /** The exit code, once `serve` has stopped for any reason. */
    exited: done,
    stderr: () => err.join(""),
    async stop(): Promise<Outcome> {
      abort.abort();
      const code = await done;
      return { code, stdout: out.join(""), stderr: err.join("") };
    },
  };
  stoppers.push(server.stop);
  return server;
}

async function mcpClient(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  // The cast is for the SDK's optional `sessionId` against `exactOptionalPropertyTypes`.
  await client.connect(transport as Transport);
  stoppers.push(() => client.close());
  return client;
}

/** One frame from the host: JSON text, or a decoded binary snapshot. */
type Seen = { json: any; snapshot?: never } | { json?: never; snapshot: DecodedSnapshot };

/** A WebSocket client that keeps every frame it is sent and waits for the one a test wants. */
class Peer {
  private readonly seen: Seen[] = [];
  private nextId = 1;
  readonly closed: Promise<number>;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      this.seen.push(
        isBinary
          ? { snapshot: decodeSnapshot(new Uint8Array(data)) }
          : { json: JSON.parse(data.toString("utf8")) },
      );
    });
    this.closed = new Promise((resolve) => socket.once("close", (code: number) => resolve(code)));
    stoppers.push(async () => socket.terminate());
  }

  static async connect(url: string): Promise<Peer> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new Peer(socket);
  }

  send(message: object): number {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ ...message, id }));
    return id;
  }

  /** Waits for the next frame that `match` accepts, dropping the frames before it. */
  async next(match: (frame: Seen) => boolean): Promise<Seen> {
    return eventually(() => {
      const at = this.seen.findIndex(match);
      return at < 0 ? undefined : this.seen.splice(0, at + 1)[at];
    });
  }

  json(t: string, extra: (json: any) => boolean = () => true) {
    return this.next((f) => f.json?.t === t && extra(f.json)).then((f) => f.json);
  }

  /** The next snapshot that carries terrain. */
  async terrain() {
    const frame = await this.next((f) => f.snapshot?.terrain !== undefined);
    return frame.snapshot as DecodedSnapshot & { terrain: NonNullable<DecodedSnapshot["terrain"]> };
  }

  async hello(): Promise<void> {
    this.socket.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));
    await this.json("welcome");
  }
}

const tokenUrl = (info: ServeInfo, token = info.token) => `${info.wsUrl}?token=${token}`;

/** An upgrade request, line by line, for a `target` that a WebSocket client would not send as is. */
const upgradeLines = (port: number, target: string) => [
  `GET ${target} HTTP/1.1`,
  `Host: 127.0.0.1:${port}`,
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version: 13",
];

/** What a server answers to a request, up to the end of the response headers, then hangs up. */
function headOf(socket: ReturnType<typeof connect>): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\r\n\r\n")) resolve(text);
    });
    socket.once("close", () => resolve(text));
    socket.once("error", reject);
  });
}

/** Sends an upgrade request for `target` as it is, and returns the head of the answer. */
function rawUpgrade(port: number, target: string): Promise<string> {
  const socket = connect(port, "127.0.0.1", () =>
    socket.write([...upgradeLines(port, target), "", ""].join("\r\n")),
  );
  return headOf(socket).finally(() => socket.destroy());
}

/** The corner at (x, y) of a 16 wide park's terrain. */
const corner = (terrain: { corners: Int16Array }, x: number, y: number) =>
  terrain.corners[y * 17 + x];

describe("serve", () => {
  it("prints one line of JSON with the urls, port, and token, and answers /health", async () => {
    const file = await makePark();
    const server = await startServe("--save", file, "--port", "0", "--token", "t");
    const { info } = server;
    expect(info.port).toBeGreaterThan(0);
    expect(info).toEqual({
      wsUrl: `ws://127.0.0.1:${info.port}/ws`,
      mcpUrl: `http://127.0.0.1:${info.port}/mcp`,
      port: info.port,
      token: "t",
    });

    const health = await fetch(`${server.http}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, name: "New Park", tick: expect.any(Number) });

    const stopped = await server.stop();
    expect(stopped.code).toBe(0);
    expect(stopped.stderr).toBe("");
    expect(stopped.stdout).toBe(`${JSON.stringify(info)}\n`);
  });

  it("refuses a socket without the token, with the wrong one, or on another path", async () => {
    const file = await makePark();
    const server = await startServe("--save", file, "--token", "t");

    const statusOf = (url: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.once("unexpected-response", (_req, res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        });
        socket.once("open", () => reject(new Error("the upgrade was accepted")));
        socket.once("error", () => {});
      });
    expect(await statusOf(server.info.wsUrl)).toBe(401);
    expect(await statusOf(tokenUrl(server.info, "nope"))).toBe(401);
    expect(await statusOf(tokenUrl(server.info, ""))).toBe(401);
    // A token of the same length as the right one, in case the comparison is a prefix check.
    expect(await statusOf(tokenUrl(server.info, "x"))).toBe(401);
    expect(await statusOf(`ws://127.0.0.1:${server.info.port}/other?token=t`)).toBe(404);

    // Still serving: a bad upgrade did not take the server down.
    const good = await Peer.connect(tokenUrl(server.info));
    await good.hello();
    expect((await server.stop()).code).toBe(0);
  });

  it("answers a refused upgrade with the 401 status line and closes the connection", async () => {
    const file = await makePark();
    const server = await startServe("--save", file, "--token", "t");
    expect(await rawUpgrade(server.info.port, "/ws")).toBe("HTTP/1.1 401 Unauthorized\r\n\r\n");
    expect((await server.stop()).code).toBe(0);
  });

  it.each([
    ["the token under another name", "/ws?tok=t", "401 Unauthorized"],
    ["the token's name in capitals", "/ws?TOKEN=t", "401 Unauthorized"],
    ["a token that only starts right", "/ws?token=tt", "401 Unauthorized"],
    ["a trailing slash", "/ws/?token=t", "404 Not Found"],
    ["a path that climbs out to /mcp", "/ws/../mcp?token=t", "404 Not Found"],
    ["the path in capitals", "/WS?token=t", "404 Not Found"],
    ["an empty first segment", "//ws?token=t", "404 Not Found"],
    ["a longer path", "/wsx?token=t", "404 Not Found"],
    ["a path that is not a URL", "//", "404 Not Found"],
    ["the token in the fragment", "/ws#token=t", "401 Unauthorized"],
  ])("refuses an upgrade with %s", async (_label, target, status) => {
    const file = await makePark();
    const server = await startServe("--save", file, "--token", "t");
    const head = await rawUpgrade(server.info.port, target);
    expect(head).toBe(`HTTP/1.1 ${status}\r\n\r\n`);
    // The same request with the right path and token is let in, so the refusals mean something.
    expect(await rawUpgrade(server.info.port, "/ws?token=t")).toMatch(
      /^HTTP\/1\.1 101 Switching Protocols\r\n/,
    );
    expect((await server.stop()).code).toBe(0);
  });

  it("refuses an upgrade that arrives while the server is shutting down, and still stops", async () => {
    const file = await makePark();
    const out = join(dir, "race.park");
    const server = await startServe("--save", file, "--out", out, "--token", "t");
    // A window that never answers the close frame, so the stop spends its grace period waiting.
    const stuck = await Peer.connect(tokenUrl(server.info));
    await stuck.hello();
    stuck.socket.pause();

    // A request that has begun, with the right token, but is not finished when the stop comes.
    const late = connect(server.info.port, "127.0.0.1");
    late.write(`${upgradeLines(server.info.port, "/ws?token=t").join("\r\n")}\r\n`);
    const answer = headOf(late);
    await sleep(50);

    const stopping = server.stop();
    await sleep(100);
    // The rest of it lands mid-stop.
    late.write("\r\n");
    expect(await answer).toBe("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    late.destroy();

    const stopped = await stopping;
    expect(stopped.code).toBe(0);
    expect(stopped.stderr).toBe("");
    // The final write was not skipped.
    expect((await readPark(out)).meta.name).toBe("New Park");
    await expect(fetch(`${server.http}/health`)).rejects.toThrow();
  });

  it("serves the window and an agent from one sim, autosaves both, and stops cleanly", async () => {
    const file = await makePark();
    const server = await startServe("--save", file, "--out", file, "--port", "0", "--token", "t");

    const peer = await Peer.connect(tokenUrl(server.info));
    await peer.hello();
    const first = await peer.terrain();
    expect(first.header).toMatchObject({ width: 16, height: 16, speed: 1 });
    expect(corner(first.terrain, 0, 0)).toBe(8);
    expect(corner(first.terrain, 4, 4)).toBe(8);

    // The player raises a patch: a result, a log event, then the new terrain.
    const raised = peer.send({
      t: "command",
      name: "terrain_raise",
      input: { x: 0, y: 0, w: 2, h: 2 },
    });
    expect(await peer.json("result", (j) => j.id === raised)).toMatchObject({
      result: { ok: true, cost: 45_000 },
    });
    expect((await peer.json("event")).entry).toMatchObject({
      client: "player",
      name: "terrain_raise",
    });
    const afterRaise = await peer.terrain();
    expect(corner(afterRaise.terrain, 0, 0)).toBe(9);
    expect(corner(afterRaise.terrain, 4, 4)).toBe(8);

    // Written as soon as the command ran, not only at shutdown.
    const autosaved = await eventually(async () => {
      const world = await readPark(file);
      return world.log.length === 1 ? world : undefined;
    });
    expect(autosaved.terrain.corners[0]).toBe(9);

    // An agent lowers another patch over MCP, and the window hears of it.
    const agent = await mcpClient(server.info.mcpUrl, "t");
    const lowered = await agent.callTool({
      name: "terrain_lower",
      arguments: { x: 4, y: 4, w: 2, h: 2 },
    });
    expect(lowered.isError).toBeFalsy();
    expect((await peer.json("event")).entry).toMatchObject({
      client: "agent",
      name: "terrain_lower",
    });
    const afterLower = await peer.terrain();
    expect(corner(afterLower.terrain, 4, 4)).toBe(7);
    expect(corner(afterLower.terrain, 0, 0)).toBe(9);
    expect(afterLower.header.cash).toBe(10_000_00 - 90_000);
    await agent.close();

    // Stop: the socket is told the server is going away, and the whole thing ends within 2 s.
    const began = Date.now();
    const stopped = await server.stop();
    expect(Date.now() - began).toBeLessThan(2000);
    expect(stopped.code).toBe(0);
    expect(stopped.stderr).toBe("");
    expect(await peer.closed).toBe(1001);
    await expect(fetch(`${server.http}/health`)).rejects.toThrow();

    const saved = await readPark(file);
    expect(saved.terrain.corners[0]).toBe(9);
    expect(saved.terrain.corners[4 * 17 + 4]).toBe(7);
    expect(saved.log.map((entry) => [entry.client, entry.name])).toEqual([
      ["player", "terrain_raise"],
      ["agent", "terrain_lower"],
    ]);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("writes --out only when the park changes, then once more on the way out", async () => {
    const file = await makePark();
    const out = join(dir, "autosave.park");
    const server = await startServe("--save", file, "--out", out, "--token", "t", "--speed", "8");
    // The clock has run for a while, but a tick is not a change a command made.
    await sleep(300);
    expect(await exists(out)).toBe(false);

    const peer = await Peer.connect(tokenUrl(server.info));
    await peer.hello();
    peer.send({ t: "command", name: "terrain_raise", input: { x: 0, y: 0, w: 1, h: 1 } });
    await eventually(async () => ((await exists(out)) ? true : undefined));

    expect((await server.stop()).code).toBe(0);
    const saved = await readPark(out);
    expect(saved.log).toHaveLength(1);
    // The final write has the ticks too.
    expect(saved.tick).toBeGreaterThan(0);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("saves every command of a burst without waiting for the stop", async () => {
    const file = await makePark();
    const out = join(dir, "burst.park");
    const server = await startServe("--save", file, "--out", out, "--token", "t", "--speed", "0");
    const peer = await Peer.connect(tokenUrl(server.info));
    await peer.hello();
    const last = Array.from({ length: 40 }, (_, i) =>
      peer.send({ t: "command", name: "terrain_raise", input: { x: i % 16, y: 0, w: 1, h: 1 } }),
    ).at(-1) as number;
    await peer.json("result", (j) => j.id === last);
    // The autosave catches up on its own, without waiting for the stop.
    const saved = await eventually(async () => {
      const world = await readPark(out).catch(() => undefined);
      return world?.log.length === 40 ? world : undefined;
    });
    expect(saved.log).toHaveLength(40);
    expect((await server.stop()).code).toBe(0);
    expect((await readPark(out)).log).toHaveLength(40);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("keeps serving when the autosave fails, says so on stderr, and fails the stop", async () => {
    const file = await makePark();
    // A folder cannot be made under a file.
    const out = join(file, "no", "autosave.park");
    const server = await startServe("--save", file, "--out", out, "--token", "t");
    const agent = await mcpClient(server.info.mcpUrl, "t");
    const called = await agent.callTool({
      name: "terrain_raise",
      arguments: { x: 0, y: 0, w: 1, h: 1 },
    });
    // The agent is told the command ran, and that it was not saved.
    const text = (called.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ ok: true, saveError: expect.any(String) });
    await eventually(() =>
      server.stderr().includes("warning: could not write") ? true : undefined,
    );
    expect(server.stderr()).toContain(out);
    expect((await fetch(`${server.http}/health`)).status).toBe(200);

    const stopped = await server.stop();
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toMatch(/error: /);
  });

  it("does not modify --save, and writes nothing, without --out", async () => {
    const file = await makePark();
    const before = (await readPark(file)).log.length;
    const server = await startServe("--save", file, "--token", "t");
    const peer = await Peer.connect(tokenUrl(server.info));
    await peer.hello();
    const id = peer.send({
      t: "command",
      name: "terrain_raise",
      input: { x: 0, y: 0, w: 1, h: 1 },
    });
    await peer.json("result", (j) => j.id === id);
    expect((await server.stop()).code).toBe(0);
    expect((await readPark(file)).log).toHaveLength(before);
    expect(await readdir(dir)).toEqual(["a.park"]);
  });

  it("runs the clock at --speed, and not at all at 0", async () => {
    const file = await makePark();
    const tickOf = async (server: { http: string }) =>
      ((await (await fetch(`${server.http}/health`)).json()) as { tick: number }).tick;

    const paused = await startServe("--save", file, "--token", "t", "--speed", "0");
    const running = await startServe("--save", file, "--token", "t", "--speed", "8");
    await eventually(async () => ((await tickOf(running)) > 40 ? true : undefined));
    expect(await tickOf(paused)).toBe(0);

    const peer = await Peer.connect(tokenUrl(paused.info));
    await peer.hello();
    expect((await peer.terrain()).header.speed).toBe(0);
    // The window can start it.
    const id = peer.send({ t: "speed", speed: 8 });
    await peer.json("result", (j) => j.id === id);
    await eventually(async () => ((await tickOf(paused)) > 0 ? true : undefined));
    expect((await paused.stop()).code).toBe(0);
    expect((await running.stop()).code).toBe(0);
  });

  it("takes the token from the environment, or makes one, and requires it of the agent", async () => {
    const file = await makePark();
    vi.stubEnv("COASTERWORKS_MCP_TOKEN", "from-env");
    const fromEnv = await startServe("--save", file);
    expect(fromEnv.info.token).toBe("from-env");
    const flagged = await startServe("--save", file, "--token", "flag");
    expect(flagged.info.token).toBe("flag");
    vi.stubEnv("COASTERWORKS_MCP_TOKEN", undefined);

    const generated = await startServe("--save", file);
    expect(generated.info.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const other = await startServe("--save", file);
    expect(other.info.token).not.toBe(generated.info.token);

    await expect(mcpClient(generated.info.mcpUrl, "nope")).rejects.toThrow();
    await expect(mcpClient(generated.info.mcpUrl, fromEnv.info.token)).rejects.toThrow();
    const agent = await mcpClient(generated.info.mcpUrl, generated.info.token);
    const names = (await agent.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("terrain_raise");
    // The file tools are off unless asked for, as they are for `mcp --http`.
    expect(names).not.toContain("save_write");

    const files = await startServe("--save", file, "--token", "t", "--allow-files");
    const trusted = await mcpClient(files.info.mcpUrl, "t");
    expect((await trusted.listTools()).tools.map((tool) => tool.name)).toContain("save_write");
  });

  it("answers other paths and methods on the HTTP side, and refuses a foreign Host", async () => {
    const file = await makePark();
    const server = await startServe("--save", file, "--token", "t");
    expect((await fetch(`${server.http}/nope`)).status).toBe(404);
    const post = await fetch(`${server.http}/health`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    // MCP keeps its own rules: the bearer token is needed.
    expect((await fetch(`${server.http}/mcp`, { method: "POST" })).status).toBe(401);

    // A web page that rebinds a hostname to this machine cannot read /health either.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.info.port,
          path: "/health",
          headers: { host: "evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("drops a client that hangs up and keeps serving the others", async () => {
    const file = await makePark();
    const server = await startServe("--save", file, "--token", "t");
    const gone = await Peer.connect(tokenUrl(server.info));
    await gone.hello();
    const stays = await Peer.connect(tokenUrl(server.info));
    await stays.hello();
    gone.socket.terminate();
    await gone.closed;

    const agent = await mcpClient(server.info.mcpUrl, "t");
    await agent.callTool({ name: "terrain_raise", arguments: { x: 0, y: 0, w: 1, h: 1 } });
    expect((await stays.json("event")).entry.name).toBe("terrain_raise");
    expect((await server.stop()).code).toBe(0);
  });

  it("does not let a client that ignores the close handshake hold up the stop", async () => {
    const file = await makePark();
    const server = await startServe("--save", file, "--token", "t");
    const peer = await Peer.connect(tokenUrl(server.info));
    await peer.hello();
    // A client that never answers the server's close frame.
    peer.socket.pause();

    const began = Date.now();
    expect((await server.stop()).code).toBe(0);
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it("lists serve in the usage text", async () => {
    const done = await cli("frobnicate");
    expect(done.code).toBe(2);
    expect(done.stderr).toContain(
      "  serve    --save <file> [--out <file>] [--port <n>] [--host <addr>] [--token <token>] [--allow-files] [--speed <0|1|2|4|8>]",
    );
    expect(done.stderr).toContain(
      "serve hosts the park for the desktop app: WebSocket at /ws, MCP at /mcp; prints a JSON line with the URLs and token.",
    );
  });
});

describe("serve usage and errors", () => {
  it("exits 2 with the usage text for a missing --save, a bad --speed, or an unknown option", async () => {
    const file = await makePark();
    const missing = await cli("serve");
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toMatch(/^error: missing required option --save/);
    expect(missing.stderr).toContain("Usage:");

    for (const speed of ["3", "16", "abc", "1.5", ""]) {
      const bad = await cli("serve", "--save", file, "--speed", speed);
      expect(bad.code, `--speed ${JSON.stringify(speed)}`).toBe(2);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toMatch(/^error: --speed must be one of 0, 1, 2, 4, 8/);
      expect(bad.stderr).toContain("Usage:");
    }

    // `parseArgs` takes a value that starts with a dash for another option.
    expect((await cli("serve", "--save", file, "--speed", "-1")).code).toBe(2);
    const unknown = await cli("serve", "--save", file, "--bogus");
    expect(unknown.code).toBe(2);
    const empty = await cli("serve", "--save", file, "--token", "");
    expect(empty.code).toBe(2);
    expect(empty.stderr).toMatch(/^error: --token must not be empty/);
  });

  it("exits 1 for a bad --port, a missing park, or a port that is taken", async () => {
    const file = await makePark();
    for (const port of ["abc", "1.5", "70000"]) {
      const bad = await cli("serve", "--save", file, "--port", port);
      expect(bad.code, `--port ${port}`).toBe(1);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toMatch(/^error: --port must be an integer from 0 to 65535/);
    }
    const missing = await cli("serve", "--save", join(dir, "missing.park"));
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toMatch(/^error: Cannot read park file .*missing\.park: file not found/);

    const server = await startServe("--save", file, "--token", "t");
    const taken = await cli("serve", "--save", file, "--port", String(server.info.port));
    expect(taken.code).toBe(1);
    expect(taken.stdout).toBe("");
    expect(taken.stderr).toMatch(/^error: .*EADDRINUSE/);
    // The running one is untouched.
    expect((await fetch(`${server.http}/health`)).status).toBe(200);
  });
});

describe("serve --exit-on-stdin-eof", () => {
  /** A stdin the test controls; `end()` is the shell going away. */
  const stdinOf = () => new PassThrough();

  it("stops as SIGINT does when stdin ends: closes windows, writes --out, resolves 0", async () => {
    const file = await makePark();
    const out = join(dir, "eof.park");
    const stdin = stdinOf();
    const server = await startServeWith(
      { stdin },
      "--save",
      file,
      "--out",
      out,
      "--token",
      "t",
      "--exit-on-stdin-eof",
    );
    const peer = await Peer.connect(tokenUrl(server.info));
    await peer.hello();
    const id = peer.send({
      t: "command",
      name: "terrain_raise",
      input: { x: 0, y: 0, w: 2, h: 2 },
    });
    await peer.json("result", (j) => j.id === id);

    stdin.end();
    expect(await server.exited).toBe(0);
    expect(server.stderr()).toBe("");
    expect(await peer.closed).toBe(1001);
    expect((await readPark(out)).log).toHaveLength(1);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("stops when stdin was already at its end before serve started", async () => {
    const file = await makePark();
    const stdin = stdinOf();
    stdin.end();
    stdin.resume();
    await once(stdin, "end");
    const server = await startServeWith(
      { stdin },
      "--save",
      file,
      "--token",
      "t",
      "--exit-on-stdin-eof",
    );
    expect(await server.exited).toBe(0);
  });

  it("also stops when stdin errors, as a pipe whose reader is gone does", async () => {
    const file = await makePark();
    const stdin = stdinOf();
    const server = await startServeWith({ stdin }, "--save", file, "--exit-on-stdin-eof");
    stdin.destroy(new Error("read ECONNRESET"));
    expect(await server.exited).toBe(0);
  });

  it("lets go of stdin when something else stops it", async () => {
    const file = await makePark();
    const stdin = stdinOf();
    const server = await startServeWith({ stdin }, "--save", file, "--exit-on-stdin-eof");
    expect(stdin.listenerCount("end")).toBeGreaterThan(0);
    expect((await server.stop()).code).toBe(0);
    for (const event of ["end", "close"]) expect(stdin.listenerCount(event)).toBe(0);
    // A late error is still caught, and the stream is paused: a real stdin no longer keeps the
    // process alive.
    expect(() => stdin.emit("error", new Error("late"))).not.toThrow();
    expect(stdin.isPaused()).toBe(true);
  });

  it("keeps serving when stdin ends and the flag was not given", async () => {
    const file = await makePark();
    const stdin = stdinOf();
    const server = await startServeWith({ stdin }, "--save", file);
    // Not read at all: nothing is listening to it.
    for (const event of ["end", "close", "error"]) expect(stdin.listenerCount(event)).toBe(0);
    stdin.end();
    stdin.resume();
    await once(stdin, "end");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await fetch(`${server.http}/health`)).status).toBe(200);
    expect((await server.stop()).code).toBe(0);
  });

  it("is a usage error without a stdin to watch", async () => {
    const file = await makePark();
    const result = await cli("serve", "--save", file, "--exit-on-stdin-eof");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("error: --exit-on-stdin-eof needs a stdin to watch");
    expect(result.stdout).toBe("");
  });
});

describe("bin serve", () => {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

  it("serves until SIGINT, then writes --out and exits 0", async (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    const file = await makePark();
    const out = join(dir, "bin.park");
    const child = spawn(
      process.execPath,
      [dist, "serve", "--save", file, "--out", out, "--token", "t"],
      { stdio: "pipe" },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    stoppers.push(async () => child.kill("SIGKILL"));

    const info = JSON.parse(
      await eventually(() => (stdout.includes("\n") ? stdout : undefined)),
    ) as ServeInfo;
    const peer = await Peer.connect(tokenUrl(info));
    await peer.hello();
    const id = peer.send({
      t: "command",
      name: "terrain_raise",
      input: { x: 0, y: 0, w: 2, h: 2 },
    });
    await peer.json("result", (j) => j.id === id);

    child.kill("SIGINT");
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
    expect(await peer.closed).toBe(1001);
    expect((await readPark(out)).log).toHaveLength(1);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("with --exit-on-stdin-eof, stops when its stdin closes, as it does if the shell is killed", async (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    const file = await makePark();
    const out = join(dir, "bin-eof.park");
    const child = spawn(
      process.execPath,
      [dist, "serve", "--save", file, "--out", out, "--token", "t", "--exit-on-stdin-eof"],
      { stdio: "pipe" },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    stoppers.push(async () => child.kill("SIGKILL"));

    const info = JSON.parse(
      await eventually(() => (stdout.includes("\n") ? stdout : undefined)),
    ) as ServeInfo;
    const peer = await Peer.connect(tokenUrl(info));
    await peer.hello();
    const id = peer.send({
      t: "command",
      name: "terrain_raise",
      input: { x: 0, y: 0, w: 2, h: 2 },
    });
    await peer.json("result", (j) => j.id === id);

    // Nothing is sent, and the process stays up: only the end of stdin stops it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(child.exitCode).toBeNull();
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
    expect(await peer.closed).toBe(1001);
    expect((await readPark(out)).log).toHaveLength(1);
  });

  it("with --exit-on-stdin-eof, still exits on SIGINT with stdin open", async (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    const file = await makePark();
    const child = spawn(
      process.execPath,
      [dist, "serve", "--save", file, "--token", "t", "--exit-on-stdin-eof"],
      { stdio: "pipe" },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    stoppers.push(async () => child.kill("SIGKILL"));
    await eventually(() => (stdout.includes("\n") ? stdout : undefined));
    child.kill("SIGINT");
    // Stdin is still open here, and the watch must not keep the process alive after the stop.
    expect(await exited).toBe(0);
  });
});
