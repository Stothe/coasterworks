# Contributing

## Setup

```sh
pnpm install
pnpm test
pnpm build
```

## Commits

Use [conventional commits](https://www.conventionalcommits.org/), for example `feat(sim): add path placement command` or `chore: bump vitest`.

## Determinism rule

The simulation must replay identically from the same seed and the same command log. In `packages/sim/src`:

- No `Math.random`, `Math.sin`, or `Date.now`.
- All state-affecting math is integer.
- Every mutation is a logged command.

## Defining commands

Commands live in `packages/sim/src/commands` and are defined with `defineCommand`, which takes a schema, a description, and `validate`, `apply`, and `revert` functions. Full details land with the first command task.
