# Plan D1: Paths and Guests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guests arrive at a park entrance, walk your paths, think, and leave; you lay paths and queues, set the entry fee, open the park, and watch the money come in. Everything is visible in the park, the inspector, the timeline and through MCP.

**Architecture:** The sim gains a path layer on tiles, a park entrance, and a guest system kept in struct-of-arrays typed arrays (integer positions in 1/32 tile units, integer needs 0..255, a seeded RNG stream) with BFS path routing over path tiles. Snapshots gain a binary guest section every tick batch and a JSON "objects" section (paths, entrance) sent when its version changes. The renderer draws paths as instanced tiles and guests as instanced capsules with per-instance color. The UI gains the Paths tray (drag to draw), the park entrance tool, guest and entrance inspector panels, and park-level numbers (guests, rating) in the pills and Overview. `packages/content` is created for guest appearance data; rides come in D2.

**Tech Stack:** as before (TypeScript, Zod 4, Vitest, three.js instancing, React 19, Playwright).

**Spec:** `docs/superpowers/specs/2026-10-16-coasterworks-design.md` (sections 4.1, 4.6 Paths and Guests, 5.3, 5.4, 5.5 binary snapshots, 6.1).

**Spec refinements made here:**
- Guest cap per park: 2,000 in this plan (the spec's 5,000 target is a Plan G performance item). Guest positions are integer 1/32 tile units; speed is 2 units per tick (2.5 tiles/s).
- Paths are a tile layer (`path: Uint8Array`, 0 none / 1 footpath / 2 queue) in this plan; elevated and underground paths, styles and additions are Plan 3 items. A tile may hold either a path or (later) a ride, never both.
- The park entrance is one tile on the map edge; guests spawn on the off-map side and walk through it. Exactly one entrance.
- Park rating in this plan is a simple 0..999 score from average guest happiness and litter-free (no litter yet) and crowding; the full RCT formula arrives with staff and vandalism.
- Guest thoughts are an enum of ids with a small template table, not free text, so saves stay small and the UI can localize later.

## Global Constraints

- Everything in Plans A to C's Global Constraints holds (determinism rules in `packages/sim/src` and `packages/protocol/src`; integer math; all mutations are logged, undoable commands unless `sim_*`/`save_*`; snake_case command names; conventional commits with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer; the full verification `pnpm format && pnpm typecheck && pnpm build && pnpm test && pnpm format:check && pnpm e2e` green at every commit; golden determinism scenario extended for every new command).
- Guest state lives in typed arrays inside `World.guests` (struct of arrays) and is saved like terrain (little-endian). No per-guest JS objects in the hot loop.
- Pathfinding results are cached per (target tile, path version) and invalidated when paths change; a single BFS flood fill from the target gives a distance field used by all guests heading there.
- Snapshot guest section: `Int32Array` ids, `Int32Array` x, `Int32Array` y (1/32 units), `Uint8Array` state, `Uint8Array` color, `Uint8Array` happiness, sent on every snapshot (periodic and on mutation); size at 2,000 guests ≈ 30 KB.
- Nothing in `apps/web` or `packages/render` may compute guest logic; they only draw and query.
- New UI strings are player-facing (no plan or task names).

## Review Focus

1. Removing a path tile that guests are standing on or routing through must not crash or strand them forever: they re-route or, with no route, walk to the nearest path tile and then wander; stuck guests get a "lost" thought and leave through the entrance when reachable. Test in Task 3.
2. Closing the park with guests inside must send them out, not freeze them, and the entry fee must not be charged to guests already inside. Test in Task 4.
3. A path built off the map edge, over the entrance tile, or over a tile that will hold a ride must be rejected with a reason; drag-drawing a path through the pond must be rejected per tile ("Cannot build on water") not for the whole drag. Test in Task 2 and Task 6.
4. Snapshot decoding must tolerate a guest count that changed between header and body (encode/decode from one consistent world) and reject a truncated guest section. Test in Task 5.
5. Undoing a path removal under a guest's feet must not duplicate or lose guests; undo restores the path tile only. Test in Task 3.

---

### Task 1: Path layer, entrance, park state, and their commands

**Files:**
- Modify: `packages/sim/src/world/types.ts` (add `Terrain.path: Uint8Array`, `World.park: ParkState`), `packages/sim/src/world/create.ts`, `packages/sim/src/world/hash.ts`, `packages/sim/src/save/codec.ts` + `invariants.ts` (schema bump to 2 with a migration from 1 that adds an empty path layer and a default park state; recompute the hash on migration), `packages/sim/src/registry-default.ts`, golden scenario
- Create: `packages/sim/src/park/types.ts`, `packages/sim/src/commands/path.ts`, `packages/sim/src/commands/park.ts`, `packages/sim/src/queries/park.ts` (extend `park_status`), `packages/sim/src/paths/paths.ts`
- Test: `packages/sim/test/path-commands.test.ts`, `packages/sim/test/park-commands.test.ts`, `packages/sim/test/save.test.ts` (migration 1→2)

**Interfaces:**
- `ParkState = { name: string; open: boolean; entryFee: number /* cents */; entrance: { x: number; y: number; side: 0|1|2|3 /* which map edge: 0 north (y=0), 1 east, 2 south, 3 west */ } | null; rating: number /* 0..999 */; guestsInPark: number; totalAdmissions: number; income: { entry: number; rides: number; shops: number }; expenses: { running: number; wages: number }; monthly: { entry: number; rides: number; shops: number; running: number; wages: number } }`.
- `paths.ts`: `PATH_NONE = 0, PATH_FOOT = 1, PATH_QUEUE = 2`; `pathAt(t, x, y)`, `canBuildPath(world, x, y): string | null` (reasons: `"Area is outside the park"`, `"Cannot build on water"`, `"Tile is too steep"` when the corner height difference exceeds 2 steps, `"Tile is the park entrance"`, `"Something is already here"` for future rides), `neighborsOnPath(t, x, y): Array<[x, y]>` (4-neighborhood of path tiles), `isEdgeTile(t, x, y)`.
- Commands (category `path`): `path_build { x, y, w, h, kind: "foot" | "queue" }` cost `PATH_COST = 10_00` per tile changed, validates every tile with `canBuildPath` and rejects the whole command when any tile fails (the UI drags per tile, see Task 6); `path_remove { x, y, w, h }` refund 0, cost 0; undo data `{ tiles: Array<[index, previous]> }`. Category `park`: `park_set_entrance { x, y }` (must be an edge tile, not water; sets `side` from the edge; cost `ENTRANCE_COST = 500_00`; placing a second time moves it; undoable), `park_set_entry_fee { cents: 0..100_00 }`, `park_open {}`, `park_close {}`, `park_rename { name: 1..40 chars }`.
- `park_status` adds `open`, `entryFee`, `entrance`, `rating`, `guestsInPark`, `totalAdmissions`, `income`, `expenses`, `monthly`.
- Save schema 2: migration `MIGRATIONS[1]` adds `terrain.path` (zeros) and `park` defaults (`open: false`, `entryFee: 10_00`, `entrance: null`, `rating: 500`, zeros), and the codec recomputes `hash` after migration (already: hash compared only when no migration ran).

- [ ] **Step 1: Tests**: `path_build` 2x2 foot costs 40_00 and sets four tiles; building over the pond is rejected with `"Cannot build on water"`; over a steep slope with `"Tile is too steep"`; over the entrance with the entrance reason; off-map (Review Focus 3); `path_remove` restores to none and undo restores the previous kinds; `park_set_entrance` on a non-edge tile fails `"The entrance must be on the park edge"`, on an edge tile sets `side`, moving it refunds nothing and charges again (`cost` applies), undo restores; `park_set_entry_fee` bounds; `park_open`/`park_close` toggle; a schema-1 fixture (write one with the pre-change `serializeWorld` captured as a base64 literal) loads with an empty path layer and default park state; the golden scenario gains path and park steps and the hash is updated with a note in the commit.
- [ ] **Step 2: Implement; run; PASS. Commit** `feat(sim): path layer, park entrance and state, path/park commands, save schema 2`.

---

### Task 2: Routing: distance fields over paths

**Files:**
- Create: `packages/sim/src/paths/routing.ts`
- Test: `packages/sim/test/routing.test.ts`

**Interfaces:**
- `class RouteCache { constructor(terrain: Terrain); invalidate(): void /* on any path change; the Sim calls it from path commands' apply/revert via world.pathVersion++ and a check */; distanceField(targetIndex: number): Uint16Array /* per tile: BFS steps to target over path tiles, 0xFFFF unreachable, computed once per (target, pathVersion) and cached (LRU of 64 fields) */; nextStep(fromIndex: number, targetIndex: number): number /* neighbor index with the smallest distance, or -1 */; nearestPathTile(x, y, maxRadius = 8): number /* -1 if none */ }`.
- `World.pathVersion: number` bumped by every path mutation (and by `park_set_entrance`); the route cache compares it.
- BFS uses a preallocated `Int32Array` queue sized to the tile count; no allocations per call after warm-up; deterministic neighbor order N, E, S, W.

- [ ] **Step 1: Tests**: a straight 10-tile path gives distances 0..9; a loop gives the shorter way; unreachable tiles are 0xFFFF; `nextStep` follows the gradient and prefers N,E,S,W order on ties (pin one case); invalidation after a path change recomputes; `nearestPathTile` finds the closest within the radius and returns -1 beyond it; a 256x256 all-path map flood fills in under 50 ms (perf guard, loose).
- [ ] **Step 2: Implement; PASS. Commit** `feat(sim): BFS distance fields over paths with a versioned route cache`.

---

### Task 3: Guests: data, generation, movement, needs, thoughts, leaving

**Files:**
- Create: `packages/sim/src/guests/types.ts`, `packages/sim/src/guests/guests.ts` (SoA storage and lifecycle), `packages/sim/src/guests/behavior.ts` (decisions), `packages/sim/src/guests/thoughts.ts`, `packages/sim/src/systems/guests.ts` (the System), `packages/sim/src/queries/guest.ts`
- Modify: `packages/sim/src/world/types.ts` (`World.guests: GuestStore`), `create.ts`, `world/hash.ts`, `save/codec.ts` + `invariants.ts` (guest arrays saved; schema stays 2 since this lands with Task 1 in the same plan: bump to 2 once, in Task 1, including guest arrays with zero count), `sim.ts` (systems order: time, finance, guests), `registry-default.ts`, golden scenario (guests appear when the park opens in the scenario)
- Test: `packages/sim/test/guests.test.ts`, `packages/sim/test/guest-behavior.test.ts`, `packages/sim/test/guest-queries.test.ts`

**Interfaces:**
- `GuestStore` (capacity `GUEST_CAP = 2000`): `count`, `nextGuestId`, and arrays of length cap: `id: Int32Array`, `x: Int32Array`, `y: Int32Array` (1/32 tile units; tile = `>> 5`), `tx: Int32Array`, `ty: Int32Array` (current step target tile, -1 none), `dest: Int32Array` (destination tile index or -1), `state: Uint8Array` (`ENTERING=0, WANDERING=1, HEADING=2, LEAVING=3, LOST=4, GONE=5`), `happiness, energy, hunger, thirst, bathroom, nausea: Uint8Array` (0..255), `cash: Int32Array` (cents), `color: Uint8Array` (0..8 palette index), `name: Uint16Array` (index into a generated-name table of 512 first names × 64 last names as two bytes), `thought: Uint8Array` (last thought id), `thoughtTick: Int32Array`, `sinceAction: Int32Array`. Free slots managed with a free-list; `count` is live guests.
- `guests.ts`: `spawnGuest(world, rng): number /* slot or -1 */` (at the entrance's off-map side, state ENTERING, needs randomized in bands, cash `20_00..80_00`), `removeGuest(world, slot)`, `forEachGuest(world, fn)`, `guestTile(world, slot)`, `moveToward(world, slot, speed = 2)` (straight-line steps toward the center of `tx,ty`; snaps when within speed).
- `behavior.ts`: `decide(world, slot, rng, routes)`: ENTERING → walk to the entrance tile, pay the fee (if `cash >= entryFee`, else turn around and leave with thought `TOO_EXPENSIVE`), become WANDERING; WANDERING → every `WANDER_INTERVAL = 120` ticks pick a random reachable path tile within 12 steps as `dest` (HEADING); HEADING → follow `routes.nextStep`; on arrival back to WANDERING; needs tick: hunger/thirst rise by 1 every 40 ticks, energy falls by 1 every 60 ticks, happiness drifts toward a baseline computed from needs; thoughts when a need crosses 200 (`HUNGRY`, `THIRSTY`, `TIRED`, `NEED_TOILET` — unsatisfiable until D2, so they lower happiness and eventually trigger leaving); when happiness < 60 or energy < 30 or `sinceAction > 6000` ticks → LEAVING (dest = entrance); LEAVING at the entrance → GONE (removed, `guestsInPark--`); LOST when no route exists to `dest` (Review Focus 1): walk to `nearestPathTile`, thought `LOST`, retry routing every 200 ticks, leave when the entrance becomes reachable.
- `thoughts.ts`: `THOUGHTS: Array<{ id: number; text: string; mood: -2..2 }>` (ids 0..31 reserved; include `GREAT_PARK`, `TOO_EXPENSIVE`, `HUNGRY`, `THIRSTY`, `TIRED`, `NEED_TOILET`, `LOST`, `CROWDED`, `NICE_VIEW`, `GOING_HOME`), `thoughtText(id)`.
- `systems/guests.ts`: `guestSystem.tick(world)`: spawn when `park.open && entrance` with probability from `park.rating` and `entryFee` (`spawnChance = rating/999 * (1 - entryFee/100_00) * 0.02` per tick, scaled by `GUEST_CAP - count`), then each guest: `decide` + `moveToward`; update `park.guestsInPark`, `park.rating` monthly-smoothed from average happiness; uses `world.rng.fork("guests")` ONCE at world creation (store the forked state in `World.rngStreams.guests` so saves preserve it).
- Queries (category `park`): `guest_list { limit: 1..500 = 100, state? }` → `[{ id, name, x, y, tile: {x,y}, state, happiness, energy, hunger, thirst, bathroom, nausea, cash, thought: { id, text } }]`; `guest_get { id }`; `guest_thoughts { limit: 20 }` → the most recent thoughts across guests with counts per thought id (what the park is thinking).
- Determinism: all randomness from the guests RNG stream; iteration order by slot index.

- [ ] **Step 1: Tests**: spawn places a guest at the entrance's off-map side with the right side offset; a guest pays the fee once and the park's `income.entry` rises (Review Focus 2's "not charged inside" is tested in Task 4); a guest with no cash turns around with `TOO_EXPENSIVE`; a guest walks a 10-tile path in `10*32/2 = 160` ticks; removing the only path under a HEADING guest makes it LOST then it reaches the entrance when the path is rebuilt (Review Focus 1); undo of `path_remove` keeps the guest count (Review Focus 5); needs rise at the specified rates; a guest with happiness < 60 leaves and is removed at the entrance; 2,000 guests tick in under 20 ms (perf guard); same seed → same hash after 5,000 ticks with 200 guests; save/load round-trips guest arrays and the stream state.
- [ ] **Step 2: Implement; PASS; update golden. Commit** `feat(sim): guests with needs, thoughts, routing, entry fee, and leaving; guest queries`.

---

### Task 4: Park finances with guests, rating, and the open/close flow

**Files:**
- Modify: `packages/sim/src/systems/finance.ts` (monthly roll-up of `park.monthly` into history), `packages/sim/src/systems/guests.ts`, `packages/sim/src/commands/park.ts`, `packages/sim/src/queries/park.ts` (`finance_summary` query)
- Test: `packages/sim/test/park-flow.test.ts`

**Interfaces:**
- `park_close` sets every guest to LEAVING; guests already inside are not charged again when the park reopens (ENTERING is the only state that pays) (Review Focus 2).
- `finance_summary {}` → `{ cash, loan, thisMonth: { entry, rides, shops, running, wages, net }, lastMonth: same | null, history: Array<{ year, month, net }> (last 12) }`; `World.park.history` ring of 12.
- Rating: `park.rating` = exponential moving average (per 400 ticks) of `avgHappiness * 999 / 255` with a penalty of up to 100 when `guestsInPark > 1500`.

- [ ] **Step 1: Tests**: open the park with an entrance and a path: guests arrive over 2,000 ticks and `income.entry` equals admissions × fee; close: all guests head out and `guestsInPark` reaches 0 within 3,000 ticks; reopen: existing guests (none) and no double charge for a guest that was inside when closed and is still leaving; month rollover moves `monthly` into `history` and resets; `finance_summary` shape.
- [ ] **Step 2: Implement; PASS; golden updated. Commit** `feat(sim): park open/close flow, finance summary, park rating`.

---

### Task 5: Protocol: guest and object sections in snapshots; host integration

**Files:**
- Modify: `packages/protocol/src/snapshot.ts` (sections), `packages/protocol/src/host.ts` (fill guest section every snapshot; objects section `{ paths?: Uint8Array /* when pathVersion changed */, park: ParkPublic }` by version), `packages/protocol/src/messages.ts` (`welcome` gains `protocol: 2`; bump `PROTOCOL_VERSION` to 2)
- Test: `packages/protocol/test/snapshot.test.ts`, `host.test.ts`

**Interfaces:**
- Snapshot layout v2: magic `CWS2`; header JSON gains `guestCount`, `pathVersion`, `hasPaths`, `park: { open, entryFee, entrance, rating, guestsInPark }`; after the terrain section (when present): the paths section (`Uint8Array` w*h, when `hasPaths`), then the guest section (always): `Int32Array id[guestCount]`, `Int32Array x`, `Int32Array y`, `Uint8Array state`, `Uint8Array color`, `Uint8Array happiness`, each little-endian with explicit byte copies. `decodeSnapshot` validates section lengths against `guestCount` and throws `ProtocolError` on truncation (Review Focus 4).
- Host: per-client `lastPathVersion` like terrain; `terrainVersion` no longer bumps on every mutation: bump only when a command's category is `terrain` (undo/redo of such, or `replaceWorld`); paths likewise by `world.pathVersion`. (This also retires Plan B's "resend terrain on every mutation".)

- [ ] **Step 1: Tests**: encode/decode round trip with 3 guests and paths; a truncated guest section throws; a world with 0 guests encodes an empty section; the host sends paths only to clients behind on `pathVersion`; a `finance_take_loan` does not resend terrain any more (pin the new behavior); a guest moving between two periodic snapshots shows a changed `x`.
- [ ] **Step 2: Implement; PASS. Commit** `feat(protocol): snapshot v2 with guest and path sections; version-gated terrain resend`.

---

### Task 6: Rendering: paths, entrance, guests

**Files:**
- Create: `packages/render/src/paths.ts` (instanced path tiles: a flat slab per tile at the tile's base height following the corner heights as a 2-triangle mesh with a path color, queue tiles striped), `packages/render/src/guests.ts` (`InstancedMesh` of capsules, 2,000 instances, per-instance color from the 9-color palette, position from the snapshot with interpolation between the last two snapshots over the snapshot interval), `packages/render/src/entrance.ts` (an arch: two posts and a lintel, plus a sign quad; color accent)
- Modify: `packages/render/src/scene.ts` (`setPaths(data)`, `setGuests(section)`, `setEntrance(e | null)`, `pickAt` also returns `guest?: { id }` when the ray hits a guest capsule within 0.4 units (CPU test against instance positions), `highlightTile` works for path placement too)
- Test: `packages/render/test/paths.test.ts` (geometry: path quad follows corner heights; queue stripes), `packages/render/test/guests.test.ts` (interpolation math pure function `interpolateGuests(prev, next, t)`), `packages/render/test/picker.test.ts` (guest pick radius)

- [ ] **Step 1: Tests as listed; implement; PASS. Commit** `feat(render): instanced paths and guests, entrance arch, guest picking`.

---

### Task 7: Web: Paths tray and tool, entrance tool, guests in the HUD and inspector

**Files:**
- Modify: `apps/web/src/state/useHost.ts` (`paths`, `guests`, `park` from snapshots), `apps/web/src/viewport/Viewport.tsx` (feed `setPaths`/`setGuests`/`setEntrance`; drag-to-draw for path placement: pointer down + move paints tiles one `path_build` per new tile, with a per-tile rejection toast aggregated as "N tiles skipped: cannot build on water" (Review Focus 3); click a guest → select `{ kind: "guest", id }`), `apps/web/src/ui/trays/PathsTray.tsx` (Footpath / Queue chips, Remove, brush 1 only, drag hint), `apps/web/src/ui/trays/ParkTray.tsx` (add "Place entrance" placement with `park_set_entrance`, Open/Close toggle, entry fee stepper), `apps/web/src/ui/StatusPills.tsx` (guests pill with count, rating pill with a 0..999 value and a colored dot), `apps/web/src/ui/inspector/{ParkOverview,GuestInspector,EntranceInspector}.tsx` (guest: name, needs as bars, happiness, cash, current thought and a mini history of the last 5 thoughts from events? No: from `guest_get` polled every second while open; entrance: fee stepper, open/close), `apps/web/src/actions/registry.ts` (new categories Paths and Park in the bar; `park_open` etc.), tests
- Create: `apps/web/src/ui/inspector/{GuestInspector,EntranceInspector}.tsx`, `apps/web/src/viewport/drawPath.ts` (pure: pointer path → tile list without duplicates), tests
- e2e: `apps/web/e2e/paths-guests.spec.ts`: press `2`, drag a path from the pond edge to the map edge, place the entrance at the drag's edge end via Park tray, open the park, set 8x speed, wait until the guests pill shows ≥ 1, click a guest → inspector shows "Guest" with needs, close the park → guests count goes to 0.

- [ ] **Step 1: Tests + implement; PASS. Commit** `feat(web): paths tray with drag-to-draw, park entrance and open/close, guests in pills and inspector`.

---

### Task 8: Sample park, headless demo script, docs, perf check

**Files:**
- Modify: `packages/sim/src/sample-park.ts` (adds a path from the entrance to the pond and around the hill, an entrance on the south edge, fee $5, park open), `README.md` (status sentence: guests arrive; the agent demo paragraph: `coasterworks new --sample`, `exec park_open`, `run --days 7`, `query guest_thoughts`), `CONTRIBUTING.md` (guest system overview; how to add a thought), `docs/superpowers/specs/...` (note schema 2, protocol 2)
- Create: `scripts/demo-headless.sh` (the README demo as a script, run by CI on ubuntu after build: asserts admissions > 0 after 7 days)
- Perf: `packages/sim/test/perf.test.ts` (2,000 guests, 1,000 ticks under 2 s; skipped unless `PERF=1`, run in CI on macos)

- [ ] **Step 1: Implement; PASS; `UPDATE_SCREENSHOT=1 pnpm e2e` to refresh the README picture with guests on paths. Commit** `feat: sample park with paths and an open entrance; headless demo script; docs`.

---

## Self-review notes

- Spec 4.6 Paths (tile layer, queues; additions/elevated deferred), Guests (needs, thoughts, routing, leaving; rides/shops/litter deferred to D2/3), Park (entrance, fee, open/close, rating, admissions), Finances (income by category, monthly history); 5.5 binary guest frames; 6.1 agent-visible via queries. Review Focus 1–5 have tests in T3, T4, T1/T6/T7, T5, T3.
- Names: `ParkState`, `PATH_FOOT/QUEUE`, `canBuildPath`, `RouteCache`, `distanceField`, `nextStep`, `GuestStore`, `GUEST_CAP`, `spawnGuest`, `decide`, `moveToward`, `guestSystem`, `guest_list/guest_get/guest_thoughts`, `finance_summary`, `CWS2`, `setPaths/setGuests/setEntrance`, `interpolateGuests`, `PathsTray`, `GuestInspector`, `EntranceInspector`, `drawPath`.
