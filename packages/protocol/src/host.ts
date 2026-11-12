import { TICKS_PER_SECOND, dateOf, formatDate } from "@coasterworks/sim";
import type { GuestStore, LogEntry, RideRecord, Sim, World } from "@coasterworks/sim";
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
import {
  encodeSnapshot,
  type GuestSection,
  type RidePublic,
  type RideStatusSection,
  type SnapshotParts,
} from "./snapshot.js";
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
  /** The path version this client was last sent, or -1 if it has had none. */
  lastPathVersion: number;
  /** The ride version this client was last sent, or -1 if it has had none. */
  lastRideVersion: number;
  helloDone: boolean;
}

/** The layer versions a frame was built from. */
interface LayerVersions {
  terrain: number;
  paths: number;
  rides: number;
}

/** Which layers a frame carries. */
interface Layers {
  terrain: boolean;
  paths: boolean;
  rides: boolean;
}

const ALL_LAYERS: Layers = { terrain: true, paths: true, rides: true };

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
 * The live guests as the arrays a snapshot carries, copied so that nothing the sim does next can
 * change them. Between ticks the live guests fill slots `0..count-1`, and those are copied as they
 * are. A store that is not packed, such as one a tick left half done when it threw, has gaps, and
 * then the live slots are gathered one by one; either way the section and the count agree.
 */
function guestSection(store: GuestStore): GuestSection {
  if (!store.fragmented) {
    const count = store.count;
    return {
      count,
      id: store.id.slice(0, count),
      x: store.x.slice(0, count),
      y: store.y.slice(0, count),
      state: store.state.slice(0, count),
      color: store.color.slice(0, count),
      happiness: store.happiness.slice(0, count),
    };
  }
  const slots: number[] = [];
  for (let slot = 0; slot < store.live.length; slot++) {
    if (store.live[slot] === 1) slots.push(slot);
  }
  const count = slots.length;
  const section: GuestSection = {
    count,
    id: new Int32Array(count),
    x: new Int32Array(count),
    y: new Int32Array(count),
    state: new Uint8Array(count),
    color: new Uint8Array(count),
    happiness: new Uint8Array(count),
  };
  slots.forEach((slot, i) => {
    section.id[i] = store.id[slot] as number;
    section.x[i] = store.x[slot] as number;
    section.y[i] = store.y[slot] as number;
    section.state[i] = store.state[slot] as number;
    section.color[i] = store.color[slot] as number;
    section.happiness[i] = store.happiness[slot] as number;
  });
  return section;
}

/** The rides of the world in ascending id order, without changing the world's own list. */
function ridesById(rides: readonly RideRecord[]): RideRecord[] {
  return [...rides].sort((a, b) => a.id - b.id);
}

function tileOrNull(tile: { x: number; y: number } | null): { x: number; y: number } | null {
  return tile === null ? null : { x: tile.x, y: tile.y };
}

/** A ride as clients see it: copied, so nothing the sim does next can change it. */
function ridePublic(ride: RideRecord): RidePublic {
  return {
    id: ride.id,
    type: ride.type,
    kind: ride.kind,
    x: ride.x,
    y: ride.y,
    rot: ride.rot,
    name: ride.name,
    open: ride.open,
    price: ride.price,
    entrance: tileOrNull(ride.entrance),
    exit: tileOrNull(ride.exit),
    service: tileOrNull(ride.service),
  };
}

/** `value` held to `0..max`, so a typed array stores it as the most it can rather than wrapping. */
function clamp(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value;
}

/** What every ride is doing, in ascending id order, each value clamped to fit its field. */
function rideStatusSection(rides: readonly RideRecord[]): RideStatusSection {
  const count = rides.length;
  const section: RideStatusSection = {
    count,
    id: new Int32Array(count),
    phase: new Uint8Array(count),
    phaseTicks: new Uint16Array(count),
    riders: new Uint8Array(count),
    queue: new Uint16Array(count),
  };
  rides.forEach((ride, i) => {
    section.id[i] = ride.id;
    section.phase[i] = clamp(ride.phase, 0xff);
    section.phaseTicks[i] = clamp(ride.phaseTicks, 0xffff);
    section.riders[i] = clamp(ride.riders.length, 0xff);
    section.queue[i] = clamp(ride.queue.length, 0xffff);
  });
  return section;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The id-less error that tells clients the sim stopped, and why. */
function haltMessage(reason: string | undefined): string {
  return `Simulation halted: ${reason ?? "unknown error"}`;
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
  /** Set when a fault stopped the sim, until a client or `setSpeed` resumes it. */
  private isHalted = false;
  private lastHaltReason: string | undefined;
  /**
   * Bumped by a command in the `terrain` category, by undoing or redoing one, and when the sim
   * holds a different world; a client holding an older version needs the terrain again.
   */
  private terrainVersion = 0;
  /**
   * Bumped whenever the world's `pathVersion` moves, and when the sim holds a different world; a
   * client holding an older version needs the paths again. The host keeps its own count because a
   * new world's `pathVersion` starts over at 0, which a client may already hold.
   */
  private pathVersion = 0;
  /** The world's own `pathVersion` as of the last time this host looked. */
  private seenPathVersion: number;
  /**
   * Bumped whenever the world's `rideVersion` moves (a ride command, or undoing or redoing one),
   * and when the sim holds a different world; kept by the host for the same reason as `pathVersion`.
   */
  private rideVersion = 0;
  /** The world's own `rideVersion` as of the last time this host looked. */
  private seenRideVersion: number;
  /** Where the scheduler's accounting of real time stands; see `advance`. */
  private lastTickAt: number;
  private lastSnapshotAt: number;
  /** The world and log length that the last broadcast covered, to spot changes made elsewhere. */
  private trackedWorld: World;
  private loggedCount: number;
  /** Set when the sim was seen to hold a different world, until a mutation announces it. */
  private worldChanged = false;
  /** Broadcasts waiting their turn; see `publish`. */
  private readonly outbox: Array<() => void> = [];
  private publishing = false;
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
    this.seenPathVersion = sim.world.pathVersion;
    this.seenRideVersion = sim.world.rideVersion;
  }

  get speed(): Speed {
    return this.currentSpeed;
  }

  /** True from a fault in the sim until the sim is resumed; see `setSpeed`. */
  get halted(): boolean {
    return this.isHalted;
  }

  /** What stopped the sim, while `halted` is true. */
  get haltReason(): string | undefined {
    return this.lastHaltReason;
  }

  /**
   * Sets the speed and tells every client. While the sim is halted, a speed above 0 resumes it:
   * the halt is cleared and the loop is started again, as a client's `speed` message does. The
   * fault that caused the halt may still be there; if it is, the next tick halts the sim again,
   * and the clients are told again.
   */
  setSpeed(speed: Speed): void {
    this.changeSpeed(speed);
    this.publish(() => this.broadcastSnapshot());
  }

  /** Starts serving a transport. It may be called before `start()`, and for any number of clients. */
  attach(transport: MessageTransport): void {
    if (this.clients.has(transport)) return;
    const client: ClientState = {
      transport,
      lastTerrainVersion: -1,
      lastPathVersion: -1,
      lastRideVersion: -1,
      helloDone: false,
    };
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
    this.loop = { handle: timers.setInterval(() => this.runLoop(), interval) };
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
    this.syncWorld();
    if (this.worldChanged || this.sim.world.log.length !== this.loggedCount) {
      this.mutated();
    } else if (now - this.lastSnapshotAt >= this.snapshotIntervalMs) {
      this.publish(() => this.broadcastSnapshot());
    }
  }

  /** Call after changing the sim from outside the protocol, such as an MCP command. */
  notifyExternalMutation(): void {
    this.mutated();
  }

  /**
   * What the timer runs. A fault in the sim must not kill the page or the process, nor leave a
   * broken sim running: the host halts it, tells the clients, and stays up for queries. A client's
   * `speed` message above 0 resumes it, and so does `setSpeed`.
   */
  private runLoop(): void {
    try {
      this.tick();
    } catch (error) {
      this.halt(error);
    }
  }

  private halt(error: unknown): void {
    this.stop();
    this.applySpeed(0);
    this.isHalted = true;
    this.lastHaltReason = errorText(error);
    const message = haltMessage(this.lastHaltReason);
    this.publish(() => {
      this.broadcast({ t: "error", message });
      this.broadcastSnapshot();
    });
  }

  private requireTimers(): HostTimers {
    if (!this.timers) {
      throw new Error("SimHostServer needs the timers option to run the tick loop");
    }
    return this.timers;
  }

  /**
   * The speed change behind `setSpeed` and the `speed` message. A halted sim stays stopped at
   * speed 0, which changes nothing; any other speed resumes it. The loop is restarted before the
   * halt is cleared, so a host that cannot run one (no timers) stays halted and says why.
   */
  private changeSpeed(speed: Speed): void {
    if (!this.isHalted) {
      this.applySpeed(speed);
      return;
    }
    if (!SPEEDS.includes(speed)) throw new RangeError(`Unknown speed: ${speed}`);
    if (speed === 0) return;
    this.start();
    this.isHalted = false;
    this.lastHaltReason = undefined;
    this.applySpeed(speed);
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
      // Before anything runs, so a command on a world that was just swapped in logs against it.
      this.syncWorld();
      this.dispatch(client, msg);
    } catch (error) {
      // A request that blows up must not take the other clients, or the loop, with it.
      this.sendError(client, errorText(error), "id" in msg ? msg.id : undefined);
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
        this.changeSpeed(msg.speed);
        this.reply(client, msg.id, { ok: true });
        this.publish(() => this.broadcastSnapshot());
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
    const { terrain, park } = this.sim.world;
    this.sendMessage(client, {
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      width: terrain.width,
      height: terrain.height,
      name: park.name,
      speed: this.currentSpeed,
      halted: this.isHalted,
    });
    // A client that joins after the fault never heard the broadcast, so it is told here.
    if (this.isHalted) this.sendError(client, haltMessage(this.lastHaltReason));
    this.sendSnapshot(client);
  }

  /**
   * Notices that the sim now holds a different world, such as a loaded save. Its log is not news,
   * so counting starts from where it ends, and its terrain and paths are new to every client.
   */
  private syncWorld(): void {
    const world = this.sim.world;
    if (world === this.trackedWorld) return;
    this.trackedWorld = world;
    this.loggedCount = world.log.length;
    this.worldChanged = true;
    this.terrainVersion++;
    this.pathVersion++;
    this.seenPathVersion = world.pathVersion;
    this.rideVersion++;
    this.seenRideVersion = world.rideVersion;
  }

  /** Counts a change to the world's paths or entrance, which its `pathVersion` records. */
  private trackPaths(): void {
    const seen = this.sim.world.pathVersion;
    if (seen === this.seenPathVersion) return;
    this.seenPathVersion = seen;
    this.pathVersion++;
  }

  /** Counts a change to the world's rides, which its `rideVersion` records. */
  private trackRides(): void {
    const seen = this.sim.world.rideVersion;
    if (seen === this.seenRideVersion) return;
    this.seenRideVersion = seen;
    this.rideVersion++;
  }

  /** Catches up with the world's path and ride versions, and returns the layer versions now. */
  private currentVersions(): LayerVersions {
    this.trackPaths();
    this.trackRides();
    return { terrain: this.terrainVersion, paths: this.pathVersion, rides: this.rideVersion };
  }

  /**
   * Whether a log entry changed the terrain: it is a command in the `terrain` category, or it
   * undoes or redoes one. Everything else leaves the terrain as the clients hold it.
   */
  private touchesTerrain(world: World, entry: LogEntry): boolean {
    let name = entry.name;
    if (name === "undo" || name === "redo") {
      const target = (entry.input as { target?: unknown } | null)?.target;
      // The target is usually among the newest entries, so look from the end, as undo does.
      let original: LogEntry | undefined;
      for (let i = world.log.length - 1; i >= 0 && !original; i--) {
        if (world.log[i]?.id === target) original = world.log[i];
      }
      if (!original) return false;
      name = original.name;
    }
    return this.sim.registry.command(name)?.category === "terrain";
  }

  /** The park changed: tell every client, in the order things happened. */
  private mutated(): void {
    this.publish(() => this.announce());
  }

  /**
   * Tells every client what was logged since the last announcement, then shows them the park,
   * with terrain and paths for any that do not hold the current versions. The terrain version
   * moves only if what was logged touched the terrain; the path version follows the world's.
   */
  private announce(): void {
    this.syncWorld();
    const world = this.sim.world;
    const from = this.loggedCount;
    const to = world.log.length;
    this.loggedCount = to;
    this.worldChanged = false;
    let terrainChanged = false;
    for (let i = from; i < to; i++) {
      const entry = world.log[i];
      if (!entry) continue;
      if (this.touchesTerrain(world, entry)) terrainChanged = true;
      this.broadcast({ t: "event", kind: "log", entry: publicEntry(entry) });
    }
    if (terrainChanged) this.terrainVersion++;
    this.broadcastSnapshot();
    this.onMutate?.(world);
  }

  /**
   * Runs a broadcast now, or, if one is already going out, right after it. A client's handler can
   * call back into the host while it is being sent to; without this, that call's broadcast would
   * reach the clients later in the loop before the one it interrupted, and they would hear events
   * out of order or twice. A broadcast reads the park when it runs, so none is ever stale.
   * Exceptions leave the queue as it is, to be run by the next broadcast.
   */
  private publish(broadcast: () => void): void {
    this.outbox.push(broadcast);
    if (this.publishing) return;
    this.publishing = true;
    try {
      for (let next = this.outbox.shift(); next; next = this.outbox.shift()) next();
    } finally {
      this.publishing = false;
    }
  }

  /**
   * The one place a snapshot is made, for a join, a broadcast, a periodic send and a halt alike.
   * The terrain, the paths and the ride list are in it only when asked for; the park, the guests
   * and the ride status are in every one, read from the world as it is now. `versions` are the
   * versions the frame says it holds.
   */
  private buildSnapshot(layers: Layers, versions: LayerVersions): Uint8Array {
    const { tick, terrain, finance, park, guests } = this.sim.world;
    const rides = ridesById(this.sim.world.rides);
    const section = guestSection(guests);
    const parts: SnapshotParts = { guests: section, rideStatus: rideStatusSection(rides) };
    if (layers.terrain) parts.terrain = terrain;
    if (layers.paths) parts.paths = terrain.path;
    return encodeSnapshot(
      {
        tick,
        speed: this.currentSpeed,
        halted: this.isHalted,
        cash: finance.cash,
        loan: finance.loan,
        monthStartCash: finance.monthStart.cash,
        date: formatDate(dateOf(tick)),
        terrainVersion: versions.terrain,
        hasTerrain: layers.terrain,
        pathVersion: versions.paths,
        hasPaths: layers.paths,
        rideVersion: versions.rides,
        hasRides: layers.rides,
        ...(layers.rides ? { rides: rides.map(ridePublic) } : {}),
        rideCount: rides.length,
        guestCount: section.count,
        width: terrain.width,
        height: terrain.height,
        park: {
          name: park.name,
          open: park.open,
          entryFee: park.entryFee,
          entrance:
            park.entrance === null
              ? null
              : { x: park.entrance.x, y: park.entrance.y, side: park.entrance.side },
          rating: park.rating,
          guestsInPark: park.guestsInPark,
          totalAdmissions: park.totalAdmissions,
        },
      },
      parts,
    );
  }

  /** Sends one client a full snapshot, terrain, paths and rides included. */
  private sendSnapshot(client: ClientState): void {
    const versions = this.currentVersions();
    this.deliverSnapshot(client, this.buildSnapshot(ALL_LAYERS, versions), versions, ALL_LAYERS);
  }

  /**
   * Sends every client a snapshot, with the terrain, the paths and the rides only for those that
   * are behind. Clients that need the same layers are sent the same frame, which is built once.
   */
  private broadcastSnapshot(): void {
    // The versions as they are now, before any frame goes out: a client's handler can run while
    // its frame is delivered and change the world, and a client sent a frame built before that
    // must not be recorded as holding what came after (it is sent the layers again instead).
    const versions = this.currentVersions();
    const frames = new Map<number, Uint8Array>();
    for (const client of this.helloClients()) {
      const layers: Layers = {
        terrain: client.lastTerrainVersion < versions.terrain,
        paths: client.lastPathVersion < versions.paths,
        rides: client.lastRideVersion < versions.rides,
      };
      const kind = (layers.terrain ? 1 : 0) + (layers.paths ? 2 : 0) + (layers.rides ? 4 : 0);
      let frame = frames.get(kind);
      if (!frame) {
        frame = this.buildSnapshot(layers, versions);
        frames.set(kind, frame);
      }
      this.deliverSnapshot(client, frame, versions, layers);
    }
    if (this.timers) this.lastSnapshotAt = this.timers.now();
  }

  /**
   * Sends one client a snapshot, and remembers which layers it now holds only once the send worked,
   * so a client that missed a frame is behind, and is sent them again, in the next one. `versions`
   * are the layer versions the frame was built from, not the host's when the send returns.
   */
  private deliverSnapshot(
    client: ClientState,
    frame: Uint8Array,
    versions: LayerVersions,
    layers: Layers,
  ): void {
    if (!this.send(client, frame)) return;
    if (layers.terrain) {
      client.lastTerrainVersion = Math.max(client.lastTerrainVersion, versions.terrain);
    }
    if (layers.paths) client.lastPathVersion = Math.max(client.lastPathVersion, versions.paths);
    if (layers.rides) client.lastRideVersion = Math.max(client.lastRideVersion, versions.rides);
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
