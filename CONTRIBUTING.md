# Contributing

## Setup

```sh
pnpm install
pnpm build
pnpm test
```

Tests run against the TypeScript in each package's `src`, so a change to `packages/sim` is tested without a rebuild. The few tests that spawn the built `coasterworks` bin (in `apps/cli`) need `dist`: they skip themselves, with a message, until `pnpm build` has run.

The browser smoke test (Playwright, in `apps/web/e2e`) drives the built web app, so it runs with `pnpm e2e` after `pnpm build`; install its browser once with `pnpm --filter @coasterworks/web exec playwright install chromium`. Each run saves its screenshot under `apps/web/test-results`; The README's picture, `apps/web/e2e/__screenshots__/park.png`, is taken on the real GPU by `node apps/web/scripts/readme-shot.mjs --port <n>` against `vite preview` of the built app (the script's header says how); commit it only when the picture is meant to change. `UPDATE_SCREENSHOT=1 pnpm e2e` can write it too, but the e2e browser paints in software at the cheapest quality, as CI does. The desktop app's Rust checks run with `pnpm --filter @coasterworks/desktop cargo:test` (and `cargo:check`, `cargo:build`); the root `pnpm typecheck`, `pnpm build` and `pnpm test` do not run them, and CI runs them in the `desktop-build` job.

## Commits

Use [conventional commits](https://www.conventionalcommits.org/), for example `feat(sim): add path placement command` or `chore: bump vitest`.

## Determinism rule

The simulation must replay identically from the same seed and the same command log. In `packages/sim/src`:

- No `Math.random`, no clock (`Date()`, `new Date`, `Date.now`, `performance.now`), and none of the `Math` functions whose results can differ between JavaScript engines: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `pow`, `cbrt`, and `hypot`. `Math.sqrt`, `floor`, `round`, `min`, `max`, `abs`, `imul`, `trunc`, and `sign` are exactly specified, so they stay allowed. `packages/sim/test/lint-determinism.test.ts` fails on any of these in `packages/sim/src`, except in `hash.ts`.
- All state-affecting math is integer.
- Every mutation is a logged command.

The golden scenario runs on V8 (Node, on Linux and macOS in the `test` job) and on JavaScriptCore: the `golden-jsc` job runs `bun packages/sim/scripts/update-golden.ts` on macOS and fails if that rewrites `scenario-1.hash`, so the hash must come out the same on both engines. You can run the same check locally with Bun installed. The sim imports `@coasterworks/content` through its built `dist`, so run `pnpm build` (or `pnpm --filter @coasterworks/content build`) before `golden:update` or the Bun check; the tests themselves read every package's `src`.

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

## The guest system

Guests live in `packages/sim/src/guests`. A guest is a slot in `GuestStore`, a set of parallel typed arrays (positions in 1/32 of a tile, needs and moods 0 to 255, cash in cents), so a park of 2,000 guests is a few dozen arrays and no objects. Each tick the guest system (`guestSystem` in `packages/sim/src/systems/guests.ts`, with the behavior in `guests/behavior.ts`) spawns arrivals at the entrance while the park is open, ages every guest's needs, lets each one think, and moves them: a guest heading somewhere follows the distance field `RouteCache` keeps for that tile (one breadth-first flood over the path tiles per destination and path version, shared by every guest going there), a guest with nowhere to go wanders to a random reachable tile, and a guest who cannot reach anything is `LOST` and gives up after `LOST_GIVE_UP` ticks. A guest who is unhappy, worn out or has been idle too long leaves through the entrance, and closing the park sends everyone inside home (`sendGuestsHome`). The renderer and the web app only draw guests and ask about them (`guest_list`, `guest_get`, `guest_thoughts`); they never decide anything for them. `packages/sim/test/perf.test.ts` holds the system to 2,000 guests on a map paved edge to edge (the worst case for routing), with three rides and three stalls: 100 ticks in under 500 ms in every test run, and 1,000 ticks in under 2 seconds with `PERF=1`, which CI runs on macOS. `PERF=1` also runs 2,000 guests in the sample park with ten rides and stalls (1,000 ticks in under 2 seconds) and 2,000 hungry guests among 90 stalls and 20 rides on a 256 by 256 map (under 2 ms a tick).

## Adding a thought

A thought is an id with a sentence and a mood, so saves store a number and the text can be translated later. To add one:

1. Give it the next free id in `THOUGHT` in `packages/sim/src/guests/thoughts.ts`, and add its `{ id, text, mood }` to `THOUGHTS` at that index. The text is what a player reads in the guest panel, so write it as the guest would say it. `mood` runs from -2 (miserable) to 2 (delighted). Never reuse or renumber an id: saved guests hold them.
2. Have a guest think it where it happens, in `behavior.ts`, with `think(world, slot, THOUGHT.YOUR_THOUGHT)`. Make it fire once when the condition starts (as the need thoughts do when a need crosses `NEED_THOUGHT_LEVEL`), not on every tick it holds. Any random number it needs comes from `world.rngStreams.guests`.
3. Test it in `packages/sim/test/guest-behavior.test.ts`: set up the condition, step the sim, and check `guest_thoughts` lists it. If it changes what happens in the golden scenario, run `golden:update` and explain the new hash in the commit message.

No save migration is needed: the thought array already holds any id.

## Adding a guest field

Guests are stored as parallel typed arrays on `GuestStore` (`packages/sim/src/guests/types.ts`), one value per slot, so the tick loop allocates nothing. A new field goes in the same few places, and the save schema goes up by one. Add the array to `GuestStore`, to `GUEST_ARRAYS` (the list that compaction, `hashWorld` and the save all walk, so it is covered everywhere at once), and to `createGuestStore`; give it a starting value in `spawnGuest`; add its type to `guestsSchema` in `save/codec.ts` and a range check to `guestProblem` in `save/invariants.ts`; then bump `SCHEMA_VERSION` and add `MIGRATIONS[n]`, which gives an old document's guests the new field (an empty store only needs an empty array) and is checked against a fixture captured before the change, as for a tile layer. Two rules keep a park deterministic. Draw every random number from `world.rngStreams.guests`, in slot order. And never let behaviour depend on a slot number: the guest system packs the store at the start and end of every tick, which is why a saved and reloaded park carries on exactly as the original would, but a guest's slot changes when guests before it leave. Use its `id` where you need something per guest, as the needs do to stagger themselves.

## Adding a ride or stall type

A new type is data, a model, and a look at it. In this order:

1. **Content.** Add an entry to `RIDE_TYPES` in `packages/content/src/rides.ts` or `STALL_TYPES` in `packages/content/src/stalls.ts`; the schema in `src/schema.ts` checks it when the module loads in tests. Money is in integer cents (prices at most $20.00), times in sim ticks (400 make a game day), ratings 0 to 999 (shown as 0.00 to 9.99). For a ride, give the entrance and exit as tile offsets from the footprint's top-left at rotation 0 (x right, y down); each must lie just outside the footprint, sharing an edge with it, and they must differ. For a stall, `front` is the side its service tile is on at rotation 0 (0 north to 3 west). Use a snake_case `id` and put the same id in `model`; the sim, the trays and `content_list` pick the type up from there.
2. **Recipe.** Add a function for the `model` id to `RECIPES` in `packages/render/src/rides/recipes.ts`: it returns a `RideModel` for a level of detail: shared geometry at rotation 0 made from three.js primitives (lathes, boxes, cylinders, instanced strips), filling the footprint and standing on the ground, its pick boxes, its `spinRate`, and an `instantiate` whose `pose(angle, motion)` moves only the parts that turn (a handful of matrix writes a frame). Colours come from the shared palette materials in `rides/materials.ts`. All art is original and procedural. `packages/render/test/rides.test.ts` fails for a content model with no recipe and holds every recipe to its triangle budget: under 2,000 at low detail, no more in software (SwiftShader, as on CI), and under 8,000 at high; it also checks that the model fills its footprint, disposes of everything, and is picked by its own boxes.
3. **Look at it.** With the web dev server running (`pnpm --filter @coasterworks/web exec vite --port 5273 --strictPort`), `node apps/web/scripts/lookdev-shot.mjs --port 5273 --preset rides --out /tmp/rides.png` builds one of every type on the sample park through the sim and photographs it on the GPU; open the picture and judge the new model beside the others, at `--query quality=low` too.

### How a ride reaches the screen

The sim keeps rides as a small list of plain records (`World.rides`), with each footprint marked in the `Terrain.occupant` layer. The host sends the list in a snapshot's JSON header only when `rideVersion` has changed since what that client last got (as it does for terrain and paths), and a binary ride status block on every snapshot: id, phase (idle, loading, running, unloading), ticks into the phase, riders and queue length, 10 bytes a ride. `useHost` exposes both to the web app; the viewport hands them to the scene (`setRides`, `setRideStatus`) as they change, and the renderer's `RideLayer` looks each status up by ride id (a ride with no status yet is drawn idle, since a status block can briefly be ahead of or behind the list), easing a running, open ride's motion up and an idle one's down in sim time. Nothing in `packages/render` or `apps/web` decides anything about a ride; they draw, place and ask (`ride_check`, `ride_get`).

### Queues and the platform

A ride's queue is its entrance tile, which is the loading platform and holds a full load (the ride's capacity, and never less than four guests), followed by every queue path tile joined to it edge to edge, ordered by steps from the entrance, four guests to a tile; guests join it from the first footpath tile beyond, line up in strict first-come order, and board from the platform while the ride is loading. A stall has no queue: guests walk to its service tile, stand there for its serve time, pay and go, several at once.
