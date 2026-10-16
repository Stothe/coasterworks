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
function allowedHostsFor(host: string, port: number): string[] {
  const names = new Set(["127.0.0.1", "localhost"]);
  // An IPv6 address appears in a Host header in brackets.
  if (!WILDCARDS.has(host)) names.add(host.includes(":") ? `[${host}]` : host);
  return [...names].flatMap((name) => [name, `${name}:${port}`]);
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
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
  const wanted = sha256(token);
  // Known once the server is listening, and always set before the first request is handled.
  let allowedHosts: string[] = [];

  const authorized = (req: IncomingMessage): boolean => {
    const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    // Compare digests, so the check takes the same time wherever the tokens differ.
    return given !== undefined && timingSafeEqual(sha256(given), wanted);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== PATH) return sendJson(res, 404, { error: "not found" });
    if (!METHODS.includes(req.method ?? "")) {
      return sendJson(res, 405, { error: "method not allowed" }, { allow: METHODS.join(", ") });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    }

    const server = createMcpServer(sim, serverOptions);
    // Stateless, which is what leaving out `sessionIdGenerator` means: a transport serves one
    // request, so each gets its own, torn down with the response.
    // The SDK checks the Host header and answers 403 itself; see `HttpOptions.host`.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.once("close", () => void server.close().catch(() => {}));
    // The cast is for the SDK's `onclose?: () => void` against `exactOptionalPropertyTypes`.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  }

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: "internal error" });
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
