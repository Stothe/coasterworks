import type { ExecResult } from "@coasterworks/sim";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  parseHostMessage,
  type ClientMessage,
  type EventMessage,
  type QueryResult,
  type ResultPayload,
  type Speed,
  type WelcomeMessage,
} from "./messages.js";
import { decodeSnapshot, type DecodedSnapshot } from "./snapshot.js";
import type { Frame, MessageTransport } from "./transport.js";

interface Pending<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

const closedError = () => new ProtocolError("Connection closed");

/** Calls every handler with `value`. One that throws must not keep the rest from hearing it. */
function notify<T>(handlers: Set<(value: T) => void>, value: T): void {
  for (const handler of [...handlers]) {
    try {
      handler(value);
    } catch {
      // The handler's failure is its own business.
    }
  }
}

/** Adds `handler` to `handlers` and returns the function that removes that registration. */
function subscribe<T>(handlers: Set<(value: T) => void>, handler: (value: T) => void) {
  // A fresh function per call, so registering one handler twice gives two independent removals.
  const entry = (value: T) => handler(value);
  handlers.add(entry);
  return () => {
    handlers.delete(entry);
  };
}

/**
 * The client end of the protocol: turns the messages on a transport into promises and callbacks.
 * The renderer holds one, whether the host is a worker next door or a server across the network.
 */
export class SimClient {
  private readonly transport: MessageTransport;
  private readonly pending = new Map<number, Pending<ResultPayload>>();
  private readonly snapshotHandlers = new Set<(snapshot: DecodedSnapshot) => void>();
  private readonly eventHandlers = new Set<(event: EventMessage) => void>();
  private readonly errorHandlers = new Set<(message: string) => void>();
  private nextId = 1;
  private connecting: Promise<WelcomeMessage> | undefined;
  private helloPending: Pending<WelcomeMessage> | undefined;
  private closed = false;

  constructor(transport: MessageTransport) {
    this.transport = transport;
    transport.onMessage((frame) => this.handleFrame(frame));
    transport.onClose(() => this.handleClose());
  }

  /** Says hello and resolves with the host's welcome. Rejects if the host refuses. */
  connect(): Promise<WelcomeMessage> {
    this.connecting ??= new Promise<WelcomeMessage>((resolve, reject) => {
      if (this.closed) throw closedError();
      // Registered before sending: an in-memory host answers before `send` returns.
      this.helloPending = { resolve, reject };
      this.transport.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));
    });
    return this.connecting;
  }

  async command(name: string, input: unknown): Promise<ExecResult> {
    const result = await this.request((id) => ({ t: "command", id, name, input }));
    return result as ExecResult;
  }

  async query<T = unknown>(name: string, input: unknown): Promise<QueryResult<T>> {
    const result = await this.request((id) => ({ t: "query", id, name, input }));
    return result as QueryResult<T>;
  }

  async undo(): Promise<ExecResult> {
    return (await this.request((id) => ({ t: "undo", id }))) as ExecResult;
  }

  async redo(): Promise<ExecResult> {
    return (await this.request((id) => ({ t: "redo", id }))) as ExecResult;
  }

  async setSpeed(speed: Speed): Promise<void> {
    await this.request((id) => ({ t: "speed", id, speed }));
  }

  /**
   * Asks for a full snapshot, terrain included. It reaches `onSnapshot` handlers before this
   * resolves.
   */
  async requestSnapshot(): Promise<void> {
    await this.request((id) => ({ t: "snapshot", id }));
  }

  /** Calls `handler` for every snapshot the host sends. Returns the function that stops that. */
  onSnapshot(handler: (snapshot: DecodedSnapshot) => void): () => void {
    return subscribe(this.snapshotHandlers, handler);
  }

  /** Calls `handler` for every log event the host sends. Returns the function that stops that. */
  onEvent(handler: (event: EventMessage) => void): () => void {
    return subscribe(this.eventHandlers, handler);
  }

  /**
   * Calls `handler` with each error the host sends that is not the answer to a request, such as
   * "Simulation halted: ..." when the sim fails. Returns the function that stops that.
   */
  onError(handler: (message: string) => void): () => void {
    return subscribe(this.errorHandlers, handler);
  }

  /** Closes the transport. Requests still waiting for an answer reject. */
  close(): void {
    this.handleClose();
    this.transport.close();
  }

  private request(build: (id: number) => ClientMessage): Promise<ResultPayload> {
    return new Promise<ResultPayload>((resolve, reject) => {
      if (this.closed) throw closedError();
      const id = this.nextId++;
      // Registered before sending, as in `connect`.
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.send(JSON.stringify(build(id)));
      } catch (error) {
        this.pending.delete(id);
        throw error;
      }
    });
  }

  private settle(id: number): Pending<ResultPayload> | undefined {
    const waiting = this.pending.get(id);
    this.pending.delete(id);
    return waiting;
  }

  private handleFrame(frame: Frame): void {
    if (typeof frame !== "string") {
      const snapshot = decodeSnapshot(frame);
      notify(this.snapshotHandlers, snapshot);
      return;
    }
    const msg = parseHostMessage(frame);
    if ("error" in msg) throw new ProtocolError(`Bad message from host: ${msg.error}`);
    switch (msg.t) {
      case "welcome": {
        const waiting = this.helloPending;
        this.helloPending = undefined;
        waiting?.resolve(msg);
        return;
      }
      case "result":
        // A result for an id nobody is waiting on, such as one already failed, is ignored.
        this.settle(msg.id)?.resolve(msg.result as ResultPayload);
        return;
      case "event":
        notify(this.eventHandlers, msg);
        return;
      case "error": {
        const failure = new ProtocolError(msg.message);
        if (msg.id !== undefined) {
          this.settle(msg.id)?.reject(failure);
        } else {
          // Without an id the error is not about a request. It is for `onError`, and it also
          // answers a hello that is waiting.
          const waiting = this.helloPending;
          this.helloPending = undefined;
          waiting?.reject(failure);
          notify(this.errorHandlers, msg.message);
        }
        return;
      }
    }
  }

  private handleClose(): void {
    this.closed = true;
    const waiting = [...this.pending.values(), ...(this.helloPending ? [this.helloPending] : [])];
    this.pending.clear();
    this.helloPending = undefined;
    for (const entry of waiting) entry.reject(closedError());
  }
}
