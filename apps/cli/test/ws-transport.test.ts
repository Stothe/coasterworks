import { EventEmitter } from "node:events";
import type { Frame } from "@coasterworks/protocol";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { wsTransport } from "../src/ws-transport.js";

/** Just enough of a `ws` socket to drive the transport with frames of every shape. */
class FakeSocket extends EventEmitter {
  send = vi.fn();
  close = vi.fn();
}

function setup() {
  const socket = new FakeSocket();
  const transport = wsTransport(socket as unknown as WebSocket);
  const frames: Frame[] = [];
  transport.onMessage((frame) => frames.push(frame));
  return { socket, transport, frames };
}

describe("wsTransport", () => {
  it("delivers a text message as a string", () => {
    const { socket, frames } = setup();
    socket.emit("message", Buffer.from('{"t":"hello"} é'), false);
    expect(frames).toEqual(['{"t":"hello"} é']);
  });

  it("delivers a binary message as one Uint8Array copy, whatever shape ws hands over", () => {
    const { socket, frames } = setup();
    const buffer = Buffer.from([1, 2, 3, 4]);
    socket.emit("message", buffer, true);
    // A view into a larger pool, as Node's small Buffers are.
    socket.emit("message", Buffer.from([9, 8, 7, 6, 5]).subarray(1, 4), true);
    socket.emit("message", new Uint8Array([4, 5, 6]).buffer, true);
    socket.emit("message", [Buffer.from([1, 2]), Buffer.from([3]), Buffer.from([4, 5])], true);

    expect(frames.map((frame) => [...(frame as Uint8Array)])).toEqual([
      [1, 2, 3, 4],
      [8, 7, 6],
      [4, 5, 6],
      [1, 2, 3, 4, 5],
    ]);
    for (const frame of frames) {
      expect(frame).toBeInstanceOf(Uint8Array);
      expect(Buffer.isBuffer(frame)).toBe(false);
    }
    // A copy: the transport does not share memory with the socket's buffer.
    buffer[0] = 99;
    expect((frames[0] as Uint8Array)[0]).toBe(1);
  });

  it("joins the fragments of a text message", () => {
    const { socket, frames } = setup();
    socket.emit("message", [Buffer.from("ab"), Buffer.from("cd")], false);
    expect(frames).toEqual(["abcd"]);
  });

  it("sends a string as a text frame and a Uint8Array as a binary one", () => {
    const { socket, transport } = setup();
    transport.send('{"t":"welcome"}');
    transport.send(new Uint8Array([1, 2, 3]));
    expect(socket.send).toHaveBeenNthCalledWith(1, '{"t":"welcome"}');
    expect(socket.send).toHaveBeenNthCalledWith(2, new Uint8Array([1, 2, 3]), { binary: true });
  });

  it("reports a close, or an error, once", () => {
    for (const event of ["close", "error"]) {
      const { socket, transport } = setup();
      const onClose = vi.fn();
      transport.onClose(onClose);
      socket.emit(event, event === "error" ? new Error("reset") : 1006);
      socket.emit("close", 1006);
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });

  it("delivers nothing after close(), nor after the socket has closed", () => {
    const { socket, transport, frames } = setup();
    socket.emit("message", Buffer.from("before"), false);
    transport.close();
    // A message already in flight when the transport was closed.
    socket.emit("message", Buffer.from("late"), false);
    socket.emit("message", Buffer.from([1]), true);
    socket.emit("close", 1000);
    socket.emit("message", Buffer.from("later"), false);
    expect(frames).toEqual(["before"]);
  });

  it("still reports the close that close() asks for", () => {
    const { socket, transport } = setup();
    const onClose = vi.fn();
    transport.onClose(onClose);
    transport.close();
    expect(onClose).not.toHaveBeenCalled();
    socket.emit("close", 1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the socket, and leaves the error to the close handler", () => {
    const { socket, transport } = setup();
    transport.close();
    expect(socket.close).toHaveBeenCalledTimes(1);
    // An error with no listener on an EventEmitter would throw; the transport listens.
    expect(() => socket.emit("error", new Error("reset"))).not.toThrow();
  });
});

describe("wsTransport over a real socket", () => {
  it("round-trips text and binary frames in both directions", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    try {
      await new Promise((resolve) => server.once("listening", resolve));
      const port = (server.address() as { port: number }).port;
      const accepted = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      const seen: Array<{ data: unknown; isBinary: boolean }> = [];
      client.on("message", (data, isBinary) => seen.push({ data, isBinary }));
      const peer = wsTransport(await accepted);
      await new Promise((resolve) => client.once("open", resolve));

      const received: Frame[] = [];
      peer.onMessage((frame) => received.push(frame));
      const closed = new Promise<void>((resolve) => peer.onClose(() => resolve()));

      peer.send("text");
      peer.send(new Uint8Array([7, 8, 9]));
      client.send("hi");
      client.send(new Uint8Array([1, 2]));
      while (seen.length < 2 || received.length < 2) await new Promise((r) => setTimeout(r, 5));

      expect(seen.map((s) => s.isBinary)).toEqual([false, true]);
      expect(seen[0]?.data?.toString()).toBe("text");
      expect([...(seen[1]?.data as Buffer)]).toEqual([7, 8, 9]);
      expect(received[0]).toBe("hi");
      expect(received[1]).toBeInstanceOf(Uint8Array);
      expect([...(received[1] as Uint8Array)]).toEqual([1, 2]);

      client.close();
      await closed;
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
