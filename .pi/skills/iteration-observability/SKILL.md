---
name: iteration-observability
description: Use this project-local skill when asked to improve agent/dev workflow, analyze iteration speed, explain validation choices, backfill local session telemetry, or turn Bakery session data into process improvements. It uses the repository's `bun run report:iteration` and `bun run project:notes` commands without printing raw prompt/tool contents.
---

# Iteration Observability

Use this skill to make workflow recommendations from local evidence instead of intuition.

## Safety and context discipline

- Treat telemetry as local-first and content-sensitive.
- Do not print raw prompts, raw tool outputs, secrets, or large JSONL contents.
- Prefer summaries: counts, durations, paths, command labels, artifact directories, and recommendations.
- If a command output is likely to be large, redirect it to a temp file or run a narrower command first.
- Use `bun run project:notes` before broad `PROJECT_LOG.md` reads.

## Quick start

From the repository root:

```bash
bun run project:notes
bun run report:iteration --agent-actions --recommend
bun run report:iteration --session-context
bun run report:iteration --session-history
```

Use `--session-context` for the current/most recent session and `--session-history` to backfill all available local JSONL session logs.

## Choosing validation commands

Before validating code changes, ask the selector for changed files:

```bash
bun run report:iteration --recommend <changed files>
```

In handoffs, include the report's `## Validation decision` block or summarize:

- changed files;
- exact commands run;
- optional escalation;
- whether full `bun run test:web-perf` was selected, escalated to, or intentionally skipped.

Follow the selector's focused-first command list in order and stop to fix the first failure. Treat full `bun run test:web-perf` as an explicit escalation, not the default: run it when protocol/session lifecycle behavior changed, broad UI interaction paths changed, focused validation fails unexpectedly, or the selector selects it.

## Reading current-session telemetry

Run:

```bash
bun run report:iteration --session-context
```

Look for:

- large context contributors in `Largest tool results`;
- repeated reads or repeated bash commands;
- validation reruns and failures;
- edit/write failure clusters;
- model usage and max reported input/cache reads;
- mobile artifact-handoff recommendations when `mobile-layout` appears.

Turn these into concrete process changes, for example:

- replace broad log reads with `bun run project:notes` plus targeted `read` offsets;
- prefer focused harness scenarios over full-suite runs when the selector says the full suite is not required;
- patch high-churn files with smaller exact replacements;
- include key harness screenshot PNG paths in mobile/UI handoffs.

## Backfilling historical session telemetry

Run:

```bash
bun run report:iteration --session-history
```

Use the aggregate sections to identify recurring optimization opportunities:

- `Validation command summary`: commands/scenarios with high run or failure counts;
- `Edit/write attempts`: files where agents often retry exact edits;
- `Top read paths` and `Top bash commands`: recurring context sinks;
- `Largest sessions` and `Largest tool results`: sessions/commands worth studying for workflow friction;
- `Sessions with edit failures`: candidate files for refactors, helper extraction, or smaller edit islands.

Caveats:

- Deleted/unlogged sessions cannot be recovered.
- Human intent for reruns cannot be reconstructed unless written in the transcript.
- The report is metadata-only; it intentionally avoids printing raw content.

## Recommendation format

When asked how to improve the workflow, produce:

1. Evidence: cite the telemetry sections and counts that matter.
2. Candidate improvements: list the top 1-3 slices in priority order.
3. Default next slice: recommend one small vertical slice.
4. Likely files to change.
5. Validation plan with exact commands.
6. Manual testing notes, including whether browser refresh or backend restart is needed.

Keep recommendations practical and repository-specific. Prefer measurable process/tooling changes over generic coaching.
