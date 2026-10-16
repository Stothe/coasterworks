import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Sim, createWorld } from "@coasterworks/sim";
import { serveHttp, type HttpServer } from "../src/index.js";

const TOKEN = "s3cret-token";

let sim: Sim;
let http: HttpServer;
const clients: Client[] = [];

beforeEach(async () => {
  sim = new Sim(createWorld({ width: 16, height: 16, seed: 1, name: "Test Park" }));
  http = await serveHttp(sim, { port: 0, token: TOKEN });
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await http.close();
});

/** Connects an SDK client to `url`, sending the bearer `token`. */
async function connectTo(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  // The cast is for the SDK's optional `sessionId` against `exactOptionalPropertyTypes`.
  await client.connect(transport as Transport);
  clients.push(client);
  return client;
}

const connect = (token: string = TOKEN) => connectTo(http.url, token);

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0.0.0" },
  },
});

function rawPost(headers: Record<string, string> = {}, path = "/mcp") {
  const url = new URL(path, http.url);
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: INITIALIZE,
  });
}

/**
 * POSTs to the server with `host` as the Host header. `fetch` takes its Host from the URL, so this
 * goes through `node:http`, which sends the header it is given.
 */
function postWithHost(
  host: string,
  headers: Record<string, string> = {},
  body: string = INITIALIZE,
  target: { address: string; port: number } = { address: "127.0.0.1", port: http.port },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.address,
        port: target.port,
        path: "/mcp",
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("serveHttp", () => {
  it("listens on a random loopback port and reports where", () => {
    expect(http.port).toBeGreaterThan(0);
    expect(http.url).toBe(`http://127.0.0.1:${http.port}/mcp`);
  });

  it("lists the sim's tools for a client with the bearer token", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["terrain_raise", "park_status", "undo"]));
    expect(names).not.toContain("save_write");
  });

  it("runs commands against one shared park across requests", async () => {
    const first = await connect();
    await first.callTool({ name: "terrain_raise", arguments: { x: 0, y: 0, w: 2, h: 2 } });
    expect(sim.world.finance.cash).toBe(955_000);

    const second = await connect();
    const status = await second.callTool({ name: "park_status", arguments: {} });
    const text = (status.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text).result.cash).toBe(955_000);
    await second.callTool({ name: "undo", arguments: {} });
    expect(sim.world.finance.cash).toBe(1_000_000);
  });

  it("rejects a request with no Authorization header with 401", async () => {
    const response = await rawPost();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it.each([
    ["the wrong token", `Bearer ${TOKEN}x`],
    ["a prefix of the token", `Bearer ${TOKEN.slice(0, 4)}`],
    ["an empty token", "Bearer "],
    ["another scheme", `Basic ${TOKEN}`],
    ["the bare token", TOKEN],
  ])("rejects %s with 401", async (_label, authorization) => {
    const response = await rawPost({ authorization });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("checks the token on GET and DELETE as well", async () => {
    const url = http.url;
    const get = await fetch(url, { headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(401);
    const del = await fetch(url, { method: "DELETE" });
    expect(del.status).toBe(401);
  });

  it("makes a client without the right token fail to connect, and changes nothing", async () => {
    const before = sim.hash();
    await expect(connect("wrong")).rejects.toThrow();
    expect(sim.hash()).toBe(before);
  });

  it("answers a raw request with the token", async () => {
    const response = await rawPost({ authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"serverInfo"');
  });

  it("returns 404 for any other path and 405 for other methods on /mcp", async () => {
    const other = await rawPost({ authorization: `Bearer ${TOKEN}` }, "/other");
    expect(other.status).toBe(404);
    const root = await fetch(new URL("/", http.url));
    expect(root.status).toBe(404);
    const put = await fetch(http.url, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("POST, GET, DELETE");
  });

  it("serves the file tools only when asked", async () => {
    const files = await serveHttp(sim, { token: TOKEN, allowFiles: true });
    try {
      const client = await connectTo(files.url, TOKEN);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("save_write");
    } finally {
      await files.close();
    }
  });

  it("refuses to start without a token", async () => {
    await expect(serveHttp(sim, { token: "" })).rejects.toThrow(/token/);
  });

  it("closes promptly while a client is still connected, and stops listening", async () => {
    const client = await connect();
    await client.listTools();
    const url = http.url;
    await http.close();
    await expect(fetch(url, { method: "POST" })).rejects.toThrow();
    // A second close is harmless.
    await http.close();
  });
});

describe("DNS rebinding protection", () => {
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const RAISE_CALL = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "terrain_raise", arguments: { x: 0, y: 0, w: 2, h: 2 } },
  });

  it("serves a request whose Host names loopback, with or without the port", async () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      `127.0.0.1:${http.port}`,
      `localhost:${http.port}`,
    ]) {
      const response = await postWithHost(host, bearer);
      expect(response.status, host).toBe(200);
      expect(response.text, host).toContain('"serverInfo"');
    }
  });

  it("answers 403 from the SDK, after the token checks out, when Host names another site", async () => {
    for (const host of [
      "evil.example",
      `evil.example:${http.port}`,
      "127.0.0.1.evil.example",
      `localhost:${http.port + 1}`,
    ]) {
      const response = await postWithHost(host, bearer);
      expect(response.status, host).toBe(403);
      expect(JSON.parse(response.text).error.message, host).toBe(`Invalid Host header: ${host}`);
    }
  });

  it("does not run a command sent with a foreign Host header and the right token", async () => {
    const before = sim.hash();
    const refused = await postWithHost("evil.example", bearer, RAISE_CALL);
    expect(refused.status).toBe(403);
    expect(sim.hash()).toBe(before);

    // The same call with a loopback Host does run, so the check above means something.
    const served = await postWithHost(`127.0.0.1:${http.port}`, bearer, RAISE_CALL);
    expect(served.status).toBe(200);
    expect(sim.world.finance.cash).toBe(955_000);
  });

  it("answers 401, not 403, to a foreign Host header with no token, because the token is checked first", async () => {
    const response = await postWithHost("evil.example");
    expect(response.status).toBe(401);
    expect(JSON.parse(response.text)).toEqual({ error: "unauthorized" });
  });

  it("also allows the address it was told to listen on, when that is not loopback", async (ctx) => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((info) => info !== undefined && info.family === "IPv4" && !info.internal);
    if (lan === undefined) return ctx.skip();
    const bound = await serveHttp(sim, { port: 0, host: lan.address, token: TOKEN });
    try {
      const target = { address: lan.address, port: bound.port };
      const bearer = { authorization: `Bearer ${TOKEN}` };
      for (const host of [lan.address, `${lan.address}:${bound.port}`, `localhost:${bound.port}`]) {
        expect((await postWithHost(host, bearer, INITIALIZE, target)).status, host).toBe(200);
      }
      expect((await postWithHost("evil.example", bearer, INITIALIZE, target)).status).toBe(403);
    } finally {
      await bound.close();
    }
  });
});
