import { PROTOCOL_VERSION } from "@coasterworks/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectHost } from "../src/host/connect";
import { WorkerTransport } from "../src/host/worker-transport";
import { WsTransport } from "../src/host/ws-transport";

type Listener = (event: never) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  binaryType: BinaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  /** Test helpers: what the network does. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }
  receive(data: string | ArrayBuffer): void {
    this.emit("message", { data });
  }
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }
  private emit(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly url: URL;
  readonly options: WorkerOptions | undefined;
  posted: Array<{ message: unknown; transfer: Transferable[] | undefined }> = [];
  terminated = false;
  private listeners = new Map<string, Listener[]>();

  constructor(url: URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Test helpers: what the worker does. */
  receive(data: unknown): void {
    this.emit("message", { data });
  }
  crash(message: string): void {
    this.emit("error", { message });
  }
  private emit(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWorker.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectHost", () => {
  it("opens a socket when the page was given ?ws=", async () => {
    const { client, mode } = await connectHost("?ws=ws://localhost:7777/socket");
    expect(mode).toBe("socket");
    expect(client).toBeDefined();
    expect(FakeWorker.instances).toHaveLength(0);
    const [socket] = FakeWebSocket.instances;
    expect(socket?.url).toBe("ws://localhost:7777/socket");
    expect(socket?.binaryType).toBe("arraybuffer");
  });

  it("appends the token to the socket URL", async () => {
    await connectHost("?ws=ws://localhost:7777&token=a%2Bb%3D");
    expect(FakeWebSocket.instances[0]?.url).toBe("ws://localhost:7777/?token=a%2Bb%3D");

    await connectHost("?ws=ws://localhost:7777/path?x=1&token=secret");
    expect(FakeWebSocket.instances[1]?.url).toBe("ws://localhost:7777/path?x=1&token=secret");
  });

  it("starts the sim worker as a module worker when there is no ?ws=", async () => {
    const { client, mode } = await connectHost("");
    expect(mode).toBe("worker");
    expect(client).toBeDefined();
    expect(FakeWebSocket.instances).toHaveLength(0);
    const [worker] = FakeWorker.instances;
    expect(worker?.url.pathname.endsWith("/sim-worker.ts")).toBe(true);
    expect(worker?.options).toEqual({ type: "module" });
  });

  it("ignores a token without a socket", async () => {
    const { mode } = await connectHost("?token=abc");
    expect(mode).toBe("worker");
  });

  it("reads the page's own query string by default", async () => {
    const { mode } = await connectHost();
    expect(mode).toBe("worker");
  });

  describe("when the desktop shell has injected window.__COASTERWORKS__", () => {
    const shell = {
      wsUrl: "ws://127.0.0.1:49152/ws",
      mcpUrl: "http://127.0.0.1:49152/mcp",
      token: "shell-token",
    };

    it("dials the shell's socket with its token, though the URL bar is clean", async () => {
      vi.stubGlobal("__COASTERWORKS__", shell);
      const { mode } = await connectHost("");
      expect(mode).toBe("socket");
      expect(FakeWorker.instances).toHaveLength(0);
      expect(FakeWebSocket.instances[0]?.url).toBe("ws://127.0.0.1:49152/ws?token=shell-token");
    });

    it("prefers the shell's socket and token over the query string", async () => {
      vi.stubGlobal("__COASTERWORKS__", shell);
      await connectHost("?ws=ws://localhost:7777/socket&token=from-the-query");
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(FakeWebSocket.instances[0]?.url).toBe("ws://127.0.0.1:49152/ws?token=shell-token");
    });

    it("reads window.__COASTERWORKS__ when the query is the page's own", async () => {
      vi.stubGlobal("__COASTERWORKS__", shell);
      const { mode } = await connectHost();
      expect(mode).toBe("socket");
    });

    it("falls back to the query string when the shell gave no socket", async () => {
      vi.stubGlobal("__COASTERWORKS__", { wsUrl: "", mcpUrl: "", token: "" });
      await connectHost("?ws=ws://localhost:7777/socket&token=q");
      expect(FakeWebSocket.instances[0]?.url).toBe("ws://localhost:7777/socket?token=q");
    });

    it("falls back to the worker when the shell gave nothing and the query has no socket", async () => {
      vi.stubGlobal("__COASTERWORKS__", {});
      const { mode } = await connectHost("");
      expect(mode).toBe("worker");
    });

    it("dials a shell socket that needs no token as it is", async () => {
      vi.stubGlobal("__COASTERWORKS__", { wsUrl: "ws://127.0.0.1:1/ws" });
      await connectHost("?token=ignored-with-the-shell");
      expect(FakeWebSocket.instances[0]?.url).toBe("ws://127.0.0.1:1/ws");
    });
  });

  it("gives back a client that speaks to the worker", async () => {
    const { client } = await connectHost("");
    const worker = FakeWorker.instances[0] as FakeWorker;
    const connecting = client.connect();
    expect(worker.posted).toHaveLength(1);
    expect(JSON.parse(worker.posted[0]?.message as string)).toEqual({
      t: "hello",
      protocol: PROTOCOL_VERSION,
    });
    worker.receive(
      JSON.stringify({
        t: "welcome",
        protocol: PROTOCOL_VERSION,
        width: 4,
        height: 4,
        name: "Test",
        speed: 1,
      }),
    );
    expect((await connecting).name).toBe("Test");
  });
});

describe("WsTransport", () => {
  function connected() {
    const socket = new FakeWebSocket("ws://x");
    const transport = new WsTransport(socket as unknown as WebSocket);
    return { socket, transport };
  }

  it("asks for binary frames as ArrayBuffers", () => {
    const { socket } = connected();
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("holds frames sent before the socket opens, then sends them in order", () => {
    const { socket, transport } = connected();
    transport.send("one");
    transport.send(new Uint8Array([2]));
    transport.send("three");
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual(["one", new Uint8Array([2]), "three"]);
    transport.send("four");
    expect(socket.sent.at(-1)).toBe("four");
  });

  it("sends text and binary frames straight through an open socket", () => {
    const { socket, transport } = connected();
    socket.open();
    const bytes = new Uint8Array([1, 2, 3]);
    transport.send("hello");
    transport.send(bytes);
    expect(socket.sent).toEqual(["hello", bytes]);
  });

  it("delivers text frames as strings and binary frames as Uint8Array", () => {
    const { socket, transport } = connected();
    const got: Array<string | Uint8Array> = [];
    transport.onMessage((frame) => got.push(frame));
    socket.open();
    socket.receive('{"t":"x"}');
    socket.receive(new Uint8Array([9, 8, 7]).buffer);
    expect(got[0]).toBe('{"t":"x"}');
    expect(got[1]).toBeInstanceOf(Uint8Array);
    expect([...(got[1] as Uint8Array)]).toEqual([9, 8, 7]);
  });

  it("reports the socket closing once, and closes the socket on request", () => {
    const { socket, transport } = connected();
    let closes = 0;
    transport.onClose(() => closes++);
    socket.open();
    socket.drop();
    expect(closes).toBe(1);

    const second = connected();
    let closed = 0;
    second.transport.onClose(() => closed++);
    second.transport.close();
    expect(second.socket.closed).toBe(true);
    expect(closed).toBe(1);
  });

  it("does not send into a socket that has closed", () => {
    const { socket, transport } = connected();
    socket.open();
    socket.drop();
    transport.send("late");
    expect(socket.sent).toEqual([]);
  });
});

describe("WorkerTransport", () => {
  function started() {
    const worker = new FakeWorker(new URL("file:///w.js"));
    const transport = new WorkerTransport(worker as unknown as Worker);
    return { worker, transport };
  }

  it("posts text frames as strings", () => {
    const { worker, transport } = started();
    transport.send("hello");
    expect(worker.posted).toEqual([{ message: "hello", transfer: undefined }]);
  });

  it("posts binary frames as a copy whose buffer is transferred, leaving the original usable", () => {
    const { worker, transport } = started();
    const frame = new Uint8Array([1, 2, 3, 4]);
    transport.send(frame);
    transport.send(frame);
    expect(worker.posted).toHaveLength(2);
    const [first, second] = worker.posted;
    const sent = first?.message as Uint8Array;
    expect([...sent]).toEqual([1, 2, 3, 4]);
    expect(sent).not.toBe(frame);
    expect(sent.buffer).not.toBe(frame.buffer);
    expect(first?.transfer).toEqual([sent.buffer]);
    expect(second?.message).not.toBe(sent);
    // The caller's frame is untouched: its buffer was not detached.
    expect(frame.byteLength).toBe(4);
  });

  it("sends only a frame's own bytes when it is a view into a larger buffer", () => {
    const { worker, transport } = started();
    const big = new Uint8Array(1000).fill(5);
    transport.send(big.subarray(10, 14));
    const sent = worker.posted[0]?.message as Uint8Array;
    expect(sent.byteLength).toBe(4);
    expect(sent.buffer.byteLength).toBe(4);
  });

  it("delivers text frames as strings and binary frames as Uint8Array", () => {
    const { worker, transport } = started();
    const got: Array<string | Uint8Array> = [];
    transport.onMessage((frame) => got.push(frame));
    worker.receive("text");
    worker.receive(new Uint8Array([4, 5]));
    worker.receive(new Uint8Array([6, 7]).buffer);
    expect(got[0]).toBe("text");
    expect(got[1]).toBeInstanceOf(Uint8Array);
    expect([...(got[1] as Uint8Array)]).toEqual([4, 5]);
    expect(got[2]).toBeInstanceOf(Uint8Array);
    expect([...(got[2] as Uint8Array)]).toEqual([6, 7]);
  });

  it("ignores messages that are neither text nor bytes", () => {
    const { worker, transport } = started();
    const got: unknown[] = [];
    transport.onMessage((frame) => got.push(frame));
    worker.receive({ some: "object" });
    worker.receive(42);
    expect(got).toEqual([]);
  });

  it("terminates the worker on close and reports the close once", () => {
    const { worker, transport } = started();
    let closes = 0;
    transport.onClose(() => closes++);
    transport.close();
    transport.close();
    expect(worker.terminated).toBe(true);
    expect(closes).toBe(1);
  });

  it("reports a worker that crashes as closed", () => {
    const { worker, transport } = started();
    let closes = 0;
    transport.onClose(() => closes++);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    worker.crash("module failed to load");
    expect(closes).toBe(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
