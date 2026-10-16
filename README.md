# Coasterworks

Coasterworks is an open-source theme-park builder in the spirit of RollerCoaster Tycoon: the depth of the original with a UI built for 2026, playable without any original game files, and MCP native so Claude or any agent can build and run a park through the same commands the player uses. Mac first; other platforms later.

Status: pre-alpha, not playable yet.

## Development setup

Requires Node 22 or newer and pnpm 10 or newer.

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm format:check
```

The repo is a pnpm monorepo:

- `packages/sim`: the deterministic simulation core (`@coasterworks/sim`)
- `packages/mcp`: the MCP server that exposes sim commands to agents (`@coasterworks/mcp`)
- `apps/cli`: the `coasterworks` command line app

## License

Source code is MIT licensed (see `LICENSE`). Art and other assets are CC BY 4.0 (see `LICENSE-ASSETS`).
