import type { Frame, MessageTransport } from "@coasterworks/protocol";

/**
 * The slice of a `Worker`, or of a worker's own global scope, that a transport uses: both can post
 * a message to the other side and hear one from it.
 */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

/** Turns what arrived in a `message` event into a frame, or `null` if it is not one. */
function toFrame(data: unknown): Frame | null {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/**
 * A `MessageTransport` over a worker port, for either end: the page wraps its `Worker`, the worker
 * wraps `self`. Text frames are posted as strings. A binary frame is posted as a copy of its bytes
 * with the copy's buffer transferred: the caller keeps its frame, as the interface requires (the
 * host sends one frame to several transports), and the receiver gets exactly the frame's bytes
 * even when it was a view into a larger buffer, which structured cloning would copy whole.
 */
export class WorkerPortTransport implements MessageTransport {
  protected readonly port: PortLike;
  private messageHandler: ((frame: Frame) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private closed = false;

  constructor(port: PortLike) {
    this.port = port;
    port.addEventListener("message", (event) => {
      if (this.closed) return;
      const frame = toFrame(event.data);
      if (frame !== null) this.messageHandler?.(frame);
    });
  }

  send(frame: Frame): void {
    if (this.closed) return;
    if (typeof frame === "string") {
      this.port.postMessage(frame);
      return;
    }
    const copy = frame.slice();
    this.port.postMessage(copy, [copy.buffer]);
  }

  onMessage(handler: (frame: Frame) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.markClosed();
  }

  /** Records that the link is gone and tells the listener, once. */
  protected markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }
}

/** The page's end of the link to the sim worker. Closing it terminates the worker. */
export class WorkerTransport extends WorkerPortTransport {
  private readonly worker: Worker;

  constructor(worker: Worker) {
    super(worker);
    this.worker = worker;
    // An uncaught error in the worker, such as a module that fails to load, ends the link. The sim
    // itself reports its own faults as protocol errors, so this is the worker failing, not the sim.
    worker.addEventListener("error", (event) => {
      console.error("The sim worker failed:", event.message);
      this.markClosed();
    });
  }

  override close(): void {
    this.worker.terminate();
    this.markClosed();
  }
}
