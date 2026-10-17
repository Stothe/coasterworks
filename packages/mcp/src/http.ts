import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Sim } from "@coasterworks/sim";
import { createMcpServer, type McpServerOptions } from "./server.js";

export interface HttpOptions extends McpServerOptions {
  /** The port to listen on; 0, the default, picks a free one. */
  port?: number;
  /**
   * The address to listen on. Defaults to loopback, so only this machine can connect.
   *
   * To stop a web page from reaching the server through a hostname it controls (DNS rebinding), a
   * request is refused with 403 unless its `Host` header is `127.0.0.1`, `localhost`, or this
   * address, with or without the port. A wildcard address such as `0.0.0.0` therefore serves
   * clients that connect by one of the loopback names, and no others.
   */
  host?: string;
  /** Every request must send `Authorization: Bearer <token>`. */
  token: string;
}

export interface HttpServer {
  /** Where clients connect, such as `http://127.0.0.1:3000/mcp`. */
  url: string;
  port: number;
  /** Stops listening and drops open connections. Safe to call more than once. */
  close(): Promise<void>;
}

const PATH = "/mcp";
const METHODS = ["POST", "GET", "DELETE"];
/** Addresses that listen on every interface; a client can name the server by none of them. */
const WILDCARDS = new Set(["0.0.0.0", "::"]);

/**
 * The `Host` header values that may reach the server: loopback by name and by address, plus the
 * address it was told to listen on, each bare and with the port, as a client's `Host` carries it.
 */
export function allowedHostsFor(host: string, port: number): string[] {
  const names = new Set(["127.0.0.1", "localhost"]);
  // An IPv6 address appears in a Host header in brackets.
  if (!WILDCARDS.has(host)) names.add(host.includes(":") ? `[${host}]` : host);
  return [...names].flatMap((name) => [name, `${name}:${port}`]);
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/**
 * True when `given` is the `expected` token. It compares digests, so the check takes the same time
 * wherever the two differ, and whatever their lengths.
 */
export function tokenMatches(expected: string, given: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export interface McpRequestHandlerOptions extends McpServerOptions {
  /** Every request must send `Authorization: Bearer <token>`. */
  token: string;
  /**
   * The `Host` header values to accept; see `HttpOptions.host`. Read on every request, so a server
   * that learns its port only once it is listening can fill the list in then. An empty list would
   * switch the check off in the MCP SDK, so the handler answers 500 instead.
   */
  allowedHosts: () => string[];
}

/**
 * Builds the part of `serveHttp` that speaks MCP, for a caller that runs its own HTTP server and
 * wants `/mcp` on it. The handler answers a request for `/mcp` itself (the method, the bearer
 * token, the `Host` header, then MCP) and returns true. For any other path it touches nothing and
 * returns false, and the request is the caller's. It never rejects: a failure becomes a 500.
 *
 * The handler keeps no session: each request gets its own MCP server, and they all share `sim`.
 */
export function createMcpRequestHandler(
  sim: Sim,
  opts: McpRequestHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { token, allowedHosts, ...serverOptions } = opts;
  if (token === "") throw new Error("createMcpRequestHandler needs a non-empty token");

  const authorized = (req: IncomingMessage): boolean => {
    const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    return given !== undefined && tokenMatches(token, given);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!METHODS.includes(req.method ?? "")) {
      return sendJson(res, 405, { error: "method not allowed" }, { allow: METHODS.join(", ") });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    }

    const hosts = allowedHosts();
    if (hosts.length === 0) throw new Error("no allowed hosts; the Host check would be off");

    const server = createMcpServer(sim, serverOptions);
    // Stateless, which is what leaving out `sessionIdGenerator` means: a transport serves one
    // request, so each gets its own, torn down with the response.
    // The SDK checks the Host header and answers 403 itself; see `HttpOptions.host`.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: hosts,
    });
    res.once("close", () => void server.close().catch(() => {}));
    // The cast is for the SDK's `onclose?: () => void` against `exactOptionalPropertyTypes`.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  }

  return async (req, res) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== PATH) return false;
    try {
      await handle(req, res);
    } catch {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: "internal error" });
    }
    return true;
  };
}

/**
 * Serves `sim` over Streamable HTTP at `/mcp`, for clients that cannot spawn a process. Every
 * request needs the bearer `token` and a `Host` header that names this machine (see
 * `HttpOptions.host`); the token is checked first. The server keeps no session: each request gets
 * its own MCP server, and they all share `sim`.
 */
export async function serveHttp(sim: Sim, opts: HttpOptions): Promise<HttpServer> {
  const { port = 0, host = "127.0.0.1", token, ...serverOptions } = opts;
  if (token === "") throw new Error("serveHttp needs a non-empty token");
  // Known once the server is listening, and always set before the first request is handled.
  let allowedHosts: string[] = [];
  const handle = createMcpRequestHandler(sim, {
    ...serverOptions,
    token,
    allowedHosts: () => allowedHosts,
  });

  const http = createServer((req, res) => {
    void handle(req, res).then((handled) => {
      if (!handled) sendJson(res, 404, { error: "not found" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const bound = (http.address() as AddressInfo).port;
  allowedHosts = allowedHostsFor(host, bound);

  let closing: Promise<void> | undefined;
  return {
    url: `http://${host}:${bound}${PATH}`,
    port: bound,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
        // `close` waits for open connections, such as a client's idle event stream.
        http.closeAllConnections();
      })),
  };
}
