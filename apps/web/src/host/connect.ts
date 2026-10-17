import { SimClient } from "@coasterworks/protocol";
import { WorkerTransport } from "./worker-transport";
import { WsTransport } from "./ws-transport";

export interface HostConnection {
  client: SimClient;
  /** Where the sim runs: in a worker on this page, or in a server across a socket. */
  mode: "worker" | "socket";
}

/** The socket URL to dial: `ws` from the page's query, with `token` added when there is one. */
function socketUrl(params: URLSearchParams): string | null {
  const ws = params.get("ws");
  if (!ws) return null;
  const url = new URL(ws);
  const token = params.get("token");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Connects the page to a sim. With `?ws=<url>` (and optionally `&token=<token>`) it talks to a
 * `coasterworks serve` host over a WebSocket; otherwise it starts the sample park in a worker of
 * its own. The returned client has not said hello yet: call `client.connect()`.
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
