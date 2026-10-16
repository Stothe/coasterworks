import { runQuery, type QueryResult } from "./commands/define.js";
import { executeCommand, type ExecResult } from "./commands/execute.js";
import type { Registry } from "./commands/registry.js";
import { simAdvance } from "./commands/sim.js";
import { redoLast, undoLast } from "./commands/undo.js";
import { createDefaultRegistry } from "./registry-default.js";
import { financeSystem } from "./systems/finance.js";
import type { System } from "./systems/types.js";
import { TICKS_PER_DAY } from "./time.js";
import { hashWorld } from "./world/hash.js";
import type { ClientKind, World } from "./world/types.js";

/**
 * A running park: the world, the commands that change it, and the systems that run each tick.
 * Every client (CLI, MCP server, renderer) holds one.
 */
export class Sim {
  readonly world: World;
  readonly registry: Registry;
  /** Run in this order on every tick. Later tasks append their own. */
  systems: System[] = [financeSystem];

  constructor(world: World, registry: Registry = createDefaultRegistry()) {
    this.world = world;
    this.registry = registry;
  }

  /**
   * Runs a command. `sim_advance` is logged like any other command, and then the time it asked
   * for passes; the log entry carries the tick at which it was issued.
   */
  execute(name: string, input: unknown, client: ClientKind = "player"): ExecResult {
    const result = executeCommand(this.world, this.registry, name, input, client);
    if (result.ok && name === simAdvance.name) {
      this.advanceDays(simAdvance.input.parse(input).days);
    }
    return result;
  }

  query(name: string, input: unknown): QueryResult {
    return runQuery(this.world, this.registry, name, input);
  }

  undo(client: ClientKind = "player"): ExecResult {
    return undoLast(this.world, this.registry, client);
  }

  redo(client: ClientKind = "player"): ExecResult {
    return redoLast(this.world, this.registry, client);
  }

  /**
   * Runs `ticks` ticks. Each one advances `world.tick` first, then runs every system in order,
   * so a system sees the tick it is running for. Throws if `ticks` is not a non-negative integer.
   */
  step(ticks = 1): void {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new RangeError(`Ticks must be a non-negative integer, got ${ticks}`);
    }
    for (let i = 0; i < ticks; i++) {
      this.world.tick++;
      for (const system of this.systems) system.tick(this.world);
    }
  }

  advanceDays(days: number): void {
    this.step(days * TICKS_PER_DAY);
  }

  /** Fingerprint of the world; see `hashWorld`. */
  hash(): string {
    return hashWorld(this.world);
  }
}
