import { Sim, createWorld } from "@coasterworks/sim";
import {
  PROTOCOL_VERSION,
  createLinkedTransports,
  decodeSnapshot,
  parseHostMessage,
  type DecodedSnapshot,
  type Frame,
  type HostMessage,
  type HostTimers,
  type MessageTransport,
  type SimHostServer,
} from "../src/index.js";

export function makeSim(): Sim {
  return new Sim(createWorld({ width: 8, height: 8, seed: 1, name: "Test Park" }));
}

export const RAISE = { x: 0, y: 0, w: 2, h: 2 };

/** A clock the test moves by hand, and timers it can fire by hand. */
export interface FakeTimers extends HostTimers {
  advance(ms: number): void;
  /** Runs every active interval callback once. */
  fire(): void;
  /** The `ms` of each interval that is active. */
  active(): number[];
  /** How many intervals were ever started. */
  started: number;
}

export function fakeTimers(): FakeTimers {
  let time = 0;
  let nextHandle = 1;
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const timers: FakeTimers = {
    started: 0,
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
    setInterval(fn, ms) {
      timers.started++;
      const handle = nextHandle++;
      intervals.set(handle, { fn, ms });
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
    fire() {
      for (const { fn } of [...intervals.values()]) fn();
    },
    active: () => [...intervals.values()].map((interval) => interval.ms),
  };
  return timers;
}

export type Received = HostMessage | DecodedSnapshot;

/** The far end of a transport attached to a host, recording everything the host sends it. */
export interface Peer {
  /** The peer's own end of the pair. */
  transport: MessageTransport;
  /** The end the host holds. */
  hostTransport: MessageTransport;
  /** Parsed messages and decoded snapshots, in arrival order. */
  received: Received[];
  /** Every frame as it arrived. */
  frames: Frame[];
  closed: boolean;
  send(message: unknown): void;
  sendRaw(frame: Frame): void;
  hello(): void;
  clear(): void;
  /** What arrived, by kind: `"snapshot"` or the message's `t`. */
  kinds(): string[];
  messages<K extends HostMessage["t"]>(t: K): Array<Extract<HostMessage, { t: K }>>;
  snapshots(): DecodedSnapshot[];
  lastSnapshot(): DecodedSnapshot;
}

export function connectPeer(host: SimHostServer): Peer {
  const [hostSide, peerSide] = createLinkedTransports();
  host.attach(hostSide);
  const peer: Peer = {
    transport: peerSide,
    hostTransport: hostSide,
    received: [],
    frames: [],
    closed: false,
    send: (message) => peerSide.send(JSON.stringify(message)),
    sendRaw: (frame) => peerSide.send(frame),
    hello: () => peer.send({ t: "hello", protocol: PROTOCOL_VERSION }),
    clear() {
      peer.received.length = 0;
      peer.frames.length = 0;
    },
    kinds: () => peer.received.map((item) => ("header" in item ? "snapshot" : item.t)),
    messages: <K extends HostMessage["t"]>(t: K) =>
      peer.received.filter(
        (item): item is Extract<HostMessage, { t: K }> => "t" in item && item.t === t,
      ),
    snapshots: () => peer.received.filter((item): item is DecodedSnapshot => "header" in item),
    lastSnapshot() {
      const last = peer.snapshots().at(-1);
      if (!last) throw new Error("no snapshot received");
      return last;
    },
  };
  peerSide.onMessage((frame) => {
    peer.frames.push(frame);
    if (typeof frame === "string") {
      const parsed = parseHostMessage(frame);
      if ("error" in parsed) throw new Error(`host sent a bad message: ${parsed.error}`);
      peer.received.push(parsed);
    } else {
      peer.received.push(decodeSnapshot(frame));
    }
  });
  peerSide.onClose(() => {
    peer.closed = true;
  });
  return peer;
}
