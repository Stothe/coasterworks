import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  SimClient,
  SimHostServer,
  createLinkedTransports,
  encodeSnapshot,
  type DecodedSnapshot,
  type EventMessage,
  type Frame,
} from "../src/index.js";
import { RAISE, fakeTimers, makeSim } from "./helpers.js";

/** A client wired to a real host over an in-memory pair. */
function setup() {
  const sim = makeSim();
  const clock = fakeTimers();
  const host = new SimHostServer(sim, { timers: clock });
  const [hostSide, clientSide] = createLinkedTransports();
  host.attach(hostSide);
  const client = new SimClient(clientSide);
  return { sim, clock, host, client, hostSide, clientSide };
}

describe("SimClient", () => {
  it("connect() resolves with the welcome", async () => {
    const { client } = setup();
    await expect(client.connect()).resolves.toEqual({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      width: 8,
      height: 8,
      name: "Test Park",
      speed: 1,
      halted: false,
    });
  });

  it("connect() twice shares one hello", async () => {
    const { client } = setup();
    const snapshots: DecodedSnapshot[] = [];
    client.onSnapshot((snapshot) => snapshots.push(snapshot));
    const first = client.connect();
    const second = client.connect();
    expect(second).toBe(first);
    await first;
    expect(snapshots).toHaveLength(1);
  });

  it("connect() rejects when the host refuses, with the host's message", async () => {
    const [hostSide, clientSide] = createLinkedTransports();
    hostSide.onMessage(() => {
      hostSide.send(JSON.stringify({ t: "error", message: "Unsupported protocol version" }));
      hostSide.close();
    });
    const client = new SimClient(clientSide);
    const failure = await client.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProtocolError);
    expect((failure as ProtocolError).message).toBe("Unsupported protocol version");
  });

  it("connect() rejects when the connection closes first", async () => {
    const { client, hostSide } = setup();
    hostSide.close();
    await expect(client.connect()).rejects.toThrow(new ProtocolError("Connection closed"));
  });

  it("command() resolves with the ExecResult", async () => {
    const { sim, client } = setup();
    await client.connect();
    const result = await client.command("terrain_raise", RAISE);
    expect(result.ok).toBe(true);
    expect(result).toEqual({ ok: true, id: sim.world.log[0]?.id, cost: sim.world.log[0]?.cost });
    expect(sim.world.log).toHaveLength(1);
  });

  it("command() resolves with the failure when the sim refuses, rather than rejecting", async () => {
    const { client } = setup();
    await client.connect();
    expect(await client.command("no_such_command", {})).toEqual({
      ok: false,
      error: "Unknown command: no_such_command",
    });
  });

  it("command() with no input still reaches the sim", async () => {
    const { client } = setup();
    await client.connect();
    const result = await client.command("terrain_raise", undefined);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("error");
  });

  it("query() resolves with the QueryResult", async () => {
    const { sim, client } = setup();
    await client.connect();
    const status = await client.query<{ name: string; width: number }>("park_status", {});
    expect(status).toEqual(sim.query("park_status", {}));
    if (!status.ok) throw new Error("expected ok");
    expect(status.result.name).toBe("Test Park");
    expect(await client.query("nope", {})).toEqual({ ok: false, error: "Unknown query: nope" });
  });

  it("undo() and redo() resolve with the ExecResult", async () => {
    const { sim, client } = setup();
    await client.connect();
    expect(await client.undo()).toEqual({ ok: false, error: "Nothing to undo" });
    const flat = sim.world.terrain.corners.slice();
    await client.command("terrain_raise", RAISE);
    const raised = sim.world.terrain.corners.slice();
    expect((await client.undo()).ok).toBe(true);
    expect(sim.world.terrain.corners).toEqual(flat);
    expect((await client.redo()).ok).toBe(true);
    expect(sim.world.terrain.corners).toEqual(raised);
  });

  it("setSpeed() resolves once the host has the new speed", async () => {
    const { host, client } = setup();
    await client.connect();
    await client.setSpeed(4);
    expect(host.speed).toBe(4);
  });

  it("onSnapshot fires with the decoded terrain, first on connect", async () => {
    const { sim, client } = setup();
    const snapshots: DecodedSnapshot[] = [];
    client.onSnapshot((snapshot) => snapshots.push(snapshot));
    await client.connect();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.header.hasTerrain).toBe(true);
    expect(snapshots[0]?.terrain?.corners).toEqual(sim.world.terrain.corners);
    expect(snapshots[0]?.terrain?.corners).toBeInstanceOf(Int16Array);
  });

  it("onSnapshot sees a command's snapshot with the changed terrain", async () => {
    const { sim, client } = setup();
    await client.connect();
    const snapshots: DecodedSnapshot[] = [];
    client.onSnapshot((snapshot) => snapshots.push(snapshot));
    await client.command("terrain_raise", RAISE);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.header.terrainVersion).toBe(1);
    expect(snapshots[0]?.terrain?.corners).toEqual(sim.world.terrain.corners);
  });

  it("requestSnapshot() delivers a full snapshot before it resolves", async () => {
    const { client } = setup();
    await client.connect();
    const snapshots: DecodedSnapshot[] = [];
    client.onSnapshot((snapshot) => snapshots.push(snapshot));
    await client.requestSnapshot();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.header.hasTerrain).toBe(true);
  });

  it("onSnapshot and onEvent return an unsubscribe", async () => {
    const { client } = setup();
    await client.connect();
    const snapshots: DecodedSnapshot[] = [];
    const events: EventMessage[] = [];
    const stopSnapshots = client.onSnapshot((snapshot) => snapshots.push(snapshot));
    const stopEvents = client.onEvent((event) => events.push(event));
    await client.command("terrain_raise", RAISE);
    expect([snapshots.length, events.length]).toEqual([1, 1]);

    stopSnapshots();
    stopEvents();
    await client.command("terrain_lower", RAISE);
    expect([snapshots.length, events.length]).toEqual([1, 1]);
  });

  it("registering one handler twice gives two independent registrations", async () => {
    const { client } = setup();
    await client.connect();
    let calls = 0;
    const handler = () => {
      calls++;
    };
    const stopFirst = client.onEvent(handler);
    client.onEvent(handler);
    await client.command("terrain_raise", RAISE);
    expect(calls).toBe(2);
    stopFirst();
    await client.command("terrain_lower", RAISE);
    expect(calls).toBe(3);
  });

  it("onEvent fires for changes made by others, such as an agent on the sim", async () => {
    const { sim, host, client } = setup();
    await client.connect();
    const events: EventMessage[] = [];
    client.onEvent((event) => events.push(event));
    sim.execute("terrain_raise", RAISE, "agent");
    host.notifyExternalMutation();
    expect(events).toHaveLength(1);
    expect(events[0]?.entry).toMatchObject({ name: "terrain_raise", client: "agent" });
  });

  it("matches concurrent requests to their own answers", async () => {
    const { client } = setup();
    await client.connect();
    const [status, bounds, raise] = await Promise.all([
      client.query("park_status", {}),
      client.query("park_bounds", {}),
      client.command("terrain_raise", RAISE),
    ]);
    expect(status).toMatchObject({ ok: true, result: { name: "Test Park" } });
    expect(bounds).toMatchObject({ ok: true, result: { width: 8 } });
    expect(raise.ok).toBe(true);
  });

  it("closing the transport rejects a pending command with a ProtocolError", async () => {
    // Nobody answers on this pair, so the command stays pending.
    const [silent, clientSide] = createLinkedTransports();
    const client = new SimClient(clientSide);
    const pending = client.command("terrain_raise", RAISE);
    const other = client.query("park_status", {});
    silent.close();
    for (const promise of [pending, other]) {
      const failure = await promise.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProtocolError);
      expect((failure as ProtocolError).message).toBe("Connection closed");
    }
  });

  it("rejects requests made after the connection closed", async () => {
    const { client, hostSide } = setup();
    await client.connect();
    hostSide.close();
    await expect(client.command("terrain_raise", RAISE)).rejects.toThrow("Connection closed");
    await expect(client.query("park_status", {})).rejects.toBeInstanceOf(ProtocolError);
  });

  it("close() closes the transport and rejects what is pending", async () => {
    const [silent, clientSide] = createLinkedTransports();
    let hostSawClose = false;
    silent.onClose(() => {
      hostSawClose = true;
    });
    const client = new SimClient(clientSide);
    const pending = client.undo();
    client.close();
    await expect(pending).rejects.toBeInstanceOf(ProtocolError);
    expect(hostSawClose).toBe(true);
    client.close(); // closing twice is harmless
  });

  it("rejects the request an error names, and only that one", async () => {
    const [server, clientSide] = createLinkedTransports();
    const sent: unknown[] = [];
    server.onMessage((frame) => sent.push(JSON.parse(frame as string)));
    const client = new SimClient(clientSide);
    const first = client.command("a", {});
    const second = client.command("b", {});
    server.send(JSON.stringify({ t: "error", id: 1, message: "Nope" }));
    server.send(JSON.stringify({ t: "result", id: 2, result: { ok: true, id: 9, cost: 0 } }));
    await expect(first).rejects.toThrow(new ProtocolError("Nope"));
    await expect(second).resolves.toEqual({ ok: true, id: 9, cost: 0 });
    expect(sent).toMatchObject([{ id: 1 }, { id: 2 }]);
  });

  it("ignores a result for an id nobody is waiting on", async () => {
    const [server, clientSide] = createLinkedTransports();
    const client = new SimClient(clientSide);
    const pending = client.undo();
    server.send(JSON.stringify({ t: "result", id: 99, result: { ok: true, id: 1, cost: 0 } }));
    server.send(JSON.stringify({ t: "error", id: 98, message: "stray" }));
    server.send(JSON.stringify({ t: "error", message: "not about a request" }));
    server.send(
      JSON.stringify({ t: "result", id: 1, result: { ok: false, error: "Nothing to undo" } }),
    );
    await expect(pending).resolves.toEqual({ ok: false, error: "Nothing to undo" });
  });

  it("numbers requests from 1 and does not reuse an id", async () => {
    const [server, clientSide] = createLinkedTransports();
    const ids: number[] = [];
    server.onMessage((frame: Frame) => {
      const id = (JSON.parse(frame as string) as { id: number }).id;
      ids.push(id);
      server.send(JSON.stringify({ t: "result", id, result: { ok: true } }));
    });
    const client = new SimClient(clientSide);
    await client.setSpeed(2);
    await client.requestSnapshot();
    await client.setSpeed(1);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("surfaces a malformed frame from the host as a ProtocolError", () => {
    // A linked pair reports a failing receiver off to the side, so reach the client's handler
    // through a transport that hands it frames directly.
    let deliver: ((frame: Frame) => void) | undefined;
    new SimClient({
      send: () => {},
      onMessage: (handler) => {
        deliver = handler;
      },
      onClose: () => {},
      close: () => {},
    });
    expect(() => deliver?.("{")).toThrow(ProtocolError);
    expect(() => deliver?.(Uint8Array.from([1, 2, 3]))).toThrow(ProtocolError);
  });

  it("onError receives errors that answer no request, and only those", async () => {
    const [server, clientSide] = createLinkedTransports();
    const client = new SimClient(clientSide);
    const messages: string[] = [];
    const stop = client.onError((message) => messages.push(message));
    const pending = client.undo();

    server.send(JSON.stringify({ t: "error", message: "Simulation halted: boom" }));
    server.send(JSON.stringify({ t: "error", id: 1, message: "Nope" }));
    await expect(pending).rejects.toThrow("Nope");
    expect(messages).toEqual(["Simulation halted: boom"]);

    stop();
    server.send(JSON.stringify({ t: "error", message: "unheard" }));
    expect(messages).toEqual(["Simulation halted: boom"]);
  });

  it("onError also hears the error that refuses a hello", async () => {
    const [server, clientSide] = createLinkedTransports();
    server.onMessage(() => {
      server.send(JSON.stringify({ t: "error", message: "Unsupported protocol version" }));
    });
    const client = new SimClient(clientSide);
    const messages: string[] = [];
    client.onError((message) => messages.push(message));
    await expect(client.connect()).rejects.toThrow("Unsupported protocol version");
    expect(messages).toEqual(["Unsupported protocol version"]);
  });

  it("onError hears that a failing sim halted, once", async () => {
    const { sim, clock, host, client } = setup();
    await client.connect();
    const messages: string[] = [];
    client.onError((message) => messages.push(message));
    sim.systems.push({
      name: "boom",
      tick: () => {
        throw new Error("boom");
      },
    });
    host.start();
    clock.advance(25);
    clock.fire();
    clock.advance(25);
    clock.fire();
    expect(messages).toEqual(["Simulation halted: boom"]);
  });

  it("connect() to a halted host resolves with halted, and onError and onSnapshot hear why", async () => {
    const { sim, clock, host, client } = setup();
    sim.systems.push({
      name: "boom",
      tick: () => {
        throw new Error("boom");
      },
    });
    host.start();
    clock.advance(25);
    clock.fire();

    const messages: string[] = [];
    const snapshots: DecodedSnapshot[] = [];
    client.onError((message) => messages.push(message));
    client.onSnapshot((snapshot) => snapshots.push(snapshot));
    const welcome = await client.connect();

    expect(welcome.halted).toBe(true);
    expect(messages).toEqual(["Simulation halted: boom"]);
    expect(snapshots.map((snapshot) => snapshot.header.halted)).toEqual([true]);
  });

  it("setSpeed() resumes a halted host, and the next snapshot says halted is over", async () => {
    const { sim, clock, host, client } = setup();
    await client.connect();
    sim.systems.push({
      name: "boom",
      tick: () => {
        throw new Error("boom");
      },
    });
    host.start();
    clock.advance(25);
    clock.fire();
    sim.systems.pop();
    const flags: boolean[] = [];
    client.onSnapshot((snapshot) => flags.push(snapshot.header.halted));

    await client.setSpeed(1);

    expect(flags).toEqual([false]);
    expect(host.halted).toBe(false);
    expect(clock.active()).toEqual([25]);
  });

  describe("onClose", () => {
    it("fires once, with the reason the transport gives", () => {
      const closers: Array<(reason?: string) => void> = [];
      const client = new SimClient({
        send: () => {},
        onMessage: () => {},
        onClose: (handler) => closers.push(handler),
        close: () => {},
      });
      const reasons: string[] = [];
      client.onClose((reason) => reasons.push(reason));

      closers[0]?.("WebSocket closed (code 1006)");
      closers[0]?.("again");

      expect(reasons).toEqual(["WebSocket closed (code 1006)"]);
    });

    it("says Connection closed when the transport gives no reason", async () => {
      const { client, hostSide } = setup();
      await client.connect();
      const reasons: string[] = [];
      client.onClose((reason) => reasons.push(reason));
      hostSide.close();
      expect(reasons).toEqual(["Connection closed"]);
    });

    it("fires once for close() too, and not again when the transport then reports its close", async () => {
      const { client } = setup();
      await client.connect();
      const reasons: string[] = [];
      client.onClose((reason) => reasons.push(reason));
      client.close();
      client.close();
      expect(reasons).toEqual(["Connection closed"]);
    });

    it("stops calling a handler that was removed, and one that throws does not stop the others", async () => {
      const { client, hostSide } = setup();
      await client.connect();
      const heard: string[] = [];
      const stop = client.onClose(() => heard.push("removed"));
      client.onClose(() => {
        throw new Error("handler failed");
      });
      client.onClose((reason) => heard.push(reason));
      stop();
      hostSide.close();
      expect(heard).toEqual(["Connection closed"]);
    });

    it("calls a handler added after the connection ended, at once, with the reason", () => {
      const closers: Array<(reason?: string) => void> = [];
      const client = new SimClient({
        send: () => {},
        onMessage: () => {},
        onClose: (handler) => closers.push(handler),
        close: () => {},
      });
      closers[0]?.("the host went away");
      const reasons: string[] = [];
      client.onClose((reason) => reasons.push(reason));
      expect(reasons).toEqual(["the host went away"]);
    });
  });

  it("a handler that throws does not keep the next one from running", async () => {
    const [server, clientSide] = createLinkedTransports();
    const client = new SimClient(clientSide);
    const heard: string[] = [];
    const failing = () => {
      throw new Error("handler failed");
    };

    client.onEvent(failing);
    client.onEvent((event) => heard.push(`event ${event.entry.id}`));
    client.onError(failing);
    client.onError((message) => heard.push(`error ${message}`));
    client.onSnapshot(failing);
    client.onSnapshot((snapshot) => heard.push(`snapshot ${snapshot.header.tick}`));

    const entry = { id: 3, tick: 0, client: "agent", name: "x", input: {}, cost: 0 };
    server.send(JSON.stringify({ t: "event", kind: "log", entry }));
    server.send(JSON.stringify({ t: "error", message: "oops" }));
    server.send(
      encodeSnapshot({
        tick: 7,
        speed: 1,
        halted: false,
        cash: 0,
        loan: 0,
        monthStartCash: 0,
        date: "March 1, Year 1",
        terrainVersion: 0,
        hasTerrain: false,
        width: 1,
        height: 1,
      }),
    );
    expect(heard).toEqual(["event 3", "error oops", "snapshot 7"]);
  });
});
