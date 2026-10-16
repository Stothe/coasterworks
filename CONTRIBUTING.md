# Contributing

## Setup

```sh
pnpm install
pnpm test
pnpm build
```

## Commits

Use [conventional commits](https://www.conventionalcommits.org/), for example `feat(sim): add path placement command` or `chore: bump vitest`.

## Determinism rule

The simulation must replay identically from the same seed and the same command log. In `packages/sim/src`:

- No `Math.random`, `Math.sin`, or `Date.now`.
- All state-affecting math is integer.
- Every mutation is a logged command.

## Defining commands

Commands live in `packages/sim/src/commands` and are defined with `defineCommand`. See "Adding a command" below.

## Adding a command

Every change to a park is a command, so the UI, the CLI, agents, and replays all take the same path through `executeCommand`. The MCP server and the CLI `exec` command read the registry, so a registered command appears in both with no further work. Put the command in a file in `packages/sim/src/commands` (`finance.ts` is a small model) and give `defineCommand` these fields:

- `name`: two or more lowercase words joined by underscores, matching `/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/`, such as `terrain_raise`. By convention the first word is the category. The registry refuses a malformed or duplicate name.
- `description`: what it does, in a sentence or two. Agents read this as the tool description, so state the units (money is in integer cents) and the limits.
- `category`: one of the `Category` values in `define.ts`.
- `input`: a `z.object({...})`. It must be an object schema, because the MCP server builds the tool's parameters from it. Use `z.int()` with `.min` and `.max` for numbers, so a bad value fails before it reaches the world.
- `undoable`: `true` for every command except those named `sim_*` (time does not run backward) or `save_*`. An undoable command's `apply` returns the data `revert` needs. That data goes in the log, so it must be plain JSON and must not point into the world. `revert` must restore exactly what `apply` changed.
- `cost` (optional): `(world, input) => cents`, a non-negative integer, 0 if left out. The cost is charged when the command succeeds, refunded when it is undone, and charged again if it is redone, which can fail if the park can no longer pay.
- `validate`: returns the reason the command cannot run now, or `null`. It must not change the world.
- `apply`: changes the world and returns the undo data. `revert` undoes it.
- `validateRevert` (optional): returns the reason the command cannot be undone now, such as cash it would need to give back that the park has spent.

Then:

1. Register it in `packages/sim/src/registry-default.ts`.
2. Add tests in `packages/sim/test` for `validate`, for the cost, and for `apply` followed by undo, which must give back the same world hash.
3. Add a step for it to `packages/sim/test/golden/scenario-1.json`, and add its name to the coverage list in `packages/sim/test/golden.test.ts`. CI runs this scenario on Linux and macOS and requires the same hash on both.
4. Adding the step changes the recorded hash, so run `pnpm --filter @coasterworks/sim golden:update` and commit the new `scenario-1.hash` with the scenario. After that, run `golden:update` only when a change is meant to alter what the simulation does, never to make a failing golden test pass, and explain the new hash in the commit message.

## Adding a query

A query reads the world and never changes it, so it is not logged or undone. Define it with `defineQuery({ name, description, category, input, run })` in `packages/sim/src/queries`, follow the same name rule, and register it with `registry.registerQuery` in `registry-default.ts`; `run` may throw to report input it cannot answer, such as an area off the map.
