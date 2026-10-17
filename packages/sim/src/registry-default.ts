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
import { catalogListQuery } from "./queries/catalog.js";
import { logRecent, undoState } from "./queries/log.js";
import { parkBounds, parkStatus } from "./queries/park.js";
import { terrainGet } from "./queries/terrain.js";

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
  registry.registerQuery(parkStatus);
  registry.registerQuery(parkBounds);
  registry.registerQuery(terrainGet);
  registry.registerQuery(logRecent);
  registry.registerQuery(undoState);
  // Reads the registry it is in, so a client can discover every command and query.
  registry.registerQuery(catalogListQuery(registry));
  return registry;
}
