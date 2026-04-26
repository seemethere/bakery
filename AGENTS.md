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

## "What's next?" dev loop

When the operator asks "what's next?" or asks to continue planning:

1. Re-read `PROJECT_LOG.md`, especially `Current status`, `Verification`, and `Next priorities`.
2. Summarize the top 1-3 candidate next slices in priority order, including why each is next.
3. Recommend one small vertical slice as the default next action.
4. If continuing into implementation, state the focused scope and validation plan before editing.
5. Keep generated session summaries/title metadata explicit-only unless the operator asks to change that product policy.

## UI validation expectations

For changes that affect the browser UI, WebSocket/session lifecycle, transcript rendering, slash commands, inspector/tree panels, or perceived responsiveness:

1. Run `bun run check`.
2. Run the automated fake-agent browser harness with `bun run test:web-perf` unless the change is clearly unrelated to UI behavior.
3. If the feature needs exploratory validation, use `bun run ui:manual` to launch a headed fake-agent browser session in a temp workspace. Inspect the feature there instead of relying only on a human operator's real browser/workspace.
4. Mention the exact harness command(s), scenario(s), and artifact path(s) in the final handoff.
5. Include the key screenshot PNG paths from the harness artifacts as workspace-relative paths in the final handoff when screenshots are generated, so the web transcript can render them as local image thumbnails for quick visual review.
6. If the harness does not cover the new behavior, prefer adding/extending a scenario before asking the human operator to manually validate it.

On a fresh machine, install the Playwright browser once if needed:

```bash
bun x playwright install chromium
```

## Commit hygiene

When committing changes, prefer Conventional Commits with a concise imperative summary:

- `feat:` for user-visible features.
- `fix:` for bug fixes.
- `refactor:` for behavior-preserving code changes.
- `test:` for tests and harness changes.
- `docs:` for documentation-only changes.
- `chore:` for maintenance, tooling, dependency, or repository housekeeping.
- `perf:` for performance improvements.
- `style:` for formatting-only changes.
- `ci:` for CI/build pipeline changes.

Examples:

```bash
git commit -m "feat: add fake-agent transcript scenario"
git commit -m "fix: preserve session reconnect state"
git commit -m "test: cover slash command rendering"
git commit -m "docs: update project handoff notes"
git commit -m "chore: refresh lockfile"
```

If multiple change types are present, choose the type that best represents the primary purpose of the commit. Prefer one commit per coherent vertical slice, avoid bundling unrelated cleanup with feature work, and avoid vague messages like `update files`, `misc fixes`, or `work in progress`.

## End-of-session handoff

Before ending a work session, unless the user asks otherwise:

1. Run `bun run check`.
2. Update `PROJECT_LOG.md` with changed status and next priorities.
3. Tell the human operator how to test the changes manually, including whether the currently running browser page can pick them up automatically, requires a page refresh, or requires a backend/dev-server restart.
4. Commit with a concise Conventional Commit message, unless the user explicitly asks not to commit.

## Useful commands

```bash
bun install
bun run check
PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:server
bun run dev:web
```
