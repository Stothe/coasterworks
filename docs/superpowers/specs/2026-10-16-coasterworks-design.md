# Coasterworks: design

Working name. "Coasterworks" is a placeholder until Steve picks a name (see Open questions). The folder is still called `RCT Modern`.

Date: 2026-10-16. Author: Claude, from a brainstorming session with Steve. Items marked **(Steve)** are his decisions in his words. Items marked **(call)** are Claude's choices, made so a builder can plan; Steve can overturn any of them.

## 1. Intent

A theme-park builder in the spirit of RollerCoaster Tycoon, with the depth of the original and a UI built for 2026.

Why: OpenRCT2 keeps RCT2's gameplay alive, but it also keeps RCT2's 1999 UI. Steve's words: "it was ugly and hurt my brain." The game underneath is still great. Nobody has shipped the full game with a modern, legible interface, because OpenRCT2 is committed to the original look and needs the original game files.

Three things make this project different from OpenRCT2 and from commercial park sims:

1. Playable by anyone. No original RCT2 files. All art, ride definitions, and sounds are original. **(Steve)**
2. Modern UI that makes building parks and rides easy. One action list, reachable from a labeled dock, a command bar, right-click, or an agent. **(Steve, shape by call)**
3. MCP native. The game is an MCP server whenever it is running, has a headless mode, and ships an in-game assistant. Everything the player can do, an agent can do, and nothing else. **(Steve)**

Mac first. Other platforms later, so nothing in the architecture may be Mac-only. **(Steve)**

Open source on GitHub. **(Steve)**

## 2. Goals, non-goals, anti-goals

Goals:

- Feature parity with RollerCoaster Tycoon 2 over time: terrain, paths, queues, ~50 ride types across all RCT categories, a coaster builder, guests with needs and thoughts, staff, finances, research, marketing, scenery, weather, park rating, awards, scenario objectives, save/load, scenario editor. Section 5 enumerates this and section 8 phases it.
- A first playable milestone where Steve can build a small park in an afternoon: terrain, paths, a few rides including one coaster he draws himself, guests showing up and spending money. **(Steve)**
- A UI a first-time player can read without a tutorial, and a power user can drive without a mouse.
- An MCP surface good enough that an agent can build a complete park from a prompt, test it, and hand back a save file.
- Deterministic simulation: the same seed and the same command log produce the same park, on every platform.
- Runs well on a 2020 M1 MacBook Air: a mid-size park at 60 fps with thousands of guests.

Non-goals (for now):

- Multiplayer.
- Importing RCT1/RCT2 saves, tracks, or object files. Doing it well means parsing proprietary formats and inviting asset use we cannot license. Revisit only as an external converter later.
- Mobile, VR, consoles.
- Photorealism. The look is stylized.
- Matching RCT's exact numbers. Ratings, guest behavior, and economics are original formulas tuned to feel like RCT, not reverse-engineered copies.

Anti-goals (would make it a failure even if it technically works):

- Any UI that looks or behaves like a 1999 window manager: free-floating overlapping windows, unlabeled icon grids, modal dialogs for routine actions.
- Any dependence on proprietary game files, at runtime or in the repo.
- Any feature an agent can do that the player cannot, or the other way around.
- A base game that needs an API key. The assistant must work with Steve's existing Claude Code login, and the game must be complete without the assistant.
- Copying code from OpenRCT2 (GPLv3) into this MIT codebase. OpenRCT2 is a behavioral reference only.

## 3. Decisions Steve made

In the order he made them, in his words where he gave them:

1. Playable without owning RCT2: "make our own art and ride definitions."
2. Look: option C of three mockups, "stylized 3D with lighting," free orbit camera, soft shadows, time of day. (He also lingered on the classic isometric sprite option; see the classic-view camera preset in 4.3.)
3. Controls: "A, the dock and inspector layout, with the command bar from C added on top."
4. MCP: "Both. Claude Code or Claude Desktop can drive the game from outside, and there's an assistant inside the game too."
5. First milestone: "Build a small park: terrain, paths, a few rides including one coaster I draw myself, guests showing up and spending money."

The mockups he chose from are in `.superpowers/brainstorm/` (git-ignored) and are the visual reference for the look and the UI.

## 4. The game

### 4.1 World

A park is a square grid of tiles, default 128x128, up to 256x256. Each tile has four corner heights in steps of half a unit, a surface type (grass, sand, dirt, rock, and others), and an optional water level. One tile is roughly 8 meters; one height step is roughly 1.5 meters. Elements on a tile: path or queue, a ride piece, scenery, or nothing. Rides and large scenery can span several tiles. Terrain editing is corner-based like RCT, with a brush for raising, lowering, leveling, and smoothing areas, and a cost per change.

The park has an entrance on the map edge, a boundary of owned land that can be extended by purchase, and guests who arrive from off-map along a path to the entrance.

Time: a park year has four seasons of one month each (RCT's calendar), a day is a few real seconds at normal speed, and the clock drives weather, research, finances, and day/night lighting.

### 4.2 Look

Stylized 3D. Saturated, soft-shaded, rounded shapes, readable at a distance. Directional sun with soft shadows, a hemisphere fill, a sky that follows the time of day, light fog at the horizon. The reference is the mockup Steve chose, which was built from primitives and already read as a park. Guests are small, simple, colorful, and numerous.

Art pipeline **(call)**: procedural first. Every object (ride, shop, scenery item, guest, vehicle, track family) starts as a model recipe in code: primitives, extrusions, lathes, and track geometry generated from a curve. This gives a consistent style, zero binary assets in the first phases, and lets an agent add a new ride without an artist. Hand-made glTF models can replace recipes per object later without touching gameplay. Textures are flat colors and simple gradients; no photo textures.

### 4.3 Camera

Free orbit camera: drag to rotate, scroll to zoom, edge or key pan, with sensible limits so you cannot go under the terrain. Plus a classic-view preset **(call)**: one key cycles the four RCT angles at RCT's elevation, with zoom but no free rotation, for people who want to frame the park the way they remember it. Both are the same camera with different constraints.

### 4.4 UI

The layout Steve chose, described so it can be built:

- Dock, bottom center. Seven tools, each with an icon and a word: Terrain, Paths, Rides, Scenery, Shops, Staff, Park. Keys 1 to 7. The active tool is highlighted.
- Tray, above the dock, opens when a tool needs choices. For Rides: category chips (Coasters, Thrill, Gentle, Water, Transport), a search field, and a horizontal row of cards with a thumbnail, name, and price. For Terrain: brush shape and size, raise/lower/level/smooth, surface types. For Paths: path styles, queue toggle, additions. For Scenery and Shops: the same card pattern. For Staff: hire buttons and patrol tools. Park opens the park-level panels (finances, research, marketing, guests, awards, objectives) in the inspector.
- Inspector, right side, one at a time. Opens when you click something in the park. Header with name and status, tabs appropriate to the thing (a ride has Overview, Pricing, Stats, Guests; a guest has Thoughts, Needs, Inventory; a staff member has Patrol, Orders). The inspector is the only panel that changes with selection. There is never a second one.
- Status pills, top left: cash and monthly delta, guests in park, park rating, date, and the speed control (pause, 1x, 2x, 4x, 8x) next to the date.
- Top right: the Assistant button, notifications, settings.
- Command bar: Cmd+K opens a palette over the viewport. Typing filters every action in the game (build X, open ride Y, hire a handyman, set park entry price, jump to a guest) plus every entity by name. Enter runs it or hands off to placement mode. The list of actions is the command registry (section 6.3), so the bar can never drift from the dock.
- Right-click on anything in the park opens its actions, drawn from the same registry.
- Notifications are toasts, top right, each with a click-to-jump target. Guest thoughts and ride events aggregate rather than spam.
- Undo and redo (Cmd+Z, Cmd+Shift+Z) cover every command, including terrain, placement, pricing, and anything the assistant did.
- Esc always cancels the current tool or placement. There are no modal dialogs for routine actions; confirmations are inline (a "Demolish" button that asks once, in place).
- Style: dark translucent panels over the viewport, system font, 12 px corner radius, minimum 32 px hit targets, every control labeled. A light theme is a later option, not a v1 requirement.

### 4.5 Coaster builder **(call)**

The hardest tool, so it gets its own section. Two modes that produce the same data.

Draw mode (default): click on the terrain or in the air to place control points; the track is a smooth curve through them. Drag a point to move it; drag its handle up or down for height; a second handle sets banking. The game generates rails, ties, and supports as you go, enforces the coaster family's limits (max slope, min radius, max bank) by snapping and by coloring a bad segment red with a one-line reason, places the station on the first flat run, and shows excitement, intensity, and nausea live in the inspector as the shape changes. A G-force strip under the stats shows where the track pulls hard. "Test" runs a train with physics and fills in the real numbers. A loop, corkscrew, or other inversion is a picked element you drop onto the curve, not something you have to draw by hand.

Classic mode: a palette of fixed pieces (straight, curves of two radii, slopes up and down, banked turns, loop, helix, brakes, lift hill, station) that append to the end of the track, for players who want RCT's piece-by-piece control. Pieces are converted into the same curve representation.

Track data: an ordered list of segments, each with length, curvature, grade, bank, and element type (plain, lift, brake, station, inversion variant). Families (wooden, steel twister, inverted, mine train, wild mouse, junior, and more in phase 3) define the limits, the vehicle, the support style, and the cost per meter. Tracks save as a separate shareable file so designs can be reused across parks.

Physics: energy-based speed along the track with friction and lift-hill drive; lateral and vertical G from curvature, grade, bank, and speed. Ratings follow RCT's shape (drops, inversions, top speed, air time, G-forces, duration, scenery nearby, intensity penalties) with original formulas. Exact formulas are left to the builder, tuned so a sensible first coaster lands around excitement 5 to 6 and a reckless one is flagged as too intense.

### 4.6 Simulation scope: the full feature list

This is the parity target, phased in section 8. A builder should treat it as the backlog, not the first plan.

Terrain and land: corner-height editing, surface types, water, land ownership and purchase, construction rights, map edges, height markers, minimap.

Paths: footpaths with styles, queue lines, path additions (benches, bins, lamps, jumping fountains), elevated and underground paths, path finding for guests and staff, litter and vomit on paths.

Rides, by RCT category:

- Transport: miniature railway, monorail, chairlift, suspended monorail, elevator.
- Gentle: carousel, Ferris wheel, observation tower, spiral slide, haunted house, mini golf, car ride, dodgems, maze, circus, crooked house, flying saucers, ghost train, space rings.
- Roller coasters: wooden, steel (several families), inverted, mine train, wild mouse, junior, suspended swinging, bobsleigh, looping, corkscrew, stand-up, twister, giga, hyper, flying, LIM launched, reverser, side-friction, virginia reel, heartline twister, mini suspended, and more as the family system allows.
- Thrill: swinging ship, pirate ship variants, top spin, launched freefall, roto-drop, enterprise, motion simulator, 3D cinema, twist, go-karts, magic carpet, swinging inverter.
- Water: log flume, river rapids, boat hire, dinghy slide, splash boats, submarine ride, water coaster.
- Shops and stalls: food (several), drink (several), souvenir, information kiosk, toilets, first aid, ATM, balloon, umbrella, hat, and others.

Ride operation: build, test, open, close, demolish; pricing; operating modes per ride; number of vehicles and cars; min and max wait times; synchronise adjacent stations; inspection interval; breakdowns and mechanic repair; ride age and reliability; ride music; customers, income, running cost, excitement/intensity/nausea, value, and history graphs; queue length and time; thoughts about the ride.

Guests: individual agents with happiness, energy, hunger, thirst, bathroom, nausea, money, intensity and nausea tolerance, preferred rides, and thoughts. Entry decisions, ride choice, queue patience, buying from shops, carrying items, eating, bins and littering, vomiting, vandalism when angry, getting lost, leaving. Guest count targets drive scenario objectives.

Staff: handymen (sweep, mow, water gardens, empty bins), mechanics (inspect, fix), security guards (deter vandalism), entertainers (cheer queues); patrol areas; wages; orders.

Finances: cash, loan and interest, income and expense by category, construction and demolition costs, running costs, wages, marketing campaigns (park entry discount, ride free entry, food voucher, advertising), park entry fee versus pay-per-ride, park value, company value, bankruptcy.

Research: funding level, category priorities, discovery of new rides, shops, and scenery over time.

Park: rating (cleanliness, happiness, ride variety, litter, vandalism), awards, park open/closed, entrance pricing, guest generation rate, scenario objectives (guests by date, park value, ride profit, coaster count with minimum excitement, and others), win and loss.

Scenery: trees, shrubs, gardens, flowers, walls, fences, fountains, statues, signs, banners, themed sets (several, original), large scenery, paths through scenery, scenery value in ride ratings.

Weather: sunny, cloudy, rain, storm; affects guest mood, umbrella sales, water ride popularity.

Meta: save and load with autosave; new game from scenario; scenario editor; track designer and track files; screenshots; options; sound effects and ride music; tutorial hints; localization hooks (English first).

### 4.7 Content model

Ride types, shops, scenery, and track families are data, not code: JSON (or TS that compiles to JSON) describing stats, cost, footprint, operating modes, the model recipe, and sounds. Adding a ride means adding a data file and, optionally, a recipe. This is also the eventual mod format.

## 5. Architecture **(call)**

### 5.1 Stack

TypeScript end to end, one monorepo, pnpm workspaces.

- Simulation: pure TypeScript, no DOM, runs in a Web Worker in the app and in Node for the CLI, MCP server, and tests.
- Rendering: three.js on WebGL2, moving to its WebGPU renderer when WKWebView ships it reliably. Instanced meshes for guests, trees, path tiles, and supports. Terrain as a chunked mesh with per-corner heights.
- UI: React 19, Tailwind 4, Radix primitives for menus, dialogs, sliders, and the command palette. UI state in Zustand. The UI never touches sim state directly; it reads snapshots and sends commands.
- Desktop shell: Tauri 2. Mac app bundle, native menu bar, file dialogs, autosave location, later Windows and Linux from the same code. The Rust side is as thin as Tauri allows; game logic never lives there.
- Web build: the same app served by Vite, deployed to GitHub Pages as a playable demo with a smaller default park. Headless and MCP features are desktop and CLI only.
- CLI: `coasterworks` binary (Node) with `run` (headless), `mcp` (stdio MCP server), `inspect` (save file), `scenario` tools.
- MCP server: the official TypeScript MCP SDK.
- Tests: Vitest for the sim and protocol; Playwright for UI smoke tests; MCP integration tests run the CLI server in-process.

Why this and not Rust/Bevy, Godot, or Swift: the complaint driving the project is UI, and web UI tooling is where polish is cheapest and where agent-written code is most reliable. One language keeps the sim, the UI, the MCP server, and the tests in the same type system. A web build gives an open-source project a zero-install demo. Determinism and headless running are easy in a pure TS core. The known cost is raw simulation speed; RCT2 ran 10,000 guests on 1999 hardware in C, and a tuned TS sim on an M1 has two orders of magnitude more headroom. If profiling shows a hot loop that TS cannot carry (pathfinding over very large parks is the likely one), that loop moves to Rust compiled to WebAssembly, behind the same interface. Swift/Metal was rejected as Mac-only. Godot and Bevy were rejected for UI polish and headless testability.

### 5.2 Packages

```
apps/
  desktop/      Tauri shell around the web app
  web/          Vite app: renderer + UI, also the GitHub Pages demo
  cli/          coasterworks CLI: headless run, MCP stdio server, tools
packages/
  sim/          world model, systems, tick loop, save/load, replay
  protocol/     command and query registry: Zod schemas, descriptions, undo info
  mcp/          MCP server built from the registry; stdio and HTTP transports
  render/       three.js scene, terrain, instancing, track geometry, picking
  ui/           React components: dock, tray, inspector, command bar, assistant
  content/      ride, shop, scenery, track-family data and model recipes
  assistant/    provider interface and the Claude Code, API key, and local providers
docs/
  superpowers/specs/   this document and successors
  superpowers/plans/   implementation plans
```

### 5.3 Command and query layer

The heart of the design, because it is what "one action list" and "MCP native" both mean.

A command is a named, schema-validated mutation: `terrain.raise`, `path.build`, `ride.build`, `coaster.set_track`, `ride.set_price`, `ride.open`, `staff.hire`, `finance.take_loan`, `park.set_entry_fee`, and so on. Each has a Zod input schema, a one-sentence description, a cost estimate function, a validator that can reject with a human-readable reason, an apply function, and undo data. The registry is the single source for the dock, the tray, the command bar, right-click menus, the MCP tool list, and the CLI.

A query is a named read: `park.status`, `ride.get`, `ride.list`, `guest.list`, `guest.thoughts`, `finance.summary`, `terrain.heights`, `view.screenshot`. Same registry, same descriptions.

All mutations go through commands. The UI, the MCP server, the CLI, replay, and the assistant are all clients. The sim keeps an append-only command log with the issuing client (player, agent, replay) and a tick number, which gives undo, replay, determinism tests, and an in-game timeline of what the assistant did.

Undo semantics **(call)**, since time keeps passing:

- Every command carries the data for its inverse. Undo applies the inverse as a new logged command (`undo` with the target command id), so replay stays complete. Redo likewise.
- The inverse is validated against the current state like any command. If something now depends on the original (a ride built on raised terrain, a path a queue joins), undo is rejected inline with a one-line reason ("Demolish Thunder Run first"). Guests standing on changed tiles are not a conflict; the sim relocates them.
- Money inverses refund or recharge the exact original amount. Interest, wages, and income that accrued in between are separate transactions and stay.
- `sim.advance`, speed changes, and saves are not commands in the undo stack and do not clear it.
- Assistant messages get a checkpoint: before the first tool call of a message, the sim snapshots the world. "Undo this message" restores the snapshot, rewinding time, and is logged as `restore_checkpoint` for replay. A restore clears the player's undo stack.
- The determinism test for undo is apply-then-undo with no ticks in between returns the same state hash.

### 5.4 Simulation loop

Fixed tick rate, 40 ticks per second of game time at 1x, scaled by speed. Seeded PRNG, one stream per system to keep changes local. State-affecting math is integer or fixed-point (positions, speeds, money, ratings) with lookup tables for trig, never `Math.sin`, `Math.random`, or floating-point accumulation, so JavaScriptCore in the app and V8 in the CLI produce identical hashes. Floats are fine in the renderer. Systems run in a fixed order each tick: time and weather, finances (monthly), research, ride operation and vehicles, guest decisions and movement, staff, park rating, notifications. The worker sends the renderer a compact snapshot each frame (typed arrays for guest and vehicle transforms, dirty lists for tiles and entities) so a 5,000-guest park does not serialize 5,000 objects per frame.

Save format: a single JSON document, gzipped, extension `.park`, with a schema version and migrations. Scenarios are `.scenario` (a park plus objectives and starting conditions). Track designs are `.track`. All three are plain data a human or agent can read.

### 5.5 Processes

Process topology **(call)**, because a webview cannot listen on a socket and the app contains no Node by default:

- Desktop app: three processes. The Tauri shell (Rust, thin). A bundled Node sidecar that owns the authoritative sim, the MCP server, the assistant providers, and autosave. The webview, which is renderer plus UI and talks to the sidecar over a local WebSocket with a per-launch token. The sidecar is the same code as the CLI; the app is the CLI with a window.
- Web demo: no sidecar. The sim runs in a Web Worker in the page, behind the same client interface (`SimHost` with `worker` and `socket` implementations). No MCP, no assistant, no headless in the browser.
- Snapshots from sim to renderer are binary frames (typed arrays for guest and vehicle transforms, dirty lists for tiles and entities) sent at tick rate and interpolated by the renderer. At 5,000 guests that is well under 100 KB per tick over localhost.
- `view.screenshot` in the app is served by the sidecar asking the webview for a canvas capture.
- Packaging: the sidecar is a single-file Node binary built per platform and signed with the app. Phase 0 includes this, which is the main reason phase 0 is not small.

### 5.6 Rendering

Terrain is chunked meshes rebuilt per chunk on edit. Paths, queues, and scenery are instanced per type. Guests and vehicles are instanced with per-instance color and a small set of animation poses. Coaster track is generated geometry per family: a rail profile swept along the curve, ties at intervals, supports dropped to terrain. Picking uses a GPU id buffer so clicking a guest in a crowd works. Lighting: one shadowed directional light following the time of day, a hemisphere light, tone mapping, fog. Target: 60 fps on an M1 Air at 1440x900 with a mid-size park.

## 6. MCP native **(call, per Steve's "both")**

### 6.1 Server

The sidecar runs an MCP server whenever a park is open. Transport: Streamable HTTP on `127.0.0.1` with a per-session token shown in Settings, plus a one-click "copy config for Claude Desktop / Claude Code" button. For clients that only launch stdio servers, `coasterworks mcp --attach` is a stdio proxy to the running app. `coasterworks mcp --save park.park` runs the same server over stdio against a save file with no renderer. Local only; the sim makes no network calls.

Tools are generated from the registry: every command and every query becomes a tool with the same name, description, and schema. Agent-issued commands are attributed in the command log and appear in the in-game timeline; they are undoable like the player's.

Extra tools for agents: `sim.advance(days)` (runs headless-fast, even in the app, with the renderer paused), `sim.set_speed`, `view.screenshot` (PNG of the current viewport; app only), `view.overview` (a top-down PNG map of an area drawn in pure Node, plus a structured text summary of what is on it; works headless, so an agent without a window can still see the park), `view.focus(entity)`, `save.write`, `save.load`, `coaster.build_from_points` (the draw-mode builder as one call), `coaster.evaluate` (ratings without building). Rendered 3D screenshots in headless mode are deferred to phase 3 **(call)**; they would need a headless Chromium in the CLI and CI. Resources: `park://status`, `park://rides`, `park://guests/summary`, and the docs. Prompts: "design a coaster for this plot," "why are guests unhappy," "plan a year."

### 6.2 Headless mode

`coasterworks run --save park.park --days 365 --out result.park` runs the sim without rendering as fast as the CPU allows. Used by agents, by CI determinism tests, and by the README demo: an agent builds a park from a prompt, runs a season, reads the results, adjusts, and hands back the save.

### 6.3 Assistant panel

A chat panel behind the top-right button. It is a thin MCP client with a pluggable model provider. It shows the conversation, streams the assistant's actions as they happen (each action is a command, so it shows in the timeline and highlights the thing in the park), and has one undo for "everything from this message."

Providers, in order of implementation:

1. Claude Code provider. Uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which drives the user's installed Claude Code and its existing login, with the game's MCP server passed as an MCP config. This is how Steve uses it with no API key. The builder must verify at implementation time that the Agent SDK uses Claude Code's subscription login on this machine; if it does not, the fallback is spawning the `claude` CLI directly in print mode with the same MCP config, which is Claude Code itself.
2. Anthropic API provider. Official `@anthropic-ai/sdk`, tool runner with Zod tools, streaming, default model `claude-opus-5-5`, adaptive thinking, server-side refusal fallbacks on. For users who prefer a key. The `claude-api` skill's TypeScript reference is the authority when this is written.
3. OpenAI-compatible endpoint provider for local models (Ollama, LM Studio) and other hosted models. Tool-calling quality will vary; the panel says so.

The assistant has the same tools as an external MCP client and nothing more.

## 7. Open source project

- Repository: `github.com/Stothe/<name>` (Steve's GitHub login is Stothe) unless he wants an org.
- License **(call)**: MIT for code, CC BY 4.0 for art, data, and sounds. MIT keeps contribution friction low; OpenRCT2 compatibility is not a goal since no code is shared.
- CI: GitHub Actions. Ubuntu runner for lint, typecheck, sim tests, determinism replay, MCP integration tests. macOS runner for the Tauri build and a Playwright smoke test. A tagged release produces a signed-if-possible `.dmg` and the web demo deploy.
- README leads with a screenshot, a 20-second clip of the agent building a park, "download for Mac," "play in browser," and "connect Claude."
- `CONTRIBUTING.md` explains the command registry, how to add a ride (data file plus recipe), and the determinism test you must keep green.
- Issues and discussions on. Conventional commits. Branch protection on main with CI required.

## 8. Phases

Each phase ends with a tagged release and a demo clip. "Done" means the listed things work in the Mac app and through MCP, with tests.

Phase 0, foundation: monorepo, registry with a dozen commands and queries, sim with terrain and time, renderer with terrain and camera, dock and inspector skeleton, command bar, Tauri Mac app, CLI headless run, MCP stdio and HTTP with the registry's tools, determinism replay test in CI, GitHub repo with CI green.

Phase 1, Steve's afternoon **(Steve's milestone)**: terrain editing with the brush; paths and queues; a park entrance and gate fee; guests who arrive, walk, queue, ride, buy, think, and leave; money that goes up and down; the ride set: carousel, Ferris wheel, spiral slide, swinging ship, two food stalls, a drink stall, toilets, and one steel coaster family with the draw-mode builder, live ratings, test runs, and auto supports; save and load; the assistant panel with the Claude Code provider; MCP tools for everything above; the web demo. Done when Steve builds a small park in an afternoon without asking how.

Phase 2, a real game: staff and patrols; breakdowns and mechanics; litter, bins, vomit, handymen; scenery sets and scenery value; research; loans and interest; marketing; park rating and awards; weather; three more coaster families and the classic-pieces mode; a dozen more rides across categories; scenario objectives and five original scenarios; minimap; notifications and the timeline; the API-key and local providers; the classic-view camera preset.

Phase 3, parity: the rest of the ride list; transport rides with multiple stations; water rides; path additions and elevated paths; land purchase; vandalism and security; ride music and sound; scenario editor; track designer and sharing; time of day; localization hooks; the content format documented as the mod format.

Phase 4, platforms: Windows and Linux builds through Tauri, code signing and notarization, auto-update, performance work for 256x256 parks, WebGPU renderer.

## 9. Testing

- Sim: unit tests per system; golden replays (seed plus command log produces a known state hash) that run in CI on every push and on every platform in the matrix.
- Protocol: every command has a schema test and a validator test; every command must be undoable and the test proves apply-undo with no ticks in between returns the same hash.
- MCP: integration tests spin up the stdio server and drive it with the SDK client; the README demo script is a test.
- Render and UI: Playwright smoke on the web build with a screenshot diff of a fixed park at a fixed camera; a manual checklist for the Mac app per release.
- Performance: a benchmark park with 5,000 guests, tick time and frame time tracked in CI with a failing threshold.

## 10. Calls Claude made

For Steve to check while reading. Each is overridable.

1. Working name "Coasterworks." (Open question 1.)
2. Stack: TypeScript, three.js, React, Tailwind, Tauri 2, official MCP SDK; WebAssembly escape hatch.
3. Procedural-first art, glTF later.
4. Draw-mode coaster builder as default, classic pieces as a mode.
5. Classic-view camera preset.
6. Dock tool set: Terrain, Paths, Rides, Scenery, Shops, Staff, Park.
7. Dark translucent UI theme first; light later.
8. Command registry as the single action list; undo on everything.
9. 40 ticks per second; seeded PRNG; JSON+gzip saves.
10. MCP over Streamable HTTP in-app with a token, stdio in the CLI.
11. Assistant providers: Claude Code first, API key second, local third.
12. MIT code, CC BY 4.0 assets.
13. Phasing in section 8, with Steve's afternoon as phase 1.
14. Non-goals: multiplayer, RCT file import, mobile.
15. Desktop app is a Node sidecar that owns the sim, plus a webview client; the web demo runs the sim in a worker (5.5).
16. Undo is inverse commands with inline conflict rejection; assistant messages get a time-rewinding checkpoint (5.3).
17. Headless agents get a top-down map and text overview; rendered 3D screenshots are app-only until phase 3 (6.1).
18. Integer and fixed-point sim math for cross-engine determinism (5.4).
19. A stdio attach proxy for MCP clients that cannot use HTTP (6.1).

## 11. Left to the builder

- Exact rating, guest, and economy formulas and their tuning.
- Ride data values (costs, stats, footprints) for every ride.
- Model recipes and the recipe DSL.
- Terrain mesh and chunking details, LOD, instancing strategy.
- Command naming beyond the examples; schema details.
- Save schema and migration mechanism.
- Pathfinding algorithm and caching.
- Exact UI component structure, animation, and keyboard map beyond what section 4.4 fixes.
- CI matrix details, release tooling, signing.

## 12. Open questions for Steve

1. Name. "Coasterworks" is free on GitHub. "Parkway" is nearly free. "Midway" collides with a popular Node framework. Pick one or give another.
2. Repo home: `Stothe/<name>` or a new org.

Anything not listed here is either decided above or left to the builder.

## 13. References

- OpenRCT2 (behavioral reference only; GPLv3, no code reuse): https://github.com/OpenRCT2/OpenRCT2
- three.js: https://threejs.org
- Tauri 2: https://tauri.app
- Model Context Protocol TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk
- Brainstorm mockups: `.superpowers/brainstorm/*/content/visual-style.html` and `ui-layout.html`
