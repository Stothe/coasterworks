# Plan B: Renderer and Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** See a park and fly around it, in a browser and in a Mac app, with click-to-edit terrain, status pills and speed control, while the sim runs in a worker (web) or a sidecar process (desktop) and MCP agents change the park live.

**Architecture:** `packages/protocol` defines the client/host message protocol and a `SimHostServer` that wraps a `Sim`, runs the tick loop, and streams binary snapshots; the web app hosts it in a Web Worker, the CLI's new `serve` command hosts it behind a WebSocket next to the MCP HTTP endpoint. `packages/render` turns terrain into chunked flat-shaded three.js meshes with a camera rig and picking. `apps/web` is the Vite + React client. `apps/desktop` is a Tauri 2 shell that spawns the sidecar and opens the web app against it.

**Tech Stack:** TypeScript, three.js (latest 0.1xx) + `@types/three`, React 19, Vite 7, Tailwind 4 (`@tailwindcss/vite`), `ws` 8, Tauri 2 (`@tauri-apps/cli`, `@tauri-apps/api`, `tauri-plugin-shell`), Playwright, Bun (CI determinism leg only).

**Spec:** `docs/superpowers/specs/2026-10-16-coasterworks-design.md` (sections 4.1 to 4.3, 5.1, 5.2, 5.4 to 5.6, 6.1 HTTP transport, 9).

**Spec refinements made here:**
- Protocol v1 between client and host is JSON text frames plus one binary snapshot frame type (section 5.5's "binary frames"). Snapshots carry terrain only when it changed; guests and vehicles arrive in Plan D.
- Rendering scale: 1 tile = 1 world unit, 1 corner-height step = 0.25 units. Chunk size 16 tiles.
- The visual day/night cycle is one game month long (about 5 minutes at 1x), not one game day (10 seconds would flicker).
- Speed (0 paused, 1, 2, 4, 8) is host state, not world state. It is not a command and not saved.
- The desktop app in this plan runs in dev mode with the sidecar spawned as `node apps/cli/dist/index.js serve`. The compiled single-binary sidecar and the signed `.dmg` are Plan G.
- Plan A follow-through (Task 0) lands the hardening the final review deferred: gzip CRC verification, load invariants, a JavaScriptCore golden leg in CI, CLI `query`, file-tool path rules.

## Global Constraints

- Everything in Plan A's Global Constraints still holds: Node `>=22`, pnpm 10, TypeScript strict, ESM/NodeNext, no `Math.random`/trig/`Date`/`performance` in `packages/sim/src` (the lint regex), integer money and heights, conventional commits with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer, `pnpm typecheck && pnpm build && pnpm test && pnpm format:check` green at every commit.
- New package names: `@coasterworks/protocol`, `@coasterworks/render`, `@coasterworks/web`, `@coasterworks/desktop`. `protocol` depends only on `sim` and `zod`; `render` depends on `three` and `protocol` (types only); `web` depends on `protocol`, `render`, `react`; `cli` gains `protocol` and `ws`.
- `packages/protocol/src` obeys the same `types: []` rule as sim (it runs in workers, browsers and Node). Transports that need Node or DOM APIs live in the app that uses them.
- The renderer may use floating point and `Math.sin`; it never mutates sim state.
- Tauri app identifier `com.coasterworks.app`; window title `Coasterworks`; minimum window 1100x700.
- Vitest aliases (as in Plan A's fix wave) point every `@coasterworks/*` import at `src/index.ts` in each new package's `vitest.config.ts`.

## Review Focus

1. A client that sends a malformed message (bad JSON, unknown `t`, missing `id`) must get an `{ t: "error" }` reply or be ignored, never crash the host or stop the tick loop. Test in Task 1.
2. Two clients on one host (desktop window plus an MCP agent) must both see a park change made by either; the snapshot after an MCP tool call must carry new terrain. Test in Task 4.
3. Clicking at the map edge or off the map must not throw or send an off-map command; the pick returns `null` outside the terrain. Test in Task 2 (picker math) and Task 3 (no command sent).
4. The tick loop must not drift or double-run when the tab is in the background: ticks per real second stay bounded by `speed * 40` and a long pause does not cause a burst of thousands of ticks. Test in Task 1 with fake timers.
5. The sidecar must exit when the window closes and must not leave the port open or the save half-written. Test in Task 4 (SIGINT path) and Task 5 (child killed on exit, manual).

---

### Task 0: Plan A follow-through

**Files:**
- Modify: `packages/sim/src/save/codec.ts`, `packages/sim/src/save/crc32.ts` (create), `packages/sim/src/commands/sim.ts` (export `MAX_ADVANCE_DAYS`), `packages/mcp/src/server.ts`, `packages/mcp/src/http.ts`, `apps/cli/src/commands/query.ts` (create), `apps/cli/src/commands/run.ts`, `apps/cli/src/index.ts`, `.github/workflows/ci.yml`, `CONTRIBUTING.md`
- Test: `packages/sim/test/save.test.ts`, `packages/sim/test/crc32.test.ts`, `packages/mcp/test/server.test.ts`, `packages/mcp/test/http.test.ts`, `apps/cli/test/cli.test.ts`

**Interfaces:**
- Produces: `crc32(bytes: Uint8Array): number` (IEEE, table-driven, uint32). `deserializeWorld` verifies the gzip trailer (CRC32 of the uncompressed bytes and ISIZE) before parsing and throws `SaveError("Save file is corrupt")` on mismatch; it compares the stored `hash` only when no migration ran (a migrated document's `hash` is recomputed from the rebuilt world and the save is accepted). `codec.ts` header comment updated to match.
- Load invariants in `deserializeWorld`: every corner `0..MAX_HEIGHT`, every surface `0..4`, every water `0..MAX_HEIGHT`, log ids strictly increasing from 1 and all `< nextId`, every `undoStack`/`redoStack` id names a log entry that has `undo` data, no id in both stacks. Violations throw `SaveError("Save file is corrupt")`.
- MCP file tools: `save_write`/`save_load` accept only paths ending in `.park` (`"Only .park files can be written"` / `"... read"`), and `serveHttp` enables the SDK's DNS-rebinding protection with `allowedHosts: ["127.0.0.1", "localhost"]` plus the port variants; when no `--token` and no env token are given to `coasterworks mcp --http`, the CLI generates a 32-byte base64url token and includes it in the printed JSON (replacing the usage error).
- CLI: `coasterworks query --save <file> --name <query> [--input <json>]` prints the `QueryResult` JSON (exit 1 on `ok: false`); `coasterworks undo --save <file> --out <file>` and `coasterworks redo ...` (exit 1 on failure). `MAX_ADVANCE_DAYS` is exported from sim and used by the CLI instead of its own copy.
- CI: a third job `golden-jsc` on `macos-latest` using `oven-sh/setup-bun@v2` that runs `bun packages/sim/scripts/update-golden.ts` then `git diff --exit-code packages/sim/test/golden/scenario-1.hash`. This is the JavaScriptCore versus V8 determinism check.

- [ ] **Step 1: Write `test/crc32.test.ts`**: `crc32(new Uint8Array([]))` is 0; `crc32(bytes("123456789"))` is `0xCBF43926`; `crc32(bytes("The quick brown fox jumps over the lazy dog"))` is `0x414FA339`.
- [ ] **Step 2: Extend `save.test.ts`**: the existing byte-flip fuzz now expects `SaveError` for every flip that changes the payload (header-byte flips that gzip still accepts remain the exception); a document with a registered migration from version 0 that changes `cash` loads successfully and the loaded world's hash equals `hashWorld` of the rebuilt world; one invariant test per rule above (corner 64, surface 5, water 64, duplicate log id, stack id without undo data, id in both stacks) each throws the corrupt message.
- [ ] **Step 3: Run, expect FAIL. Implement `crc32.ts` and the codec changes.** Parse the gzip trailer yourself: the last 8 bytes are CRC32 then ISIZE, little-endian; compare against the gunzipped bytes.
- [ ] **Step 4: MCP tests**: `save_write` to `x.txt` returns `isError` with `"Only .park files can be written"`; `save_load` of `x.json` likewise; an HTTP request with `Host: evil.example` gets a 403 from the SDK's rebinding protection (or 401 if auth runs first; pin whichever the code does and say why in the test name). `mcp --http 0` with no token prints a `token` field of 43 characters.
- [ ] **Step 5: CLI tests**: `query --name park_status` prints `date "March 1, Year 1"`; `query --name terrain_get --input '{"x":0,"y":0,"w":2,"h":2}'` returns 9 corners; `undo` after an `exec terrain_raise --out f` restores cash; `redo` re-charges; `run --days 3651` still fails with the sim's own message.
- [ ] **Step 6: Implement, then `ci.yml` and CONTRIBUTING ("Determinism" gains a sentence about the Bun leg; "Try it headless" in README gains `query`).**
- [ ] **Step 7: Full verification green; commit** `fix(sim,mcp,cli): gzip CRC and load invariants, .park-only file tools, token generation, query/undo/redo subcommands, JSC golden leg`.

---

### Task 1: Protocol package: messages, snapshots, SimHostServer, SimClient

**Files:**
- Create: `packages/protocol/package.json`, `tsconfig.json`, `vitest.config.ts`, `test/tsconfig.json`, `src/index.ts`, `src/messages.ts`, `src/snapshot.ts`, `src/transport.ts`, `src/host.ts`, `src/client.ts`
- Test: `packages/protocol/test/messages.test.ts`, `test/snapshot.test.ts`, `test/host.test.ts`, `test/client.test.ts`

**Interfaces:**
- `src/transport.ts`:
  ```ts
  export type Frame = string | Uint8Array;
  export interface MessageTransport { send(frame: Frame): void; onMessage(handler: (frame: Frame) => void): void; onClose(handler: () => void): void; close(): void }
  export function createLinkedTransports(): [MessageTransport, MessageTransport]; // in-memory pair for tests and the worker shim
  ```
- `src/messages.ts` (Zod 4 schemas and inferred types): `PROTOCOL_VERSION = 1`; `Speed = 0 | 1 | 2 | 4 | 8`; client messages `hello { t: "hello"; protocol: number }`, `command { t: "command"; id: number; name: string; input: unknown }`, `query { t: "query"; id; name; input }`, `undo { t: "undo"; id }`, `redo { t: "redo"; id }`, `speed { t: "speed"; id; speed: Speed }`, `snapshot { t: "snapshot"; id }`; host messages `welcome { t: "welcome"; protocol; width; height; name; speed }`, `result { t: "result"; id; result: ExecResult | QueryResult | { ok: true } }`, `event { t: "event"; kind: "log"; entry: LogEntryPublic }` (log entry without `undo`), `error { t: "error"; id?: number; message: string }`. `parseClientMessage(text: string): ClientMessage | { error: string }`, `parseHostMessage(text)` likewise.
- `src/snapshot.ts`: `interface SnapshotHeader { tick: number; speed: Speed; cash: number; loan: number; date: string; terrainVersion: number; hasTerrain: boolean; width: number; height: number }`; `encodeSnapshot(header, terrain?: { corners: Int16Array; surface: Uint8Array; water: Uint8Array }): Uint8Array` (magic bytes `CWS1`, uint32 LE header length, UTF-8 JSON header, then little-endian corner bytes, surface, water when `hasTerrain`); `decodeSnapshot(bytes: Uint8Array): { header: SnapshotHeader; terrain?: {...} }` throwing `ProtocolError` on bad magic or length mismatch. Little-endian encoding of Int16 is explicit (as in the save codec).
- `src/host.ts`:
  ```ts
  export interface HostTimers { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void; now(): number }
  export interface SimHostOptions { timers?: HostTimers /* default globalThis timers + performance/Date via injection by the app, not read here */; snapshotIntervalMs?: number /* 50 */; maxTicksPerFrame?: number /* 40 */; onMutate?: (world: World) => void }
  export class SimHostServer {
    constructor(sim: Sim, opts?: SimHostOptions);
    attach(transport: MessageTransport): void;   // many clients
    detach(transport: MessageTransport): void;
    get speed(): Speed; setSpeed(s: Speed): void;
    start(): void; stop(): void;                 // tick loop
    tick(): void;                                // one scheduler step, public for tests: runs up to maxTicksPerFrame ticks based on elapsed time and speed, then broadcasts a snapshot if due
    notifyExternalMutation(): void;              // call after sim.execute from outside the protocol (MCP); bumps terrainVersion and broadcasts
  }
  ```
  Behavior: on `hello` with a wrong protocol reply `error` and close that transport; otherwise `welcome` then a full snapshot. Commands are executed as client `"player"` (the socket client is the player; MCP is the agent and goes through `sim` directly). After any successful mutation (command, undo, redo, or `notifyExternalMutation`) bump `terrainVersion` and broadcast a snapshot immediately and an `event` with the new log entry. Terrain arrays are included in a snapshot only for transports whose last-sent `terrainVersion` is older. The scheduler: on each `tick()` call compute `elapsed = now - last`, `due = floor(elapsed * 40 * speed / 1000)` capped at `maxTicksPerFrame`, run `sim.step(due)`, set `last += due / (40 * speed) * 1000` (so leftover time carries) but never let the backlog exceed one frame (if `elapsed > 250 ms`, drop the backlog: `last = now`). Also detect external mutations cheaply: if `sim.world.log.length` changed since the last tick, treat it as a mutation (so an MCP call in the same process is noticed even without `notifyExternalMutation`).
- `src/client.ts`:
  ```ts
  export class SimClient {
    constructor(transport: MessageTransport);
    connect(): Promise<WelcomeMessage>;
    command(name: string, input: unknown): Promise<ExecResult>;
    query<T = unknown>(name: string, input: unknown): Promise<QueryResult<T>>;
    undo(): Promise<ExecResult>; redo(): Promise<ExecResult>;
    setSpeed(s: Speed): Promise<void>; requestSnapshot(): Promise<void>;
    onSnapshot(handler: (snap: DecodedSnapshot) => void): () => void;   // returns unsubscribe
    onEvent(handler: (ev: EventMessage) => void): () => void;
    close(): void;
  }
  ```
  Pending requests are keyed by `id`; a `result` for an unknown id is ignored; transport close rejects all pending with `ProtocolError("Connection closed")`.

- [ ] **Step 1: Package scaffold** mirroring `packages/mcp` (deps: `@coasterworks/sim` `workspace:*`, `zod`), `types: []` in `tsconfig.json`, test tsconfig with node types, vitest alias for sim.
- [ ] **Step 2: Write `messages.test.ts`**: every message kind round-trips through its schema; `parseClientMessage("{")` returns an error; unknown `t` returns an error; `command` without `id` returns an error.
- [ ] **Step 3: Write `snapshot.test.ts`**: encode/decode round trip with terrain preserves arrays (including a negative-free but max-value corner 63 and water 12) and header; without terrain `hasTerrain` false and no bytes after the header; bad magic throws `ProtocolError`; truncated bytes throw.
- [ ] **Step 4: Write `host.test.ts`** with `createLinkedTransports()` and fake timers (`HostTimers` injected with a manual `now`): hello with protocol 2 gets `error` and close; hello then welcome carries width/height/speed; a `command terrain_raise` gets a `result` with `ok: true`, then an `event` with the log entry, then a snapshot with terrain; a second snapshot after a `speed` message has no terrain; two attached clients both receive the snapshot after one of them raises terrain (Review Focus 2); a malformed frame `"{"` gets `error` and the loop keeps running (Review Focus 1); scheduler: with speed 1 and `now` advanced by 25 ms, `tick()` runs 1 sim tick; advanced by 10 s at once, runs at most `maxTicksPerFrame` (40) and drops the backlog (Review Focus 4); speed 0 runs none; `notifyExternalMutation()` after a direct `sim.execute` broadcasts terrain.
- [ ] **Step 5: Write `client.test.ts`** against a real `SimHostServer` over linked transports: `connect()` resolves with welcome; `command` resolves with the `ExecResult`; `query("park_status")` resolves; `onSnapshot` fires with decoded terrain; closing the transport rejects a pending command with `ProtocolError`.
- [ ] **Step 6: Run, expect FAIL; implement the five source files; run, expect PASS.**
- [ ] **Step 7: Commit** `feat(protocol): client/host messages, binary snapshots, SimHostServer and SimClient`

---

### Task 2: Render package: terrain geometry, camera rig, picking, scene

**Files:**
- Create: `packages/render/package.json`, `tsconfig.json` (lib `["ES2022", "DOM"]`), `vitest.config.ts`, `test/tsconfig.json`, `src/index.ts`, `src/units.ts`, `src/palette.ts`, `src/terrain-geometry.ts`, `src/camera.ts`, `src/picker.ts`, `src/scene.ts`, `src/input.ts`, `src/sky.ts`
- Test: `packages/render/test/terrain-geometry.test.ts`, `test/camera.test.ts`, `test/picker.test.ts`, `test/sky.test.ts`

**Interfaces:**
- `src/units.ts`: `HEIGHT_STEP = 0.25`, `CHUNK = 16`, `tileToWorld(x, y, h): [number, number, number]` (world x = tile x, world z = tile y, world y = h * HEIGHT_STEP).
- `src/palette.ts`: `SURFACE_COLORS: Record<Surface, [r, g, b]>` (grass `#6fbf4a`, sand `#e3d28a`, dirt `#8a6a3e`, rock `#8d8d8d`, snow `#f2f6fa`), `surfaceColor(surface, x, y): [r, g, b]` applying a checker of ±4% lightness by `(x + y) % 2` for grass only; `WATER_COLOR = #3aa0e0`.
- `src/terrain-geometry.ts`: `interface TerrainData { width; height; corners: Int16Array; surface: Uint8Array; water: Uint8Array }`; `buildChunkGeometry(t: TerrainData, chunkX: number, chunkY: number): ChunkGeometry` returning `{ positions: Float32Array; normals: Float32Array; colors: Float32Array; indices: Uint32Array; tileCount: number }` with per-triangle duplicated vertices (flat shading), the diagonal chosen so that the split joins the two corners with the smaller height difference, normals computed per triangle; `buildWaterGeometry(t, chunkX, chunkY): ChunkGeometry | null` with one quad per water tile at `water * HEIGHT_STEP`; `chunkCount(t): { cx: number; cy: number }`.
- `src/camera.ts`: `class CameraRig { target = { x, y, z }; distance = 40; yaw = PI/4; pitch = 0.6; readonly limits = { pitch: [0.26, 1.4], distance: [4, 200] }; orbit(dYaw, dPitch); zoom(factor); pan(dxScreen, dyScreen, viewportHeight) /* moves target in the ground plane relative to yaw */; setClassic(index: 0|1|2|3) /* yaw = PI/4 + index*PI/2, pitch = 0.615 (RCT's ~35°), distance unchanged */; clampTarget(width, height); position(): { x, y, z } /* spherical */; applyTo(camera: { position: {set}; lookAt(x,y,z) }) }`.
- `src/picker.ts`: pure math `pickTile(ray: { origin: V3; direction: V3 }, t: TerrainData): { x: number; y: number; point: V3 } | null` by marching the ray across tiles (DDA over the grid) and intersecting the two triangles of each candidate tile (Möller–Trumbore); returns `null` when the ray misses the map. The scene wraps it with three's `Raycaster` for the ray only.
- `src/sky.ts`: `sunFor(t: number /* 0..1 of the visual day */): { elevation: number; azimuth: number; intensity: number; color: [r,g,b]; skyColor: [r,g,b]; ambient: number }` with a daytime plateau and a short dusk/dawn; night is never fully black (ambient >= 0.25).
- `src/scene.ts`: `createScene(canvas: HTMLCanvasElement, opts?: { pixelRatioCap?: number /* 2 */ }): SceneHandle` where `SceneHandle = { rig: CameraRig; setTerrain(t: TerrainData): void /* rebuilds all chunks */; updateTerrain(t: TerrainData): void /* rebuilds only chunks whose bytes changed, by per-chunk fnv hash of its corner/surface/water slices */; setTimeOfDay(t: number): void; render(): void; resize(): void; pickAt(clientX, clientY): { x, y } | null; highlightTile(x: number, y: number, w: number, h: number) | highlightTile(null); dispose(): void }`. Lighting: `DirectionalLight` with shadow map 2048 following `sunFor`, `HemisphereLight`, `Fog`, `ACESFilmicToneMapping`, `MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })` for terrain and a translucent water material; the highlight is a thin `Mesh` box outline over the tile rect.
- `src/input.ts`: `attachControls(canvas, rig, handlers: { onTileClick(x, y, mods: { shift: boolean; alt: boolean }): void; onHover(x: number | null, y: number | null): void; pick(clientX, clientY) }, opts?: { keyTarget?: Window }): () => void` (returns detach): left click → pick → `onTileClick`; left drag with the pointer moving more than 4 px is a pan, not a click; right drag orbits; wheel zooms (factor `1.1 ** deltaY/100`); keys `q`/`e` rotate yaw by ±90° animated over 250 ms; `Home` → `setClassic(0)`; `1`-`4` → `setClassic(n-1)`.

- [ ] **Step 1: Package scaffold**: deps `three`, `@types/three`, `@coasterworks/protocol` (types), `@coasterworks/sim` (types only, for `Surface`); vitest with `environment: "node"` for the pure tests.
- [ ] **Step 2: Write `terrain-geometry.test.ts`**: a flat 16x16 chunk at height 8 has `tileCount` 256, 512 triangles, every normal `(0,1,0)`, every y `2.0`; raising corner (1,1) to 12 makes the four tiles around it non-flat and the tile (0,0)'s diagonal join (0,0)-(1,1)? No: assert the diagonal joins the two corners with the smaller height difference by checking the index pattern on a tile with corners `[8, 8, 12, 8]`; colors for grass alternate by parity; a water tile at level 12 yields a quad at y `3.0`; a chunk partly off the map (last chunk of a 20x20 map) has `tileCount` 16 (4x4).
- [ ] **Step 3: Write `camera.test.ts`**: `position()` at yaw 0, pitch 0, distance 10 is `target + (10, 0, 0)`; pitch is clamped to the limits; `zoom(0.5)` halves the distance down to the minimum; `setClassic(1)` adds 90° yaw; `pan` moves the target along the camera's right/forward ground vectors; `clampTarget(64, 64)` keeps the target inside `[0, 64]`.
- [ ] **Step 4: Write `picker.test.ts`**: a ray straight down at (5.5, 100, 7.5) over flat terrain hits tile (5, 7) at y 2.0; a ray at (-1, 100, 3) misses (`null`, Review Focus 3); a ray pointing away from the map misses; a ray hitting a raised tile returns the correct tile and a point on the raised surface.
- [ ] **Step 5: Write `sky.test.ts`**: `sunFor(0.5)` has elevation near the maximum and intensity 1; `sunFor(0)` and `sunFor(1)` are equal (wraps); ambient never below 0.25 across 100 samples.
- [ ] **Step 6: Implement all source files; run pure tests, expect PASS.** `scene.ts` and `input.ts` are not unit-tested here (DOM/WebGL); the web smoke test in Task 6 covers them.
- [ ] **Step 7: Commit** `feat(render): chunked flat-shaded terrain, camera rig, DDA tile picking, sky model, three.js scene`

---

### Task 3: Web app: Vite + React client with worker-hosted sim

**Files:**
- Create: `apps/web/package.json`, `index.html`, `vite.config.ts`, `tsconfig.json`, `vitest.config.ts`, `test/tsconfig.json`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/host/sim-worker.ts`, `src/host/connect.ts`, `src/host/worker-transport.ts`, `src/host/ws-transport.ts`, `src/state/useHost.ts`, `src/ui/StatusPills.tsx`, `src/ui/SpeedControl.tsx`, `src/ui/TerrainTool.tsx`, `src/ui/Toast.tsx`, `src/viewport/Viewport.tsx`, `src/dev/sample-park.ts`
- Test: `apps/web/test/connect.test.ts`, `test/useHost.test.tsx`, `test/StatusPills.test.tsx`, `test/sample-park.test.ts`

**Interfaces:**
- `src/host/connect.ts`: `connectHost(): Promise<{ client: SimClient; mode: "worker" | "socket" }>`: if `location.search` has `ws=<url>` (and optional `token=`), connect a `WsTransport` (browser `WebSocket`, binary type `arraybuffer`) with `?token=` appended; otherwise start `sim-worker.ts` as a module `Worker` and wrap its port in `WorkerTransport`. Both transports implement `MessageTransport`.
- `src/host/sim-worker.ts`: builds the sample park (`createSamplePark(seed)` from `dev/sample-park.ts`: 64x64, a hill, a pond, cash 10,000_00, using sim commands so the log is non-empty and the park looks like the mockup), creates `Sim`, `SimHostServer` with real timers, attaches the worker port transport, starts the loop at speed 1. Note: `HostTimers.now()` here uses `performance.now()` (the worker is not the sim).
- `src/state/useHost.ts`: `useHost(): { status: "connecting" | "ready" | "error"; snapshot: DecodedSnapshot | null; terrain: TerrainData | null; events: EventMessage[]; client: SimClient | null; error?: string }` keeping the latest terrain arrays when a snapshot has none.
- `App.tsx` layout (the mockup's HUD, pared down): the viewport canvas fills the window; top-left `StatusPills` (cash as `$10,000.00`, date, `SpeedControl` with pause/1x/2x/4x/8x and keys `space` toggles pause, `+`/`-` step speed); bottom-center `TerrainTool` (Raise / Lower / Level / Water, brush size 1, 2, 3, the cost estimate of the hovered rect via a `terrain_*` dry run is NOT available yet, so show the brush size and the last charge); top-right nothing yet; `Toast` shows the last `ExecResult` error for 3 s and each `event` from an `agent` client as "Agent: <name>" for 3 s.
- Viewport: creates the scene on mount, feeds `setTerrain` on the first terrain and `updateTerrain` on later ones, drives `setTimeOfDay((tick % (TICKS_PER_DAY * DAYS_PER_MONTH)) / (TICKS_PER_DAY * DAYS_PER_MONTH))`, `attachControls` with `onTileClick` → `client.command("terrain_raise" | "terrain_lower" | "terrain_level" | "terrain_set_water", { x, y, w: size, h: size, ... })` clamped to the map so a brush at the edge shrinks rather than fails (Review Focus 3), `onHover` → `highlightTile`. Undo/redo: `Cmd+Z`, `Cmd+Shift+Z` (`Ctrl` on other platforms). Exposes `window.__coasterworks = { ready: true, client }` for the smoke test.
- Styling: Tailwind 4 with CSS tokens for the dark glass panels (`--glass-bg: rgb(18 22 28 / 0.74)`, backdrop blur 14px, radius 12px, border `rgb(255 255 255 / 0.09)`); system font; 32 px minimum hit targets.

- [ ] **Step 1: Scaffold** Vite 7 React TS app under `apps/web` (deps `react`, `react-dom`, `@coasterworks/protocol`, `@coasterworks/render`, `@coasterworks/sim`; dev deps `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `jsdom`, `@testing-library/react`); scripts `dev`, `build`, `preview`, `typecheck`, `test`. Root `vitest.config.ts` gains the project. `pnpm build` at root builds the web app too.
- [ ] **Step 2: Write `sample-park.test.ts`** (node): `createSamplePark(7)` returns a 64x64 world whose max corner is at least 14 and that has at least 20 water tiles and a non-empty log; same seed, same hash.
- [ ] **Step 3: Write `connect.test.ts`** (jsdom): with `?ws=ws://x` the `WsTransport` path is chosen (mock `WebSocket`); without, the worker path is chosen (mock `Worker`); frames are forwarded both ways and binary frames arrive as `Uint8Array`.
- [ ] **Step 4: Write `useHost.test.tsx`** with linked transports and a real `SimHostServer` in the test: status goes `connecting` → `ready`; the first snapshot populates `terrain`; a later snapshot without terrain keeps the old arrays; an error from the host sets `error`.
- [ ] **Step 5: Write `StatusPills.test.tsx`**: renders `$10,000.00` for 1,000,000 cents and `March 1, Year 1`; the pause button has `aria-pressed` when speed is 0.
- [ ] **Step 6: Implement; run tests, expect PASS; run `pnpm --filter @coasterworks/web dev` and confirm in a browser (or via the Claude browser pane) that the park renders, the camera orbits, clicking raises terrain and the cash pill drops.** Record a screenshot path in the report.
- [ ] **Step 7: Commit** `feat(web): Vite React client with worker-hosted sim, viewport, status pills, speed, terrain tool`

---

### Task 4: Sidecar: `coasterworks serve`

**Files:**
- Create: `apps/cli/src/commands/serve.ts`, `apps/cli/src/ws-transport.ts`
- Modify: `apps/cli/src/index.ts` (usage, dispatch), `packages/mcp/src/http.ts` (export `createMcpRequestHandler(sim, opts): (req, res) => Promise<boolean>` used by `serveHttp` and by `serve`), `apps/cli/src/commands/mcp.ts` (share the write queue helper by moving it to `apps/cli/src/write-queue.ts`)
- Test: `apps/cli/test/serve.test.ts`, `packages/mcp/test/http.test.ts` (handler export)

**Interfaces:**
- `coasterworks serve --save <file> [--out <file>] [--port 0] [--host 127.0.0.1] [--token <t>] [--allow-files] [--speed 1]`: one `node:http` server; `GET /health` → `{ ok: true, name, tick }`; `/mcp` → the MCP handler (bearer token required); WebSocket upgrade on `/ws` (package `ws`) requiring `?token=<t>`; each socket is wrapped in `WsTransport` (text frames as strings, binary as `Uint8Array`) and attached to one `SimHostServer` whose `onMutate` queues the `--out` write; the MCP server's `onMutate` calls `host.notifyExternalMutation()` and the same queued write. Prints one JSON line `{ "wsUrl": "ws://127.0.0.1:<port>/ws", "mcpUrl": "http://127.0.0.1:<port>/mcp", "port", "token" }` then runs until SIGINT (abort signal on `io`), on which it stops the loop, awaits the write queue, writes `--out` once more, closes sockets, and exits 0. Token generated when absent (Task 0's helper).
- `WsTransport(socket: WebSocket): MessageTransport`.

- [ ] **Step 1: Write `serve.test.ts`**: start `main(["serve","--save",f,"--out",f,"--port","0","--token","t"])` in the background with an `AbortController`; parse the printed JSON; `GET /health` is ok; a `ws` client without token is closed with 1008; with token: hello/welcome, `command terrain_raise` → result ok, snapshot with terrain; then an MCP `callTool("terrain_lower", ...)` over HTTP (bearer) → the ws client receives an `event` and a snapshot with terrain (Review Focus 2); abort → the promise resolves 0 within 2 s, the port is closed (`fetch` refused), and `f` loads with the lowered terrain and no `.tmp-` file (Review Focus 5).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.** Also `pnpm build && node apps/cli/dist/index.js serve --save /tmp/x.park --port 0 --token t` manually once, then open `http://localhost:5173/?ws=ws://127.0.0.1:<port>/ws&token=t` with the web dev server and confirm the browser drives the sidecar (report the check).
- [ ] **Step 3: Commit** `feat(cli): serve command hosting the sim over WebSocket next to MCP HTTP`

---

### Task 5: Desktop: Tauri 2 Mac app (dev mode)

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/sidecar.rs`, `src-tauri/icons/` (generated by `tauri icon` from `assets/icon.png`, a simple generated 1024px coaster glyph), `apps/desktop/README.md`
- Modify: `apps/web/src/host/connect.ts` (also accept the ws URL and token from `window.__COASTERWORKS__` injected by the shell via the init script, so the URL bar is clean), root `package.json` (`dev:desktop` script)

**Interfaces:**
- `sidecar.rs`: `pub struct Sidecar { child, ws_url, mcp_url, token }`; `pub fn spawn(app: &AppHandle) -> Result<Sidecar>`: resolves the park path `app_data_dir()/parks/current.park` (creating it with `node <cli> new --out` when missing), the CLI entry from env `COASTERWORKS_CLI` or `<repo>/apps/cli/dist/index.js` resolved from the current exe's cargo manifest dir in dev, spawns `node <cli> serve --save <park> --out <park> --port 0` via `tauri_plugin_shell::ShellExt::shell().command("node")`, reads stdout lines until a JSON object with `wsUrl` arrives (10 s timeout → error dialog and exit), and kills the child on `RunEvent::ExitRequested`/`Exit`. `pub fn parse_ready_line(line: &str) -> Option<Ready>` is the unit-tested piece.
- `lib.rs`: builds the app with the shell plugin, spawns the sidecar in `setup`, creates the main window (`WebviewWindowBuilder` with `initialization_script` setting `window.__COASTERWORKS__ = { wsUrl, token, mcpUrl }`), title `Coasterworks`, inner size 1400x900, min 1100x700; menu: the default macOS app menu plus `File > Copy MCP Config` (copies `{ "mcpServers": { "coasterworks": { "type": "http", "url": "<mcpUrl>", "headers": { "Authorization": "Bearer <token>" } } } }` to the clipboard via `tauri-plugin-clipboard-manager`) and `View > Classic View` (emits an event the web app listens to: `rig.setClassic(0)`).
- `tauri.conf.json`: `identifier: "com.coasterworks.app"`, `build.devUrl: "http://localhost:5173"`, `build.beforeDevCommand: "pnpm --filter @coasterworks/web dev"`, `build.frontendDist: "../../web/dist"`, `build.beforeBuildCommand: "pnpm --filter @coasterworks/web build"`, CSP allowing `ws://127.0.0.1:*` and `http://127.0.0.1:*`.

- [ ] **Step 1: Scaffold with `pnpm create tauri-app` equivalents by hand** (dependencies: `@tauri-apps/cli@^2`, `@tauri-apps/api@^2`, `@tauri-apps/plugin-shell`, `@tauri-apps/plugin-clipboard-manager`; Rust crates `tauri = { version = "2", features = [] }`, `tauri-plugin-shell`, `tauri-plugin-clipboard-manager`, `serde`, `serde_json`). Generate icons from a programmatically drawn PNG (an orange circle with a white loop glyph) using `pnpm tauri icon`.
- [ ] **Step 2: Write the Rust unit test** for `parse_ready_line`: a JSON line with `wsUrl` parses; a non-JSON line returns `None`; a JSON line without `wsUrl` returns `None`.
- [ ] **Step 3: Implement; `cargo test` in `src-tauri` passes; `cargo build` passes; `pnpm dev:desktop` opens the window showing the park driven by the sidecar; closing the window kills the sidecar (verify with `pgrep -f "serve --save"` before and after) and `current.park` on disk is updated (verify with `coasterworks inspect`).** Record all three checks in the report with their output. Take a screenshot of the window (`screencapture -l <windowid>` or the macOS screenshot tool) and save it under `docs/images/desktop-dev.png`.
- [ ] **Step 4: Commit** `feat(desktop): Tauri 2 Mac shell that spawns the sidecar and opens the web client`

---

### Task 6: Web smoke test and CI

**Files:**
- Create: `apps/web/e2e/smoke.spec.ts`, `apps/web/playwright.config.ts`
- Modify: `.github/workflows/ci.yml`, `README.md`, `apps/web/package.json` (`e2e` script), root `package.json` (`e2e` script)

- [ ] **Step 1: Write `smoke.spec.ts`**: `vite preview` as the web server (Playwright `webServer`), open `/`, wait for `window.__coasterworks?.ready`, assert the pills text contains `March 1, Year 1` and `$10,000.00`, click the canvas center, wait for the cash text to change, press `Meta+z`, wait for it to return to `$10,000.00`, press `space` and assert the pause button is pressed, take a screenshot to `apps/web/e2e/__screenshots__/park.png` (committed, used by the README).
- [ ] **Step 2: Run locally** (`pnpm exec playwright install chromium` once), expect PASS. Confirm the screenshot shows terrain, not a blank canvas (open it).
- [ ] **Step 3: CI**: in the `test` job add `pnpm exec playwright install --with-deps chromium` and `pnpm e2e` on `ubuntu-latest` only (condition on `matrix.os`); add a `desktop-build` job on `macos-latest` that installs Rust via `dtolnay/rust-toolchain@stable`, caches cargo, runs `pnpm install`, `pnpm build`, and `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` (no bundling, no signing).
- [ ] **Step 4: README**: replace the status line with "Status: pre-alpha. You can fly around a park and shape terrain in the browser (`pnpm dev:web`) or the Mac app (`pnpm dev:desktop`). Rides, guests and money arrive in the next plans."; add the screenshot; add "Run the Mac app (dev)" with the Rust prerequisite (`rustup`), and "Connect Claude to the running app" (File > Copy MCP Config, paste into `.mcp.json` or `claude mcp add --transport http coasterworks <url> --header "Authorization: Bearer <token>"`).
- [ ] **Step 5: Full verification green; commit** `test(web): Playwright smoke; ci: e2e on ubuntu, Tauri build on macos; docs`

---

## Self-review notes

- Spec coverage for this plan: 4.1 world rendering scale (T2), 4.3 camera incl. classic preset (T2, T3 keys), 5.1 stack (T2, T3, T5), 5.2 packages protocol/render/web/desktop (T1, T2, T3, T5), 5.4 the sim stays deterministic (speed lives in the host, T1), 5.5 process topology and binary snapshots (T1, T3, T4, T5), 5.6 rendering (T2), 6.1 HTTP MCP in the running app (T4 sidecar serves `/mcp`; T5 copies the config), 9 Playwright smoke (T6). Guests, rides, UI dock/inspector, assistant are Plans C to F.
- Names used consistently: `SimHostServer`, `SimClient`, `MessageTransport`, `createLinkedTransports`, `encodeSnapshot`/`decodeSnapshot`, `TerrainData`, `buildChunkGeometry`, `CameraRig`, `pickTile`, `sunFor`, `createScene`, `attachControls`, `connectHost`, `useHost`, `createSamplePark`, `WsTransport`, `createMcpRequestHandler`, `parse_ready_line`.
- Review Focus 1 to 5 have tests in T1, T4, T2/T3, T1, T4/T5.
