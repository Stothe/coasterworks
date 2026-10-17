import type { DecodedSnapshot, EventMessage, SimClient } from "@coasterworks/protocol";
import type { TerrainData } from "@coasterworks/render";
import { useEffect, useRef, useState } from "react";
import { connectHost } from "../host/connect";

export type HostStatus = "connecting" | "ready" | "error";

export interface HostState {
  status: HostStatus;
  /** The latest snapshot the host sent. */
  snapshot: DecodedSnapshot | null;
  /** The latest terrain. A snapshot without terrain leaves it as it was. */
  terrain: TerrainData | null;
  /** The last 50 log events, oldest first. */
  events: EventMessage[];
  client: SimClient | null;
  /** Why the connection failed, or the last error the host reported. */
  error?: string;
  /** True once the host has stopped the simulation after a fault. */
  halted: boolean;
}

/** What `useHost` needs from a connection. `connectHost` provides it; tests provide their own. */
export type ConnectFn = () => Promise<{ client: SimClient }>;

const MAX_EVENTS = 50;

const INITIAL: HostState = {
  status: "connecting",
  snapshot: null,
  terrain: null,
  events: [],
  client: null,
  halted: false,
};

/** One connection's life. It outlasts the effect that opened it by a moment; see `useHost`. */
interface Session {
  client: SimClient | null;
  closed: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | undefined;
}

function withSnapshot(state: HostState, snapshot: DecodedSnapshot): HostState {
  const { header, terrain } = snapshot;
  return {
    ...state,
    snapshot,
    terrain: terrain ? { width: header.width, height: header.height, ...terrain } : state.terrain,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function close(session: Session): void {
  session.closed = true;
  session.client?.close();
}

/** Connects, then follows the host: snapshots, log events and errors become state. */
function open(connect: ConnectFn, setState: (update: (state: HostState) => HostState) => void) {
  const session: Session = { client: null, closed: false, releaseTimer: undefined };
  void (async () => {
    let client: SimClient | null = null;
    try {
      ({ client } = await connect());
      session.client = client;
      // A page that went away while connecting leaves nobody to talk to.
      if (session.closed) {
        client.close();
        return;
      }
      // Everything is subscribed before hello: the host sends its first snapshot with the welcome.
      client.onSnapshot((snapshot) => setState((state) => withSnapshot(state, snapshot)));
      client.onEvent((event) =>
        setState((state) => ({ ...state, events: [...state.events, event].slice(-MAX_EVENTS) })),
      );
      client.onError((message) =>
        setState((state) => ({
          ...state,
          error: message,
          halted: state.halted || message.startsWith("Simulation halted"),
        })),
      );
      await client.connect();
      if (session.closed) return;
      setState((state) => ({ ...state, status: "ready", client }));
    } catch (error) {
      if (session.closed) return;
      client?.close();
      setState((state) => ({ ...state, status: "error", error: messageOf(error), client: null }));
    }
  })();
  return session;
}

/**
 * Connects to the sim once and follows it. The connection is made when the component mounts and
 * closed when it unmounts. `connect` is read when the connection is opened and not again.
 *
 * React strict mode mounts, unmounts and mounts a component again at once. The close is therefore
 * put off until the next turn of the event loop, and a mount in that gap keeps the connection, so
 * strict mode does not open a second worker or close a client that is in use.
 */
export function useHost(connect: ConnectFn = connectHost): HostState {
  const [state, setState] = useState<HostState>(INITIAL);
  const session = useRef<Session | null>(null);
  const connectFn = useRef(connect);

  useEffect(() => {
    const current = session.current ?? open(connectFn.current, setState);
    session.current = current;
    clearTimeout(current.releaseTimer);
    current.releaseTimer = undefined;
    return () => {
      current.releaseTimer = setTimeout(() => {
        close(current);
        if (session.current === current) session.current = null;
      }, 0);
    };
  }, []);

  return state;
}
