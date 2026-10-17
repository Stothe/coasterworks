import {
  LogEntryPublicSchema,
  type DecodedSnapshot,
  type EventMessage,
  type SimClient,
} from "@coasterworks/protocol";
import type { TerrainData } from "@coasterworks/render";
import { useEffect, useMemo, useRef, useState } from "react";
import { connectHost } from "../host/connect";
import type { SnapshotSource } from "./useSnapshot";

/**
 * `error` is a connection that could not be made; `disconnected` is one that was made and then
 * lost. Either way `HostState.error` says why.
 */
export type HostStatus = "connecting" | "ready" | "error" | "disconnected";

export interface HostState extends SnapshotSource {
  status: HostStatus;
  /** The park's name, from the host's welcome. Unknown until the connection is made. */
  name?: string;
  /** The latest terrain. A snapshot without terrain leaves it as it was. */
  terrain: TerrainData | null;
  /**
   * The last 200 log events, oldest first and in id order: the park's history as of the connection,
   * then what has happened since. An event whose id is already here replaces that entry, so no id
   * appears twice, and a live event is never replaced by the history's copy of it.
   */
  events: EventMessage[];
  /**
   * The id of the newest log entry that was loaded as history, or 0 if none was. Everything up to it
   * happened before the page looked, so it is not news: it does not count for the bell or get a toast.
   */
  historyThrough?: number;
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

/** How much of the log is asked for when the connection is made: the most a query returns. */
const HISTORY_LIMIT = 200;

/** What the host's error starts with when it has stopped the simulation. */
const HALT_PREFIX = "Simulation halted";

/** What the hook keeps in React state: all of `HostState` but the snapshot, which has its own feed. */
type Core = Omit<HostState, keyof SnapshotSource>;

const INITIAL: Core = {
  status: "connecting",
  terrain: null,
  events: [],
  client: null,
  halted: false,
};

/**
 * The latest snapshot and those who want to hear of the next. It sits outside React state so that
 * a snapshot, which is nearly always only time passing, renders nothing but what shows it.
 */
class SnapshotFeed {
  latest: DecodedSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  publish(snapshot: DecodedSnapshot): void {
    this.latest = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

/** One connection's life. It outlasts the effect that opened it by a moment; see `useHost`. */
interface Session {
  client: SimClient | null;
  closed: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * `state` after a snapshot. Most snapshots change nothing the state holds (the tick moved on), and
 * then `state` itself is returned, so React does not render.
 */
function withSnapshot(state: Core, snapshot: DecodedSnapshot): Core {
  const { header, terrain } = snapshot;
  // Running again: the halt, and the error that announced it, are over.
  const clearsHalt =
    !header.halted && (state.haltMessage !== undefined || !!state.error?.startsWith(HALT_PREFIX));
  if (!terrain && state.halted === header.halted && !clearsHalt) return state;
  const next: Core = {
    ...state,
    terrain: terrain ? { width: header.width, height: header.height, ...terrain } : state.terrain,
    halted: header.halted,
  };
  if (clearsHalt) {
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

/**
 * `events` with the history added: entries it does not have are put where their ids belong, and an
 * id it does have keeps the event it has, which is the live one. The newest 200 are kept.
 */
function withHistory(events: EventMessage[], history: readonly EventMessage[]): EventMessage[] {
  const byId = new Map<number, EventMessage>();
  for (const event of history) byId.set(event.entry.id, event);
  for (const event of events) byId.set(event.entry.id, event);
  return [...byId.values()].sort((a, b) => a.entry.id - b.entry.id).slice(-MAX_EVENTS);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function close(session: Session): void {
  session.closed = true;
  session.client?.close();
}

/**
 * The park's log as it stands, newest entries last, for a client that has just joined. It is
 * history only: a host that cannot answer, or an answer that is not a list of log entries, leaves
 * the timeline to begin from now.
 */
async function loadHistory(client: SimClient): Promise<EventMessage[]> {
  const answer = await client.query<unknown>("log_recent", { limit: HISTORY_LIMIT });
  if (!answer.ok || !Array.isArray(answer.result)) return [];
  const events: EventMessage[] = [];
  // The query answers newest first.
  for (const item of answer.result) {
    const entry = LogEntryPublicSchema.safeParse(item);
    if (entry.success) events.unshift({ t: "event", kind: "log", entry: entry.data });
  }
  return events;
}

/** Connects, then follows the host: snapshots, log events and errors become state. */
function open(
  connect: ConnectFn,
  setState: (update: (state: Core) => Core) => void,
  feed: SnapshotFeed,
) {
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
      client.onSnapshot((snapshot) => {
        feed.publish(snapshot);
        setState((state) => withSnapshot(state, snapshot));
      });
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
              name: welcome.name,
              // The welcome comes first, so this is what a page that has no snapshot yet knows.
              halted: feed.latest ? state.halted : welcome.halted,
            },
      );
      if (lost !== undefined) return;
      // What the park did before this page joined fills the timeline. It is asked for once.
      const history = await loadHistory(client).catch(() => []);
      if (session.closed || history.length === 0) return;
      const through = Math.max(...history.map(({ entry }) => entry.id));
      setState((state) => ({
        ...state,
        events: withHistory(state.events, history),
        historyThrough: Math.max(state.historyThrough ?? 0, through),
      }));
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
 * The component renders when anything but the snapshot changes. The snapshot is read from the
 * returned state when needed (`state.snapshot`), and a component that shows part of it follows it
 * with `useSnapshot`, so a snapshot every 50 ms renders only what shows it.
 *
 * React strict mode mounts, unmounts and mounts a component again at once. The close is therefore
 * put off until the next turn of the event loop, and a mount in that gap keeps the connection, so
 * strict mode does not open a second worker or close a client that is in use.
 */
export function useHost(connect: ConnectFn = connectHost): HostState {
  const [core, setCore] = useState<Core>(INITIAL);
  const [feed] = useState(() => new SnapshotFeed());
  const session = useRef<Session | null>(null);
  const connectFn = useRef(connect);

  useEffect(() => {
    const current = session.current ?? open(connectFn.current, setCore, feed);
    session.current = current;
    clearTimeout(current.releaseTimer);
    current.releaseTimer = undefined;
    return () => {
      current.releaseTimer = setTimeout(() => {
        close(current);
        if (session.current === current) session.current = null;
      }, 0);
    };
  }, [feed]);

  return useMemo<HostState>(
    () => ({
      ...core,
      get snapshot() {
        return feed.latest;
      },
      subscribeSnapshot: feed.subscribe,
    }),
    [core, feed],
  );
}
