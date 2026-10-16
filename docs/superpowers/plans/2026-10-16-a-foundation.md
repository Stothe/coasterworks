# Plan A: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic park simulation core with terrain, time, a command registry with undo and a log, queries, save/load, a headless CLI, and an MCP server, in a pnpm monorepo with CI.

**Architecture:** `packages/sim` owns the world and every command and query (schema, description, validate, apply, revert together). `packages/mcp` turns the sim's catalog into MCP tools. `apps/cli` runs the sim headless and hosts the MCP server. All state-affecting math is integer. Every mutation is a logged command.

**Tech Stack:** TypeScript 5 (strict, ESM, NodeNext), Node 22, pnpm 10 workspaces, Vitest, Zod 4, `@modelcontextprotocol/sdk` 1.x, `fflate` for gzip, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-16-coasterworks-design.md` (sections 5.1 to 5.4, 6.1, 6.2, 7, 9).

**Spec refinements made here:**
- Calendar follows RCT: eight months, March to October, 31 days each. The spec's "four seasons of one month each" is replaced. 1 day = 400 ticks (10 s at 1x). A month is about 5 minutes at 1x.
- Command and query names are `snake_case` with a domain prefix (`terrain_raise`, `park_status`), never dotted, because MCP and Claude tool names must match `^[a-zA-Z0-9_-]{1,64}$`.
- Terrain is a shared-corner heightmap: `(w+1)*(h+1)` corner heights in half-unit steps, 0 to 63. Tiles render as two flat-shaded triangles. No RCT slope-type enum.
- Money is integer cents. Positions, when they arrive in Plan D, are integer 1/32 tile units.

## Global Constraints

- Node `>=22`, pnpm `>=10`, TypeScript `>=5.6`, `"type": "module"` everywhere, `moduleResolution: NodeNext`, `strict: true`, `noUncheckedIndexedAccess: true`.
- Package names: `@coasterworks/sim`, `@coasterworks/mcp`; CLI package `coasterworks` with bin `coasterworks`.
- No `Math.random`, `Math.sin`, `Math.cos`, `Date.now`, or floating-point accumulation in `packages/sim/src` except in `hash.ts` and tests. A lint test greps for them (Task 2).
- Command names match `/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/`.
- Every command is undoable unless `undoable: false`; `undoable: false` is allowed only for `sim_*` and `save_*` commands.
- Commits: conventional commits, each task ends in a commit, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- License: MIT (`LICENSE`), assets CC BY 4.0 (`LICENSE-ASSETS`).

## Review Focus

1. A command whose rectangle runs off the map edge (`x + w > width`) must be rejected with a reason, not clamp silently or throw. Test in Task 5.
2. Undoing a terrain change after ticks have passed must still work when nothing depends on it, and the log must show the `undo` entry. Test in Task 6.
3. Loading a save written by a newer `schemaVersion` must fail with a clear error, not produce a half-loaded world. Test in Task 8.
4. The MCP server must reject a tool call whose input fails the schema with an `isError` result carrying the Zod message, and leave the world unchanged. Test in Task 11.
5. `sim_advance` with a huge day count must be bounded (max 3650) so an agent cannot hang the app. Test in Task 6.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.npmrc`, `.prettierrc`, `.editorconfig`, `LICENSE`, `LICENSE-ASSETS`, `README.md`, `CONTRIBUTING.md`
- Create: `packages/sim/package.json`, `packages/sim/tsconfig.json`, `packages/sim/src/index.ts`
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/src/index.ts`
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/src/index.ts`
- Modify: `.gitignore` (add `dist/`, `coverage/`, `*.tsbuildinfo`)

**Interfaces:**
- Produces: root scripts `pnpm typecheck` (runs `tsc -b` per package), `pnpm test` (vitest run), `pnpm build` (tsc -b), `pnpm format`.

- [ ] **Step 1: Write root `package.json`** with `"private": true`, `"type": "module"`, `packageManager: "pnpm@10"`, `engines.node: ">=22"`, scripts `typecheck`, `test`, `test:watch`, `build`, `format`, `format:check`; devDependencies `typescript ^5.6`, `vitest ^3`, `prettier ^3`, `@types/node ^22`.
- [ ] **Step 2: Write `pnpm-workspace.yaml`** with `packages: ["packages/*", "apps/*"]`.
- [ ] **Step 3: Write `tsconfig.base.json`**: `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `declaration`, `composite`, `sourceMap`, `skipLibCheck`, `lib: ["ES2022"]`.
- [ ] **Step 4: Write the three package skeletons.** Each `package.json` has `name`, `version 0.0.0`, `type module`, `main ./dist/index.js`, `types ./dist/index.d.ts`, `exports`, scripts `build: tsc -b`, `typecheck: tsc -b --noEmit false`. `apps/cli/package.json` adds `"bin": {"coasterworks": "./dist/index.js"}` and depends on `@coasterworks/sim` and `@coasterworks/mcp` via `workspace:*`. `packages/mcp` depends on `@coasterworks/sim` `workspace:*`. Each `tsconfig.json` extends the base with `rootDir src`, `outDir dist`, `references` to dependencies. Each `src/index.ts` exports `export const VERSION = "0.0.0";` for now (cli's has a `#!/usr/bin/env node` shebang and `console.log(VERSION)`).
- [ ] **Step 5: Write `vitest.workspace.ts`** listing `packages/*/vitest.config.ts` and `apps/*/vitest.config.ts`; add a `vitest.config.ts` to each package with `test.include: ["test/**/*.test.ts"]`.
- [ ] **Step 6: Write `LICENSE` (MIT, copyright 2026 Steve Kryworuka and contributors), `LICENSE-ASSETS` (CC BY 4.0 notice pointing to the full text URL), `README.md` (name, one-paragraph description from the spec's intent, "status: pre-alpha", dev setup commands), `CONTRIBUTING.md` (setup, conventional commits, the determinism rule, how commands are defined).**
- [ ] **Step 7: Install and verify**

Run: `pnpm install && pnpm typecheck && pnpm build && node apps/cli/dist/index.js`
Expected: install succeeds, typecheck and build succeed, CLI prints `0.0.0`.

- [ ] **Step 8: Commit** `chore: scaffold pnpm monorepo with sim, mcp, cli packages`

---

### Task 2: RNG, hashing, and the determinism lint

**Files:**
- Create: `packages/sim/src/rng.ts`, `packages/sim/src/hash.ts`
- Test: `packages/sim/test/rng.test.ts`, `packages/sim/test/hash.test.ts`, `packages/sim/test/lint-determinism.test.ts`

**Interfaces:**
- Produces:
  - `class Rng { constructor(seed: number); next(): number; int(n: number): number; chance(num: number, den: number): boolean; readonly state: readonly [number, number, number, number]; static fromState(s: readonly [number, number, number, number]): Rng; fork(label: string): Rng }` where `next()` returns a uint32, `int(n)` returns `0..n-1` without modulo bias for `n <= 2^31`, `fork` derives a new independent stream by hashing the label into the state (used to give each system its own stream).
  - `fnv1a64(bytes: Uint8Array, seed?: bigint): bigint`, `hashString(s: string): bigint`, `hexHash(h: bigint): string` (16 hex chars).
  - `hashWorld(world: World): string` is added in Task 3 once `World` exists; this task provides the primitives.

- [ ] **Step 1: Write `test/rng.test.ts`**: `Rng(42).next()` called three times equals a fixed triple you record on first run and pin; two `Rng(42)` produce identical sequences of 1000; `fromState(r.state)` continues identically; `int(10)` over 10,000 draws yields every value 0..9; `fork("guests")` differs from `fork("rides")` and is itself reproducible; `int(0)` throws.
- [ ] **Step 2: Run, expect FAIL** (`Rng` not defined).
- [ ] **Step 3: Implement `Rng` with xoshiro128\*\*** seeded through splitmix32 from the seed; `fork(label)` mixes `hashString(label)` low and high 32 bits into a copy's state via splitmix again. All arithmetic with `Math.imul` and `>>> 0`.
- [ ] **Step 4: Write `test/hash.test.ts`**: `fnv1a64(new Uint8Array([]))` equals the FNV offset basis `0xcbf29ce484222325n`; `hashString("a")` equals `0xaf63dc4c8601ec8cn`; `hexHash` pads to 16 chars.
- [ ] **Step 5: Implement `hash.ts`** with BigInt FNV-1a 64 (prime `0x100000001b3n`, mask `0xffffffffffffffffn`).
- [ ] **Step 6: Write `test/lint-determinism.test.ts`**: reads every `.ts` under `packages/sim/src` except `hash.ts`, asserts none contains `Math.random`, `Math.sin`, `Math.cos`, `Math.tan`, `Date.now`, `performance.now`, `new Date(`.
- [ ] **Step 7: Run all sim tests, expect PASS.** `pnpm --filter @coasterworks/sim test`
- [ ] **Step 8: Commit** `feat(sim): seeded xoshiro rng, fnv1a hashing, determinism lint`

---

### Task 3: World and terrain

**Files:**
- Create: `packages/sim/src/world/types.ts`, `packages/sim/src/world/create.ts`, `packages/sim/src/terrain/terrain.ts`, `packages/sim/src/world/hash.ts`
- Modify: `packages/sim/src/index.ts` (re-export)
- Test: `packages/sim/test/world.test.ts`, `packages/sim/test/terrain.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export const SCHEMA_VERSION = 1;
  export const MAX_HEIGHT = 63;          // corner height, half-unit steps
  export const MAX_MAP = 256;            // tiles per side
  export type Surface = 0 | 1 | 2 | 3 | 4; // grass, sand, dirt, rock, snow
  export interface Terrain { width: number; height: number; corners: Int16Array /* (w+1)*(h+1) */; surface: Uint8Array /* w*h */; water: Uint8Array /* w*h, 0 = none, else level */ }
  export interface Finance { cash: number /* cents */; loan: number; monthStart: { cash: number } }
  export type ClientKind = "player" | "agent" | "replay" | "system";
  export interface LogEntry { id: number; tick: number; client: ClientKind; name: string; input: unknown; cost: number; undo?: unknown; undoneBy?: number }
  export interface World { meta: { schemaVersion: number; name: string; seed: number; created: string /* ISO, set by creator, never read by sim */ }; tick: number; terrain: Terrain; finance: Finance; rng: Rng; log: LogEntry[]; undoStack: number[]; redoStack: number[]; nextId: number }
  ```
- Produces (`create.ts`): `createWorld(opts: { width: number; height: number; seed: number; name: string; cash?: number /* default 10_000_00 */; createdIso?: string }): World` (flat terrain at corner height 8, surface grass, no water).
- Produces (`terrain.ts`): `cornerIndex(t: Terrain, cx: number, cy: number): number`, `getCorner(t, cx, cy): number`, `setCorner(t, cx, cy, h): void` (clamps 0..MAX_HEIGHT), `tileIndex(t, x, y)`, `tileCorners(t, x, y): [number, number, number, number]` (NW, NE, SE, SW), `tileBase(t, x, y): number` (min corner), `inBounds(t, x, y, w = 1, h = 1): boolean`, `forEachCornerInRect(t, rect: Rect, fn)`, `type Rect = { x: number; y: number; w: number; h: number }`.
- Produces (`world/hash.ts`): `hashWorld(world: World): string` covering tick, terrain arrays, finance, rng state, log length, and nextId (not `meta.created`).

- [ ] **Step 1: Write `test/world.test.ts`**: `createWorld({width: 8, height: 8, seed: 1, name: "t"})` has `terrain.corners.length === 81`, all corners 8, cash 1,000,000 cents, tick 0, empty log; two worlds with the same seed hash equal; different seeds hash differently; `width > MAX_MAP` throws.
- [ ] **Step 2: Write `test/terrain.test.ts`**: `setCorner` clamps to 0..63; `tileCorners` order is NW, NE, SE, SW for a world where you set corner (1,1) to 20 and check tiles (0,0), (1,0), (1,1), (0,1); `inBounds(t, 7, 7, 2, 1)` is false on an 8x8; `forEachCornerInRect` over `{x:0,y:0,w:2,h:2}` visits 9 corners.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement `types.ts`, `create.ts`, `terrain.ts`, `world/hash.ts`.** `hashWorld` feeds typed arrays' bytes and a JSON of the scalar parts through `fnv1a64`.
- [ ] **Step 5: Run, expect PASS.**
- [ ] **Step 6: Commit** `feat(sim): world model, corner-height terrain, world hash`

---

### Task 4: Command registry, execution, log, undo

**Files:**
- Create: `packages/sim/src/commands/define.ts`, `packages/sim/src/commands/registry.ts`, `packages/sim/src/commands/execute.ts`, `packages/sim/src/commands/undo.ts`
- Test: `packages/sim/test/commands.test.ts`

**Interfaces:**
- Produces (`define.ts`):
  ```ts
  export type Category = "terrain" | "path" | "ride" | "scenery" | "shop" | "staff" | "park" | "finance" | "sim" | "save";
  export interface CommandDef<I = unknown, U = unknown> {
    name: string; description: string; category: Category; input: z.ZodType<I>;
    undoable: boolean;
    cost?: (world: World, input: I) => number;                 // cents, default 0
    validate: (world: World, input: I) => string | null;        // reason or null
    apply: (world: World, input: I) => U;                       // returns undo data
    revert: (world: World, input: I, undo: U) => void;
    validateRevert?: (world: World, input: I, undo: U) => string | null;
  }
  export function defineCommand<I, U>(def: CommandDef<I, U>): CommandDef<I, U>;
  export interface CatalogEntry { name: string; description: string; category: Category; inputSchema: Record<string, unknown> /* JSON Schema */; undoable: boolean; kind: "command" | "query" }
  ```
- Produces (`registry.ts`): `class Registry { register(def: CommandDef<any, any>): void; registerQuery(def: QueryDef<any, any>): void; command(name): CommandDef | undefined; query(name): QueryDef | undefined; commands(): CommandDef[]; queries(): QueryDef[]; catalog(): CatalogEntry[] }`. `QueryDef<I, R> = { name; description; category; input: z.ZodType<I>; run: (world: World, input: I) => R }`. Registering a name that fails the name regex or is already registered throws. JSON Schema via `z.toJSONSchema` (Zod 4).
- Produces (`execute.ts`): `type ExecResult = { ok: true; id: number; cost: number } | { ok: false; error: string }`; `executeCommand(world: World, registry: Registry, name: string, rawInput: unknown, client: ClientKind): ExecResult`. Order: look up (unknown name is an error), `input.safeParse` (error message is the Zod issue path and message joined), `validate`, cost check (`cost > world.finance.cash` is `"Not enough cash: need $X, have $Y"`, dollars with two decimals), `apply`, charge cash, push `LogEntry`, push id on `undoStack` if undoable, clear `redoStack`.
- Produces (`undo.ts`): `undoLast(world, registry, client): ExecResult` and `redoLast(world, registry, client): ExecResult`. Undo pops `undoStack`, finds the entry, runs `validateRevert` if present, `revert`, refunds cost, logs `{ name: "undo", input: { target: id } }` with `undoneBy` set on the original, pushes id onto `redoStack`. Redo re-applies the original via `apply` (not `executeCommand`, so it does not re-validate cost differently), charges, logs `{ name: "redo", input: { target: id } }`. Empty stack returns `{ ok: false, error: "Nothing to undo" }` / `"Nothing to redo"`.
- Produces (`query.ts` lives in `define.ts`): `runQuery(world, registry, name, rawInput): { ok: true; result: unknown } | { ok: false; error: string }`.

- [ ] **Step 1: Write `test/commands.test.ts`** using a throwaway test command `test_add_cash` (`input: { amount: z.int().positive() }`, apply adds, revert subtracts) and `test_spend` (`cost: input.amount`): unknown name errors; bad input errors with the Zod message and leaves cash unchanged; `validate` rejection is returned verbatim; insufficient cash message matches `"Not enough cash: need $5.00, have $1.00"`; successful execution logs an entry with `client`, charges cost, and returns the id; `undoLast` refunds and logs `undo`, sets `undoneBy`; `redoLast` re-charges and logs `redo`; executing a new command after undo clears `redoStack`; registering `"Bad.Name"` throws; `catalog()` contains an entry with a JSON schema `properties.amount`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the four files.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(sim): command registry, execution, log, undo/redo`

---

### Task 5: Terrain commands

**Files:**
- Create: `packages/sim/src/commands/terrain.ts`, `packages/sim/src/registry-default.ts`
- Test: `packages/sim/test/terrain-commands.test.ts`

**Interfaces:**
- Produces commands (all `category: "terrain"`, all undoable, undo data is `{ corners: Array<[index, previousHeight]> }` or `{ tiles: Array<[index, previous]> }`):
  - `terrain_raise` `{ x, y, w, h, steps = 1 }` raises every corner in the rect by `steps` (clamped). Cost: `RAISE_COST_PER_CORNER = 50_00` per corner actually changed. Validate: rect in bounds (`"Area is outside the park"`), `steps` 1..8.
  - `terrain_lower` same with negative steps.
  - `terrain_level` `{ x, y, w, h, height }` sets every corner in the rect to `height` (0..63). Cost per corner changed.
  - `terrain_smooth` `{ x, y, w, h }` sets each corner to the rounded mean of itself and its up to 8 neighbors, one pass. Cost per corner changed.
  - `terrain_set_surface` `{ x, y, w, h, surface: 0..4 }`. Cost `SURFACE_COST_PER_TILE = 10_00` per tile changed.
  - `terrain_set_water` `{ x, y, w, h, level: 0..63 }`. Validate: `level === 0` or `level > tileBase` for every tile (`"Water must be above the ground"`). Cost `WATER_COST_PER_TILE = 20_00` per tile changed.
- Produces (`registry-default.ts`): `createDefaultRegistry(): Registry` registering every command and query in the sim (grows in later tasks).
- Rect schema shared: `rectSchema = z.object({ x: z.int().min(0), y: z.int().min(0), w: z.int().min(1), h: z.int().min(1) })`.

- [ ] **Step 1: Write `test/terrain-commands.test.ts`**: raise a 2x2 rect by 1 changes 9 corners and costs 45,000 cents; raising off the map edge (`x: 7, w: 2` on 8x8) returns `"Area is outside the park"` and leaves the hash unchanged; `terrain_level` to 63 then raise by 1 changes nothing and costs 0; `terrain_smooth` on a single spike of height 20 in a plain of 8 lowers the spike; `terrain_set_water` at level 5 on ground 8 is rejected with `"Water must be above the ground"`; for each command, `hashWorld` before equals `hashWorld` after apply then undo (with no ticks).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `terrain.ts` and `registry-default.ts`.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(sim): terrain raise/lower/level/smooth/surface/water commands`

---

### Task 6: Time, the Sim class, and tick loop

**Files:**
- Create: `packages/sim/src/time.ts`, `packages/sim/src/sim.ts`, `packages/sim/src/systems/types.ts`, `packages/sim/src/systems/finance.ts`, `packages/sim/src/commands/sim.ts`
- Modify: `packages/sim/src/registry-default.ts`, `packages/sim/src/index.ts`
- Test: `packages/sim/test/time.test.ts`, `packages/sim/test/sim.test.ts`

**Interfaces:**
- Produces (`time.ts`): `TICKS_PER_SECOND = 40`, `TICKS_PER_DAY = 400`, `DAYS_PER_MONTH = 31`, `MONTHS_PER_YEAR = 8`, `MONTH_NAMES = ["March","April","May","June","July","August","September","October"]`, `dateOf(tick: number): { year: number /* 1-based */; month: number /* 0-7 */; day: number /* 1-31 */; tickOfDay: number }`, `isMonthStart(tick): boolean` (tick % (TICKS_PER_DAY*DAYS_PER_MONTH) === 0 and tick > 0), `formatDate(d): string` like `"March 1, Year 1"`.
- Produces (`systems/types.ts`): `interface System { name: string; tick(world: World): void }`.
- Produces (`systems/finance.ts`): `financeSystem: System` which on `isMonthStart` sets `finance.monthStart.cash = finance.cash` and charges loan interest `Math.floor(loan * 10 / 100 / MONTHS_PER_YEAR)` (10% yearly). Also exports `takeLoan`/`repayLoan` helpers used by commands `finance_take_loan { amount }` and `finance_repay_loan { amount }` (undoable; max loan `LOAN_MAX = 50_000_00`; repay validate `amount <= min(loan, cash)`).
- Produces (`sim.ts`):
  ```ts
  export class Sim {
    constructor(world: World, registry?: Registry /* default createDefaultRegistry() */);
    readonly world: World; readonly registry: Registry;
    execute(name: string, input: unknown, client?: ClientKind /* "player" */): ExecResult;
    query(name: string, input: unknown): QueryResult;
    undo(client?): ExecResult; redo(client?): ExecResult;
    step(ticks = 1): void;            // runs systems in order per tick, increments world.tick
    advanceDays(days: number): void;  // step(days * TICKS_PER_DAY)
    hash(): string;
    systems: System[];                // default [financeSystem]; later tasks append
  }
  ```
- Produces command `sim_advance { days: 1..3650 }` (`undoable: false`, category `sim`) that calls `advanceDays` through a hook: `apply` returns nothing and the Sim intercepts `sim_*` commands before `executeCommand` (so the command is logged like any other but the work happens in `Sim`). Simplest implementation: `Sim.execute` checks `name === "sim_advance"`, validates via the registry schema, logs an entry with `client`, then calls `advanceDays`.

- [ ] **Step 1: Write `test/time.test.ts`**: `dateOf(0)` is `{year 1, month 0, day 1, tickOfDay 0}`; `dateOf(TICKS_PER_DAY*31)` is month 1 day 1; `dateOf(TICKS_PER_DAY*31*8)` is year 2 month 0; `formatDate(dateOf(0)) === "March 1, Year 1"`; `isMonthStart(0)` false, `isMonthStart(12400)` true.
- [ ] **Step 2: Write `test/sim.test.ts`**: `new Sim(createWorld(...)).step(5)` sets tick 5; `advanceDays(31)` on a world with loan 10,000_00 charges interest 125_00 once; `execute("sim_advance", {days: 4000})` fails validation; `execute("sim_advance", {days: 2})` advances 800 ticks and logs an entry; terrain raise, then `advanceDays(1)`, then `undo()` succeeds and the log's last entry is `undo` (Review Focus 2); `hash()` of two sims from the same seed after the same command list and 1000 ticks are equal.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement.** Register `sim_advance`, `finance_take_loan`, `finance_repay_loan` in `registry-default.ts`. Export `Sim`, time helpers, and types from `index.ts`.
- [ ] **Step 5: Run, expect PASS.**
- [ ] **Step 6: Commit** `feat(sim): calendar, Sim loop, finance system, loans, sim_advance`

---

### Task 7: Queries

**Files:**
- Create: `packages/sim/src/queries/park.ts`, `packages/sim/src/queries/terrain.ts`, `packages/sim/src/queries/log.ts`
- Modify: `packages/sim/src/registry-default.ts`
- Test: `packages/sim/test/queries.test.ts`

**Interfaces:**
- Produces queries:
  - `park_status` `{}` → `{ name, tick, date: string, year, month, day, cash: number /* cents */, loan, guests: 0, rating: 0, width, height }` (guests and rating are placeholders until Plan D).
  - `terrain_get` `{ x, y, w, h }` (max 64x64) → `{ x, y, w, h, corners: number[] /* (w+1)*(h+1) row-major */, surface: number[], water: number[] }`.
  - `park_bounds` `{}` → `{ width, height, maxHeight: MAX_HEIGHT }`.
  - `log_recent` `{ limit?: 1..200 = 20 }` → `LogEntry[]` without `undo` data.
  - `undo_state` `{}` → `{ canUndo: boolean; canRedo: boolean; undoCount; redoCount }`.

- [ ] **Step 1: Write `test/queries.test.ts`**: `park_status` on a fresh 16x16 world has `date === "March 1, Year 1"` and `cash === 1_000_000`; `terrain_get` 2x2 at origin returns 9 corners; `terrain_get` with `w: 65` fails; `log_recent` after two commands returns 2 entries newest first with no `undo` field; `undo_state` after one command is `{canUndo: true, canRedo: false, ...}`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement and register.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(sim): park_status, terrain_get, park_bounds, log_recent, undo_state queries`

---

### Task 8: Save and load

**Files:**
- Create: `packages/sim/src/save/codec.ts`, `packages/sim/src/save/migrate.ts`
- Modify: `packages/sim/src/index.ts`
- Test: `packages/sim/test/save.test.ts`

**Interfaces:**
- Produces: `serializeWorld(world: World): Uint8Array` (gzip of JSON; typed arrays encoded as `{ "$t": "Int16Array", "$b64": "..." }`; `rng` as its state tuple; the log included), `deserializeWorld(bytes: Uint8Array): World` (throws `SaveError` with message `"Save is from a newer version (schema 2, this build reads 1)"` when `schemaVersion > SCHEMA_VERSION`; runs `migrate(doc)` when older), `class SaveError extends Error`, `migrate(doc: unknown): unknown` (identity for version 1; a `MIGRATIONS: Record<number, (doc) => doc>` table for later). Uses `fflate` `gzipSync`/`gunzipSync` so the same code runs in Node and browsers.

- [ ] **Step 1: Write `test/save.test.ts`**: round trip preserves `hashWorld`; round trip after 3 commands and 500 ticks preserves hash and `log.length`; corrupt bytes throw `SaveError`; a document with `schemaVersion: 2` throws the exact newer-version message (Review Focus 3); the serialized size of a 64x64 world is under 20 KB.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add `fflate` to sim dependencies.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(sim): gzip JSON save format with schema version and migrations`

---

### Task 9: Golden determinism test

**Files:**
- Create: `packages/sim/test/golden/scenario-1.json` (the command script), `packages/sim/test/golden/scenario-1.hash`, `packages/sim/test/golden.test.ts`, `packages/sim/scripts/update-golden.ts`
- Modify: `packages/sim/package.json` (script `golden:update`)

**Interfaces:**
- Script format: `{ "world": { "width": 32, "height": 32, "seed": 7, "name": "golden" }, "steps": [ { "exec": ["terrain_raise", { "x": 2, "y": 2, "w": 4, "h": 4, "steps": 2 }] }, { "tick": 400 }, { "undo": true }, ... ] }` with at least 12 steps covering every terrain command, a loan, undo, redo, and `sim_advance`.
- Produces: `runScenario(doc): Sim` exported from `test/golden/run.ts` for reuse by the CLI tests.

- [ ] **Step 1: Write `golden.test.ts`** that runs the scenario, asserts every `exec` returned `ok`, and compares `sim.hash()` to the `.hash` file; a second run in the same process matches the first.
- [ ] **Step 2: Write `update-golden.ts`** (tsx or `node --import tsx`) that writes the hash file; run it once to create the golden.
- [ ] **Step 3: Run the test, expect PASS; change the seed in a copy and confirm the hash differs.**
- [ ] **Step 4: Commit** `test(sim): golden determinism scenario`

---

### Task 10: CLI

**Files:**
- Create: `apps/cli/src/index.ts` (replace), `apps/cli/src/commands/new.ts`, `apps/cli/src/commands/run.ts`, `apps/cli/src/commands/inspect.ts`, `apps/cli/src/commands/exec.ts`, `apps/cli/src/io.ts`
- Test: `apps/cli/test/cli.test.ts`

**Interfaces:**
- Produces bin `coasterworks` with subcommands parsed by `node:util` `parseArgs`:
  - `new --out <file> [--width 64] [--height 64] [--seed <n>] [--name <s>]` writes a `.park`.
  - `run --save <file> --days <n> [--out <file>]` loads, `advanceDays`, prints `park_status` JSON, writes `--out` if given.
  - `inspect <file>` prints `park_status` JSON plus `log_recent`.
  - `exec --save <file> --command <name> --input <json> [--out <file>]` executes one command as client `agent` and prints the `ExecResult` JSON; exit code 1 when `ok: false`.
  - `mcp --save <file> [--out <file>]` is wired in Task 11.
  - Produces `main(argv: string[], io: { stdout: (s: string) => void; stderr: (s: string) => void }): Promise<number>` exported from `src/index.ts` for tests; the bin calls `process.exit(await main(process.argv.slice(2), ...))`.
  - `io.ts`: `readPark(path): Promise<World>`, `writePark(path, world): Promise<void>`.

- [ ] **Step 1: Write `test/cli.test.ts`** using a temp dir: `new` creates a file that `inspect` reads back with `date "March 1, Year 1"`; `exec terrain_raise` then `inspect` shows cash reduced; `run --days 31` advances the date to April; `exec` with bad input exits 1 and prints an error JSON; unknown subcommand prints usage and exits 2.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS; also `pnpm build && node apps/cli/dist/index.js new --out /tmp/x.park && node apps/cli/dist/index.js inspect /tmp/x.park`.**
- [ ] **Step 5: Commit** `feat(cli): new, run, inspect, exec subcommands`

---

### Task 11: MCP server

**Files:**
- Create: `packages/mcp/src/server.ts`, `packages/mcp/src/stdio.ts`, `packages/mcp/src/http.ts`, `packages/mcp/src/index.ts` (replace)
- Create: `apps/cli/src/commands/mcp.ts`; modify `apps/cli/src/index.ts`
- Test: `packages/mcp/test/server.test.ts`, `packages/mcp/test/http.test.ts`

**Interfaces:**
- Produces (`server.ts`): `createMcpServer(sim: Sim, opts?: { name?: string; version?: string }): McpServer`. For every `CatalogEntry` of kind `command`, `registerTool(name, { title, description, inputSchema: <the zod object's shape>, annotations: { readOnlyHint: false, destructiveHint: category !== "sim" } }, handler)` where the handler calls `sim.execute(name, input, "agent")` and returns `{ content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok }`. For queries, same with `readOnlyHint: true` and `sim.query`. Plus built-in tools `undo`, `redo` (call `sim.undo("agent")`), and `save_write { path }` / `save_load { path }` (only when `opts.allowFiles`, default false; the CLI enables it). Plus resource `park://status` returning `park_status` JSON.
- Produces (`stdio.ts`): `serveStdio(sim: Sim, opts?): Promise<void>` using `StdioServerTransport`.
- Produces (`http.ts`): `serveHttp(sim: Sim, opts: { port?: number /* 0 = random */; host?: "127.0.0.1"; token: string }): Promise<{ url: string; port: number; close(): Promise<void> }>` using `StreamableHTTPServerTransport` on `node:http`, path `/mcp`, rejecting requests without `Authorization: Bearer <token>` with 401. Stateless mode (`sessionIdGenerator: undefined`) is fine.
- CLI: `coasterworks mcp --save <file> [--out <file>] [--http <port> --token <t>]`; stdio by default; on `--out`, writes the park on `SIGINT` and after every command.

- [ ] **Step 1: Write `test/server.test.ts`** with `InMemoryTransport.createLinkedPair()` and an SDK `Client`: `listTools` includes `terrain_raise`, `park_status`, `undo`, and excludes `save_write` by default; `callTool("terrain_raise", {x:0,y:0,w:2,h:2})` returns `ok: true` and `park_status` then shows cash `955_000`; `callTool("terrain_raise", {x: -1, ...})` returns `isError: true` with a message containing `x` and the hash is unchanged (Review Focus 4); `readResource("park://status")` parses to the same as `park_status`; `callTool("undo")` refunds.
- [ ] **Step 2: Write `test/http.test.ts`**: `serveHttp` on port 0 then an SDK `Client` over `StreamableHTTPClientTransport` with the bearer header lists tools; a request without the header gets 401.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement.** Dependencies: `@modelcontextprotocol/sdk`, `zod` (the same major as sim).
- [ ] **Step 5: Run, expect PASS; manual check: `node apps/cli/dist/index.js mcp --save /tmp/x.park` responds to a JSON-RPC `initialize` on stdin.**
- [ ] **Step 6: Commit** `feat(mcp): MCP server from the sim catalog over stdio and streamable HTTP`

---

### Task 12: CI and docs

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`, `CONTRIBUTING.md`

- [ ] **Step 1: Write `ci.yml`**: on push and pull_request; matrix `ubuntu-latest` and `macos-latest`, Node 22, pnpm 10 via `pnpm/action-setup`; steps install, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm format:check`. Golden test runs on both OSes, which is the cross-platform determinism check.
- [ ] **Step 2: README**: add "Try it headless" with the four CLI commands and "Connect Claude Code" with `claude mcp add coasterworks -- coasterworks mcp --save my.park`. **CONTRIBUTING**: add "Adding a command" (defineCommand fields, the regex, the undo rule, register in `registry-default.ts`, add to the golden scenario).
- [ ] **Step 3: Run `pnpm format` then the full suite locally; expect green.**
- [ ] **Step 4: Commit** `ci: typecheck, build, test on ubuntu and macos`

---

## Self-review notes

- Spec coverage for this plan's scope: 5.1 stack (T1), 5.3 registry/log/undo (T4, T5, T6), 5.4 loop/determinism/save (T6, T8, T9), 6.1 MCP tools and HTTP with token (T11), 6.2 headless (T10), 7 CI/license (T1, T12), 9 tests (throughout). Rendering, UI, guests, rides, assistant are later plans.
- Names used consistently: `Sim`, `Registry`, `defineCommand`, `executeCommand`, `undoLast`, `redoLast`, `hashWorld`, `serializeWorld`, `deserializeWorld`, `createDefaultRegistry`, `createMcpServer`, `serveStdio`, `serveHttp`, `main`.
- Review Focus items 1 to 5 each have a test in T5, T6, T8, T11, T6.
