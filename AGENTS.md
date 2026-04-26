# Agent Instructions

Before making changes in this repository, read:

1. `DESIGN.md`
2. `PROJECT_LOG.md`

Use `DESIGN.md` for the target architecture, scope, and feature checklist.
Use `PROJECT_LOG.md` for current status, handoff notes, run commands, verification commands, and next priorities.

## During implementation

- Keep the project Bun-first.
- Keep shared API/WebSocket contracts in `packages/protocol`.
- Validate external boundaries with Zod.
- Preserve local-first security assumptions from `DESIGN.md`.
- Prefer small, incremental vertical slices over large rewrites.

## UI validation expectations

For changes that affect the browser UI, WebSocket/session lifecycle, transcript rendering, slash commands, inspector/tree panels, or perceived responsiveness:

1. Run `bun run check`.
2. Run the automated fake-agent browser harness with `bun run test:web-perf` unless the change is clearly unrelated to UI behavior.
3. If the feature needs exploratory validation, use `bun run ui:manual` to launch a headed fake-agent browser session in a temp workspace. Inspect the feature there instead of relying only on a human operator's real browser/workspace.
4. Mention the exact harness command(s), scenario(s), and artifact path(s) in the final handoff.
5. If the harness does not cover the new behavior, prefer adding/extending a scenario before asking the human operator to manually validate it.

On a fresh machine, install the Playwright browser once if needed:

```bash
bun x playwright install chromium
```

## End-of-session handoff

Before ending a work session, unless the user asks otherwise:

1. Run `bun run check`.
2. Update `PROJECT_LOG.md` with changed status and next priorities.
3. Tell the human operator how to test the changes manually, including whether the currently running browser page can pick them up automatically, requires a page refresh, or requires a backend/dev-server restart.
4. Commit with a concise message, unless the user explicitly asks not to commit.

## Useful commands

```bash
bun install
bun run check
PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:server
bun run dev:web
```
