import { SimClient, SimHostServer, createLinkedTransports } from "@coasterworks/protocol";
import type { EventMessage, HostTimers, MessageTransport } from "@coasterworks/protocol";
import { Sim, createWorld } from "@coasterworks/sim";
import { Profiler, StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { useHost } from "../src/state/useHost";
import { useSnapshot } from "../src/state/useSnapshot";
import { buildTimeline } from "../src/state/useTimeline";

interface Rig {
  sim: Sim;
  host: SimHostServer;
  clientEnd: MessageTransport;
  /** A `connect` for `useHost` over an in-memory pair; counts how often it is called. */
  connect: Mock<() => Promise<{ client: SimClient }>>;
  clients: SimClient[];
  /** Runs one timer callback, as the host's loop would. */
  runLoop: () => void;
  advance: (ms: number) => void;
}

function makeRig(): Rig {
  const sim = new Sim(createWorld({ width: 8, height: 8, seed: 3, name: "Hook Test" }));
  let now = 0;
  let loop: (() => void) | undefined;
  const timers: HostTimers = {
    setInterval: (fn) => {
      loop = fn;
      return 1;
    },
    clearInterval: () => {
      loop = undefined;
    },
    now: () => now,
  };
  const host = new SimHostServer(sim, { timers });
  const [clientEnd, hostEnd] = createLinkedTransports();
  host.attach(hostEnd);
  host.start();
  const clients: SimClient[] = [];
  const connect = vi.fn(async () => {
    const client = new SimClient(clientEnd);
    clients.push(client);
    return { client };
  });
  return {
    sim,
    host,
    clientEnd,
    connect,
    clients,
    runLoop: () => loop?.(),
    advance: (ms) => {
      now += ms;
    },
  };
}

/** A log event, as the host would send it. */
function logEvent(id: number, over: Partial<EventMessage["entry"]> = {}): EventMessage {
  return {
    t: "event",
    kind: "log",
    entry: { id, tick: id, client: "player", name: "terrain_raise", input: {}, cost: 0, ...over },
  };
}

/**
 * `useHost` over a client that does nothing but connect, and hands back a way to send it events.
 * `history` is what the client answers to the `log_recent` query with, newest first.
 */
async function withStubClient(history: unknown[] | "fails" = []) {
  let handler: ((event: EventMessage) => void) | undefined;
  const client = {
    onSnapshot: () => () => {},
    onEvent: (fn: (event: EventMessage) => void) => {
      handler = fn;
      return () => {};
    },
    onError: () => () => {},
    onClose: () => () => {},
    connect: async () => ({ halted: false, name: "Stub Park" }),
    query: vi.fn(async (name: string) => {
      if (history === "fails") throw new Error("Connection closed");
      return name === "log_recent" ? { ok: true, result: history } : { ok: false, error: "no" };
    }),
    close: () => {},
  } as unknown as SimClient;
  const hook = renderHook(() => useHost(async () => ({ client })));
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return {
    result: hook.result,
    client,
    emit: (event: EventMessage) => handler?.(event),
  };
}

/** A log entry as the sim's `log_recent` answers with it. */
function entryOf(id: number, over: Partial<EventMessage["entry"]> = {}): EventMessage["entry"] {
  return logEvent(id, over).entry;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHost", () => {
  it("goes from connecting to ready, and the first snapshot brings the terrain", async () => {
    const rig = makeRig();
    const { result } = renderHook(() => useHost(rig.connect));
    expect(result.current.status).toBe("connecting");
    expect(result.current.terrain).toBeNull();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.client).toBeNull();
    expect(result.current.halted).toBe(false);

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.client).toBe(rig.clients[0]);
    expect(result.current.snapshot?.header.width).toBe(8);
    expect(result.current.snapshot?.header.cash).toBe(10_000_00);
    expect(result.current.error).toBeUndefined();

    const terrain = result.current.terrain;
    expect(terrain?.width).toBe(8);
    expect(terrain?.height).toBe(8);
    expect(terrain?.corners.length).toBe(81);
    expect(terrain?.corners[0]).toBe(8);
    expect(terrain?.surface.length).toBe(64);
    expect(terrain?.water.length).toBe(64);
  });

  it("keeps the old terrain arrays when a snapshot comes without terrain", async () => {
    const rig = makeRig();
    const { result } = renderHook(() => useHost(rig.connect));
    await waitFor(() => expect(result.current.terrain).not.toBeNull());
    const first = result.current.terrain;
    const firstTick = result.current.snapshot?.header.tick;

    // A tick of the sim makes a snapshot without terrain: no terrain change, only time passing.
    act(() => {
      rig.advance(1000);
      rig.runLoop();
    });
    await waitFor(() =>
      expect(result.current.snapshot?.header.tick).toBeGreaterThan(firstTick ?? 0),
    );
    expect(result.current.snapshot?.header.hasTerrain).toBe(false);
    expect(result.current.snapshot?.terrain).toBeUndefined();
    expect(result.current.terrain).toBe(first);
  });

  it("replaces the terrain when a command changes it, and records the event", async () => {
    const rig = makeRig();
    const { result } = renderHook(() => useHost(rig.connect));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const before = result.current.terrain;

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.client?.command("terrain_raise", {
        x: 1,
        y: 1,
        w: 1,
        h: 1,
      });
    });
    expect(outcome).toMatchObject({ ok: true, cost: 4 * 50_00 });

    await waitFor(() => expect(result.current.terrain).not.toBe(before));
    expect(result.current.terrain?.corners[1 * 9 + 1]).toBe(9);
    expect(result.current.snapshot?.header.cash).toBe(10_000_00 - 4 * 50_00);
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toMatchObject({
      t: "event",
      kind: "log",
      entry: { client: "player", name: "terrain_raise" },
    });
  });

  it("keeps only the last 200 events", async () => {
    const { result, emit } = await withStubClient();
    act(() => {
      for (let id = 1; id <= 205; id++) emit(logEvent(id));
    });
    expect(result.current.events).toHaveLength(200);
    const ids = result.current.events.map((e) => e.entry.id);
    expect(ids[0]).toBe(6);
    expect(ids[ids.length - 1]).toBe(205);
  });

  it("replaces an event whose id it already has, rather than adding a second", async () => {
    const { result, emit } = await withStubClient();
    act(() => {
      emit(logEvent(1, { cost: 100 }));
      emit(logEvent(2, { cost: 200 }));
      emit(logEvent(2, { cost: 999, undoneBy: 3 }));
    });
    expect(result.current.events.map((e) => e.entry.id)).toEqual([1, 2]);
    expect(result.current.events[1]?.entry).toMatchObject({ cost: 999, undoneBy: 3 });
    expect(result.current.events[0]?.entry.cost).toBe(100);
  });

  it("keeps events in id order, however they arrive", async () => {
    const { result, emit } = await withStubClient();
    act(() => {
      emit(logEvent(3));
      emit(logEvent(1));
      emit(logEvent(2));
    });
    expect(result.current.events.map((e) => e.entry.id)).toEqual([1, 2, 3]);
  });

  it("does not count a replaced event twice against the cap", async () => {
    const { result, emit } = await withStubClient();
    act(() => {
      for (let id = 1; id <= 200; id++) emit(logEvent(id));
      for (let again = 0; again < 10; again++) emit(logEvent(200, { cost: again }));
    });
    expect(result.current.events).toHaveLength(200);
    expect(result.current.events[0]?.entry.id).toBe(1);
  });

  it("knows the park's name from the welcome", async () => {
    const rig = makeRig();
    const { result } = renderHook(() => useHost(rig.connect));
    expect(result.current.name).toBeUndefined();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.name).toBe("Hook Test");
  });

  describe("the snapshots", () => {
    it("are read from the state as the latest, and a snapshot that only moves time on commits nothing", async () => {
      const rig = makeRig();
      let commits = 0;
      const { result } = renderHook(() => useHost(rig.connect), {
        wrapper: ({ children }) => (
          <Profiler id="host" onRender={() => commits++}>
            {children}
          </Profiler>
        ),
      });
      await waitFor(() => expect(result.current.status).toBe("ready"));
      const state = result.current;
      const firstTick = state.snapshot?.header.tick ?? 0;
      // React renders once more for the first update that leaves the state as it was; after that, none.
      act(() => {
        rig.advance(1000);
        rig.runLoop();
      });
      await waitFor(() => expect(state.snapshot?.header.tick).toBeGreaterThan(firstTick));
      const settled = commits;

      for (let again = 0; again < 3; again++) {
        act(() => {
          rig.advance(1000);
          rig.runLoop();
        });
      }
      await waitFor(() => expect(state.snapshot?.header.tick).toBeGreaterThan(firstTick + 40));
      // The same state reads the latest snapshot, and none of them rendered anything.
      expect(result.current).toBe(state);
      expect(commits).toBe(settled);
    });

    it("tell a subscriber after each one, and stop when it stops", async () => {
      const rig = makeRig();
      const { result } = renderHook(() => useHost(rig.connect));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      const heard = vi.fn();
      const stop = result.current.subscribeSnapshot?.(heard);
      act(() => {
        rig.advance(1000);
        rig.runLoop();
      });
      await waitFor(() => expect(heard).toHaveBeenCalled());
      const seen = heard.mock.calls.length;
      stop?.();
      act(() => {
        rig.advance(1000);
        rig.runLoop();
      });
      expect(heard).toHaveBeenCalledTimes(seen);
    });

    it("render a component that follows part of one when that part changes, and only then", async () => {
      const rig = makeRig();
      const view = renderHook(() => {
        const host = useHost(rig.connect);
        const cash = useSnapshot(host, (snapshot) => snapshot?.header.cash);
        const tick = useSnapshot(host, (snapshot) => snapshot?.header.tick);
        return { host, cash, tick };
      });
      await waitFor(() => expect(view.result.current.cash).toBe(10_000_00));
      await act(async () => {
        await view.result.current.host.client?.command("terrain_raise", { x: 1, y: 1, w: 1, h: 1 });
      });
      await waitFor(() => expect(view.result.current.cash).toBe(10_000_00 - 4 * 50_00));
      act(() => {
        rig.advance(1000);
        rig.runLoop();
      });
      await waitFor(() => expect(view.result.current.tick).toBeGreaterThan(0));
    });
  });

  describe("the history", () => {
    it("fills the events with what the park's log held when the page joined, oldest first", async () => {
      const rig = makeRig();
      rig.sim.execute("terrain_raise", { x: 1, y: 1, w: 1, h: 1 }, "agent");
      rig.sim.execute("terrain_lower", { x: 1, y: 1, w: 1, h: 1 }, "player");
      const { result } = renderHook(() => useHost(rig.connect));
      await waitFor(() => expect(result.current.events).toHaveLength(2));
      expect(result.current.events.map((e) => [e.entry.name, e.entry.client])).toEqual([
        ["terrain_raise", "agent"],
        ["terrain_lower", "player"],
      ]);
      expect(result.current.historyThrough).toBe(result.current.events[1]?.entry.id);
      expect(result.current.events[0]).toMatchObject({ t: "event", kind: "log" });
    });

    it("asks once, for the 200 the query allows, when the connection is ready", async () => {
      const { client } = await withStubClient([entryOf(1)]);
      await waitFor(() => expect(client.query).toHaveBeenCalledTimes(1));
      expect(client.query).toHaveBeenCalledWith("log_recent", { limit: 200 });
    });

    it("keeps the live event when the history holds the same id: one entry, the live one", async () => {
      const { result, emit } = await withStubClient();
      // The live event comes first, as one sent while the query was out would.
      act(() => emit(logEvent(5, { cost: 111, client: "agent" })));
      const stub = await withStubClient([entryOf(5, { cost: 999 }), entryOf(4, { cost: 444 })]);
      act(() => stub.emit(logEvent(5, { cost: 111, client: "agent" })));
      await waitFor(() => expect(stub.result.current.events).toHaveLength(2));
      expect(stub.result.current.events.map((e) => [e.entry.id, e.entry.cost])).toEqual([
        [4, 444],
        [5, 111],
      ]);
      expect(result.current.events).toHaveLength(1);
    });

    it("puts history before a live event of a later id, and never twice", async () => {
      const { result, emit } = await withStubClient([entryOf(2), entryOf(1)]);
      await waitFor(() => expect(result.current.events).toHaveLength(2));
      act(() => emit(logEvent(3, { client: "agent" })));
      act(() => emit(logEvent(2, { cost: 7 })));
      expect(result.current.events.map((e) => e.entry.id)).toEqual([1, 2, 3]);
      expect(result.current.events[1]?.entry.cost).toBe(7);
    });

    it("keeps the newest 200 of a history and the live events together", async () => {
      const history = Array.from({ length: 200 }, (_, i) => entryOf(200 - i));
      const { result, emit } = await withStubClient(history);
      await waitFor(() => expect(result.current.events).toHaveLength(200));
      act(() => emit(logEvent(201)));
      expect(result.current.events).toHaveLength(200);
      expect(result.current.events[0]?.entry.id).toBe(2);
      expect(result.current.events.at(-1)?.entry.id).toBe(201);
    });

    it("says how far it reaches, so those entries are known and not news", async () => {
      const { result, emit } = await withStubClient([entryOf(8), entryOf(7)]);
      await waitFor(() => expect(result.current.historyThrough).toBe(8));
      // A live event after it moves nothing.
      act(() => emit(logEvent(9)));
      expect(result.current.historyThrough).toBe(8);
    });

    it("computes the timeline's undo marks over the history too: a loaded undo marks its target", async () => {
      const { result } = await withStubClient([
        entryOf(3, { name: "undo", input: { target: 2 }, cost: -200 }),
        entryOf(2, { name: "terrain_lower" }),
        entryOf(1, { name: "terrain_raise" }),
      ]);
      await waitFor(() => expect(result.current.events).toHaveLength(3));
      const timeline = buildTimeline(result.current.events);
      expect(timeline.map((e) => [e.id, e.undone])).toEqual([
        [3, false],
        [2, true],
        [1, false],
      ]);
      expect(timeline[0]?.title).toBe("Undid Lower terrain");
    });

    it("does the same over the real log: an undo the sim did before the page joined", async () => {
      const rig = makeRig();
      rig.sim.execute("terrain_raise", { x: 1, y: 1, w: 1, h: 1 }, "agent");
      rig.sim.undo("player");
      const { result } = renderHook(() => useHost(rig.connect));
      await waitFor(() => expect(result.current.events).toHaveLength(2));
      const timeline = buildTimeline(result.current.events);
      expect(timeline.map((e) => [e.name, e.undone])).toEqual([
        ["undo", false],
        ["terrain_raise", true],
      ]);
    });

    it("leaves the timeline to begin from now when the park cannot answer", async () => {
      const { result, emit } = await withStubClient("fails");
      expect(result.current.status).toBe("ready");
      act(() => emit(logEvent(1)));
      expect(result.current.events.map((e) => e.entry.id)).toEqual([1]);
      expect(result.current.historyThrough ?? 0).toBe(0);
      expect(result.current.error).toBeUndefined();
    });

    it("ignores an answer that is not a list of log entries", async () => {
      const { result } = await withStubClient([{ nonsense: true }, "text", entryOf(4)]);
      await waitFor(() => expect(result.current.events).toHaveLength(1));
      expect(result.current.events[0]?.entry.id).toBe(4);
    });

    it("does not ask a connection that failed, or one lost before it was ready", async () => {
      const rig = makeRig();
      const failing = vi.fn(async () => {
        throw new Error("no socket");
      });
      const { result } = renderHook(() => useHost(failing));
      await waitFor(() => expect(result.current.status).toBe("error"));
      expect(result.current.events).toEqual([]);
      expect(rig.connect).not.toHaveBeenCalled();
    });
  });

  it("sets error when the host reports one that is not about a request", async () => {
    const rig = makeRig();
    const { result } = renderHook(() => useHost(rig.connect));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // A binary frame to the host is answered with an error that has no request id.
    act(() => {
      rig.clientEnd.send(new Uint8Array([1, 2, 3]));
    });
    await waitFor(() => expect(result.current.error).toBe("Expected a text frame"));
    expect(result.current.halted).toBe(false);
    expect(result.current.status).toBe("ready");
  });

  it("flags halted when the simulation faults", async () => {
    const rig = makeRig();
    rig.sim.systems.push({
      name: "boom",
      tick() {
        throw new Error("kaboom");
      },
    });
    const { result } = renderHook(() => useHost(rig.connect));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      rig.advance(1000);
      rig.runLoop();
    });
    await waitFor(() => expect(result.current.halted).toBe(true));
    expect(result.current.error).toBe("Simulation halted: kaboom");
    expect(result.current.snapshot?.header.speed).toBe(0);
  });

  describe("a halted simulation", () => {
    const boom = {
      name: "boom",
      tick() {
        throw new Error("kaboom");
      },
    };

    /** A rig whose sim has faulted and been halted, as a page that joins late finds it. */
    function haltedRig(): Rig {
      const rig = makeRig();
      rig.sim.systems.push(boom);
      rig.advance(1000);
      rig.runLoop();
      expect(rig.host.halted).toBe(true);
      return rig;
    }

    it("is known to a page that joins after the fault, from the welcome, the error and the snapshot", async () => {
      const rig = haltedRig();
      const { result } = renderHook(() => useHost(rig.connect));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.halted).toBe(true);
      expect(result.current.haltMessage).toBe("Simulation halted: kaboom");
      expect(result.current.error).toBe("Simulation halted: kaboom");
      expect(result.current.snapshot?.header).toMatchObject({ halted: true, speed: 0 });
    });

    it("is known from the welcome alone when no snapshot has come yet", async () => {
      const rig = makeRig();
      // A host whose snapshot trails the welcome, as a socket's does: hold the snapshot back.
      const real = rig.clientEnd;
      const connect = vi.fn(async () => {
        const client = new SimClient({
          send: (frame) => real.send(frame),
          onMessage: (handler) =>
            real.onMessage((frame) => {
              if (typeof frame === "string") handler(frame);
            }),
          onClose: (handler) => real.onClose(handler),
          close: () => real.close(),
        });
        rig.clients.push(client);
        return { client };
      });
      rig.sim.systems.push(boom);
      rig.advance(1000);
      rig.runLoop();

      const { result } = renderHook(() => useHost(connect));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.snapshot).toBeNull();
      expect(result.current.halted).toBe(true);
    });

    it("is cleared by the first snapshot that says the host runs again, with its error", async () => {
      const rig = makeRig();
      rig.sim.systems.push(boom);
      const { result } = renderHook(() => useHost(rig.connect));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.halted).toBe(false);

      act(() => {
        rig.advance(1000);
        rig.runLoop();
      });
      await waitFor(() => expect(result.current.halted).toBe(true));
      expect(result.current.haltMessage).toBe("Simulation halted: kaboom");

      rig.sim.systems.pop();
      await act(async () => {
        await result.current.client?.setSpeed(1);
      });
      await waitFor(() => expect(result.current.halted).toBe(false));
      expect(result.current.haltMessage).toBeUndefined();
      expect(result.current.error).toBeUndefined();
      expect(result.current.snapshot?.header).toMatchObject({ halted: false, speed: 1 });

      // And the sim really runs: the next loop step advances the tick.
      const before = result.current.snapshot?.header.tick ?? 0;
      act(() => {
        rig.advance(1000);
        rig.runLoop();
      });
      await waitFor(() => expect(result.current.snapshot?.header.tick).toBeGreaterThan(before));
      expect(result.current.halted).toBe(false);
    });

    it("is set again when the fault is still there after a resume", async () => {
      const rig = haltedRig();
      const { result } = renderHook(() => useHost(rig.connect));
      await waitFor(() => expect(result.current.halted).toBe(true));

      await act(async () => {
        await result.current.client?.setSpeed(1);
      });
      await waitFor(() => expect(result.current.halted).toBe(false));
      act(() => {
        rig.advance(1000);
        rig.runLoop();
      });
      await waitFor(() => expect(result.current.halted).toBe(true));
      expect(result.current.haltMessage).toBe("Simulation halted: kaboom");
    });

    it("keeps the halt, and what it said, when some other error arrives", async () => {
      const rig = haltedRig();
      const { result } = renderHook(() => useHost(rig.connect));
      await waitFor(() => expect(result.current.halted).toBe(true));

      act(() => {
        rig.clientEnd.send(new Uint8Array([1, 2, 3]));
      });
      await waitFor(() => expect(result.current.error).toBe("Expected a text frame"));
      expect(result.current.halted).toBe(true);
      expect(result.current.haltMessage).toBe("Simulation halted: kaboom");
    });
  });

  describe("a lost connection", () => {
    it("moves from ready to disconnected, with the reason, no client, and the park still in hand", async () => {
      const rig = makeRig();
      const { result } = renderHook(() => useHost(rig.connect));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      const terrain = result.current.terrain;

      act(() => {
        rig.clientEnd.close();
      });

      await waitFor(() => expect(result.current.status).toBe("disconnected"));
      expect(result.current.error).toBe("Connection closed");
      expect(result.current.client).toBeNull();
      expect(result.current.terrain).toBe(terrain);
      expect(result.current.snapshot).not.toBeNull();
    });

    it("passes on the reason the transport gives", async () => {
      const rig = makeRig();
      let drop: (reason?: string) => void = () => {};
      const connect = async () => {
        const client = new SimClient({
          send: (frame) => rig.clientEnd.send(frame),
          onMessage: (handler) => rig.clientEnd.onMessage(handler),
          onClose: (handler) => {
            drop = handler;
          },
          close: () => rig.clientEnd.close(),
        });
        return { client };
      };
      const { result } = renderHook(() => useHost(connect));
      await waitFor(() => expect(result.current.status).toBe("ready"));

      act(() => drop("WebSocket closed (code 1006)"));

      await waitFor(() => expect(result.current.status).toBe("disconnected"));
      expect(result.current.error).toBe("WebSocket closed (code 1006)");
    });

    it("is a failed connection, not a lost one, when the link closes before the welcome", async () => {
      const [clientEnd, hostEnd] = createLinkedTransports();
      hostEnd.onMessage(() => hostEnd.close());
      const connect = async () => ({ client: new SimClient(clientEnd) });
      const { result } = renderHook(() => useHost(connect));
      await waitFor(() => expect(result.current.status).toBe("error"));
      expect(result.current.error).toBe("Connection closed");
    });
  });

  it("reports a connection that fails", async () => {
    const connect = vi.fn(async () => {
      throw new Error("no route to host");
    });
    const { result } = renderHook(() => useHost(connect));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("no route to host");
    expect(result.current.client).toBeNull();
  });

  it("reports a host that refuses the hello", async () => {
    const [clientEnd, hostEnd] = createLinkedTransports();
    // A peer that answers hello with an id-less error, the way a host refuses a bad protocol.
    hostEnd.onMessage(() => {
      hostEnd.send(JSON.stringify({ t: "error", message: "Unsupported protocol version" }));
    });
    const connect = async () => ({ client: new SimClient(clientEnd) });
    const { result } = renderHook(() => useHost(connect));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Unsupported protocol version");
  });

  it("connects once under React strict mode, and closes the client on unmount", async () => {
    const rig = makeRig();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result, unmount } = renderHook(() => useHost(rig.connect), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(rig.connect).toHaveBeenCalledTimes(1);

    const client = result.current.client as SimClient;
    // The client works: it is still connected after strict mode's mount, unmount, mount.
    await expect(
      client.command("terrain_raise", { x: 0, y: 0, w: 1, h: 1 }),
    ).resolves.toMatchObject({
      ok: true,
    });

    unmount();
    // Closing is deferred a moment so strict mode's trial unmount does not close a live client.
    await waitFor(async () => {
      await expect(client.command("terrain_raise", { x: 0, y: 0, w: 1, h: 1 })).rejects.toThrow(
        /closed/i,
      );
    });
  });

  it("closes a client that finishes connecting after the component is gone", async () => {
    const rig = makeRig();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async () => {
      await gate;
      return rig.connect();
    });
    const { unmount } = renderHook(() => useHost(slow));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await waitFor(() => expect(rig.clients).toHaveLength(1));
    const client = rig.clients[0] as SimClient;
    await waitFor(async () => {
      await expect(client.requestSnapshot()).rejects.toThrow(/closed/i);
    });
  });
});
