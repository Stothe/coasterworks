# Plan D2: Rides and Stalls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** You place flat rides and stalls, join them to your paths with queues, open them and set their prices; guests pick a ride they like, queue for it, ride it, come off happier (or queasier), buy food and drinks when hungry or thirsty, use the toilets, and the money shows up in the monthly books. Everything is placeable from the Rides and Shops trays, inspectable, drawn in the modern look with original procedural models, and drivable through MCP and the CLI.

**Architecture:** A new `packages/content` holds ride and stall types as typed data validated by a Zod schema: footprint, cost, running cost, default price, capacity, cycle length, excitement/intensity/nausea, what a stall sells and which need it meets, and the name of a procedural model recipe. The sim gains a ride store (`World.rides`, a small array of plain JSON records, since a park holds tens of rides, not thousands), a tile occupancy layer (`Terrain.occupant: Uint16Array`, 0 free, else ride id) that paths and other rides respect, ride commands and queries, a queue model derived from queue path tiles joined to a ride's entrance, a ride operation system (load, run, unload, a phase per ride), and new guest states (QUEUING, RIDING, BUYING) with ride choice and need-driven stall visits. Snapshots gain a rides objects section (sent when `rideVersion` changes) and a small per-snapshot ride status block (phase, riders, queue length). The renderer draws each ride type from a recipe of primitives in the modern look and animates it from the phase; the UI gains Rides and Shops trays with cards, a rotate-able placement ghost, and a ride inspector.

**Tech Stack:** as before (TypeScript, Zod 4, Vitest, three.js, React 19, Playwright).

**Spec:** `docs/superpowers/specs/2026-10-16-coasterworks-design.md` (4.1 elements on a tile, 4.4 Rides/Shops trays and inspector, 4.6 Rides (Gentle, Thrill, Shops and stalls), Ride operation, Guests, Finances; 4.7 content model; 5.3, 5.5, 6.1) and `docs/superpowers/specs/2026-11-11-modern-look-design.md` (materials, palette, quality tiers, picking).

**Spec refinements made here:**
- Six types in this plan, all original names and original procedural models: three flat rides — **Carousel** (gentle, 3x3), **Big Wheel** (gentle, 2x4), **Swing Tower** (thrill, 3x3) — and three stalls (1x1) — **Snack Stand** (food, meets hunger), **Drinks Stand** (drink, meets thirst), **Restrooms** (meets bathroom). More types are data files later.
- Breakdown-free: rides never break down, have no reliability, inspection or mechanics in this plan (Plan for staff). Operating mode is one fixed cycle per type (load, run `cycleTicks`, unload); no min/max wait settings yet.
- A ride has one entrance tile and one exit tile, fixed by the type relative to the footprint and rotated with it, both outside the footprint. A queue is the chain of `PATH_QUEUE` tiles joined edge to edge to the entrance tile; the first non-queue path tile beyond it is where guests join. A ride with no queue tile still works: guests reaching the entrance tile from a footpath queue on it (capacity one tile).
- Stalls have no queue: a guest walks to the stall's service tile (the path tile in front of it), stands `serveTicks`, pays, and goes. Several guests may be served at once.
- Prices: ride price per ride and stall item price, in cents, 0..20_00. Pay-per-ride and the entry fee coexist (RCT's either/or switch is a later item).
- Ratings (excitement, intensity, nausea, 0..999 like RCT's x.xx scale ×100) are fixed per type in content for flat rides; coaster ratings arrive in Plan E.
- Demolishing refunds half the build cost; undo of a demolish restores the ride exactly (including id, stats and price) and takes the refund back.
- Rides are a JSON record list (not struct-of-arrays): at most `RIDE_CAP = 255` rides and stalls; per-ride queues are `Int32Array`-free plain arrays of guest ids in the record, saved as JSON.

## Global Constraints

- Everything in Plans A to D1's Global Constraints holds: determinism rules in `packages/sim/src`, `packages/content/src` and `packages/protocol/src` (no `Math.random`, `Date`, floats in sim state, or iteration over unordered structures); integer math; every mutation is a logged command, undoable unless `sim_*`/`save_*`; snake_case command names; conventional commits with the `Co-Authored-By` and `Claude-Session` trailers used on this branch; the full verification `pnpm format && pnpm typecheck && pnpm build && pnpm test && pnpm format:check && pnpm e2e` green at every pushed commit; the golden determinism scenario extended for every new command, with the re-recorded hash noted in the commit.
- `packages/content` depends on nothing but Zod. The sim imports content as data; nothing in content runs at tick time.
- All art is original and procedural (primitives, lathes, extrusions in `packages/render`), in the modern look's palette and materials; no names, models, colours or layouts taken from any existing game. Type names are generic descriptive words.
- The software render tier (SwiftShader on CI, 4 vCPU) must stay cheap: each ride model is under 2,000 triangles at low, shares materials, casts no shadows at low, and animates on the CPU with at most a handful of matrix updates per ride per frame. The e2e suite must not grow by more than about 30 s.
- Nothing in `apps/web` or `packages/render` computes ride or guest logic; they draw, place and query.
- New UI strings are player-facing.

## Review Focus

1. A ride or stall can never overlap a path, the entrance, water, another ride, or the map edge ring; a path can never be laid on a ride tile ("Something is already here"); demolish then undo restores occupancy exactly. Test in Task 2.
2. Demolishing (or closing) a ride with guests queuing or riding must not strand, duplicate or lose guests: riders are unloaded at the exit (or, if the exit is gone, onto the nearest path tile), queuers leave the queue and wander, and their state arrays stay consistent. Undoing the demolish restores the ride empty. Test in Task 3.
3. Queue order is strict FIFO and survives save/load mid-cycle with an identical continuation (hash equality after N ticks against an unsaved twin). Test in Task 3.
4. A guest never pays for a ride it does not board or a stall it is not served by; ride and shop income in `park.income`, `park.monthly` and the month history add up to what guests paid. Test in Task 4.
5. The snapshot ride status block tolerates rides being added or removed between snapshots and rejects a truncated block. Test in Task 5.
6. Picking a ride in the 3D view selects that ride (not the tile under it, not a guest on the path in front), at every quality tier. Test in Task 6.

---

### Task 1: `packages/content`: ride and stall types as data

**Files:**
- Create: `packages/content/package.json`, `tsconfig.json`, `src/index.ts`, `src/schema.ts`, `src/rides.ts`, `src/stalls.ts`, `test/content.test.ts`
- Modify: `pnpm-workspace.yaml` (if needed), root `tsconfig`/vitest config, `packages/sim/package.json` (depend on `@coasterworks/content`), `CONTRIBUTING.md` (how to add a type)

**Interfaces:**
- `RideTypeSchema` (Zod): `{ id: string /* snake_case */, kind: "ride", category: "gentle" | "thrill", name, description, footprint: { w, h }, entrance: { x, y }, exit: { x, y } /* offsets from the footprint's top-left at rotation 0, outside the footprint, edge-adjacent */, cost /* cents */, runningCost /* cents per month */, defaultPrice, capacity /* riders per cycle */, loadTicks, cycleTicks, excitement, intensity, nausea /* 0..999 */, model: string /* recipe id */ }`.
- `StallTypeSchema`: `{ id, kind: "stall", category: "food" | "drink" | "facility", name, description, footprint: { w: 1, h: 1 }, front: 0|1|2|3 /* side the service tile is on at rotation 0 */, cost, runningCost, defaultPrice, serveTicks, meets: "hunger" | "thirst" | "bathroom", amount /* need reduced by */, model }`.
- `RIDE_TYPES`, `STALL_TYPES`, `ALL_TYPES` (frozen arrays, validated at module load in tests, not at runtime in the sim), `typeById(id)`, `rotateOffset({x,y}, footprint, rot)` (pure integer helper used by sim and render: rot 0..3 clockwise).
- Data: carousel (3x3; entrance (1,3) below the middle of the south side, exit (3,1) beside the east side), big_wheel and swing_tower likewise with entrance and exit on different sides (the implementer documents each offset in the data file), big_wheel (2x4), swing_tower (3x3), snack_stand, drinks_stand, restrooms, with costs in the $800–$4,000 range for rides and $300–$600 for stalls, running costs $20–$80/month.

- [ ] **Step 1: Tests**: every type parses with its schema; ids unique and snake_case; entrance/exit outside the footprint and edge-adjacent; entrance ≠ exit; `rotateOffset` four rotations return to the start and keep offsets edge-adjacent; integer-only numbers.
- [ ] **Step 2: Implement; run the full verification; PASS. Commit** `feat(content): ride and stall types as data`.

---

### Task 2: Sim: ride store, occupancy, build/demolish/open/close/price commands, queries, save schema 5

**Files:**
- Create: `packages/sim/src/rides/types.ts`, `rides/rides.ts` (footprint tiles, `canPlaceRide`, occupancy set/clear), `commands/ride.ts`, `queries/ride.ts`
- Modify: `world/types.ts` (`Terrain.occupant: Uint16Array`, `World.rides: RideRecord[]`, `World.nextRideId`, runtime-only `World.rideVersion`), `world/create.ts`, `hash.ts`, `save/codec.ts` + migrations + `invariants.ts` (schema 5; `MIGRATIONS[4]` adds an empty occupant layer and no rides), `paths/paths.ts` (`canBuildPath` returns `"Something is already here"` on an occupied tile — the reserved slot), `commands/park.ts` (`park_set_entrance` refuses an occupied tile), `registry-default.ts`, golden scenario
- Test: `packages/sim/test/ride-commands.test.ts`, `save.test.ts` (4→5 fixture), `path-commands.test.ts`

**Interfaces:**
- `RideRecord = { id: number; type: string; x: number; y: number; rot: 0|1|2|3; name: string; open: boolean; price: number; phase: number /* 0 idle, 1 loading, 2 running, 3 unloading */; phaseTicks: number; riders: number[]; queue: number[]; stats: { customers: number; income: number; runningCost: number; monthCustomers: number; monthIncome: number } }`. Names default to the type name plus a number ("Carousel 1").
- `canPlaceRide(world, type, x, y, rot): string | null` — reasons: `"Area is outside the park"` (footprint or entrance/exit tile off the map or on the edge ring), `"Cannot build on water"`, `"Ground is not flat"` (all footprint corners equal), `"Something is already here"` (path, entrance, or occupied), `"Too many rides"`.
- Commands (category `ride`): `ride_build { type, x, y, rot }` (flat rides only; cost from content), `stall_build { type, x, y, rot }` (category `shop`; stalls only), `ride_demolish { id }` (rides and stalls; refunds half the cost as a negative charge recorded in the undo data; undoable), `ride_open { id }`, `ride_close { id }`, `ride_set_price { id, cents: 0..20_00 }`, `ride_rename { id, name: 1..40 }`. Every apply/revert bumps `rideVersion`.
- Queries: `ride_list {}` → `[{ id, type, kind, name, x, y, rot, open, price, queueLength, riders }]`; `ride_get { id }` → full record plus content stats and entrance/exit tile coordinates; `content_list { kind?: "ride" | "stall" }` → the content types (name, category, cost, footprint, ratings).
- `park_status` gains `rides` and `stalls` counts.

- [ ] **Step 1: Tests** (Review Focus 1): building each type on flat grass charges its cost and occupies exactly its footprint; refusals for water, slope, path, entrance, overlap, edge, off-map; `path_build` over a ride tile refused; demolish frees the tiles and refunds half; undo of demolish restores record, id and occupancy and takes back the refund; open/close/price/rename with undo; ids never reused; schema-4 fixture loads with no rides; the golden scenario gains ride and stall steps.
- [ ] **Step 2: Implement; run; PASS. Commit** `feat(sim): ride store, tile occupancy, ride and stall commands, save schema 5`.

---

### Task 3: Sim: queues and ride operation

**Files:**
- Create: `packages/sim/src/rides/queue.ts` (queue tiles of a ride: flood over `PATH_QUEUE` tiles from the entrance tile, ordered by distance; cached by `pathVersion` + `rideVersion`), `systems/rides.ts`
- Modify: `guests/types.ts` (states `QUEUING: 6`, `RIDING: 7`; arrays `ride: Int32Array` /* ride id queued for or riding, 0 none */, `intensityPref: Uint8Array`, `lastRide: Int32Array`, `queueTicks: Int32Array`), `guests/guests.ts`, `guests/behavior.ts`, `sim.ts` (system order: finance, rides, guests), save schema 6 (`MIGRATIONS[5]` adds the guest arrays with defaults; intensity preference derived deterministically from the guest id for migrated guests), `commands/ride.ts` (demolish/close eject riders and queuers)
- Test: `packages/sim/test/ride-operation.test.ts`, `queue.test.ts`

**Behavior:**
- A guest heading to a ride routes to the ride's entrance tile (the route cache already takes any target tile; queue tiles are walkable). On stepping onto one of that ride's queue tiles or its entrance tile it becomes QUEUING and is appended to `ride.queue`; its standing tile is `queueTiles[floor(position / QUEUE_PER_TILE)]` (`QUEUE_PER_TILE = 4`), and it walks forward as the queue moves. A guest that has queued `QUEUE_PATIENCE = 2400` ticks leaves the queue (thought "This queue is too long") and wanders.
- Ride cycle per tick: idle with a non-empty queue and the ride open → loading for `loadTicks`, boarding up to `capacity` guests from the front who are standing at the entrance tile and can pay `price` (a guest who cannot pay leaves the queue with "I can't afford this"); paid money goes to `park.income.rides`, `park.monthly.rides`, `ride.stats`; boarded guests become RIDING (position frozen at the ride's centre, hidden by the renderer); then running `cycleTicks`; then unloading: riders go to the exit tile as WANDERING with happiness += excitement-based amount, nausea += nausea-based amount, `lastRide = id`, a ride thought ("That was fun!" / "I feel sick"), and the ride returns to idle.
- Closing a ride: queuers leave the queue and wander; current riders finish the cycle. Demolishing: riders are put on the exit tile (or the nearest path tile if none) at once, queuers released, then the record goes. Running cost: `runningCost / 28` per day accrued to `park.expenses.running`/`monthly.running` and `ride.stats.runningCost` while the ride exists (open or closed), using integer division with the remainder carried so a month totals exactly `runningCost`.

- [ ] **Step 1: Tests** (Review Focus 2, 3): FIFO order with three guests; capacity limits boarding; a guest without cash is refused and not charged; ride income equals price × boarded; closing mid-queue releases guests; demolishing mid-ride puts riders on the exit and leaves arrays consistent (invariants); undo of the demolish restores an empty, idle ride; save at mid-cycle and reload gives the same hash as an unsaved twin after 2,000 ticks; queue patience; schema-5 fixture loads.
- [ ] **Step 2: Implement; run; PASS. Commit** `feat(sim): queues and ride operation`.

---

### Task 4: Sim: guests choose rides and stalls; needs; finances

**Files:**
- Modify: `guests/types.ts` (state `BUYING: 8`; no new arrays: the stall being used is `ride`), `guests/behavior.ts` (`decide`), `guests/thoughts.ts` (new ids from 12: RIDE_FUN, RIDE_SICK, QUEUE_TOO_LONG, CANT_AFFORD_RIDE, TOO_INTENSE, GOOD_FOOD, REFRESHING, BETTER_NOW, NOTHING_TO_EAT, NOTHING_TO_DRINK, NO_TOILETS), `systems/rides.ts` (stall service), `systems/finance.ts` (month roll-up already carries rides/shops/running; per-ride month stats reset at month start), `systems/guests.ts` (rating gains a small ride-variety term), `queries/park.ts` (`finance_summary` breaks out ride and shop income and running costs), `queries/guest.ts` (`guest_get` shows the ride it is queuing for or on)
- Test: `packages/sim/test/guest-choice.test.ts`, `finance.test.ts`

**Behavior:**
- When a WANDERING guest decides: if hunger, thirst or bathroom is over `NEED_SEEK_LEVEL = 160`, it heads for the nearest reachable open stall that meets that need (distance field from the stall's service tile; nearest by distance, ties by ride id); if none, the "nothing to eat/drink"/"no toilets" thought and wander. Otherwise, with chance 1/2, it picks a ride: open, reachable, not `lastRide`, intensity within `intensityPref ± 300`, queue length under `capacity × 6`; among those, the one with the best `excitement - |intensity - pref| / 2 - distance × 4`, ties by id. Else it wanders as in D1.
- A guest on a stall's service tile is BUYING for `serveTicks` (it stands still), then pays `price` (if it can; else "I can't afford this", not charged), the need drops by `amount`, happiness rises a little, a thought; income to `park.income.shops`, `monthly.shops` and the stall's stats.
- Too intense (ride intensity above pref + 300) when chosen through `ride_get`-free play never happens; a guest that ends up in a queue for one (agent-forced later) leaves with TOO_INTENSE.

- [ ] **Step 1: Tests** (Review Focus 4): a hungry guest with a reachable snack stand walks there, pays once and is less hungry; no stall → thought, no charge; a guest prefers the nearer of two equal rides; `lastRide` stops an immediate repeat; month roll-up history row has `rides` and `shops` equal to the sum of payments that month and `running` equal to the rides' running costs; `finance_summary` figures; golden re-recorded with a note.
- [ ] **Step 2: Implement; run; PASS. Commit** `feat(sim): guests choose rides and stalls, needs met, ride and shop finances`.

---

### Task 5: Protocol and host: rides in snapshots; CLI and MCP

**Files:**
- Modify: `packages/protocol/src/snapshot.ts` (magic `CWS3`; the JSON header gains `rideVersion` and `hasRides`, and `rides: [{ id, type, x, y, rot, name, open, price }]` only when the client is behind on `rideVersion`, gated exactly like `pathVersion`/`hasPaths` and with the delivery versions captured per frame; a binary ride status section after the guests on every snapshot: `Int32 id, Uint8 phase, Uint16 phaseTicks, Uint8 riders, Uint16 queue` per ride, 10 bytes each), `host.ts`, `client.ts`, `PROTOCOL_VERSION = 3`, `apps/web/src/host/*` (`useHost` exposes `rides` and `rideStatus`), `packages/mcp` tests (catalog includes the new commands and queries with schemas), `apps/cli` (`coasterworks run` prints ride/stall counts in its summary), `scripts/demo-headless.sh` (builds a carousel and a snack stand with a queue and shows income after a month)
- Test: `packages/protocol/test/snapshot.test.ts`, `host.test.ts`, `packages/mcp/test/*`

- [ ] **Step 1: Tests** (Review Focus 5): encode/decode round trip with 0, 1 and 255 rides; a ride removed between two snapshots disappears from the next status block; truncated block rejected; terrain/path resend gating unchanged; MCP `catalog_list` lists `ride_build`, `stall_build`, `ride_*`, `ride_list`, `ride_get`, `content_list`; an MCP-driven build-open-advance run earns ride income.
- [ ] **Step 2: Implement; run; PASS. Commit** `feat(protocol): rides in snapshots; ride commands over MCP and the CLI`.

---

### Task 6: Render: procedural ride and stall models in the modern look

**Files:**
- Create: `packages/render/src/rides/recipes.ts` (one recipe per content `model` id: carousel — a lathed canopy and platform with poles and simple seat blocks; big wheel — a rim torus, spokes, gondola boxes; swing tower — a column with a rotating crown and chains as thin cylinders; snack/drinks stands — a kiosk box with a striped awning band made of alternating instanced strips and a counter; restrooms — a small block with a pitched roof), `rides/rides.ts` (`RideLayer`: builds one group per ride from its recipe, places it on the terrain height at the footprint, rotates by `rot`, animates from phase and `phaseTicks`, disposes on removal; placement ghost from the same recipe, tinted red when the sim would refuse), `rides/materials.ts` (shared palette materials)
- Modify: `scene.ts` (`setRides`, `setRideStatus`, `setPlacementGhost(type, x, y, rot, ok)`, `pickRideAt`), `picker.ts`, `quality.ts` (rides at low: no shadows, merged static geometry), `apps/web/src/lookdev/*` (a lookdev preset with every type)
- Test: `packages/render/test/rides.test.ts` (recipes build under the triangle budget at each tier; geometry/material disposal counts back to zero after remove; picking a ride returns its id at three camera angles; ghost toggles), a lookdev shot in `docs/superpowers/shots/` (JPEG)

- [ ] **Step 1: Tests** (Review Focus 6). **Step 2: Implement; run; PASS. Commit** `feat(render): procedural rides and stalls, animation, placement ghost, ride picking`.

---

### Task 7: Web: Rides and Shops trays, placement, ride inspector

**Files:**
- Create: `apps/web/src/ui/trays/RidesTray.tsx` (category chips Gentle/Thrill, cards with name, price, footprint; from `content_list`), `ShopsTray.tsx` (Food/Drink/Facilities), `apps/web/src/ui/inspector/RideInspector.tsx` (tabs Overview: status, open/close, price stepper with commit-on-blur, rename; Stats: customers, income this month and all time, running cost, queue length, riders; ratings for rides), `apps/web/e2e/rides.spec.ts`
- Modify: `uiStore.ts` (placement carries `rot`; `R` rotates), `Viewport.tsx` (ghost follows the pointer; click places; picking a ride opens its inspector), `Dock.tsx` (Rides and Shops enabled), `registry.ts` labels, `GuestInspector.tsx` (shows "Queuing for Carousel 1" / "On Big Wheel 1"), `StatusPills`/`ParkOverview` (ride and stall counts)
- Test: component tests for trays and the inspector; e2e: open the Rides tray, place a Carousel on the sample park's free flat area, open it, see it in the inspector with its price; keep the spec under 20 s on CI.

- [ ] **Step 1: Tests. Step 2: Implement; run; PASS. Commit** `feat(web): rides and shops trays, placement with rotation, ride inspector`.

---

### Task 8: Sample park, docs, perf

**Files:**
- Modify: `packages/sim/src/sample-park.ts` (a carousel and a big wheel with short queues off the main path, a snack stand, a drinks stand and restrooms; all open; sample-park tests check guests ride and buy within two in-game days), `README.md` (rides and stalls; refreshed picture), `CONTRIBUTING.md` (adding a ride type: content entry + recipe), the design spec (refinements above), `docs/superpowers/plans/2026-10-16-roadmap.md` (D split into D1/D2), the perf test (2,000 guests with 10 rides stays within the existing tick budget)
- [ ] **Step 1: Implement; run; PASS. Commit** `feat: sample park with rides and stalls; docs; perf check`.

## Self-review notes

- Spec 4.6 Rides (gentle, thrill subsets), Shops and stalls (food, drink, toilets), Ride operation (build, open, close, demolish, pricing, customers, income, running cost, ratings, queue length; breakdowns and modes deferred), Guests (ride choice, queueing, queue patience, buying, needs met), Finances (ride and shop income, running costs, monthly roll-up); 4.7 content as data; 4.2 procedural recipes. Review Focus 1–6 are tested in T2, T3, T3, T4, T5, T6.
- Names: `@coasterworks/content`, `RideTypeSchema`, `StallTypeSchema`, `rotateOffset`, `RideRecord`, `Terrain.occupant`, `canPlaceRide`, `ride_build`, `stall_build`, `ride_demolish/open/close/set_price/rename`, `ride_list`, `ride_get`, `content_list`, `QUEUING`, `RIDING`, `BUYING`, `QUEUE_PER_TILE`, `QUEUE_PATIENCE`, `NEED_SEEK_LEVEL`, `RideLayer`, `RidesTray`, `ShopsTray`, `RideInspector`.
- Schema bumps twice (5 in T2, 6 in T3), as D1 did, so each task's save change has its own fixture.
