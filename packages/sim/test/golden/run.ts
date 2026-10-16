import { z } from "zod";
import { Sim, createWorld, type CreateWorldOptions } from "../../src/index.js";

/*
 * A scenario is a JSON script: the world to create, then steps run in order. A step is one of
 *
 *   { "exec": [commandName, input] }   run a command
 *   { "tick": n }                      step the simulation n ticks
 *   { "undo": true } / { "redo": true }
 *
 * The scenario file is plain JSON, so it is checked here before it is run.
 */

const stepSchema = z.union([
  z.strictObject({ exec: z.tuple([z.string(), z.unknown()]) }),
  z.strictObject({ tick: z.int().min(0) }),
  z.strictObject({ undo: z.literal(true) }),
  z.strictObject({ redo: z.literal(true) }),
]);

const scenarioSchema = z.strictObject({
  world: z.strictObject({
    width: z.int(),
    height: z.int(),
    seed: z.int(),
    name: z.string(),
    cash: z.int().optional(),
  }),
  steps: z.array(stepSchema),
});

export type ScenarioDoc = z.infer<typeof scenarioSchema>;
export type ScenarioStep = ScenarioDoc["steps"][number];

/** Checks a parsed JSON value is a scenario. Throws a `ZodError` if it is not. */
export function parseScenario(json: unknown): ScenarioDoc {
  return scenarioSchema.parse(json);
}

function describeStep(step: ScenarioStep): string {
  if ("exec" in step) return step.exec[0];
  if ("tick" in step) return "tick";
  return "undo" in step ? "undo" : "redo";
}

/**
 * Builds the scenario's world and runs its steps. Every command, undo, and redo must succeed: the
 * first one that does not throws an error naming the step (counting from 0) and the reason, so a
 * broken scenario cannot pass for a golden hash.
 */
export function runScenario(doc: ScenarioDoc): Sim {
  const { cash, ...rest } = doc.world;
  const options: CreateWorldOptions = cash === undefined ? rest : { ...rest, cash };
  const sim = new Sim(createWorld(options));

  doc.steps.forEach((step, index) => {
    if ("tick" in step) {
      sim.step(step.tick);
      return;
    }
    const result =
      "exec" in step
        ? sim.execute(step.exec[0], step.exec[1])
        : "undo" in step
          ? sim.undo()
          : sim.redo();
    if (!result.ok) {
      throw new Error(`Scenario step ${index} (${describeStep(step)}) failed: ${result.error}`);
    }
  });
  return sim;
}
