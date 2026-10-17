import type { DecodedSnapshot, EventMessage, SimClient } from "@coasterworks/protocol";
import type { TerrainData } from "@coasterworks/render";
import { useEffect, useRef, useState } from "react";
import { connectHost } from "../host/connect";

/**
 * `error` is a connection that could not be made; `disconnected` is one that was made and then
 * lost. Either way `HostState.error` says why.
 */
export type HostStatus = "connecting" | "ready" | "error" | "disconnected";

export interface HostState {
  status: HostStatus;
  /** The latest snapshot the host sent. */
  snapshot: DecodedSnapshot | null;
  /** The latest terrain. A snapshot without terrain leaves it as it was. */
  terrain: TerrainData | null;
  /**
   * The last 200 log events, oldest first and in id order. An event whose id is already here
   * replaces that entry, so no id appears twice.
   */
  events: EventMessage[];
  client: SimClient | null;
  /** Why the connection failed or was lost, or the last error the host reported. */
  error?: string;
  /**
   * True while the host has the simulation stopped after a fault. The welcome, every snapshot and
   * the host's error all say so, and a snapshot that says it is running again clears it.
   */
  halted: boolean;
  /** What the host said when it halted, such as `Simulation halted: boom`, while `halted`. */
  haltMessage?: string;
}

/** What `useHost` needs from a connection. `connectHost` provides it; tests provide their own. */
export type ConnectFn = () => Promise<{ client: SimClient }>;

const MAX_EVENTS = 200;

/** What the host's error starts with when it has stopped the simulation. */
const HALT_PREFIX = "Simulation halted";

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
  const next: HostState = {
    ...state,
    snapshot,
    terrain: terrain ? { width: header.width, height: header.height, ...terrain } : state.terrain,
    halted: header.halted,
  };
  if (!header.halted) {
    // Running again: the halt, and the error that announced it, are over.
    delete next.haltMessage;
    if (state.error?.startsWith(HALT_PREFIX)) delete next.error;
  }
  return next;
}

/**
 * `events` with `event` in it. The newest id is the common case and is added at the end; an id the
 * list already has is replaced in place, and an older one is put where its id belongs.
 */
function withEvent(events: EventMessage[], event: EventMessage): EventMessage[] {
  const { id } = event.entry;
  const last = events.at(-1);
  if (!last || id > last.entry.id) return [...events, event].slice(-MAX_EVENTS);
  const at = events.findIndex((known) => known.entry.id >= id);
  const next = events.slice();
  next.splice(at, events[at]?.entry.id === id ? 1 : 0, event);
  return next.slice(-MAX_EVENTS);
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
        setState((state) => ({ ...state, events: withEvent(state.events, event) })),
      );
      client.onError((message) =>
        setState((state) =>
          message.startsWith(HALT_PREFIX)
            ? { ...state, error: message, halted: true, haltMessage: message }
            : { ...state, error: message },
        ),
      );
      // A connection lost before the page learned it was ready is told by `connect` failing, or
      // by `lost` here; one lost after that, by the handler.
      let lost: string | undefined;
      client.onClose((reason) => {
        lost = reason;
        if (session.closed) return;
        setState((state) =>
          state.status === "ready"
            ? { ...state, status: "disconnected", error: reason, client: null }
            : state,
        );
      });
      const welcome = await client.connect();
      if (session.closed) return;
      setState((state) =>
        lost !== undefined
          ? { ...state, status: "disconnected", error: lost, client: null }
          : {
              ...state,
              status: "ready",
              client,
              // The welcome comes first, so this is what a page that has no snapshot yet knows.
              halted: state.snapshot ? state.halted : welcome.halted,
            },
      );
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
