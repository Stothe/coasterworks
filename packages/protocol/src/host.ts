import { TICKS_PER_SECOND, dateOf, formatDate } from "@coasterworks/sim";
import type { LogEntry, Sim, World } from "@coasterworks/sim";
import {
  PROTOCOL_VERSION,
  SpeedSchema,
  parseClientMessage,
  type ClientMessage,
  type HelloMessage,
  type HostMessage,
  type LogEntryPublic,
  type ResultPayload,
  type Speed,
} from "./messages.js";
import { encodeSnapshot } from "./snapshot.js";
import type { Frame, MessageTransport } from "./transport.js";

/** The clock and the repeating timer the host runs on. The app supplies them; `src` has no globals. */
export interface HostTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Milliseconds from any fixed starting point; only differences are used. */
  now(): number;
}

export interface SimHostOptions {
  /** Needed to `start()` the loop or call `tick()`. The app passes its own timers and clock. */
  timers?: HostTimers;
  /** How often the running host sends a snapshot even if nothing was commanded. Default 50. */
  snapshotIntervalMs?: number;
  /** The most sim ticks one `tick()` call runs. Default 40, one second at 1x. */
  maxTicksPerFrame?: number;
  /** Called after each mutation, once clients have been told, with the world as it now is. */
  onMutate?: (world: World) => void;
}

/** What the host remembers about one connected transport. */
interface ClientState {
  readonly transport: MessageTransport;
  /** The terrain version this client was last sent, or -1 if it has had none. */
  lastTerrainVersion: number;
  helloDone: boolean;
}

const DEFAULT_SNAPSHOT_INTERVAL_MS = 50;
const DEFAULT_MAX_TICKS_PER_FRAME = 40;
/** Further behind than this, the host gives up catching up rather than run a burst of ticks. */
const MAX_BACKLOG_MS = 250;
/** One tick at 1x. The loop wakes at least this often. */
const LOOP_INTERVAL_MS = 1000 / TICKS_PER_SECOND;
const SPEEDS: readonly Speed[] = SpeedSchema.options.map((option) => option.value);

function publicEntry(entry: LogEntry): LogEntryPublic {
  const out: LogEntryPublic = {
    id: entry.id,
    tick: entry.tick,
    client: entry.client,
    name: entry.name,
    input: entry.input,
    cost: entry.cost,
  };
  if (entry.undoneBy !== undefined) out.undoneBy = entry.undoneBy;
  return out;
}

/**
 * Runs a sim and serves it to any number of clients. Socket clients act as the `"player"`; an MCP
 * server acts as the `"agent"` by calling the sim directly, and the host notices through
 * `notifyExternalMutation()` or, failing that, a change in the log's length on the next `tick()`.
 */
export class SimHostServer {
  private readonly sim: Sim;
  private readonly timers: HostTimers | undefined;
  private readonly snapshotIntervalMs: number;
  private readonly maxTicksPerFrame: number;
  private readonly onMutate: ((world: World) => void) | undefined;
  private readonly clients = new Map<MessageTransport, ClientState>();
  private currentSpeed: Speed = 1;
  /** Bumped by every mutation; a client holding an older version needs the terrain again. */
  private terrainVersion = 0;
  /** Where the scheduler's accounting of real time stands; see `advance`. */
  private lastTickAt: number;
  private lastSnapshotAt: number;
  /** The world and log length that the last broadcast covered, to spot changes made elsewhere. */
  private trackedWorld: World;
  private loggedCount: number;
  private loop: { handle: unknown } | undefined;

  constructor(sim: Sim, opts: SimHostOptions = {}) {
    this.sim = sim;
    this.timers = opts.timers;
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.maxTicksPerFrame = opts.maxTicksPerFrame ?? DEFAULT_MAX_TICKS_PER_FRAME;
    this.onMutate = opts.onMutate;
    if (!(this.snapshotIntervalMs > 0)) {
      throw new RangeError(`snapshotIntervalMs must be positive, got ${this.snapshotIntervalMs}`);
    }
    if (!Number.isInteger(this.maxTicksPerFrame) || this.maxTicksPerFrame < 1) {
      throw new RangeError(
        `maxTicksPerFrame must be a positive integer, got ${this.maxTicksPerFrame}`,
      );
    }
    this.lastTickAt = this.lastSnapshotAt = this.timers?.now() ?? 0;
    this.trackedWorld = sim.world;
    this.loggedCount = sim.world.log.length;
  }

  get speed(): Speed {
    return this.currentSpeed;
  }

  /** Sets the speed and tells every client. */
  setSpeed(speed: Speed): void {
    this.applySpeed(speed);
    this.broadcastSnapshot();
  }

  /** Starts serving a transport. It may be called before `start()`, and for any number of clients. */
  attach(transport: MessageTransport): void {
    if (this.clients.has(transport)) return;
    const client: ClientState = { transport, lastTerrainVersion: -1, helloDone: false };
    this.clients.set(transport, client);
    transport.onMessage((frame) => this.handleMessage(client, frame));
    transport.onClose(() => this.detach(transport));
  }

  /** Stops serving a transport, without closing it. A transport that was never attached is ignored. */
  detach(transport: MessageTransport): void {
    this.clients.delete(transport);
  }

  /** Runs the scheduler on a repeating timer. Starting a running host does nothing. */
  start(): void {
    if (this.loop) return;
    const timers = this.requireTimers();
    const now = timers.now();
    this.lastTickAt = this.lastSnapshotAt = now;
    const interval = Math.min(LOOP_INTERVAL_MS, this.snapshotIntervalMs);
    this.loop = { handle: timers.setInterval(() => this.tick(), interval) };
  }

  stop(): void {
    if (!this.loop) return;
    this.requireTimers().clearInterval(this.loop.handle);
    this.loop = undefined;
  }

  /**
   * One scheduler step, which the timer runs and tests may call directly. It runs the ticks that
   * real time has made due at the current speed, up to `maxTicksPerFrame`; notices changes made to
   * the sim outside the protocol; and sends a snapshot if one is due.
   */
  tick(): void {
    const now = this.requireTimers().now();
    this.advance(now);
    const world = this.sim.world;
    if (world !== this.trackedWorld || world.log.length !== this.loggedCount) {
      this.mutated();
    } else if (now - this.lastSnapshotAt >= this.snapshotIntervalMs) {
      this.broadcastSnapshot();
    }
  }

  /** Call after changing the sim from outside the protocol, such as an MCP command. */
  notifyExternalMutation(): void {
    this.mutated();
  }

  private requireTimers(): HostTimers {
    if (!this.timers) {
      throw new Error("SimHostServer needs the timers option to run the tick loop");
    }
    return this.timers;
  }

  private applySpeed(speed: Speed): void {
    if (!SPEEDS.includes(speed)) throw new RangeError(`Unknown speed: ${speed}`);
    // While paused the clock is not read, so leaving the pause must not count the time spent in it.
    if (this.currentSpeed === 0 && speed !== 0 && this.timers) this.lastTickAt = this.timers.now();
    this.currentSpeed = speed;
  }

  /**
   * Runs the ticks due by `now`. Time that does not make a whole tick stays owed: `lastTickAt`
   * moves only by the time the ticks cover. If the host is more than `MAX_BACKLOG_MS` behind it
   * stops owing the rest, so a stalled page does not catch up in a burst.
   */
  private advance(now: number): void {
    const elapsed = now - this.lastTickAt;
    if (this.currentSpeed === 0 || elapsed < 0) {
      this.lastTickAt = now;
      return;
    }
    const ticksPerSecond = TICKS_PER_SECOND * this.currentSpeed;
    const due = Math.min(Math.floor((elapsed * ticksPerSecond) / 1000), this.maxTicksPerFrame);
    if (due > 0) this.sim.step(due);
    this.lastTickAt =
      elapsed > MAX_BACKLOG_MS ? now : this.lastTickAt + (due * 1000) / ticksPerSecond;
  }

  private handleMessage(client: ClientState, frame: Frame): void {
    if (this.clients.get(client.transport) !== client) return;
    if (typeof frame !== "string") {
      this.sendError(client, "Expected a text frame");
      return;
    }
    const msg = parseClientMessage(frame);
    if ("error" in msg) {
      this.sendError(client, msg.error, msg.id);
      return;
    }
    try {
      this.dispatch(client, msg);
    } catch (error) {
      // A request that blows up must not take the other clients, or the loop, with it.
      this.sendError(
        client,
        error instanceof Error ? error.message : String(error),
        "id" in msg ? msg.id : undefined,
      );
    }
  }

  private dispatch(client: ClientState, msg: ClientMessage): void {
    if (msg.t === "hello") {
      this.hello(client, msg);
      return;
    }
    if (!client.helloDone) {
      this.sendError(client, "Expected hello", msg.id);
      return;
    }
    switch (msg.t) {
      case "command": {
        const result = this.sim.execute(msg.name, msg.input, "player");
        this.reply(client, msg.id, result);
        if (result.ok) this.mutated();
        return;
      }
      case "query":
        this.reply(client, msg.id, this.sim.query(msg.name, msg.input));
        return;
      case "undo":
      case "redo": {
        const result = msg.t === "undo" ? this.sim.undo("player") : this.sim.redo("player");
        this.reply(client, msg.id, result);
        if (result.ok) this.mutated();
        return;
      }
      case "speed":
        this.applySpeed(msg.speed);
        this.reply(client, msg.id, { ok: true });
        this.broadcastSnapshot();
        return;
      case "snapshot":
        // The snapshot goes first, so a client that waits for the reply has it when the wait ends.
        this.sendSnapshot(client);
        this.reply(client, msg.id, { ok: true });
        return;
    }
  }

  private hello(client: ClientState, msg: HelloMessage): void {
    if (client.helloDone) {
      this.sendError(client, "Already said hello");
      return;
    }
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.sendError(client, "Unsupported protocol version");
      this.detach(client.transport);
      client.transport.close();
      return;
    }
    client.helloDone = true;
    const { terrain, meta } = this.sim.world;
    this.sendMessage(client, {
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      width: terrain.width,
      height: terrain.height,
      name: meta.name,
      speed: this.currentSpeed,
    });
    this.sendSnapshot(client);
  }

  /**
   * The park changed. Tell every client what was logged, then show them the park, with terrain
   * for any that do not hold the new version.
   */
  private mutated(): void {
    const world = this.sim.world;
    if (world !== this.trackedWorld) {
      // A different park altogether, such as a loaded save: its history is not news.
      this.trackedWorld = world;
      this.loggedCount = world.log.length;
    }
    this.terrainVersion++;
    for (let i = this.loggedCount; i < world.log.length; i++) {
      const entry = world.log[i];
      if (entry) this.broadcast({ t: "event", kind: "log", entry: publicEntry(entry) });
    }
    this.loggedCount = world.log.length;
    this.broadcastSnapshot();
    this.onMutate?.(world);
  }

  private buildSnapshot(withTerrain: boolean): Uint8Array {
    const { tick, terrain, finance } = this.sim.world;
    return encodeSnapshot(
      {
        tick,
        speed: this.currentSpeed,
        cash: finance.cash,
        loan: finance.loan,
        date: formatDate(dateOf(tick)),
        terrainVersion: this.terrainVersion,
        hasTerrain: withTerrain,
        width: terrain.width,
        height: terrain.height,
      },
      withTerrain ? terrain : undefined,
    );
  }

  /** Sends one client a full snapshot, terrain included. */
  private sendSnapshot(client: ClientState): void {
    this.deliverSnapshot(client, this.buildSnapshot(true), true);
  }

  /** Sends every client a snapshot, with terrain only for those that are behind. */
  private broadcastSnapshot(): void {
    let plain: Uint8Array | undefined;
    let full: Uint8Array | undefined;
    for (const client of this.helloClients()) {
      const behind = client.lastTerrainVersion < this.terrainVersion;
      const frame = behind
        ? (full ??= this.buildSnapshot(true))
        : (plain ??= this.buildSnapshot(false));
      this.deliverSnapshot(client, frame, behind);
    }
    if (this.timers) this.lastSnapshotAt = this.timers.now();
  }

  private deliverSnapshot(client: ClientState, frame: Uint8Array, withTerrain: boolean): void {
    if (this.send(client, frame) && withTerrain) client.lastTerrainVersion = this.terrainVersion;
  }

  private helloClients(): ClientState[] {
    return [...this.clients.values()].filter((client) => client.helloDone);
  }

  private broadcast(msg: HostMessage): void {
    const text = JSON.stringify(msg);
    for (const client of this.helloClients()) this.send(client, text);
  }

  private reply(client: ClientState, id: number, result: ResultPayload): void {
    this.sendMessage(client, { t: "result", id, result });
  }

  private sendError(client: ClientState, message: string, id?: number): void {
    this.sendMessage(
      client,
      id === undefined ? { t: "error", message } : { t: "error", id, message },
    );
  }

  private sendMessage(client: ClientState, msg: HostMessage): void {
    this.send(client, JSON.stringify(msg));
  }

  /** A transport that throws on send is gone; drop it so the others still hear the broadcast. */
  private send(client: ClientState, frame: Frame): boolean {
    try {
      client.transport.send(frame);
      return true;
    } catch {
      this.detach(client.transport);
      return false;
    }
  }
}
