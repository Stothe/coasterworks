# Coasterworks

Coasterworks is an open-source theme-park builder in the spirit of RollerCoaster Tycoon: the depth of the original with a UI built for 2026, playable without any original game files, and MCP native so Claude or any agent can build and run a park through the same commands the player uses. Mac first; other platforms later.

Status: pre-alpha, not playable yet.

## Try it headless

There is no UI yet, but the simulation already runs from the command line. You need Node 22 or newer and pnpm 10 or newer.

```bash
pnpm install
pnpm build
```

Make a park, change it, let time pass, and look at it. Every command prints one line of JSON, and `run` and `exec` leave the file alone unless you give `--out`.

```bash
# Create a 64 by 64 park in my.park
node apps/cli/dist/index.js new --out my.park --name "Demo Park" --seed 1

# Raise a patch of land (the result says what it cost, in cents)
node apps/cli/dist/index.js exec --save my.park --command terrain_raise --input '{"x":4,"y":4,"w":3,"h":3}' --out my.park

# Let 30 days pass
node apps/cli/dist/index.js run --save my.park --days 30 --out my.park

# Show the park's status and its recent command log
node apps/cli/dist/index.js inspect my.park
```

Command names such as `terrain_raise` come from `packages/sim/src/commands`.

## Connect Claude Code

The same commands are available to an agent over MCP. Build first (`pnpm build`), then register the server with Claude Code, using absolute paths:

```bash
claude mcp add coasterworks -- node /absolute/path/to/apps/cli/dist/index.js mcp --save /absolute/path/my.park --out /absolute/path/my.park
```

Claude can then build in the park with the tools the sim exposes (`terrain_raise`, `park_status`, `undo`, and so on). `--out` writes every change back to the file; without it the park lives in memory and `--save` is never modified.

For a client that cannot start a process, serve it over HTTP instead:

```bash
node /absolute/path/to/apps/cli/dist/index.js mcp --save /absolute/path/my.park --out /absolute/path/my.park --http 7788 --token <a-secret-you-choose>
```

The server listens on `127.0.0.1` and wants `Authorization: Bearer <token>` on every request. To keep the token out of your process list, leave out `--token` and set `COASTERWORKS_MCP_TOKEN` instead. Over HTTP the `save_write` and `save_load` file tools are off, because they let any holder of the token read and write files as you. Turn them on with `--allow-files` only if you trust every client.

Configuration for an MCP client that speaks Streamable HTTP, such as a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "coasterworks": {
      "type": "http",
      "url": "http://127.0.0.1:7788/mcp",
      "headers": { "Authorization": "Bearer <a-secret-you-choose>" }
    }
  }
}
```

## What's here

- `packages/sim`: the deterministic simulation core: world, commands, queries, undo, and the save format (`@coasterworks/sim`)
- `packages/mcp`: the MCP server that exposes sim commands to agents over stdio and HTTP (`@coasterworks/mcp`)
- `apps/cli`: the `coasterworks` command line app: `new`, `run`, `inspect`, `exec`, and `mcp`

## Determinism

The simulation uses integer math only and draws all its randomness from a seeded generator, so the same seed and the same command log always produce the same park. CI runs a golden scenario on Linux and macOS and requires both to end on the same recorded hash.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm format:check
```

See `CONTRIBUTING.md` before changing the simulation or adding a command.

## License

Source code is MIT licensed (see `LICENSE`). Art and other assets are CC BY 4.0 (see `LICENSE-ASSETS`).
