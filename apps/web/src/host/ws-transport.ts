import type { Frame, MessageTransport } from "@coasterworks/protocol";

/** Why a socket closed, for the player: the server's words if it gave any, else the close code. */
function closeReason(event: CloseEvent): string {
  const said = typeof event.reason === "string" ? event.reason.trim() : "";
  return said !== "" ? said : `WebSocket closed (code ${event.code})`;
}

/**
 * A `MessageTransport` over a browser `WebSocket`, for a host that runs elsewhere (`coasterworks
 * serve`). Binary frames arrive as `Uint8Array`. Frames sent while the socket is still opening wait
 * and go out in order once it is open, so a client can say hello straight away.
 */
export class WsTransport implements MessageTransport {
  private readonly socket: WebSocket;
  private readonly waiting: Frame[] = [];
  private messageHandler: ((frame: Frame) => void) | undefined;
  private closeHandler: ((reason?: string) => void) | undefined;
  private closed = false;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      for (const frame of this.waiting.splice(0)) this.socket.send(frame);
    });
    socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (typeof data === "string") this.messageHandler?.(data);
      else if (data instanceof ArrayBuffer) this.messageHandler?.(new Uint8Array(data));
    });
    socket.addEventListener("close", (event) => this.markClosed(closeReason(event)));
    // An error is always followed by a close event, which is what ends the link.
  }

  send(frame: Frame): void {
    if (this.closed) return;
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.waiting.push(frame);
      return;
    }
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(frame);
  }

  onMessage(handler: (frame: Frame) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.socket.close();
    this.markClosed();
  }

  private markClosed(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.waiting.length = 0;
    this.closeHandler?.(reason);
  }
}
