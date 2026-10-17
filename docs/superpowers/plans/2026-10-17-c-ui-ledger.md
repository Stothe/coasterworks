# Plan C ledger (archived from the SDD workspace)

Preserved for Plan D pickup of deferred items. Rulings are decisions Claude made on Steve's behalf during execution.


Branch: feat/ui (from main at 5e0cc34). Spec read. Plan B ledger archived at docs/superpowers/plans/2026-10-16-b-renderer-and-shell-ledger.md.

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 → T2..T5 | `catalog_list` query + `buildActions`/`useActions`/kit | consistent |
| T2 → T3/T4 | `uiStore` (zustand) owns tool/placement/selection; Viewport reads it | consistent |
| T4 sim change | `park_status` gains `monthStartCash`; Plan A queries.test.ts pins the full fresh object with toEqual | implementer updates that test; ruled below |
| T5 ↔ useHost | events kept 200 and deduped by id | consistent |
| T6 "right-click via context menu; add to T3 if simpler" | ambiguous owner | ruled below |
| deps | cmdk, zustand, @radix-ui/* must support React 19 | implementer verifies at install |

Ruling: `park_status.monthStartCash` is added in T4 and the Plan A full-object test is extended, not weakened — cost if wrong: none.
Ruling: the tile right-click context menu is built in T4 next to TileInspector (same per-tile action list), not T6 — cost if wrong: none.
Ruling: `packages/ui` stays deferred (components in apps/web/src/ui) — cost if wrong: a later move.

## Tasks
Task 1: implemented (commit 48852cb, implementer ad96680c9b8434f5c); review pending
Ruling: `useActions(client, deps)` (needs both) accepted; Task 2 memoizes deps. A shared `apps/web/test/setup.ts` (ResizeObserver stub etc.) is added in Task 2. `catalog_list` being an MCP tool is fine (read-only). Tray must supply `height`/`surface`/`level` for level/surface/water placements (Task 3) — cost if wrong: none.
Task 1: complete (commits 5e0cc34..48852cb, review clean; implementer ad96680c9b8434f5c)
Task 1: minor (carried into T3): level/surface/water placements start with {} and need the tray to supply height/surface/level (derive missing params from fieldsFor minus rect keys)
Task 1: minor (deferred): Segmented passes display shortcuts into aria-keyshortcuts (expects key syntax); no useActions test for mid-fetch client switch; 32 px tests assert class names; SPEEDS duplicates PLAY_SPEEDS; unstable deps rebuild actions per render; Tabs label optional; one Tooltip.Provider per IconButton
Task 2: implemented (commit 1f62e38, implementer a144ba41914d26760); review pending
Ruling: Radix Dialog + cmdk Command (not Command.Dialog) accepted; Esc steps back one level (form → list → close) and never touches placement while the bar is open; `ControlOrMeta` in the e2e so CI on Ubuntu passes; Playwright workers: 1 — cost if wrong: none.
Task 2: review found 1 Important (render attachControls binds 1-4 and Home first, so the dock keymap never sees them) — fix round 1 dispatched to implementer a144ba41914d26760; FIX_BASE 1f62e38
Ruling: spec 4.4 dock keys 1-7 win; `attachControls` drops the digit and Home bindings (keeps q/e); `ui.classicView` (Home, View > Classic View) cycles the four classic angles on repeated presses — cost if wrong: a changed render-package key list, documented.
Task 2: minor (carried into fix round): focus lost after Esc/Back from a form (refocus Command.Input); add an App-level keymap test that does not mock Viewport
Task 2: minor (deferred): no full-stack Esc test with a live placement; Shift+Space no longer pauses; "Enter a number" branch unreachable; main chunk ~990 kB of the 1000 kB limit (lazy-load cmdk); ControlOrMeta pairing relies on navigator.platform under Playwright
Task 2: fix round 1/5 (2 addressed, 0 open — dock keys own 1-7 / Home cycles classic angles / unmocked keymap test; command bar refocus; commits 1f62e38..e102d14)
Task 2: complete (commits 48852cb..e102d14, review clean after 1 fix round; implementer a144ba41914d26760)
Task 2: minor (deferred): startTurn uses a stale turn.to for ≤16 ms after an interrupting yaw change; classicCycle tracks yaw only (vertical-only orbit then Home advances the angle); Plan B doc still describes the old render keys (historical)
Task 3: implemented (commit 77df37a, implementer a7a907be34caf4dc8); review pending
Ruling: Tray props carry actions/ctx/lastCharge (the brief's `{ tool; children? }` was a sketch); the park opens on Terrain with Raise in hand; three.js split into its own chunk; `ui.terrain.*`/`ui.brush.*` actions are key-only (hidden from the bar) — cost if wrong: none.
Task 3: complete (commits e102d14..77df37a, review clean; implementer a7a907be34caf4dc8)
Task 3: minor (carried into T4): dock wrapper swallows clicks beside the narrower of tray/dock (pointer-events-none on the wrapper); re-selecting the verb in hand resets its options; player-facing strings mention "Plan D"/"next task"
Task 3: minor (deferred): SelectIcon unused; costHintOf parses prose; dock overflows below ~560 px
Task 4: implemented (commit cbb2de4, implementer aabf6202d8fa8a687); review pending
Ruling: useParkStatus keys the re-query on the newest event id (events are capped at 50 so length would stall); openInspector selects the park in the store; context menu opens via a synthetic contextmenu on a hidden Radix trigger from the viewport's own right-click detection (so right-drag orbit does not open it) — cost if wrong: none.
Task 4: review found 1 Important (useParkStatus event re-query not coalesced; bursts starve the display) — fix round 1 dispatched to implementer aabf6202d8fa8a687; FIX_BASE cbb2de4
Task 4: minor (carried into fix round): vacuous after-unmount test; toast offset hard-codes the inspector width; "Set water" has no hint about +2
Task 4: minor (deferred): pointer-events fix asserted by class only; status lives in ParkPanel (brief "Loading" flash on tile→park); 4 px menu slop vs 0 px orbit slop; no map outline for the selected tile; inspector buttons not disabled on disconnect
Task 4: fix round 1/5 (4 addressed, 0 open — debounced/coalesced status refresh; real unmount test; shared layout constant; water hint; commits cbb2de4..4266a90)
Task 4: complete (commits 77df37a..4266a90, review clean after 1 fix round; implementer aabf6202d8fa8a687)
Task 4: minor (deferred): pending follow-up ignores `active` false while mounted (one extra query at most); busy reset depends on the first .then not throwing (use finally); command-bar button hard-codes right-3.5; hint "N steps" wording if default becomes 1; no max-wait on the debounce
Task 5: implemented (commit 70c26d8, implementer a9292fb980aa2c6de); review pending
Task 5: complete (commits 4266a90..70c26d8, review clean; implementer a9292fb980aa2c6de)
Task 5: minor (carried into T6): test/setup.ts localStorage shim is unconditional (masks jsdom Storage on Node 22; make it conditional or correct the comment); useTimeline built twice per event (pass entries down)
Task 5: minor (deferred): disabled IconButton tooltips are mouse-only; settings store initial read untested; toast aria-label replaces visible text (plan-mandated); undo/redo markers not jump buttons; Settings popover can overlap the inspector
Task 6: implemented (commit d922394, implementer a2f8a4befcb45f5e7); review pending
Ruling: command bar ranking fixed (word matches first; cmdk group order replaced by our own ordering); `--color-accent-strong` token for filled accent buttons (contrast); tray/dock slide left while the inspector is open; token names stay `--color-ink`/`--color-muted` — cost if wrong: none.
Task 6: complete (commits 70c26d8..d922394, review clean; implementer a2f8a4befcb45f5e7). README sentence verified verbatim by the controller.
Task 6: minor (deferred): cmdk active row has no focus ring (10% wash only); Stepper buttons rounded-md vs input rounded-lg; stale comment in smoke.spec.ts; PITCH_RELAX rejects an overshooting step instead of clamping; reduced-motion snapping only unit-tested
All tasks complete; final whole-branch review pending (merge base 5e0cc34, head d922394)
Final review (opus, a61c7b588f25713cf): no Critical. Important #1 timeline shows only this session's events (load log_recent on ready); #2 tile menu/buttons hand-written instead of drawn from the registry; #3 one toast per agent command, uncapped; #4 park opens with Raise in hand (first click spends money). Fix wave dispatched; FIX_BASE d922394.
Ruling: the park opens on Select with nothing in hand; a click with nothing in hand inspects the tile under any tool; `1` puts Raise in hand; the smoke test presses 1 first — reverses the Task 3 "Raise in hand on load" ruling; spec 4.4 says the inspector opens when you click something — cost if wrong: one extra keypress before shaping terrain.
Ruling: the snapshot header gains `monthStartCash` (protocol) so the pills can show the monthly delta and Finances reads from snapshots; `useParkStatus` polling is dropped in favour of snapshot data plus `welcome.name` — cost if wrong: a protocol field.
Ruling: folded into the fix wave as cheap: cmdk active-row ring; toast aria-label keeps visible text; shortcut hints built from KEYMAP; help closes when the bar opens; pause/speed actions disabled while halted; Esc and ? work while disconnected; bell counts agent events only; AZERTY digit fallback via e.code; ctx reads the snapshot via a ref (no app-wide re-render per snapshot); Review Focus 2 e2e switches dock tools — cost if wrong: none.
Ruling: deferred to Plan D's first task: help overlay camera controls + focus trap (Minor 4); sim_advance inline confirmation (6); render q/e listener ignoring menus (10); single live region for toasts (13); Settings aria-expanded (14); icons outside icons.tsx (15); `1` forgets the last verb (17); catalog fetch retry (18); cost field on catalog entries; selection outline — cost if wrong: polish only.
Final fix wave: commits cbc05d1, 118ef14, 9701277 (fixer a146393f9b6f16d13); scoped re-review pending. Branch CI at d922394 result recorded in /tmp/claude-ci-watch-c.log; fix-wave head pushed for a second run.
