import { financeRepayLoan, financeTakeLoan } from "./commands/finance.js";
import { Registry } from "./commands/registry.js";
import { simAdvance } from "./commands/sim.js";
import {
  terrainLevel,
  terrainLower,
  terrainRaise,
  terrainSetSurface,
  terrainSetWater,
  terrainSmooth,
} from "./commands/terrain.js";

/** A registry holding every command and query in the sim. */
export function createDefaultRegistry(): Registry {
  const registry = new Registry();
  registry.register(terrainRaise);
  registry.register(terrainLower);
  registry.register(terrainLevel);
  registry.register(terrainSmooth);
  registry.register(terrainSetSurface);
  registry.register(terrainSetWater);
  registry.register(simAdvance);
  registry.register(financeTakeLoan);
  registry.register(financeRepayLoan);
  return registry;
}
