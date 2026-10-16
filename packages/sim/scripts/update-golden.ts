import { readFileSync, writeFileSync } from "node:fs";
import { parseScenario, runScenario } from "../test/golden/run.js";

/*
 * Re-records the golden hash: runs scenario 1 and writes the world's hash to scenario-1.hash.
 * Run it with `pnpm --filter @coasterworks/sim golden:update` only when a change is meant to alter
 * the simulation's results, and explain the new hash in the commit message.
 */
const scenarioUrl = new URL("../test/golden/scenario-1.json", import.meta.url);
const hashUrl = new URL("../test/golden/scenario-1.hash", import.meta.url);

const sim = runScenario(parseScenario(JSON.parse(readFileSync(scenarioUrl, "utf8"))));
writeFileSync(hashUrl, `${sim.hash()}\n`);
console.log(
  `scenario-1: ${sim.hash()} (tick ${sim.world.tick}, ${sim.world.log.length} log entries)`,
);
