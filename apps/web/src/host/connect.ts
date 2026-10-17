import { SimClient } from "@coasterworks/protocol";
import { WorkerTransport } from "./worker-transport";
import { WsTransport } from "./ws-transport";

export interface HostConnection {
  client: SimClient;
  /** Where the sim runs: in a worker on this page, or in a server across a socket. */
  mode: "worker" | "socket";
}

/** What the desktop shell tells the page: where its sidecar listens, and the key to it. */
export interface ShellConfig {
  wsUrl?: string;
  mcpUrl?: string;
  token?: string;
}

/** `ws` with `token` added when there is one. */
function withToken(ws: string, token: string | null | undefined): string {
  const url = new URL(ws);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

/**
 * The socket URL to dial. The desktop shell's `window.__COASTERWORKS__` wins, so a page it opens
 * needs no query string; otherwise `ws` from the page's query, with `token` added when there is one.
 */
function socketUrl(params: URLSearchParams): string | null {
  const shell = globalThis.__COASTERWORKS__;
  if (shell?.wsUrl) return withToken(shell.wsUrl, shell.token);
  const ws = params.get("ws");
  if (!ws) return null;
  return withToken(ws, params.get("token"));
}

/**
 * Connects the page to a sim. Inside the desktop app (`window.__COASTERWORKS__`), or with
 * `?ws=<url>` (and optionally `&token=<token>`), it talks to a `coasterworks serve` host over a
 * WebSocket; otherwise it starts the sample park in a worker of its own. The returned client has
 * not said hello yet: call `client.connect()`.
 *
 * `search` is the page's query string, which is where it is read from unless a caller says so.
 */
export async function connectHost(
  search: string = globalThis.location?.search ?? "",
): Promise<HostConnection> {
  const url = socketUrl(new URLSearchParams(search));
  if (url !== null) {
    return { client: new SimClient(new WsTransport(new WebSocket(url))), mode: "socket" };
  }
  const worker = new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module" });
  return { client: new SimClient(new WorkerTransport(worker)), mode: "worker" };
}
