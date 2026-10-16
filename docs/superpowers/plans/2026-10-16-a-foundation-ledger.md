# Plan A ledger (archived from the SDD workspace)

Preserved so Plan B's first task can pick up the deferred items. Rulings are decisions Claude made on Steve's behalf during execution.


Branch: feat/foundation (from main at 1421634). Spec: docs/superpowers/specs/2026-10-16-coasterworks-design.md (read).

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 → T3, T6, T8 | `packages/sim/src/index.ts` stub, later re-exports | consistent |
| T2 → T3 | `fnv1a64` used by `hashWorld`; `Rng` type in `World.rng` | consistent |
| T3 → T4 | `World.log/undoStack/redoStack/nextId` | consistent |
| T4 → T5, T6, T7 | `defineCommand`, `Registry`, `registry-default.ts` grows | consistent |
| T4 → T6 | `Sim.execute` intercepts `sim_advance` (undoable: false, allowed for `sim_*`) | consistent |
| T6 → T7 | `park_status.date` uses `formatDate(dateOf(tick))` | consistent |
| T6 → T9 | golden uses `sim_advance`, `tick`, `undo`, `redo` | consistent |
| T3/T2 → T8 | `Rng.state` / `Rng.fromState` for serialization | consistent |
| T10 → T11 | `main(argv, io)`; `mcp` subcommand added in T11 | consistent |
| T4 → T11 | MCP needs zod shapes, `catalog()` only has JSON Schema | **conflict, ruled below** |
| T5 ↔ T11 | 2x2 raise = 9 corners × 50_00 = 45_000 → cash 955_000 | consistent |
| T6 self | loan 1,000,000c × 10% / 8 = 12,500c = $125.00; month start tick 12400 | consistent |
| T1 self | `typecheck: tsc -b --noEmit false` is odd | ruled below |
| T2 ↔ T3 | lint excludes `hash.ts`; `world/hash.ts` shares the basename | harmless, excluded too |

Ruling: `createMcpServer` iterates `sim.registry.commands()` and `queries()` and uses each def's zod `input.shape`; every command/query `input` must be a `z.object(...)` (`ZodObject`), enforced by `Registry.register` — why: MCP `registerTool` wants a zod raw shape, JSON Schema is for UI/catalog consumers — cost if wrong: a small adapter later.
Ruling: root `typecheck` script is `tsc -b` (composite projects emit; `--noEmit` conflicts with `composite`) — cost if wrong: none.
Ruling: Zod 4 and the latest `@modelcontextprotocol/sdk` 1.x; if the installed SDK rejects zod 4 peer, pin `zod@^3.25` and import from `zod/v4` everywhere — why: SDK peer ranges moved during 2025 — cost if wrong: one dependency pin.
Ruling: work happens on branch `feat/foundation` in this checkout, merged to `main` by me at the end; no remote exists yet, the GitHub repo is created in Plan G (or earlier if useful) — Steve said "yolo, make all the decisions" — cost if wrong: none.

## Tasks
Task 1: complete (commits 1421634..b369526, review clean)
Task 1: minor (deferred): tests under test/ are not type-checked by tsc -b — carried into Task 2 as a ruling (per-package test/tsconfig.json + typecheck script)
Task 1: minor (deferred): drop --passWithNoTests once the first test lands — carried into Task 2
Task 1: minor (deferred): add license: MIT and engines.pnpm to package.json files before publish; LICENSE-ASSETS wording "everything that is not source code" is broader than "art and audio"
Task 1: minor (deferred): VERSION hard-coded in three index.ts files; vitest.config.ts byte-identical x3
Ruling: packages/sim/tsconfig.json gets "types": [] so the deterministic core cannot reference Node ambient types; the test tsconfig adds node types — why: reviewer's cheap insurance for the determinism rule — cost if wrong: a Buffer/btoa use in sim must be replaced by a small hand-written base64 (Task 8)
Task 2: complete (commits b369526..dee9dcf, review clean; implementer ab12e9a7d16b72f31)
Ruling: plan's `pnpm --filter @coasterworks/sim test` is a silent no-op (no per-package test script) — add `"test": "vitest run"` to packages/sim, packages/mcp, apps/cli in Task 3 — cost if wrong: none.
Ruling: keep the implemented splitmix32 variant (lowbias32 finalizer 0x21f0aaad/0x735a2d97, shifts 16/15/15) rather than murmur3 constants; both bijective; switching later would invalidate every golden hash — cost if wrong: none.
Task 2: minor (deferred): rng.test.ts xoshiro reference test checks one output; replace with the 10-value published sequence for state [1,2,3,4] (11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804)
Task 2: minor (deferred): rng.ts splitmix variant not cited in a comment; fromState goes through new Rng(0); chance() error names Rng.int
Task 2: note for T3/T8: Rng uses #private fields; toEqual/structuredClone ignore RNG state; hashWorld and save must read rng.state explicitly
Task 3: complete (commits dee9dcf..cc3761d, review clean; implementer af3857b83f7a85a9f)
Task 3: minor (deferred): world.test.ts has no isolated meta.seed hash case; setCorner truncates fractional heights silently; tileCorners/tileBase re-validate per corner (hot-path cost); stride formula written twice in terrain.ts; forEachCornerInRect throws on w<1/h<1 (rectSchema in T5 enforces w,h >= 1 so fine); no golden hash value until T9
Task 4: complete (commits cc3761d..338dd52, review clean; implementer a053e815da8afbc55)
Task 4: minor (carried into T5): execute.ts:212 writes `undo: undefined` when apply returns void — guard with `if (undo !== undefined)`
Task 4: minor (deferred): no tests for "Log entry N not found" branches; failed-redo tests don't assert undoneBy still set; failed validate/cash don't assert redoStack untouched; catalog() can throw on unrepresentable zod types (validate at register time); ExecResult cost-sign undocumented; InputSchema not exported; ZodObject<any,any> leaves input.shape untyped for mcp; test line 827 `&&` narrowing hack
Task 4: note for T7: no defineQuery helper exists; T7 adds one (plan text uses defineQuery)
Task 5: complete (commits 338dd52..742d38d, review clean; implementer a436c78fd0009d253)
Ruling: the plan's "hash before == hash after apply then undo" property is tested on def.apply/def.revert directly (hashWorld covers log/stacks so the executor path always changes the hash); a separate executor-level test checks cash and terrain restore — cost if wrong: none.
Task 5: minor (deferred): height-command wiring repeated x4 (factory would collapse); tile commands' cost() silently over-counts off-map while height commands throw (unreachable via executeCommand; document cost contract); executor-level undo tested only for terrain_raise; no-op commands take an undo slot; raising terrain under water can leave water <= tileBase (note for render/sim); test boilerplate
Task 6: complete (commits 742d38d..3cbe82f, review clean; implementer afc9e8226ee298517)
Ruling: non-undoable (`sim_*`) commands must NOT clear the redo stack (reverses the T4 ruling); time passing should not discard a redo, matching the spec's "sim.advance ... do not clear it" — carried into T7 as a one-line change in execute.ts plus a test — cost if wrong: a stale redo may be refused by re-validation, which is already handled.
Task 6: minor (carried into T7): finance_repay_loan amount min(100) can leave an unrepayable residual (50 cents) — change to min(1)
Task 6: minor (deferred): Sim.execute re-parses raw input via module-level simAdvance def (custom registry could throw after logging); finance.ts imports formatMoney from execute.ts (a money.ts would be cleaner); no test pins "sim_advance preserves undo stack"
Task 7: review found 1 Important (offset-area terrain_get test is transposition-blind) — fix round 1 dispatched to implementer ad2e640ca47737ee3; FIX_BASE b8736b7
Ruling: the one-line `input: structuredClone(entry.input)` aliasing fix for log_recent rides along in the same fix round (no extra round, avoids a real redo-corruption path) — cost if wrong: none.
Task 7: fix round 1/5 (2 addressed, 0 open — transposition-blind terrain_get test; log_recent input aliasing; commits b8736b7..3bc3e64)
Task 7: complete (commits 3cbe82f..3bc3e64, review clean after 1 fix round; implementer ad2e640ca47737ee3)
Task 7: minor (deferred): runQuery catches every error thrown by run (engine bugs surface as ok:false; a QueryError class caught alone would be stricter); module-local `declare function structuredClone` in queries/log.ts (move to a shared ambient .d.ts if a second file needs it); commit mixes three concerns
Task 8: review found 1 Critical (save schema cost:int.min(0) rejects negative undo-entry costs; round trip after undoing a priced command throws) — fix round 1 dispatched to implementer a145416a3340c71ae; FIX_BASE a7b8e7b
Ruling: migration step errors are wrapped as SaveError in the same fix round (cheap, keeps the "only SaveError" contract) — cost if wrong: none.
Task 8: minor (deferred): no multi-step migrate test; vacuous `if (plain)` assertion in save.test.ts:110; gunzipSync has no output cap; fromBase64 accepts non-canonical trailing bits; undoStack/redoStack ids not checked against the log; LogEntry fields enumerated in three places in codec.ts
Task 8: fix round 1/5 (2 addressed, 0 open — negative undo cost schema; migration error wrapping; commits a7b8e7b..3d1d0ef)
Task 8: complete (commits 3bc3e64..3d1d0ef, review clean after 1 fix round; implementer a145416a3340c71ae)
Ruling: save integrity — the document carries `hash: hashWorld(world)` written at serialize time and verified after rebuild on load (SaveError "Save file is corrupt" on mismatch), closing the fflate no-CRC gap; folded into Task 9 — cost if wrong: hashWorld changes in later tasks invalidate old saves (acceptable pre-alpha; a migration can drop the check).
Task 9: complete (commits 3d1d0ef..417f666, review clean; implementer acff368412adb334a). Golden hash 24ee8503e3d9ef93.
Task 9: minor (deferred): changing hashWorld coverage will invalidate every prior save — document in codec.ts that it requires a SCHEMA_VERSION bump and a migration that recomputes/drops hash; magic 70*400 in golden.test.ts; comment claims CI exists; step classification duplicated across run.ts and golden.test.ts; log contents not hashed (logLength only)
Task 10: complete (commits 417f666..b136523, review clean; implementer a435bb3912fb58aaa)
Task 10: minor (carried into T11): writePark is not atomic (temp file + rename); usage text should say "without --out the save is not modified"
Task 10: minor (deferred): MAX_DAYS duplicates sim's private MAX_ADVANCE_DAYS (export it from sim); weak "--input omitted" test; parseArgs strict not explicit; integerOption typing; queryOrThrow lives in io.ts; isEntryPoint swallows realpath errors; missing --save tested only for inspect
Task 11: implemented (commit 769c230, implementer a463f6ed29a85d288); review pending
Task 11: note (security, deferred to Plan B): CLI enables allowFiles so a holder of the HTTP token can read/write any file the user can; add a path allowlist (saves directory) before the app exposes HTTP
Task 11: complete (commits b136523..769c230, review clean; implementer a463f6ed29a85d288)
Ruling: `allowFiles` is enabled only in stdio mode; HTTP mode requires an explicit `--allow-files` flag; `--token` may come from env `COASTERWORKS_MCP_TOKEN` instead of argv — why: a bearer token on argv is readable from the process list and would gate arbitrary file writes — carried into T12 — cost if wrong: none.
Task 11: minor (carried into T12): server.test.ts:152 `toContain("x")` is vacuous ("expected" contains x) — assert /at x\b/
Task 11: minor (deferred): GET /mcp builds a full server per stream (405 would be cheaper); possible unhandled rejection in stdio stop(); whenIdle timing assumption; save_write duplicates writePark without atomic rename and bypasses the --out queue; `result.ok ? mutated : toolResult` repeated x3; --token starting with "-" needs --token=; saveError may disclose absolute paths; enableJsonResponse undeclared; no test for a throwing apply(); usage wording under "one line of JSON"
Task 12: implemented (commits 812efdf, f53e368; implementer a4f3f16066579c57a); review pending
Task 12: complete (commits 769c230..f53e368, review clean; implementer a4f3f16066579c57a)
Task 12: minor (deferred): README .mcp.json example embeds a plaintext token (suggest ${COASTERWORKS_MCP_TOKEN}); CONTRIBUTING mentions save_* commands that only exist as MCP tools; no test pins --allow-files accepted over stdio; *.park ignore is repo-wide
All tasks complete; final whole-branch review pending (merge base 1421634)
Final review (opus, a35ad3cf82e35fcc3): no Critical; Important #1 save_write non-atomic/bypasses --out queue; #2 determinism lint misses engine-dependent Math fns; #3 save hash check vs migrations (design; comment fix now, real fix at first SCHEMA_VERSION bump); #4 mcp/cli tests resolve @coasterworks/* to dist (stale-build false greens); #5 no registry-wide undo-property test; #6 CI both legs V8 (add a Bun/JSC golden step later). Fix wave dispatched; FIX_BASE f53e368.
Ruling: the hash-ruling escape hatch "a migration can drop the check" is NOT possible as written (hash is checked after migration against current hashWorld); corrected — the real fix (gzip CRC check + hash only when no migration ran) is the first task of Plan B along with #5/#6 follow-through — cost if wrong: none now.
Ruling: deferred from the fix wave to Plan B's first task: Important #3 (design), #6 (Bun golden step), Minor #1 (load invariants), #2 (sim_advance special-case), #7 (CLI query/undo subcommands), #4 (DNS rebinding, token generation), #5 (.park extension for file tools) — cost if wrong: these are hardening items with no user-facing effect yet.
Final fix wave: commits e860492, 3034af4 (fixer a81aada2604a702df); scoped re-review pending
