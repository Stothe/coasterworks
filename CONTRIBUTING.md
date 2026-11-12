# Contributing

## Setup

```sh
pnpm install
pnpm build
pnpm test
```

Tests run against the TypeScript in each package's `src`, so a change to `packages/sim` is tested without a rebuild. The few tests that spawn the built `coasterworks` bin (in `apps/cli`) need `dist`: they skip themselves, with a message, until `pnpm build` has run.

The browser smoke test (Playwright, in `apps/web/e2e`) drives the built web app, so it runs with `pnpm e2e` after `pnpm build`; install its browser once with `pnpm --filter @coasterworks/web exec playwright install chromium`. Each run saves its screenshot under `apps/web/test-results`; `UPDATE_SCREENSHOT=1 pnpm e2e` also refreshes the README's picture, `apps/web/e2e/__screenshots__/park.png`, which you commit only when the picture is meant to change. The desktop app's Rust checks run with `pnpm --filter @coasterworks/desktop cargo:test` (and `cargo:check`, `cargo:build`); the root `pnpm typecheck`, `pnpm build` and `pnpm test` do not run them, and CI runs them in the `desktop-build` job.

## Commits

Use [conventional commits](https://www.conventionalcommits.org/), for example `feat(sim): add path placement command` or `chore: bump vitest`.

## Determinism rule

The simulation must replay identically from the same seed and the same command log. In `packages/sim/src`:

- No `Math.random`, no clock (`Date()`, `new Date`, `Date.now`, `performance.now`), and none of the `Math` functions whose results can differ between JavaScript engines: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `pow`, `cbrt`, and `hypot`. `Math.sqrt`, `floor`, `round`, `min`, `max`, `abs`, `imul`, `trunc`, and `sign` are exactly specified, so they stay allowed. `packages/sim/test/lint-determinism.test.ts` fails on any of these in `packages/sim/src`, except in `hash.ts`.
- All state-affecting math is integer.
- Every mutation is a logged command.

The golden scenario runs on V8 (Node, on Linux and macOS in the `test` job) and on JavaScriptCore: the `golden-jsc` job runs `bun packages/sim/scripts/update-golden.ts` on macOS and fails if that rewrites `scenario-1.hash`, so the hash must come out the same on both engines. You can run the same check locally with Bun installed.

## Defining commands

Commands live in `packages/sim/src/commands` and are defined with `defineCommand`. See "Adding a command" below.

## Adding a command

Every change to a park is a command, so the UI, the CLI, agents, and replays all take the same path through `executeCommand`. The MCP server and the CLI `exec` command read the registry, so a registered command appears in both with no further work. Put the command in a file in `packages/sim/src/commands` (`finance.ts` is a small model) and give `defineCommand` these fields:

- `name`: two or more lowercase words joined by underscores, matching `/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/`, such as `terrain_raise`. By convention the first word is the category. The registry refuses a malformed or duplicate name.
- `description`: what it does, in a sentence or two. Agents read this as the tool description, so state the units (money is in integer cents) and the limits.
- `category`: one of the `Category` values in `define.ts`.
- `input`: a `z.object({...})`. It must be an object schema, because the MCP server builds the tool's parameters from it. Use `z.int()` with `.min` and `.max` for numbers, so a bad value fails before it reaches the world.
- `undoable`: `true` for every command except those named `sim_*` (time does not run backward). The `save_` prefix is reserved for MCP file tools, not registry commands: the registry refuses `save_write` and `save_load` as names. An undoable command's `apply` returns the data `revert` needs. That data goes in the log, so it must be plain JSON and must not point into the world. `revert` must restore exactly what `apply` changed.
- `cost` (optional): `(world, input) => cents`, a non-negative integer, 0 if left out. The cost is charged when the command succeeds, refunded when it is undone, and charged again if it is redone, which can fail if the park can no longer pay.
- `validate`: returns the reason the command cannot run now, or `null`. It must not change the world.
- `apply`: changes the world and returns the undo data. `revert` undoes it.
- `validateRevert` (optional): returns the reason the command cannot be undone now, such as cash it would need to give back that the park has spent.

Then:

1. Register it in `packages/sim/src/registry-default.ts`.
2. Add tests in `packages/sim/test` for `validate`, for the cost, and for `apply` followed by undo, which must give back the same world hash. Add an input for the command to the fixtures in `packages/sim/test/registry-undo.test.ts`, which fails by name until there is one and then checks that undo restores the hash.
3. Add a step for it to `packages/sim/test/golden/scenario-1.json`, and add its name to the coverage list in `packages/sim/test/golden.test.ts`. CI runs this scenario on Linux and macOS and requires the same hash on both.
4. Adding the step changes the recorded hash, so run `pnpm --filter @coasterworks/sim golden:update` and commit the new `scenario-1.hash` with the scenario. After that, run `golden:update` only when a change is meant to alter what the simulation does, never to make a failing golden test pass, and explain the new hash in the commit message.

## Adding a query

A query reads the world and never changes it, so it is not logged or undone. Define it with `defineQuery({ name, description, category, input, run })` in `packages/sim/src/queries`, follow the same name rule, and register it with `registry.registerQuery` in `registry-default.ts`; `run` may throw to report input it cannot answer, such as an area off the map.

## Adding a tile layer

A tile layer is a typed array with one value per tile, such as `water` or `path`. Adding one touches the same few places, in this order, and the save schema goes up by one. This is how `path` (0 none, 1 footpath, 2 queue) was added. Declare it on `Terrain` in `packages/sim/src/world/types.ts` and allocate it, zeroed, in `createWorld`. Cover it in `hashWorld` (`world/hash.ts`), after the layers already there, so two parks that differ only in that layer hash differently. In `save/codec.ts`, add it to the document's `terrain` block, to `saveSchema`, to `serializeWorld`, and to `deserializeWorld` (decoded with the map's `width * height`, like `surface`). Add a range check for its values to `validateWorldInvariants` in `save/invariants.ts`. Bump `SCHEMA_VERSION` and add `MIGRATIONS[n]` for the version it left behind: the migration gives an old document an empty layer (and any new state the layer comes with) and nothing else. The migrated save's stored `hash` is not compared, because it was computed over the old state, so check the migration another way: capture a save from the code before your change (`serializeWorld(createSamplePark(7))`, base64, in `packages/sim/test/fixtures/`), and test that it loads with the layer empty and that `hashWorld` of what it loads is a pinned value. Then add the tests the commands need (see "Adding a command"), and put the layer's commands in the golden scenario.

## Adding a guest field

Guests are stored as parallel typed arrays on `GuestStore` (`packages/sim/src/guests/types.ts`), one value per slot, so the tick loop allocates nothing. A new field goes in the same few places, and the save schema goes up by one. Add the array to `GuestStore`, to `GUEST_ARRAYS` (the list that compaction, `hashWorld` and the save all walk, so it is covered everywhere at once), and to `createGuestStore`; give it a starting value in `spawnGuest`; add its type to `guestsSchema` in `save/codec.ts` and a range check to `guestProblem` in `save/invariants.ts`; then bump `SCHEMA_VERSION` and add `MIGRATIONS[n]`, which gives an old document's guests the new field (an empty store only needs an empty array) and is checked against a fixture captured before the change, as for a tile layer. Two rules keep a park deterministic. Draw every random number from `world.rngStreams.guests`, in slot order. And never let behaviour depend on a slot number: the guest system packs the store at the start and end of every tick, which is why a saved and reloaded park carries on exactly as the original would, but a guest's slot changes when guests before it leave. Use its `id` where you need something per guest, as the needs do to stagger themselves.
