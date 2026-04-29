# Bakery extension architecture

Status: design draft. This document describes the extension model Bakery should implement after the current local-first web-agent baseline.

## Goals

- Keep Bakery's core small by moving product-specific workflows and UI affordances behind typed extension points.
- Support trusted local and project extensions that can add browser UI, slash commands, workflow prompts, backend actions, and session-aware behavior.
- Bridge existing pi SDK extensions where practical instead of replacing pi's agent-side extension system.
- Make `/plan` the first reference extension shape: a workflow command that interviews the operator, launches an agent prompt, and renders final inline actions.
- Provide a developer experience that supports fast prototyping, focused tests, hot reload, and long-term maintenance.

## Non-goals for the first extension slice

- A marketplace or third-party distribution channel.
- Sandboxing untrusted extension code.
- Hosted multi-user extension isolation.
- Arbitrary DOM mutation of the Bakery app shell.
- Replacing pi's existing extension, skill, prompt-template, or context-resource systems.
- A complete reusable component library before the first extension migration.

## Current state

Bakery already exposes parts of pi's resource ecosystem:

- `DESIGN.md` defines a backend-controlled `ResourcePolicy` with extension, skill, prompt-template, and context-file gates.
- `apps/server/src/pi-runner.ts` lists registered pi extension commands through `session.extensionRunner.getRegisteredCommands()`.
- Slash command autocomplete can show command sources from `builtin`, `extension`, `prompt`, and `skill` via `packages/protocol/src/index.ts`.
- `/reload` calls `session.reload()` and reloads extensions, skills, prompts, and context resources.
- Bundled workflow commands currently live in `apps/server/src/workflow-skills.ts`; `/plan` is implemented there as a built-in workflow prompt factory rather than as a general extension.
- The browser UI is a framework-light TypeScript app with focused modules for routing, composer behavior, transcript rendering, session sidebar, and harness scenarios.

This is enough to design Bakery extensions as a thin host layer around stable protocol and UI contribution points.

## Relationship to pi extensions

Bakery should treat pi extensions as the agent/runtime extension layer. They can already register tools, commands, lifecycle hooks, user prompts, state entries, and terminal/TUI rendering. Bakery should not duplicate those capabilities unless the browser needs a web-specific counterpart.

The bridge policy should be:

1. **Discover pi resources through the pi SDK.** Continue to surface pi extension commands, prompt templates, and skills in command autocomplete.
2. **Handle browser-compatible pi commands when possible.** If a pi command can return text or structured data without terminal-only UI, Bakery can render it as a normal command result.
3. **Report unsupported terminal-only capabilities clearly.** Custom TUI components and terminal shortcuts should not silently fail in the browser.
4. **Use Bakery extensions for web UI.** Browser panels, transcript cards, composer actions, and route contributions should be Bakery extension capabilities, even when backed by a pi extension.

## Trust and security model

V1 Bakery extensions are trusted local code.

- Extensions run with the permissions of the Bakery backend process.
- Browser extension bundles are served by the trusted local backend.
- Project-local extensions are disabled/enabled by backend policy, not by arbitrary remote content.
- Extension manifests must declare capabilities so users can understand what a trusted extension intends to do, but v1 declarations are documentation and validation boundaries, not a sandbox.
- Containerization remains the recommended boundary when exposing Bakery outside a trusted local machine.

Future sandboxing can be added with worker processes, iframes, or capability-enforced RPC, but the first design should not imply that untrusted code is safe.

## Extension package and discovery model

Initial discovery should mirror Bakery's local-first posture and pi's resource loading conventions.

Candidate locations:

| Location | Scope | Notes |
| --- | --- | --- |
| `apps/server/src/bundled-extensions/*` | Bundled | Used for `/plan` and other core-adjacent workflows during migration. |
| `.pi/bakery/extensions/*` | Project-local | Loaded only when project resources are enabled. |
| `~/.pi/bakery/extensions/*` | Global local | Loaded only when global resources are enabled. |
| Explicit config paths | Local override | Useful for development and tests. |

An extension can start as a directory:

```text
.pi/bakery/extensions/my-extension/
  bakery.extension.ts
  package.json
  web/
    index.ts
    components/
  test/
    extension.test.ts
  README.md
```

The initial manifest should be TypeScript-first:

```ts
import { defineBakeryExtension } from "@pi-web-agent/extension-api";

export default defineBakeryExtension({
  id: "example.my-extension",
  displayName: "My extension",
  version: "0.1.0",
  capabilities: ["commands", "ui:transcript.messageActions"],
  commands: [],
  ui: [],
});
```

The backend should validate the normalized manifest with Zod before exposing it over the shared protocol.

## Backend extension API

The backend API should support extension-shaped product features before it supports dynamic third-party loading. That keeps the first implementation small and gives `/plan` a migration path.

Conceptual API:

```ts
type BakeryExtension = {
  id: string;
  displayName: string;
  version?: string;
  capabilities?: ExtensionCapability[];
  commands?: ExtensionCommand[];
  ui?: ExtensionUiContribution[];
  activate?(ctx: ExtensionActivateContext): void | Promise<void>;
};

type ExtensionCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  handler: (ctx: ExtensionCommandContext, args: string) => Promise<ExtensionCommandResult>;
};
```

Command handlers should be able to:

- launch an agent prompt;
- return a text/markdown command result;
- return a structured result for a registered UI view;
- ask a browser question through the existing `ask_question` path where appropriate;
- read session metadata and runtime settings;
- update extension-scoped state;
- call explicitly exposed backend helpers.

They should not receive raw app internals by default. The host context should expose stable services rather than implementation objects.

Example command result types:

```ts
type ExtensionCommandResult =
  | { kind: "handled"; title?: string; body?: string; isError?: boolean }
  | { kind: "launchPrompt"; prompt: string; compactLaunchText?: string }
  | { kind: "view"; view: string; props: unknown };
```

## Browser extension API

Browser extensions should be framework-neutral and Web Component friendly.

An extension web entry should register custom elements and declare contributions; it should not patch arbitrary DOM nodes.

Conceptual browser entry:

```ts
import { defineBakeryWebExtension } from "@pi-web-agent/extension-api/web";
import "./components/plan-actions.js";

export default defineBakeryWebExtension({
  id: "bakery.plan",
  components: ["bakery-plan-actions"],
  slots: [
    {
      slot: "transcript.messageActions",
      component: "bakery-plan-actions",
      when: { marker: "Plan actions:" },
    },
  ],
});
```

The web host should provide a typed element context through properties/events rather than global app access:

```ts
type BakeryElementContext = {
  sessionId: string;
  theme: "light" | "dark" | "system";
  dispatchAction(action: ExtensionUiAction): void;
  request<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
};
```

## Named UI slots

V1 should use controlled slots. This preserves core ownership of layout, accessibility, mobile behavior, and performance.

Recommended slot taxonomy:

| Slot | Purpose | First priority |
| --- | --- | --- |
| `transcript.messageActions` | Inline buttons under specific assistant/system messages. | High; `/plan` reference. |
| `transcript.customCard` | Structured transcript cards for extension results. | High after `/plan`. |
| `composer.left` | Small indicators/adornments near composer context controls. | Medium. |
| `composer.right` | Additional compact composer controls. | Medium. |
| `composer.actions` | Explicit send-adjacent actions. | Medium. |
| `session.header.actions` | Session-scoped buttons in the top bar/details area. | Medium. |
| `session.details.sections` | Extension sections in session details. | Medium. |
| `app.sidebar.nav` | Extension navigation entries. | Later. |
| `settings.sections` | Extension settings pages/sections. | Later. |
| `routes` | Full extension-owned pages under a controlled route prefix. | Later. |

Each slot should define:

- allowed component shape;
- props contract;
- actions/events contract;
- loading and error UI;
- mobile behavior;
- test harness expectations.

## Shared UI components and design tokens

Bakery should not require extension authors to copy core CSS or rebuild common controls. However, a full design system should be extracted gradually.

Start with a small `@pi-web-agent/extension-api/web` surface that exposes design tokens and primitives:

- button styles/classes;
- card surface styles/classes;
- inline action layout;
- badge/chip styles;
- form field styles;
- focus-ring and accessibility helpers;
- empty/error/loading patterns.

Candidate Web Components for later extraction:

- `bakery-button`;
- `bakery-card`;
- `bakery-inline-actions`;
- `bakery-panel`;
- `bakery-text-field`;
- `bakery-select`;
- `bakery-badge`;
- `bakery-empty-state`;
- `bakery-toast`;
- `bakery-modal`.

The first implementation can expose stable CSS classes and tokens, then promote heavily reused pieces to custom elements after a real extension needs them.

## Protocol and validation

All extension data crossing server/browser boundaries should live in `packages/protocol` and be validated with Zod.

Likely protocol additions:

- `extensionManifestSchema`;
- `extensionContributionSchema`;
- `extensionCommandResultSchema`;
- `extensionUiSlotSchema`;
- `extensionActionRequestSchema`;
- `extensionActionResponseSchema`.

Keep unknown extension props as `unknown` at the protocol boundary, then validate them either:

- with extension-provided schemas registered by the backend; or
- as opaque JSON passed only to the extension-owned component.

Prefer opaque JSON for the first slice to avoid building a general schema registry too early.

## State and persistence

Extension state should be explicit and scoped.

Recommended scopes:

- `session`: state tied to one Bakery web session;
- `workspace`: state tied to a workspace directory;
- `global`: local user state across workspaces.

Initial implementation can store state in existing SQLite metadata behind an extension-state interface:

```sql
extension_state (
  extension_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (extension_id, scope, scope_id, key)
)
```

Do not store provider credentials in extension state. Credentials remain backend/env/pi-auth concerns.

## Reload and developer loop

The dev loop should be boring and observable.

- `/reload` should reload pi resources and Bakery extension manifests.
- Backend extension reload failures should be returned as command results and logged server-side.
- Browser extension reload should invalidate served bundles and show component load failures inline at the slot that failed.
- Dynamic web bundle reload can come later; a backend/dev-server restart is acceptable for the first design if documented clearly.
- Extension authors should be able to run focused tests without starting a real agent.

Future scaffold command:

```bash
bun run create:extension my-extension
```

Future local validation command examples:

```bash
bun test .pi/bakery/extensions/my-extension/test/extension.test.ts
bun scripts/ui-harness.ts --scenario extension-smoke --extension my-extension
```

## Testing strategy

Use three layers.

### Unit tests

- Manifest validation.
- Command parsing and handler output.
- Slot matching predicates.
- Extension state helpers.

### Integration tests

- Bundled extension registry loads `/plan`.
- Slash autocomplete includes extension commands with `source: "extension"` or a more specific bundled source.
- Command results serialize through `packages/protocol`.
- `/reload` updates the extension registry and reports errors.

### UI harness scenarios

- Existing `slash-commands` should continue to cover `/plan` discovery and launch.
- Add an `extension-inline-actions` scenario when the first slot renderer lands.
- Add an `extension-panel` or `extension-route` scenario when persistent UI slots land.
- Run mobile coverage for transcript/composer slots because those areas are layout-sensitive.

## Reference extension: `/plan`

`/plan` should become the canonical extension-shaped workflow.

Target behavior:

1. Register `/plan` through the extension command API.
2. Build the canonical interview prompt from an optional focus argument.
3. Launch the prompt as the next agent request.
4. Require the workflow to use `ask_question` one question at a time.
5. Recognize the final marker `Plan actions: Accept plan · Back to chat`.
6. Render the final actions through `transcript.messageActions` rather than hard-coded product logic.

Proposed shape:

```text
apps/server/src/bundled-extensions/plan/
  index.ts
  plan-prompt.ts
  web/
    plan-actions.ts
```

The first migration does not need dynamic extension loading. It can introduce the registry and make existing bundled workflow skills look like extensions internally.

## Phased implementation plan

### Phase 0: design and alignment

Create this design doc, review the tradeoffs, and confirm the first API boundary.

Validation:

```bash
bun run check
```

### Phase 1: bundled extension registry

Refactor current bundled workflow skills into an extension-shaped internal registry without dynamic loading.

Likely files:

- `apps/server/src/workflow-skills.ts`;
- new `apps/server/src/extensions.ts`;
- `packages/protocol/src/index.ts`.

Validation:

```bash
bun run report:iteration --recommend apps/server/src/workflow-skills.ts apps/server/src/extensions.ts packages/protocol/src/index.ts
bun run check
bun scripts/ui-harness.ts --scenario slash-commands
```

### Phase 2: protocol-backed inline action slot

Move `/plan` final inline actions behind a typed UI contribution slot.

Likely files:

- `packages/protocol/src/index.ts`;
- `apps/web/src/transcript.ts`;
- `apps/web/src/main.ts`;
- `apps/server/src/workflow-skills.ts` or the new extension registry;
- `scripts/ui-harness.ts`.

Validation:

```bash
bun run report:iteration --recommend packages/protocol/src/index.ts apps/web/src/transcript.ts apps/web/src/main.ts scripts/ui-harness.ts
bun run check
bun scripts/ui-harness.ts --scenario slash-commands
bun scripts/ui-harness.ts --scenario mobile-layout
```

### Phase 3: trusted local extension loading

Load project/global Bakery extensions from policy-approved locations, validate manifests, and expose command contributions.

Likely files:

- `apps/server/src/config.ts`;
- `apps/server/src/index.ts`;
- new `apps/server/src/extension-loader.ts`;
- `packages/protocol/src/index.ts`.

Validation:

```bash
bun run report:iteration --recommend apps/server/src/config.ts apps/server/src/index.ts apps/server/src/extension-loader.ts packages/protocol/src/index.ts
bun run check
bun scripts/ui-harness.ts --scenario slash-commands
```

### Phase 4: extension DX kit

Add a scaffold, docs, examples, and harness helpers.

Likely files:

- new `packages/extension-api`;
- new `scripts/create-extension.ts`;
- `scripts/ui-harness.ts`;
- extension author docs.

Validation:

```bash
bun run report:iteration --recommend packages/extension-api scripts/create-extension.ts scripts/ui-harness.ts
bun run check
```

## Open questions

- Should bundled workflow commands report `source: "skill"`, `source: "extension"`, or a new source such as `"workflow"` after the registry refactor?
- Should project-local Bakery extensions live under `.pi/bakery/extensions` or reuse `.pi/extensions` with a Bakery-specific manifest?
- How much browser bundle tooling should v1 provide before extension authors need to bring their own build step?
- Which extension capabilities should be visible in the settings UI before local dynamic loading ships?
- Should extension state live in the existing metadata store immediately, or wait until a real extension needs persistence?
