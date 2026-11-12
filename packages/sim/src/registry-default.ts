import {
  coasterAddPiece,
  coasterBegin,
  coasterBuildFromPoints,
  coasterComplete,
  coasterExtendTo,
  coasterRemovePiece,
} from "./commands/coaster.js";
import { financeRepayLoan, financeTakeLoan } from "./commands/finance.js";
import {
  parkClose,
  parkOpen,
  parkRename,
  parkSetEntrance,
  parkSetEntryFee,
} from "./commands/park.js";
import { pathBuild, pathBuildTiles, pathRemove, pathRemoveTiles } from "./commands/path.js";
import { Registry } from "./commands/registry.js";
import {
  rideBuild,
  rideClose,
  rideDemolish,
  rideOpen,
  rideRename,
  rideSetPrice,
  stallBuild,
} from "./commands/ride.js";
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
import {
  coasterFitPreview,
  coasterGet,
  coasterPieceOptions,
  trackPiecesList,
} from "./queries/coaster.js";
import { guestGet, guestList, guestThoughts } from "./queries/guest.js";
import { logRecent, undoState } from "./queries/log.js";
import { financeSummary, parkBounds, parkStatus } from "./queries/park.js";
import { pathCheckTiles } from "./queries/path.js";
import { contentList, rideCheck, rideGet, rideList } from "./queries/ride.js";
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
  registry.register(pathBuild);
  registry.register(pathRemove);
  registry.register(pathBuildTiles);
  registry.register(pathRemoveTiles);
  registry.register(parkSetEntrance);
  registry.register(parkSetEntryFee);
  registry.register(parkOpen);
  registry.register(parkClose);
  registry.register(parkRename);
  registry.register(rideBuild);
  registry.register(stallBuild);
  registry.register(rideDemolish);
  registry.register(rideOpen);
  registry.register(rideClose);
  registry.register(rideSetPrice);
  registry.register(rideRename);
  registry.register(coasterBegin);
  registry.register(coasterAddPiece);
  registry.register(coasterRemovePiece);
  registry.register(coasterComplete);
  registry.register(coasterBuildFromPoints);
  registry.register(coasterExtendTo);
  registry.register(simAdvance);
  registry.register(financeTakeLoan);
  registry.register(financeRepayLoan);
  registry.registerQuery(parkStatus);
  registry.registerQuery(parkBounds);
  registry.registerQuery(financeSummary);
  registry.registerQuery(terrainGet);
  registry.registerQuery(logRecent);
  registry.registerQuery(undoState);
  registry.registerQuery(guestList);
  registry.registerQuery(guestGet);
  registry.registerQuery(guestThoughts);
  registry.registerQuery(pathCheckTiles);
  registry.registerQuery(rideList);
  registry.registerQuery(rideGet);
  registry.registerQuery(contentList);
  registry.registerQuery(rideCheck);
  registry.registerQuery(coasterGet);
  registry.registerQuery(coasterPieceOptions);
  registry.registerQuery(coasterFitPreview);
  registry.registerQuery(trackPiecesList);
  // Reads the registry it is in, so a client can discover every command and query.
  registry.registerQuery(catalogListQuery(registry));
  return registry;
}
