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
  /** The address to listen on. Defaults to loopback, so only this machine can connect. */
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

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Serves `sim` over Streamable HTTP at `/mcp`, for clients that cannot spawn a process. Every
 * request needs the bearer `token`. The server keeps no session: each request gets its own MCP
 * server, and they all share `sim`.
 */
export async function serveHttp(sim: Sim, opts: HttpOptions): Promise<HttpServer> {
  const { port = 0, host = "127.0.0.1", token, ...serverOptions } = opts;
  if (token === "") throw new Error("serveHttp needs a non-empty token");
  const wanted = sha256(token);

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
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
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
