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

## End-of-session handoff

Before ending a work session, unless the user asks otherwise:

1. Run `bun run check`.
2. Update `PROJECT_LOG.md` with changed status and next priorities.
3. If the user asked to commit, commit with a concise message.

## Useful commands

```bash
bun install
bun run check
PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:server
bun run dev:web
```
