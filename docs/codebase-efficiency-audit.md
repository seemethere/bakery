# Codebase and iteration efficiency audit

## Purpose

This document is a shared planning artifact for making Bakery easier to evolve over multiple sessions. It is intentionally a spike/audit, not a refactor. The goal is to rank organizational and workflow improvements by evidence from the current codebase, project notes, and local session telemetry.

Use this document when choosing future slices that should reduce edit blast radius, context load, validation time, or architectural drift.

## Current architecture map

Bakery is still aligned with `DESIGN.md`:

```text
Browser UI
  | HTTP + WebSocket
  v
Bun-first TypeScript web service
  | @earendil-works/pi-coding-agent SDK
  v
Pi AgentSession / AgentSessionRuntime
  | default pi tools/resources
  v
Workspace filesystem
```

The repository is a small Bun-first workspace:

- `apps/web`: Vite/browser UI, transcript rendering, composer, session shell, local interaction state, and fake-agent UI coverage.
- `apps/server`: Fastify backend, auth/workspace boundaries, session metadata, WebSocket hubs, pi SDK runner wiring, artifact serving, and command handling.
- `packages/protocol`: shared Zod schemas, protocol constants, and TypeScript contracts.
- `scripts`: dev-loop utilities, UI harness, iteration telemetry, project notes, doctor/local-network helpers, and artifact upload tooling.
- `docs`: focused design notes for extensions, LAN setup, remote artifacts, and now codebase/iteration efficiency.

The product has grown through vertical slices. That has been effective for dogfooding, but a few files now carry too many responsibilities and dominate agent context, edit retries, and validation reruns.

## Evidence from telemetry and code shape

The following observations came from `bun run project:notes`, `bun run report:iteration --agent-actions --recommend`, `bun run report:iteration --session-history`, and quick code-shape inspection.

### Hot files by size and churn

| Surface | Current shape | Telemetry signal | Risk |
| --- | ---: | --- | --- |
| `apps/web/src/main.ts` | ~2,964 lines | 583 edit attempts, 33 edit failures, 796 historical reads, ~4.7M read chars | App shell, session lifecycle, composer, rendering orchestration, and UI actions are too concentrated. |
| `scripts/ui-harness.ts` | ~1,915 lines | 336 edit attempts, 17 edit failures; high-frequency scenario churn | Scenario additions and harness helper changes collide in one large file. |
| `scripts/report-iteration.ts` | ~1,568 lines | Expanding scope across validation selection, session logs, history, and recommendations | Useful but growing into a reporting monolith. |
| `apps/server/src/index.ts` | ~1,059 lines | Route, metadata, artifact, and WebSocket/session hub concerns live together | Backend changes can have wider review/validation scope than needed. |
| `PROJECT_LOG.md` | Long-running history | 330 historical reads, ~7.0M read chars | Broad reads are expensive; compact summaries help but the log remains a context sink. |

### Validation and rerun cost

Session-history telemetry reported:

- 2,512 validation runs, 518 failures, and 1,846 reruns across 112 sessions.
- `bun run check`: 841 runs, 128 failures.
- Full/all harness: 166 runs, 46 failures.
- Frequent focused harnesses:
  - `mobile-layout`: 143 runs, 41 failures.
  - `slash-commands`: 146 runs, 40 failures.
  - `question-answer`: 123 runs, 34 failures.
  - `streaming-responsiveness`: 108 runs, 18 failures.

This does not mean the harness is bad. It means the harness is now central product infrastructure and should be organized as such. It also means future agents should stop after the first focused failure, inspect artifacts, then patch one cause before rerunning.

### Context-cost signals

Largest historical read contributors:

- `PROJECT_LOG.md`: ~7.0M chars.
- `apps/web/src/main.ts`: ~4.7M chars.
- `scripts/ui-harness.ts`: ~1.4M chars.
- `DESIGN.md`: ~1.1M chars.

Current mitigations are working and should become default practice:

- Prefer `bun run project:notes` before broad `PROJECT_LOG.md` reads.
- Prefer `bun run report:iteration --recommend <changed files>` before choosing validation commands.
- Use targeted `rg -n` plus small `read` ranges for long files.
- Include the validation decision in handoffs so selector quality can be tuned.

## Organizational risks

1. **App-shell concentration in `main.ts`**
   - The file still owns too many imperative concerns: connection/session state, DOM event wiring, composer behavior, transcript patch orchestration, image intake, slash-command flows, sidebar/drawer behavior, and app-level render decisions.
   - Even when helpers are extracted, future slices often still need to read or patch `main.ts`.

2. **Harness monolith pressure**
   - `scripts/ui-harness.ts` mixes process orchestration, browser setup, shared helpers, and many scenario bodies.
   - High-frequency scenarios are product-critical hot paths; keeping all scenario code in one file makes small additions more collision-prone.

3. **Backend `index.ts` breadth**
   - The server entry combines route definitions, metadata helpers, artifact serving, and WebSocket hub/session-control logic.
   - This is manageable today, but extension/worktree/session-lifecycle work will increase pressure.

4. **Docs/log split is uneven**
   - `PROJECT_LOG.md` is valuable as a handoff ledger, but design decisions and process principles should graduate into focused docs when they become stable.
   - New audit/follow-up docs should link back to the log rather than duplicate every verification detail.

5. **Telemetry is offline and approximate**
   - JSONL-derived history is useful without exposing raw prompts/tool outputs, but it lacks explicit phase/intent markers.
   - We can see validation reruns and edit failures, but not always whether a rerun was necessary, exploratory, or accidental.

## Efficiency principles for future sessions

- **Extract only when a near-term slice benefits.** Avoid abstract cleanup that is not tied to a real product or validation pain.
- **Prefer move-only or behavior-preserving extraction first.** Add tests around extracted pure helpers before changing behavior.
- **Patch islands, not continents.** For high-churn files, use `rg` to find the smallest function/section and edit only that block.
- **Use focused validation first.** Run `bun run report:iteration --recommend <changed files>` and follow the ordered commands.
- **Inspect failed harness artifacts before rerunning.** Especially for `mobile-layout`, `slash-commands`, `question-answer`, `transcript-scroll-stability`, and `narrow-tool-stream`.
- **Keep shared contracts in `packages/protocol`.** New browser/server behavior should not grow ad hoc message shapes in either app.
- **Document stable decisions outside the running log.** `PROJECT_LOG.md` should point to durable docs once an idea becomes a multi-session plan.

## Ranked follow-up slices

### 1. Extract a cohesive app-shell controller from `apps/web/src/main.ts`

**Why first:** `main.ts` is the largest edit/context hotspot and remains central to most UI slices.

**Candidate boundaries:**

- Session lifecycle/controller state and WebSocket message dispatch.
- Composer image/drop/upload handling.
- Transcript row binding/live patch orchestration.
- Sidebar/drawer session-list interaction state.

**Recommended first extraction:** choose the next product slice that already touches one of these islands, then extract that island behavior-preservingly before making product changes.

**Likely files:**

- `apps/web/src/main.ts`
- New focused module under `apps/web/src/`, for example `session-controller.ts`, `composer-images.ts`, or `transcript-controller.ts`.
- Focused unit test if the extracted logic can be made pure.

**Validation:**

```bash
bun run report:iteration --recommend apps/web/src/main.ts <new-module>
bun run check
```

Run any focused harness selected by the report. Escalate to full `bun run test:web-perf` only if the selector requests it or the slice changes broad UI/session lifecycle behavior.

### 2. Split the UI harness by scenario family

**Why second:** the harness is product-critical and has high churn/failure/rerun counts. It should be easier to add or debug one scenario without reading unrelated scenarios.

**Candidate shape:**

```text
scripts/ui-harness.ts                  # CLI/process orchestration and scenario dispatch
scripts/ui-harness/
  helpers.ts                           # shared Playwright/session helpers
  scenarios/transcript.ts
  scenarios/mobile.ts
  scenarios/slash-commands.ts
  scenarios/artifacts.ts
  scenarios/lifecycle.ts
```

**Important constraint:** preserve the existing command interface:

```bash
bun scripts/ui-harness.ts --scenario <name>
bun run test:web-perf
```

**Likely files:**

- `scripts/ui-harness.ts`
- New `scripts/ui-harness/*` modules.

**Validation:**

```bash
bun run report:iteration --recommend scripts/ui-harness.ts scripts/ui-harness
bun run check
bun scripts/ui-harness.ts --scenario slash-commands
bun scripts/ui-harness.ts --scenario mobile-layout
```

### 3. Extract backend route/session-hub boundaries from `apps/server/src/index.ts`

**Why third:** extension/worktree/session lifecycle work is likely to keep growing backend complexity.

**Candidate boundaries:**

- `session-hub.ts`: WebSocket client/session hub, sequence envelopes, controller handling.
- `metadata-routes.ts`: title/summary generation and metadata patch/apply routes.
- `artifact-routes.ts`: artifact upload/raw-file serving helpers.
- `command-routes.ts`: slash/workflow command metadata and command execution helpers.

**Likely files:**

- `apps/server/src/index.ts`
- New focused backend modules.
- `packages/protocol/src/index.ts` only if contracts need to move or become stricter.

**Validation:**

```bash
bun run report:iteration --recommend apps/server/src/index.ts <new-server-modules>
bun run check
```

Add focused lifecycle harnesses only when selected or when the extraction changes WebSocket/session behavior.

### 4. Make validation reruns artifact-first by default

**Why:** telemetry estimates a conservative 77-155 avoidable reruns if agents inspect artifacts before retrying focused harnesses.

**Possible improvements:**

- Extend `bun run report:iteration --session-context` and `--session-history` with clearer next-action wording for the latest failed scenario.
- Add a small command that prints the latest artifact paths for a scenario.
- Add optional intent labels/phase markers so future telemetry can distinguish planning, editing, validation, and handoff.

**Likely files:**

- `scripts/report-iteration.ts`
- `.pi/skills/iteration-observability/SKILL.md`
- `AGENTS.md`

**Validation:**

```bash
bun run report:iteration --recommend scripts/report-iteration.ts .pi/skills/iteration-observability/SKILL.md AGENTS.md
bun run check
bun run report:iteration --session-history --latest-sessions 10 --exclude-current-session
```

### 5. Continue the extension-shaped `/plan` migration after the audit

**Why:** `docs/extensions-design.md` Phase 1 remains a high-priority product architecture slice. The audit does not replace it; it provides guardrails for doing it without increasing monolith pressure.

**Recommended constraint:** introduce the registry in a way that reduces or avoids growth in `apps/server/src/index.ts` and keeps `/plan` behavior unchanged.

**Likely files:**

- `apps/server/src/workflow-skills.ts`
- New `apps/server/src/extensions.ts` or `apps/server/src/bundled-extensions/plan/*`
- `packages/protocol/src/index.ts`

**Validation:**

```bash
bun run report:iteration --recommend apps/server/src/workflow-skills.ts apps/server/src/extensions.ts packages/protocol/src/index.ts
bun run check
bun scripts/ui-harness.ts --scenario slash-commands
```

## Recommended sequencing

1. Keep this audit as the shared planning baseline.
2. For the next implementation session, choose one small behavior-preserving extraction tied to the actual feature being touched.
3. Prefer `main.ts` extraction only when the next user-visible slice touches that area anyway.
4. Prefer harness split when the next session is mostly validation/tooling work.
5. Prefer server extraction when starting extension Phase 1, worktree status, or session lifecycle changes.

## Open questions

- Which `main.ts` island is most painful during the next real product slice: composer, session lifecycle, transcript patching, or sidebar/drawer?
- Should harness scenario modules be split by UX area, by validation frequency, or by backend dependency/lifecycle risk?
- Is offline JSONL telemetry enough, or do we need explicit phase/intent markers to make rerun recommendations more accurate?
- Should `PROJECT_LOG.md` gain a short “durable docs index” near the top so agents find audit/design docs before reading long history?

## Revisit criteria

Re-run this audit when one of these changes materially:

- `apps/web/src/main.ts` drops below ~2,000 lines or gains another major feature area.
- `scripts/ui-harness.ts` is split or exceeds ~2,500 lines.
- Full/all harness becomes the default again in practice.
- Iteration telemetry shows edit failures moving away from the current hotspots.
- Extension loading, worktree status, or transcript performance work changes the core architecture boundaries.
