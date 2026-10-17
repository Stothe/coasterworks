# Plan B ledger (archived from the SDD workspace)

Preserved for Plan C/D pickup of deferred items. Rulings are decisions Claude made on Steve's behalf during execution.


Branch: feat/renderer-shell (from main at the Plan B docs commit). Spec read. Plan A ledger archived at docs/superpowers/plans/2026-10-16-a-foundation-ledger.md.

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T0 ↔ T4 | both modify packages/mcp/src/http.ts and apps/cli/src/index.ts | sequential, fine |
| T0 ↔ Plan A T12 test | token generation replaces the "--http needs --token" usage error; existing test must change | ruled below |
| T1 → T2/T3 | snapshot terrain `{corners,surface,water}` + header width/height vs render `TerrainData` | T3 assembles TerrainData from header + arrays; consistent |
| T1 self | `SimClient.query<T>` returns `QueryResult<T>` but sim's QueryResult is not generic | ruled below |
| T3 ↔ T5 | T5 modifies apps/web/src/host/connect.ts to read window.__COASTERWORKS__ | sequential, fine |
| T4 ↔ T5 | serve prints `{wsUrl,mcpUrl,port,token}`; Rust parse_ready_line keys on wsUrl | consistent |
| T1 `types: []` | HostTimers.now injected; protocol never reads performance/Date itself | consistent |

Ruling: protocol defines `QueryResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string }` locally (structurally identical to sim's) — cost if wrong: none.
Ruling: T0 updates Plan A's "--http without --token exits 2" test to "generates a 43-char token and prints it"; `--token ""` stays an error — cost if wrong: none.

## Tasks
Task 0: implemented (commit 26e4e30, implementer a3d3e1c2e2150b063); review pending
Ruling: the load invariant "stack ids must name entries with undo data" was wrong (undoable commands like finance_take_loan legitimately return no undo data); accepted rule is "stack ids name existing log entries, none repeated or on both stacks" — cost if wrong: none.
Task 0: complete (commits 4f093ae..26e4e30, review clean)
Task 0: minor (deferred): http.ts allowedHosts starts as [] (fail-open if ordering changes; initialise to a never-matching value); stale mcp.ts comment about `{url,port}`; ISIZE cap before gunzipSync for save_load over HTTP; Bun unpinned in CI (canary by design); odd message for empty log with nextId 0
Task 1: implemented (implementer ab19f16285f7d29b9); review pending
Task 1: review found 1 Important (mutated() re-sends log events under synchronous reentrancy) — fix round 1 dispatched to implementer ab19f16285f7d29b9; FIX_BASE 9c0f886
Ruling: the host's interval callback catches exceptions, stops the loop, and broadcasts an id-less `error`; SimClient gains `onError`; included in this fix round because Task 3 mounts the host in a worker where an uncaught throw would freeze the UI silently — cost if wrong: none.
Task 1: minor (carried into fix round): per-handler catch in SimClient; decodeSnapshot must copy when given a Buffer (subarray → new Uint8Array); LinkedEnd.onMessage drain must preserve order; replaceWorld+command before next tick swallows one event
Task 1: minor (deferred): undoneBy changes never reach clients (log panel needs a follow-up); sim_advance from a socket client runs synchronously in the request path; test gaps (250 ms boundary, negative corner encoding, lone surrogate, host-level handler isolation)
Task 1: fix round 1/5 (6 addressed, 0 open — reentrancy publish queue; halt on fault + onError; handler isolation; Buffer copies; ordered linked transport; replaceWorld sync; commits 9c0f886..4ab099c)
Task 1: complete (commits 26e4e30..4ab099c, review clean after 1 fix round; implementer ab19f16285f7d29b9)
Task 1: minor (deferred): halt() flush after a stranded publish queue could rethrow (contrived); after a halt a client `speed` message sets speed 1 while the loop stays stopped (embedder must call start(); Task 3/4 should surface halted state in the UI); tick() runs advance() before syncWorld(); LinkedEnd.close() does not discard queued frames; notify() swallows handler errors silently
Task 2: implemented (commit fac8e12, implementer a46aec435a73432f0); review pending
Ruling: three r186 has no PCFSoftShadowMap; PCFShadowMap is the soft filter now — accepted. sunFor noon intensity is 2.2 per the controller formula (the brief's "1" was illustrative). Water quads at +0.01. position() at yaw 0 is target+(0,0,d). input.ts passes rig.pan(-dx, dy, h) for grab semantics — cost if wrong: none.
Task 2: complete (commits 4ab099c..fac8e12, review clean; implementer a46aec435a73432f0)
Ruling: pan scale was plan-mandated and wrong for grab semantics (2 vs 2·tan(fov/2)); carried into Task 3 as a render change: `CameraRig.fovY` (default 35° in radians) and `pan` scales by `distance * 2 * tan(fovY/2) / viewportHeight`; `scene.render()` calls `rig.clampTarget(width, height)` — cost if wrong: none.
Task 2: minor (deferred): 1 px white highlight invisible on snow/sand (ribbon mesh later); highlight geometry reallocated per pointermove; handle unguarded after dispose(); surface byte > 4 throws in buildChunkGeometry (sim invariants make it unreachable); detach does not release pointer capture
Task 3: implemented (commit 0bfbb5f, implementer a8b8e62c17d204fd5); review pending
Task 3: complete (commits fac8e12..0bfbb5f, review clean; implementer a8b8e62c17d204fd5). Screenshot docs/images/web-first-light.png sent to Steve.
Ruling: visual day phase offset — the web app computes t = ((tick + 0.3 * CYCLE) % CYCLE) / CYCLE with CYCLE = TICKS_PER_DAY * DAYS_PER_MONTH so a fresh park opens mid-morning; carried into Task 4 — cost if wrong: none.
Ruling: hotkeys (space, +, -) are gated on `halted`; carried into Task 4 — cost if wrong: none.
Task 3: minor (deferred): rapid-press speed race; keys.ts untested; useHost shows no state change when the link drops after ready and never calls unsubscribes; host-error toasts derived from state; water brush 2/3 on uneven ground fails often (use highest base + 1); log costs from sample-park shaping would be counted by a future "expenses this month" report (filter client === "system"); tool buttons' accessible names include the key hint
Task 4: implemented (commit 4150ad7, implementer a6eb3171e4125e38b); review pending
Ruling: ws auth failure answers an HTTP 401 on the upgrade (not a 1008 close) — the brief's test line was superseded by the clarification — cost if wrong: none.
Task 4: review found 1 Important (createMcpRequestHandler parses the URL outside the try; a raw `GET //` crashes mcp --http unauthenticated) — fix round 1 dispatched to implementer a6eb3171e4125e38b; FIX_BASE 4150ad7
Task 4: minor (carried into fix round): shutdown race when an upgrade completes during the grace window (closing flag); wsTransport has no local closed gate; tokenMatches("","") is true; upgrade bypass variants untested
Task 4: minor (deferred): no ws send backpressure; sendJson duplicated between http.ts and serve.ts
Task 4: fix round 1/5 (5 addressed, 0 open — guarded URL parse + never-reject handler; closing flag + 503 + terminate after grace; transport closed gate; strict tokenMatches; bypass tests; commits 4150ad7..2c0033f)
Task 4: complete (commits 0bfbb5f..2c0033f, review clean after 1 fix round; implementer a6eb3171e4125e38b)
Task 4: minor (deferred): the 401-refusal test no longer pins that the server closes the socket; race test is timing-dependent (50/100/500 ms); serve's own `GET //` over plain HTTP untested
Task 5: implemented (commit 144943a, implementer a9d0e027c22235c77); review pending. No screenshot: the Mac session was locked (screencapture blank); window open, sidecar lifecycle, and MCP edit landing in current.park were verified by process checks.
Ruling: the desktop package's `typecheck`/`test` scripts must not run cargo from the root flow (ubuntu CI has no webkit2gtk); they become no-ops and the macOS `desktop-build` CI job (Task 6) runs `cargo check`/`cargo test`/`cargo build` — carried into Task 6 — cost if wrong: none.
Ruling: capabilities omit `shell:allow-spawn` (Rust-side spawn needs no capability; granting it would let the page run node) — accepted. SIGTERM via libc instead of CommandChild::kill (which is SIGKILL) so the sidecar saves on quit — accepted.
Task 5: review found 1 Important (window-build failure after spawn orphans the sidecar) — fix round 1 dispatched to implementer a9d0e027c22235c77; FIX_BASE 144943a
Task 5: minor (carried into fix round): sidecar should also stop on stdin EOF (hard kill of the shell); unchecked u32→pid_t cast; hostile-token init_script test; vite strictPort
Task 5: minor (deferred): no Edit/Window menu (add Cut/Copy/Paste/Select All when the first text input lands); spawn/timeout logic only manually tested; icon is a rounded square; capability $schema points into gen/
Task 5: fix round 1/5 (5 addressed, 0 open — stop sidecar on setup failure; --exit-on-stdin-eof; checked pid cast; hostile-token test; strictPort; commits 144943a..f98b804)
Task 5: complete (commits 2c0033f..f98b804, review clean after 1 fix round; implementer a9d0e027c22235c77). Still no desktop screenshot (session locked); in-window click and menu items not exercised live.
Task 5: minor (deferred): stdin watch armed before start() outside try/finally (infallible calls); no bin-level test for real stdin ending without the flag
Task 6: implemented (commit d3f0071, implementer ae0121180afed634e); review pending
Task 6: review found 1 Important (smoke test passes with a blank canvas) — fix round 1 dispatched to implementer ae0121180afed634e; FIX_BASE d3f0071
Task 6: minor (carried into fix round): stale README line "There is no UI yet"; cash assertion accepts any change; committed png churn on every local run; no timeout-minutes on CI jobs
Task 6: minor (deferred): 10 s day-rollover margin before the pause lands; no Playwright browser cache in CI; desktop typecheck echo names cargo:check which the job does not run
Task 6: fix round 1/5 (5 addressed, 0 open — canvas colour check + console.error; README line; strict cash; opt-in screenshot; CI timeouts; commits d3f0071..163b815)
Task 6: complete (commits f98b804..163b815, review clean after 1 fix round; implementer ae0121180afed634e)
Task 6: minor (deferred): UPDATE_SCREENSHOT writes before the assertions; colour assertion runs before the problems assertion; CI jobs never run on GitHub yet
All tasks complete; final whole-branch review pending (merge base 4f093ae, head 163b815)
Final review (opus, a17944f6225e908b4): no Critical. Important #1 halted state invisible/unrecoverable (late joiners, speed accepted while stopped); #2 dropped connection silent in the desktop app; #3 camera can go inside hills (spec 4.3); #4 desktop never seen end to end, CI never run. Fix wave dispatched; FIX_BASE 163b815.
Ruling: GitHub repo Stothe/coasterworks is created now (public, as Steve asked for an open-source project on GitHub) so CI runs on main before Plan B merges; Plan G keeps the release/polish work — cost if wrong: a public pre-alpha repo, which is what Steve asked for.
Ruling: the sample-park recipe moves from apps/web/src/dev into packages/sim (`createSamplePark`) so `coasterworks new --sample` and the desktop first run share it — cost if wrong: none.
Ruling: deferred to later plans from the final review: Minor 5 (terrain-changed signal / dirty chunks, before Plan D), 7 (render on demand), 8 (init-script origin guard / Origin check), 11, 12, 13, 16 — cost if wrong: perf and polish only.
Final fix wave: commits beab68d, 1343ea8, 23cac10 (fixer a24b89c187c8c0730); scoped re-review pending. Desktop visible pass still blocked by the locked Mac screen.
GitHub: https://github.com/Stothe/coasterworks created (public), main pushed.
Final fix wave re-review (ab4cb8e7b4844ead8): all 8 findings addressed, no new Critical/Important.
Ruling: parked — camera target easing amplifies the permanent pitch raise during fast pans over hills (measure clearance against the eased target or let pitch relax) — real, deferred to Plan C polish — cost if wrong: a slightly steeper view after panning over a hill.
Ruling: parked — startup-failure dialog always suggests deleting the park file even for a missing node/unbuilt CLI; run_on_main_thread failure ignored — deferred to Plan G (first-run polish) — cost if wrong: a confusing hint on a rare failure.
Ruling: PROTOCOL_VERSION stays 1 (nothing shipped; new host strips unknown keys for old clients) — bump to 2 before the first release (Plan G) — cost if wrong: none.
Ruling: merge feat/renderer-shell to main only after the branch's first CI run (test on ubuntu/macos, e2e, desktop-build, golden-jsc) is green; the desktop visible pass stays blocked by the locked screen and is reported to Steve as unverified — cost if wrong: a delay.
