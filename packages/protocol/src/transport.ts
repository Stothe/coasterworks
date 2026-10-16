/** One message on the wire: JSON text, or a binary snapshot. */
export type Frame = string | Uint8Array;

/**
 * A two-way pipe to one peer, such as a WebSocket, a worker port, or a stdio pair. Frames arrive
 * in the order they were sent.
 */
export interface MessageTransport {
  /**
   * Sends a frame. The host may send the same frame to several transports, so an implementation
   * must not change it or transfer its buffer.
   */
  send(frame: Frame): void;
  onMessage(handler: (frame: Frame) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/**
 * Reports an error from a handler without unwinding into whoever called `send`. A real transport
 * delivers in its own event, so a failing receiver never disturbs the sender; this keeps that true
 * for the in-memory pair. It surfaces as an unhandled rejection, which the platform reports.
 */
function reportLater(error: unknown): void {
  void Promise.reject(error);
}

class LinkedEnd implements MessageTransport {
  peer!: LinkedEnd;
  private messageHandler: ((frame: Frame) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private inbox: Frame[] = [];
  private closed = false;
  private closeReported = false;

  send(frame: Frame): void {
    if (this.closed) return;
    this.peer.receive(frame);
  }

  onMessage(handler: (frame: Frame) => void): void {
    this.messageHandler = handler;
    // Frames sent before anyone listened wait their turn here.
    while (this.inbox.length > 0) this.deliver(this.inbox.shift() as Frame);
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closed) this.reportClose();
  }

  close(): void {
    if (this.closed) return;
    this.markClosed();
    this.peer.markClosed();
  }

  private receive(frame: Frame): void {
    if (this.closed) return;
    if (this.messageHandler) this.deliver(frame);
    else this.inbox.push(frame);
  }

  private deliver(frame: Frame): void {
    try {
      this.messageHandler?.(frame);
    } catch (error) {
      reportLater(error);
    }
  }

  private markClosed(): void {
    this.closed = true;
    this.reportClose();
  }

  private reportClose(): void {
    if (this.closeReported || !this.closeHandler) return;
    this.closeReported = true;
    try {
      this.closeHandler();
    } catch (error) {
      reportLater(error);
    }
  }
}

/**
 * An in-memory pair: what one side sends, the other receives. Delivery is synchronous, inside
 * `send`, so tests need not wait; frames sent before the other side calls `onMessage` are queued.
 * Closing either side closes both, and each side's `onClose` handler runs once.
 */
export function createLinkedTransports(): [MessageTransport, MessageTransport] {
  const a = new LinkedEnd();
  const b = new LinkedEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
