import type { Frame, MessageTransport } from "@coasterworks/protocol";
import type { RawData, WebSocket } from "ws";

/** The bytes of a binary message, however `ws` was asked to hand them over, as a fresh array. */
function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  // Copied, because a Buffer from ws may be a view into memory that is reused.
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(data);
}

/** The text of a text message. */
function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return (data instanceof ArrayBuffer ? Buffer.from(data) : data).toString("utf8");
}

/**
 * Wraps a server-side `ws` socket as the `MessageTransport` a `SimHostServer` serves. Text
 * messages arrive as strings and binary ones as a `Uint8Array` of their own; a string is sent as a
 * text frame and a `Uint8Array` as a binary one. The close handler runs once, when the socket
 * closes or fails (a failed socket is dropped, as the browser's is). Once `close()` has been
 * called, no message is delivered, even one that was already on its way. Attach it in the same turn as
 * the socket is accepted, so no message arrives before there is a handler for it.
 */
export function wsTransport(socket: WebSocket): MessageTransport {
  let messageHandler: ((frame: Frame) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  // Set by `close()`: what arrives after it is not for anyone. `closed` is the socket's own end.
  let closing = false;
  let closed = false;

  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    closeHandler?.();
  };

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (closing || closed) return;
    messageHandler?.(isBinary ? bytesOf(data) : textOf(data));
  });
  socket.on("close", markClosed);
  // Without a listener an `error` event would throw and take the process down.
  socket.on("error", markClosed);

  return {
    send(frame) {
      if (typeof frame === "string") socket.send(frame);
      else socket.send(frame, { binary: true });
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    close() {
      closing = true;
      socket.close();
    },
  };
}
