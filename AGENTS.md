# Agent Instructions

Before making changes in this repository, read:

1. `DESIGN.md`
2. `PROJECT_LOG.md`

Prefer the compact notes command first to avoid pulling long verification history into context:

```bash
bun run project:notes
```

Use `DESIGN.md` for the target architecture, scope, and feature checklist.
Use `PROJECT_LOG.md` for current status, handoff notes, run commands, verification commands, and next priorities. When more detail is needed, use `rg -n` and targeted `read` offsets instead of broad reads of the long log.

## During implementation

- Keep the project Bun-first.
- Keep shared API/WebSocket contracts in `packages/protocol`.
- Validate external boundaries with Zod.
- Preserve local-first security assumptions from `DESIGN.md`.
- Prefer small, incremental vertical slices over large rewrites.

## Subagent implementation hints

When the `subagent` tool is available during implementation, use subagents deliberately for bounded assistance that reduces context load or risk, not as a replacement for parent-session ownership.

- For editing help, delegate only a clearly scoped file, module, or vertical slice; keep the parent agent responsible for reviewing and integrating the final diff.
- For validation help, ask subagents for focused test strategy, failure triage, or independent review, but run the selected repository validation commands in the parent session and report exact results.
- For top-level `subagent` runs in this repository, set `output: false` unless a saved artifact is explicitly needed. Builtin defaults like `context.md`/`plan.md` can dirty or case-collide with tracked root files such as `CONTEXT.md`; when saved output is needed, prefer chain-mode paths under `{chain_dir}` or an explicit temp/artifact path outside the repo root.
- Prefer foreground subagent runs for implementation/review loops; use async/background subagents only when the task is explicitly parallelizable and the parent can continue safely.

## "What's next?" dev loop

When the operator asks "what's next?" or asks to continue planning:

1. Run `bun run project:notes` first, then re-read targeted `PROJECT_LOG.md` ranges only if the compact summary is insufficient, especially around `Current status`, `Verification`, and `Next priorities`.
2. If the question involves iteration efficiency, agent behavior, validation choice, or action/tool-call optimization, run `bun run report:iteration --agent-actions --recommend` and use its output as evidence.
3. Summarize the top 1-3 candidate next slices in priority order, including why each is next.
4. Recommend one small vertical slice as the default next action.
5. If continuing into implementation, state the focused scope and validation plan before editing.
6. Keep generated session summaries/title metadata explicit-only unless the operator asks to change that product policy.

## Agent iteration telemetry

Agents learn about this repository's telemetry workflow from this file, the bundled `/plan` workflow prompt, and the project-local pi skill at `.pi/skills/iteration-observability/SKILL.md` (loadable as `/skill:iteration-observability` in pi environments with skill commands enabled).

Use the local iteration telemetry report to keep future agent decisions evidence-based.

When planning agent behavior improvements, analyzing speed of iteration, or choosing validation commands, run:

```bash
bun run report:iteration --agent-actions --recommend
```

Use the output to identify:

- validation actions to run or skip;
- high-churn files that need smaller, more targeted edits;
- recurring hot-path harness scenarios;
- missing telemetry that limits confidence, such as per-tool counts or phase timing.

When a session may be context-heavy, inspect local pi JSONL session logs without dumping tool contents:

```bash
bun run report:iteration --session-context
```

Use this to estimate per-tool result payload size, largest context contributors, validation reruns, edit/write failures, and latest model usage before deciding to read large artifacts or rerun verbose commands.

To backfill all available local session JSONL logs into aggregate process evidence, run:

```bash
bun run report:iteration --session-history
```

Use this to identify historical validation hotspots, high-churn edit-failure files, and repeated context sinks before proposing workflow/process improvements.

Before validating code changes, prefer:

```bash
bun run report:iteration --recommend <changed files>
```

Follow the report's focused-first command list in order and stop to fix the first failure instead of continuing through later harness commands. Treat full `bun run test:web-perf` as an explicit escalation, not the default: run it when the report selects it, when protocol/session lifecycle behavior changed, when broad UI interaction paths changed, or when focused validation fails unexpectedly. For non-trivial validation choices, paste or summarize the report's `## Validation decision` block in the final handoff, including whether the full suite was run or intentionally skipped.

When a focused UI harness scenario fails, locate the newest artifact before rerunning with `bun run report:iteration --latest-artifact <scenario>`; inspect the listed failure/log/screenshot paths, patch one cause, then rerun only that scenario unless escalation criteria apply.

## UI validation expectations

For changes that affect the browser UI, WebSocket/session lifecycle, transcript rendering, slash commands, inspector/tree panels, or perceived responsiveness:

1. Run `bun run report:iteration --recommend <changed files>` and use its `## Validation decision` as the source of truth.
2. Run `bun run check` plus the focused fake-agent scenario commands selected by the report.
3. Escalate to full `bun run test:web-perf` only when the report selects it, when protocol/session lifecycle behavior changed, when broad UI interaction paths changed, or when focused validation fails unexpectedly.
4. If the feature needs exploratory validation, use `bun run ui:manual` to launch a headed fake-agent browser session in a temp workspace. Inspect the feature there instead of relying only on a human operator's real browser/workspace.
5. Mention the exact harness command(s), scenario(s), and artifact path(s) in the final handoff.
6. Include the key screenshot PNG paths from the harness artifacts as workspace-relative paths in the final handoff when screenshots are generated, so the web transcript can render them as local image thumbnails for quick visual review.
7. If the harness does not cover the new behavior, prefer adding/extending a scenario before asking the human operator to manually validate it.

On a fresh machine, install the Playwright browser once if needed:

```bash
bun x playwright install chromium
```

## Containerized development validation

When modifying `Dockerfile`, `.dockerignore`, `docker/entrypoint.sh`, `compose*.yaml`, `.env.example`, or container-development docs, follow `docs/container-development.md#validation-for-future-changes`. In short: run `bun run report:iteration --recommend <changed files>` and `bun run check`, then validate the relevant Docker layer (`docker build`, UID/GID ownership smoke, Compose config/startup, and Docker socket override only when touched). Do not run full `bun run test:web-perf` by default for Docker/docs-only changes; escalate only for UI/protocol/session lifecycle/auth runtime impact or unexpected focused-smoke failures.

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
5. For this repository's current isolated-worktree dev loop, if the branch is a `bakery/session/*` branch and `gh auth status` succeeds, push the branch and create or update a GitHub PR so the operator can review/merge there. Use `git push -u origin HEAD` for a new branch, then create/update the PR with a human-readable title and body derived from the final handoff: summary of changes, validation commands/results, manual test notes, and key screenshot artifact paths (especially PNGs) so GitHub reviewers see the same useful context the operator saw in chat. Do not commit transient harness screenshots to the repository by default; list local `test-results/...` paths unless/until the operator chooses a GitHub attachment upload flow. Prefer `gh pr create --title "..." --body-file <file> --head <branch>` or `gh pr edit --title "..." --body-file <file>` over `--fill` when handoff context is available. If a PR already exists, update its title/body after pushing and mention its URL. If GitHub auth/remote/branch conditions are not met, skip PR creation and say why.

## Useful commands

```bash
bun install
bun run check
bun run dev
bun run dev:server:restart
bun run dev:server:logs
bun run dev:server:down
```

`bun run dev` is the default local bootstrap: it ensures a detached backend is running, then starts Vite in the foreground. During the dev loop, use `bun run dev:server:restart` to restart only the backend without killing Vite/browser state. The older foreground backend command still works when needed: `PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:server`.
