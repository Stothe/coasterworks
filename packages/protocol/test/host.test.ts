import { createWorld } from "@coasterworks/sim";
import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  SimHostServer,
  createLinkedTransports,
  type Frame,
  type MessageTransport,
  type SimHostOptions,
  type Speed,
} from "../src/index.js";
import { RAISE, connectPeer, fakeTimers, makeSim, type Peer } from "./helpers.js";

function setup(opts: SimHostOptions = {}) {
  const sim = makeSim();
  const clock = fakeTimers();
  const host = new SimHostServer(sim, { timers: clock, ...opts });
  return { sim, clock, host };
}

/** A peer that has said hello, with the welcome and first snapshot cleared away. */
function joined(host: SimHostServer): Peer {
  const peer = connectPeer(host);
  peer.hello();
  peer.clear();
  return peer;
}

describe("handshake", () => {
  it("answers hello with welcome, then a full snapshot", () => {
    const { sim, host } = setup();
    const peer = connectPeer(host);
    peer.hello();
    expect(peer.kinds()).toEqual(["welcome", "snapshot"]);
    expect(peer.messages("welcome")[0]).toEqual({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      width: 8,
      height: 8,
      name: "Test Park",
      speed: 1,
    });
    const snapshot = peer.lastSnapshot();
    expect(snapshot.header).toMatchObject({
      tick: 0,
      speed: 1,
      date: "March 1, Year 1",
      cash: sim.world.finance.cash,
      loan: sim.world.finance.loan,
      hasTerrain: true,
      width: 8,
      height: 8,
    });
    expect(snapshot.terrain?.corners).toEqual(sim.world.terrain.corners);
    expect(snapshot.terrain?.surface).toEqual(sim.world.terrain.surface);
    expect(snapshot.terrain?.water).toEqual(sim.world.terrain.water);
  });

  it("refuses another protocol version, then closes that transport", () => {
    const { host } = setup();
    const peer = connectPeer(host);
    peer.send({ t: "hello", protocol: 2 });
    expect(peer.messages("error")).toEqual([
      { t: "error", message: "Unsupported protocol version" },
    ]);
    expect(peer.kinds()).toEqual(["error"]);
    expect(peer.closed).toBe(true);
  });

  it("does not serve other clients differently after one is refused", () => {
    const { host } = setup();
    const bad = connectPeer(host);
    const good = connectPeer(host);
    bad.send({ t: "hello", protocol: 99 });
    good.hello();
    expect(good.kinds()).toEqual(["welcome", "snapshot"]);
    expect(good.closed).toBe(false);
  });

  it("answers anything before hello with Expected hello, echoing the id", () => {
    const { host } = setup();
    const peer = connectPeer(host);
    peer.send({ t: "command", id: 4, name: "terrain_raise", input: RAISE });
    peer.send({ t: "snapshot", id: 5 });
    expect(peer.messages("error")).toEqual([
      { t: "error", id: 4, message: "Expected hello" },
      { t: "error", id: 5, message: "Expected hello" },
    ]);
    expect(peer.closed).toBe(false);
    peer.hello();
    expect(peer.kinds()).toEqual(["error", "error", "welcome", "snapshot"]);
  });

  it("does not run a command sent before hello", () => {
    const { sim, host } = setup();
    const peer = connectPeer(host);
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    expect(sim.world.log).toHaveLength(0);
  });

  it("sends nothing but errors to a client that has not said hello, even when others mutate", () => {
    const { host } = setup();
    const waiting = connectPeer(host);
    const active = joined(host);
    active.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    expect(waiting.received).toEqual([]);
  });

  it("rejects a second hello", () => {
    const { host } = setup();
    const peer = joined(host);
    peer.hello();
    expect(peer.messages("error")).toEqual([{ t: "error", message: "Already said hello" }]);
    expect(peer.closed).toBe(false);
  });

  it("rejects a binary frame from a client", () => {
    const { host } = setup();
    const peer = joined(host);
    peer.sendRaw(Uint8Array.from([1, 2, 3]));
    expect(peer.messages("error")).toHaveLength(1);
  });
});

describe("requests", () => {
  it("answers a command with the result, then the log event, then a snapshot with terrain", () => {
    const { sim, host } = setup();
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    expect(peer.kinds()).toEqual(["result", "event", "snapshot"]);

    const result = peer.messages("result")[0];
    expect(result).toMatchObject({ id: 1, result: { ok: true } });
    const entry = sim.world.log[0]!;
    expect(sim.world.log).toHaveLength(1);
    expect(entry.client).toBe("player");
    expect(entry.undo).toBeDefined();

    const event = peer.messages("event")[0]!;
    expect(event.kind).toBe("log");
    expect(event.entry).toEqual({
      id: entry.id,
      tick: 0,
      client: "player",
      name: "terrain_raise",
      input: entry.input,
      cost: entry.cost,
    });

    const snapshot = peer.lastSnapshot();
    expect(snapshot.header.hasTerrain).toBe(true);
    expect(snapshot.header.terrainVersion).toBe(1);
    expect(snapshot.header.cash).toBe(sim.world.finance.cash);
    expect(snapshot.terrain?.corners).toEqual(sim.world.terrain.corners);
  });

  it("does not put the undo data on the wire", () => {
    const { host } = setup();
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    const eventFrame = peer.frames.find(
      (frame) => typeof frame === "string" && frame.includes('"event"'),
    );
    expect(JSON.parse(eventFrame as string).entry).not.toHaveProperty("undo");
  });

  it("answers a failed command with the error and sends nothing else", () => {
    const { sim, host } = setup();
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "no_such_command", input: {} });
    peer.send({ t: "command", id: 2, name: "terrain_raise", input: { x: 99, y: 0, w: 1, h: 1 } });
    expect(peer.messages("result")).toEqual([
      { t: "result", id: 1, result: { ok: false, error: "Unknown command: no_such_command" } },
      { t: "result", id: 2, result: { ok: false, error: expect.any(String) } },
    ]);
    expect(peer.kinds()).toEqual(["result", "result"]);
    expect(sim.world.log).toHaveLength(0);
  });

  it("runs commands as the player", () => {
    const { sim, host } = setup();
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "finance_take_loan", input: { amount: 100_000 } });
    expect(sim.world.log.at(-1)?.client).toBe("player");
  });

  it("answers a query without telling anyone else", () => {
    const { sim, host } = setup();
    const asker = joined(host);
    const other = joined(host);
    asker.send({ t: "query", id: 3, name: "park_status", input: {} });
    expect(asker.kinds()).toEqual(["result"]);
    expect(asker.messages("result")[0]).toEqual({
      t: "result",
      id: 3,
      result: sim.query("park_status", {}),
    });
    expect(sim.query("park_status", {})).toMatchObject({ ok: true, result: { name: "Test Park" } });
    expect(other.received).toEqual([]);
  });

  it("answers a failed query with the error", () => {
    const { host } = setup();
    const peer = joined(host);
    peer.send({ t: "query", id: 3, name: "nope", input: {} });
    expect(peer.messages("result")[0]?.result).toEqual({ ok: false, error: "Unknown query: nope" });
  });

  it("answers a speed message with an ack, then a snapshot without terrain", () => {
    const { host } = setup();
    const peer = joined(host);
    peer.send({ t: "speed", id: 1, speed: 4 });
    expect(peer.kinds()).toEqual(["result", "snapshot"]);
    expect(peer.messages("result")[0]).toEqual({ t: "result", id: 1, result: { ok: true } });
    expect(peer.lastSnapshot().header).toMatchObject({ speed: 4, hasTerrain: false });
    expect(peer.lastSnapshot()).not.toHaveProperty("terrain");
    expect(host.speed).toBe(4);
  });

  it("sends a snapshot without terrain after a speed message that follows a raise", () => {
    const { host } = setup();
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    peer.clear();
    peer.send({ t: "speed", id: 2, speed: 2 });
    expect(peer.lastSnapshot().header.hasTerrain).toBe(false);
  });

  it("tells every client about a speed change", () => {
    const { host } = setup();
    const a = joined(host);
    const b = joined(host);
    a.send({ t: "speed", id: 1, speed: 8 });
    expect(b.kinds()).toEqual(["snapshot"]);
    expect(b.lastSnapshot().header.speed).toBe(8);
  });

  it("sends the full snapshot first, then the ack, when asked for a snapshot", () => {
    const { sim, host } = setup();
    const peer = joined(host);
    const other = joined(host);
    peer.send({ t: "snapshot", id: 9 });
    expect(peer.kinds()).toEqual(["snapshot", "result"]);
    expect(peer.lastSnapshot().header.hasTerrain).toBe(true);
    expect(peer.lastSnapshot().terrain?.corners).toEqual(sim.world.terrain.corners);
    expect(peer.messages("result")[0]).toEqual({ t: "result", id: 9, result: { ok: true } });
    expect(other.received).toEqual([]);
  });

  it("undoes and redoes, with the log event and terrain each time", () => {
    const { sim, host } = setup();
    const peer = joined(host);
    const flat = sim.world.terrain.corners.slice();
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    const raised = sim.world.terrain.corners.slice();
    peer.clear();

    peer.send({ t: "undo", id: 2 });
    expect(peer.kinds()).toEqual(["result", "event", "snapshot"]);
    expect(peer.messages("event")[0]?.entry).toMatchObject({ name: "undo", client: "player" });
    expect(peer.lastSnapshot().header.hasTerrain).toBe(true);
    expect(peer.lastSnapshot().terrain?.corners).toEqual(flat);
    peer.clear();

    peer.send({ t: "redo", id: 3 });
    expect(peer.kinds()).toEqual(["result", "event", "snapshot"]);
    expect(peer.messages("event")[0]?.entry).toMatchObject({ name: "redo" });
    expect(peer.lastSnapshot().terrain?.corners).toEqual(raised);
  });

  it("answers an undo with nothing to undo with the error and no broadcast", () => {
    const { host } = setup();
    const peer = joined(host);
    const other = joined(host);
    peer.send({ t: "undo", id: 1 });
    peer.send({ t: "redo", id: 2 });
    expect(peer.messages("result")).toEqual([
      { t: "result", id: 1, result: { ok: false, error: "Nothing to undo" } },
      { t: "result", id: 2, result: { ok: false, error: "Nothing to redo" } },
    ]);
    expect(peer.kinds()).toEqual(["result", "result"]);
    expect(other.received).toEqual([]);
  });
});

describe("several clients", () => {
  it("sends every client the event and a snapshot with terrain when one raises terrain", () => {
    const { sim, host } = setup();
    const a = joined(host);
    const b = joined(host);
    a.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });

    expect(a.kinds()).toEqual(["result", "event", "snapshot"]);
    expect(b.kinds()).toEqual(["event", "snapshot"]);
    for (const peer of [a, b]) {
      const snapshot = peer.lastSnapshot();
      expect(snapshot.header.hasTerrain).toBe(true);
      expect(snapshot.header.terrainVersion).toBe(1);
      expect(snapshot.terrain?.corners).toEqual(sim.world.terrain.corners);
    }
    expect(b.messages("event")[0]?.entry.name).toBe("terrain_raise");
  });

  it("sends a client that joined late the current terrain and no old events", () => {
    const { sim, host } = setup();
    const early = joined(host);
    early.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    const late = connectPeer(host);
    late.hello();
    expect(late.kinds()).toEqual(["welcome", "snapshot"]);
    expect(late.lastSnapshot().terrain?.corners).toEqual(sim.world.terrain.corners);
    expect(late.lastSnapshot().header.terrainVersion).toBe(1);
  });

  it("does not resend terrain to a client that already holds the version", () => {
    const { clock, host } = setup();
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    peer.clear();
    clock.advance(50);
    host.tick();
    expect(peer.kinds()).toEqual(["snapshot"]);
    expect(peer.lastSnapshot().header).toMatchObject({ hasTerrain: false, terrainVersion: 1 });
  });

  it("stops sending to a client after detach and ignores what it sends", () => {
    const { sim, host } = setup();
    const a = joined(host);
    const b = joined(host);
    host.detach(b.hostTransport);
    a.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    expect(b.received).toEqual([]);
    b.send({ t: "command", id: 1, name: "finance_take_loan", input: { amount: 100_000 } });
    expect(sim.world.log).toHaveLength(1);
    expect(b.received).toEqual([]);
  });

  it("ignores detach of a transport it never attached", () => {
    const { host } = setup();
    const peer = joined(host);
    const [stranger] = createLinkedTransports();
    expect(() => host.detach(stranger)).not.toThrow();
    host.notifyExternalMutation();
    expect(peer.kinds()).toEqual(["snapshot"]);
  });

  it("stops serving a transport that closes", () => {
    const { host } = setup();
    const a = joined(host);
    const b = joined(host);
    b.transport.close();
    expect(() =>
      a.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE }),
    ).not.toThrow();
    expect(a.kinds()).toEqual(["result", "event", "snapshot"]);
  });

  it("serves a transport attached twice once", () => {
    const { host } = setup();
    const [hostSide, peerSide] = createLinkedTransports();
    host.attach(hostSide);
    host.attach(hostSide);
    const frames: Frame[] = [];
    peerSide.onMessage((frame) => frames.push(frame));
    peerSide.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));
    expect(frames).toHaveLength(2); // one welcome and one snapshot, not two of each
  });

  it("drops a transport whose send throws, and still serves the rest", () => {
    const { host } = setup();
    let handler: ((frame: Frame) => void) | undefined;
    let broken = false;
    const sent: Frame[] = [];
    const flaky: MessageTransport = {
      send(frame) {
        if (broken) throw new Error("socket is gone");
        sent.push(frame);
      },
      onMessage: (h) => {
        handler = h;
      },
      onClose: () => {},
      close: () => {},
    };
    host.attach(flaky);
    handler?.(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));
    const sentBeforeBreak = sent.length;
    broken = true;
    const healthy = joined(host);
    expect(() => host.notifyExternalMutation()).not.toThrow();
    expect(healthy.kinds()).toEqual(["snapshot"]);
    broken = false;
    host.notifyExternalMutation();
    expect(sent).toHaveLength(sentBeforeBreak);
  });
});

describe("bad input", () => {
  it("answers a malformed frame with an error and keeps serving", () => {
    const { clock, sim, host } = setup();
    const peer = joined(host);
    peer.sendRaw("{");
    expect(peer.messages("error")).toEqual([{ t: "error", message: "Message is not valid JSON" }]);
    expect(peer.closed).toBe(false);

    // The same client still works, and so does the loop.
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    expect(peer.messages("result")).toHaveLength(1);
    clock.advance(25);
    host.tick();
    expect(sim.world.tick).toBe(1);
  });

  it("carries the id of a bad request in the error", () => {
    const { host } = setup();
    const peer = joined(host);
    peer.sendRaw('{"t":"command","id":7}');
    peer.sendRaw('{"t":"dance","id":8}');
    peer.sendRaw('{"t":"command","name":"x"}');
    expect(peer.messages("error")).toEqual([
      { t: "error", id: 7, message: "Invalid command message at name" },
      { t: "error", id: 8, message: "Unknown message type: dance" },
      { t: "error", message: "Invalid command message at id" },
    ]);
  });

  it("answers a request that throws with an error carrying its id, and keeps serving", () => {
    const { sim, host } = setup();
    const peer = joined(host);
    const other = joined(host);
    vi.spyOn(sim, "execute").mockImplementationOnce(() => {
      throw new Error("a command blew up");
    });
    peer.send({ t: "command", id: 5, name: "terrain_raise", input: RAISE });
    expect(peer.messages("error")).toEqual([{ t: "error", id: 5, message: "a command blew up" }]);
    expect(other.received).toEqual([]);
    peer.send({ t: "command", id: 6, name: "terrain_raise", input: RAISE });
    expect(peer.messages("result")).toHaveLength(1);
  });

  it("answers a query whose result cannot be sent with an error", () => {
    const { sim, host } = setup();
    const peer = joined(host);
    vi.spyOn(sim, "query").mockReturnValueOnce({ ok: true, result: 10n });
    peer.send({ t: "query", id: 2, name: "park_status", input: {} });
    expect(peer.messages("error")).toHaveLength(1);
    expect(peer.messages("error")[0]).toMatchObject({ id: 2 });
  });
});

describe("scheduler", () => {
  it("runs one tick for 25 ms at speed 1", () => {
    const { sim, clock, host } = setup();
    clock.advance(25);
    host.tick();
    expect(sim.world.tick).toBe(1);
  });

  it("runs nothing until a whole tick is due, and carries the remainder", () => {
    const { sim, clock, host } = setup();
    clock.advance(10);
    host.tick();
    expect(sim.world.tick).toBe(0);
    clock.advance(15);
    host.tick();
    expect(sim.world.tick).toBe(1);
    clock.advance(30); // 5 ms past the next tick
    host.tick();
    expect(sim.world.tick).toBe(2);
    clock.advance(20); // the 5 ms owed makes this a whole tick
    host.tick();
    expect(sim.world.tick).toBe(3);
  });

  it("runs more ticks per call at higher speeds", () => {
    for (const [speed, ticks] of [
      [1, 1],
      [2, 2],
      [4, 4],
      [8, 8],
    ] as const) {
      const { sim, clock, host } = setup();
      host.setSpeed(speed);
      clock.advance(25);
      host.tick();
      expect(sim.world.tick).toBe(ticks);
    }
  });

  it("runs at most maxTicksPerFrame and drops the backlog after a long stall", () => {
    const { sim, clock, host } = setup();
    clock.advance(10_000);
    host.tick();
    expect(sim.world.tick).toBe(40);
    // The 10 s are not owed: the next 25 ms is one tick, not a burst.
    clock.advance(25);
    host.tick();
    expect(sim.world.tick).toBe(41);
  });

  it("honours a smaller maxTicksPerFrame", () => {
    const { sim, clock, host } = setup({ maxTicksPerFrame: 5 });
    clock.advance(10_000);
    host.tick();
    expect(sim.world.tick).toBe(5);
  });

  it("keeps what a capped frame left owed when the stall was short", () => {
    const { sim, clock, host } = setup();
    host.setSpeed(8);
    clock.advance(200); // 64 ticks due; 40 run
    host.tick();
    expect(sim.world.tick).toBe(40);
    host.tick(); // the 24 left over are still owed
    expect(sim.world.tick).toBe(64);
  });

  it("runs nothing while paused and does not burst when resumed", () => {
    const { sim, clock, host } = setup();
    host.setSpeed(0);
    clock.advance(5_000);
    host.tick();
    expect(sim.world.tick).toBe(0);
    host.setSpeed(1);
    host.tick();
    expect(sim.world.tick).toBe(0);
    clock.advance(25);
    host.tick();
    expect(sim.world.tick).toBe(1);
  });

  it("does not burst when resumed by a client, even if the pause was never ticked through", () => {
    const { sim, clock, host } = setup();
    const peer = joined(host);
    peer.send({ t: "speed", id: 1, speed: 0 });
    clock.advance(5_000);
    peer.send({ t: "speed", id: 2, speed: 1 });
    host.tick();
    expect(sim.world.tick).toBe(0);
  });

  it("starts counting from when it was created, and again from start()", () => {
    const clock = fakeTimers();
    clock.advance(1_000);
    const sim = makeSim();
    const host = new SimHostServer(sim, { timers: clock });
    clock.advance(25);
    host.tick();
    expect(sim.world.tick).toBe(1);

    clock.advance(1_000); // idle, not started
    host.start();
    clock.advance(25);
    clock.fire();
    expect(sim.world.tick).toBe(2);
  });

  it("re-anchors when the clock goes backwards", () => {
    const { sim, clock, host } = setup();
    clock.advance(1_000);
    host.tick();
    expect(sim.world.tick).toBe(40);
    clock.advance(-5_000);
    host.tick();
    expect(sim.world.tick).toBe(40);
    clock.advance(25);
    host.tick();
    expect(sim.world.tick).toBe(41);
  });

  it("rejects speeds it does not know", () => {
    const { host } = setup();
    expect(() => host.setSpeed(3 as Speed)).toThrow(RangeError);
    expect(host.speed).toBe(1);
  });

  it("rejects options that cannot work", () => {
    const sim = makeSim();
    expect(() => new SimHostServer(sim, { maxTicksPerFrame: 0 })).toThrow(RangeError);
    expect(() => new SimHostServer(sim, { maxTicksPerFrame: 1.5 })).toThrow(RangeError);
    expect(() => new SimHostServer(sim, { snapshotIntervalMs: 0 })).toThrow(RangeError);
  });
});

describe("periodic snapshots", () => {
  it("sends a snapshot without terrain every snapshotIntervalMs", () => {
    const { sim, clock, host } = setup();
    const peer = joined(host);
    clock.advance(25);
    host.tick();
    expect(peer.received).toEqual([]);
    clock.advance(25);
    host.tick();
    expect(peer.kinds()).toEqual(["snapshot"]);
    expect(peer.lastSnapshot().header).toMatchObject({ tick: sim.world.tick, hasTerrain: false });
    expect(sim.world.tick).toBe(2);

    clock.advance(25);
    host.tick();
    expect(peer.kinds()).toEqual(["snapshot"]);
    clock.advance(25);
    host.tick();
    expect(peer.kinds()).toEqual(["snapshot", "snapshot"]);
  });

  it("honours a different snapshotIntervalMs", () => {
    const { clock, host } = setup({ snapshotIntervalMs: 100 });
    const peer = joined(host);
    clock.advance(75);
    host.tick();
    expect(peer.received).toEqual([]);
    clock.advance(25);
    host.tick();
    expect(peer.kinds()).toEqual(["snapshot"]);
  });

  it("counts a snapshot sent for a command as the latest one", () => {
    const { clock, host } = setup();
    const peer = joined(host);
    clock.advance(40);
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    peer.clear();
    clock.advance(40);
    host.tick();
    expect(peer.received).toEqual([]);
  });

  it("still sends them while paused", () => {
    const { clock, host } = setup();
    host.setSpeed(0);
    const peer = joined(host);
    clock.advance(50);
    host.tick();
    expect(peer.kinds()).toEqual(["snapshot"]);
    expect(peer.lastSnapshot().header.speed).toBe(0);
  });

  it("shows the game date", () => {
    const { sim, clock, host } = setup();
    const peer = joined(host);
    sim.step(400 * 31 + 400 * 2); // into April 3
    clock.advance(50);
    host.tick();
    expect(peer.lastSnapshot().header.date).toBe("April 3, Year 1");
  });
});

describe("start and stop", () => {
  it("runs the scheduler from a timer and stops when asked", () => {
    const { sim, clock, host } = setup();
    host.start();
    expect(clock.active()).toEqual([25]);
    clock.advance(25);
    clock.fire();
    expect(sim.world.tick).toBe(1);

    host.stop();
    expect(clock.active()).toEqual([]);
    clock.advance(25);
    clock.fire();
    expect(sim.world.tick).toBe(1);
  });

  it("does nothing when started twice or stopped when not running", () => {
    const { clock, host } = setup();
    host.stop();
    host.start();
    host.start();
    expect(clock.started).toBe(1);
    host.stop();
    host.stop();
    expect(clock.active()).toEqual([]);
    host.start();
    expect(clock.started).toBe(2);
  });

  it("ticks at least as often as it sends snapshots", () => {
    const { clock, host } = setup({ snapshotIntervalMs: 10 });
    host.start();
    expect(clock.active()).toEqual([10]);
  });

  it("can have clients attached before it starts", () => {
    const { clock, host } = setup();
    const peer = connectPeer(host);
    peer.hello();
    host.start();
    clock.advance(50);
    clock.fire();
    expect(peer.kinds()).toEqual(["welcome", "snapshot", "snapshot"]);
  });

  it("needs timers to start or tick, and says so", () => {
    const host = new SimHostServer(makeSim());
    expect(() => host.start()).toThrow(/timers/);
    expect(() => host.tick()).toThrow(/timers/);
  });

  it("serves requests without timers", () => {
    const host = new SimHostServer(makeSim());
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    expect(peer.kinds()).toEqual(["result", "event", "snapshot"]);
    host.setSpeed(2);
    expect(host.speed).toBe(2);
  });
});

describe("changes made outside the protocol", () => {
  it("notifyExternalMutation after a direct execute tells every client, with terrain", () => {
    const { sim, host } = setup();
    const a = joined(host);
    const b = joined(host);
    const result = sim.execute("terrain_raise", RAISE, "agent");
    expect(result.ok).toBe(true);
    host.notifyExternalMutation();
    for (const peer of [a, b]) {
      expect(peer.kinds()).toEqual(["event", "snapshot"]);
      expect(peer.messages("event")[0]?.entry).toMatchObject({
        name: "terrain_raise",
        client: "agent",
      });
      expect(peer.lastSnapshot().header).toMatchObject({ hasTerrain: true, terrainVersion: 1 });
      expect(peer.lastSnapshot().terrain?.corners).toEqual(sim.world.terrain.corners);
    }
  });

  it("sends an event for each entry added since the last broadcast, in order", () => {
    const { sim, host } = setup();
    const peer = joined(host);
    sim.execute("terrain_raise", RAISE, "agent");
    sim.execute("finance_take_loan", { amount: 100_000 }, "agent");
    host.notifyExternalMutation();
    expect(peer.kinds()).toEqual(["event", "event", "snapshot"]);
    expect(peer.messages("event").map((event) => event.entry.name)).toEqual([
      "terrain_raise",
      "finance_take_loan",
    ]);
    peer.clear();
    host.notifyExternalMutation();
    expect(peer.kinds()).toEqual(["snapshot"]);
  });

  it("notices a direct execute on the next tick without being told", () => {
    const { sim, clock, host } = setup();
    const peer = joined(host);
    sim.execute("terrain_raise", RAISE, "agent");
    clock.advance(25);
    host.tick();
    expect(peer.kinds()).toEqual(["event", "snapshot"]);
    expect(peer.lastSnapshot().header.hasTerrain).toBe(true);
    expect(peer.lastSnapshot().terrain?.corners).toEqual(sim.world.terrain.corners);

    peer.clear();
    clock.advance(50);
    host.tick();
    expect(peer.kinds()).toEqual(["snapshot"]);
    expect(peer.lastSnapshot().header.hasTerrain).toBe(false);
  });

  it("does not announce the same change twice when told and then ticked", () => {
    const { sim, clock, host } = setup();
    const peer = joined(host);
    sim.execute("terrain_raise", RAISE, "agent");
    host.notifyExternalMutation();
    peer.clear();
    host.tick();
    expect(peer.received).toEqual([]);
    clock.advance(25);
    host.tick();
    expect(peer.received).toEqual([]);
  });

  it("does not announce a change a client made through the protocol again on the next tick", () => {
    const { clock, host } = setup();
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    peer.clear();
    clock.advance(25);
    host.tick();
    expect(peer.received).toEqual([]);
  });

  it("starts over when the sim is given a different world", () => {
    const { sim, clock, host } = setup();
    const peer = joined(host);
    sim.execute("terrain_raise", RAISE, "agent");
    host.notifyExternalMutation();
    peer.clear();

    sim.replaceWorld(createWorld({ width: 4, height: 6, seed: 2, name: "Other Park" }));
    clock.advance(25);
    host.tick();
    expect(peer.kinds()).toEqual(["snapshot"]);
    const snapshot = peer.lastSnapshot();
    expect(snapshot.header).toMatchObject({ width: 4, height: 6, hasTerrain: true });
    expect(snapshot.terrain?.corners).toHaveLength(5 * 7);

    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 }, "agent");
    peer.clear();
    host.notifyExternalMutation();
    expect(peer.messages("event")).toHaveLength(1);
  });
});

describe("onMutate", () => {
  it("is called with the world after each mutation, once clients have been told", () => {
    const seen: Array<{ tick: number; logLength: number; heard: string[] }> = [];
    const { sim, host } = setup({
      onMutate: (world) => {
        seen.push({ tick: world.tick, logLength: world.log.length, heard: peer.kinds() });
        expect(world).toBe(sim.world);
      },
    });
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "terrain_raise", input: RAISE });
    expect(seen).toEqual([{ tick: 0, logLength: 1, heard: ["result", "event", "snapshot"] }]);

    sim.execute("finance_take_loan", { amount: 100_000 }, "agent");
    host.notifyExternalMutation();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.logLength).toBe(2);
  });

  it("is not called for a failed command, a query, or a speed change", () => {
    const onMutate = vi.fn();
    const { host } = setup({ onMutate });
    const peer = joined(host);
    peer.send({ t: "command", id: 1, name: "nope", input: {} });
    peer.send({ t: "query", id: 2, name: "park_status", input: {} });
    peer.send({ t: "speed", id: 3, speed: 2 });
    peer.send({ t: "snapshot", id: 4 });
    expect(onMutate).not.toHaveBeenCalled();
  });
});
