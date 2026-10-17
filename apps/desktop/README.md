# Coasterworks desktop (Tauri 2, dev mode)

The Mac app. It is a thin shell: it starts the `coasterworks serve` sidecar, waits for the line
that says where it is listening, opens the web client against it, and owns the menu. It holds no
game logic. Everything the player does goes over the sidecar's WebSocket, and an agent can drive
the same park over its MCP endpoint, so what the agent builds appears in the window as it happens.

This is the **dev-mode** app. It runs the sidecar as `node apps/cli/dist/index.js`; the compiled
sidecar and a bundled app replace that in Plan G.

## Run it

You need Rust (`cargo`), Node 22 or newer, and pnpm 10.

```sh
pnpm install
pnpm dev:desktop    # builds apps/cli/dist, then tauri dev: starts the Vite dev server, builds the
                    # shell, opens the window
```

The first run compiles Tauri, which takes several minutes. After that it is seconds.

`node` has to be on the `PATH` of whatever starts the app, which it is when you run it from a
terminal. To use a CLI from somewhere else, set `COASTERWORKS_CLI=/path/to/index.js`.

Port 5173 must be free: `tauri dev` waits for the Vite dev server there, and Vite is set to
`strictPort`, so if `pnpm dev:web` is already running the second one fails rather than moving to
another port. Stop the first.

## What it does

1. Finds the CLI (`COASTERWORKS_CLI`, else `apps/cli/dist/index.js`).
2. Makes `~/Library/Application Support/com.coasterworks.app/parks/current.park` with
   `coasterworks new --sample --name "Leafy Lake"` if it is not there yet: the first run opens the
   sample park, a hill and a pond, rather than a flat field.
3. Runs `node <cli> serve --save <park> --out <park> --port 0` and reads its stdout until the ready
   line arrives (10 s limit, otherwise it shows a dialog with the sidecar's stderr and exits 1).
4. Opens the `main` window (1400x900, minimum 1100x700) with an initialization script that sets
   `window.__COASTERWORKS__ = { wsUrl, token, mcpUrl }`. The web client reads that ahead of its
   `?ws=&token=` query string, so the URL bar stays clean and the token stays out of it.
5. On quit, or when the last window closes, sends the sidecar SIGTERM so it writes the park, and
   kills it only if it has not exited after 5 s. If the window cannot be opened, the sidecar is
   stopped the same way before the app exits 1 (a failed startup runs no exit handler).

If the app cannot start (no CLI, a park file that will not load, a window that will not open) a
native dialog says what went wrong, names the park file and says to move or delete it to start
fresh, and the app exits 1 when it is dismissed. If the sidecar dies while the app is running, the
page shows that it lost the connection, a dialog says "The park process stopped unexpectedly.
Coasterworks will quit.", and the app exits 1. A stop the shell asked for is not reported. The
dialogs are shown from Rust with `tauri-plugin-dialog`, which needs no capability.

The sidecar also saves after every change a window or an agent makes, so the park on disk is
current even if the app is killed. And it does not outlive a killed app: the shell holds the other
end of the sidecar's stdin, and `--exit-on-stdin-eof` makes `serve` stop, with its usual save, when
that stream ends, however the shell went away (SIGKILL, SIGHUP, a crash).

## Menu

- **Coasterworks**: About, Services, Hide, Quit.
- **File > Copy MCP Config**: puts this on the clipboard, ready to paste into an MCP client's
  config:

  ```json
  {
    "mcpServers": {
      "coasterworks": {
        "type": "http",
        "url": "http://127.0.0.1:<port>/mcp",
        "headers": { "Authorization": "Bearer <token>" }
      }
    }
  }
  ```

  The port and token change on every launch.

- **View > Classic View**: the shell emits `coasterworks://classic-view`; the web client (inside
  Tauri only) answers with `rig.setClassic(0)`.

There is no Edit menu on purpose: a native Undo item would take Cmd+Z before the page's own
undo hotkey saw it.

## Capabilities

`src-tauri/capabilities/default.json` grants the window `core:default` only. Spawning the sidecar,
writing the clipboard and showing the error dialogs happen in Rust, and capabilities gate only
what a page may ask for over IPC. So the page is not given `shell:allow-spawn` (a `node` scope
with any arguments would let anything running in the page run arbitrary code) or the clipboard and
dialog plugins' permissions.

When the sidecar becomes a compiled binary, spawn it with `app.shell().sidecar(...)` and keep the
page out of the shell plugin.

## Icons

`pnpm --filter @coasterworks/desktop icon` redraws `assets/icon.png` (a 1024px PNG made with
`scripts/make-icon.mjs`, no image library) and runs `tauri icon` on it to fill `src-tauri/icons/`.

## Checks

```sh
pnpm --filter @coasterworks/desktop cargo:check   # cargo check
pnpm --filter @coasterworks/desktop cargo:test    # cargo test: the ready-line parser, the init script, the MCP config
pnpm --filter @coasterworks/desktop cargo:build   # a debug build of the shell, no bundle
```

The package's own `typecheck`, `build` and `test` scripts do nothing, so the root `pnpm typecheck`
and `pnpm build` stay free of Rust (on Linux `cargo` also needs webkit2gtk). CI runs the
last two in the `desktop-build` job on macOS, after `pnpm build`, because `tauri.conf.json` takes
its `frontendDist` from `apps/web/dist`. Making the app is `tauri build`, which is Plan G.

## CSP

`tauri.conf.json` sets a CSP that lets the page connect to `ws://` and `http://` on `127.0.0.1` and
`localhost` (the sidecar, and the Vite dev server's HMR socket). Under `tauri dev` the page is
served by Vite, so Tauri does not apply the CSP there; it applies to the bundled app
(`tauri://localhost`), which Plan G builds and should re-check, including the sim worker.
