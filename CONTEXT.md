# Bakery Context

## Scope

This context covers the product language for Bakery: a local-first web application for creating and steering server-backed pi coding-agent sessions. It focuses on operator-visible concepts and planning vocabulary, not internal file/module names.

## Glossary

### Bakery

The local-first web application that lets an operator create, inspect, and guide pi coding-agent sessions from a browser.

- Not: a hosted multi-user SaaS product.
- Example: an operator opens Bakery for a repository, starts a session, asks the agent to plan a slice, and reviews the resulting transcript and changes.

### Operator

The human using Bakery to steer a coding session.

- Also known as: user, human operator.
- Not: the coding agent or the application server.

### Agent Session

A server-backed pi coding-agent conversation bound to a workspace directory and surfaced through Bakery.

- Also known as: session.
- Not: a browser tab; multiple clients may observe or reconnect to the same agent session.
- Example: an operator starts a session in a repository and later reconnects to the same transcript from another browser window.

### Workspace

The filesystem directory that bounds an agent session's code access and project context.

- Not: the entire machine unless the configured allowed root intentionally permits it.
- Example: `/Users/example/projects/bakery` is the workspace for a Bakery development session.

### Bakery Launcher

The operator-facing command that starts Bakery for an invocation workspace, keeps the local backend and browser UI processes tied to that command, and prints the localhost UI address.

- Also known as: launcher, local launcher.
- Not: the npm package name, registry publishing decision, or a guarantee that the first implementation is single-port.
- Example: an operator runs `bun run bakery` from `/Users/example/projects/app`; Bakery starts for that workspace, prints `http://127.0.0.1:5173/`, and stops the started processes when the operator presses Ctrl+C.

### Workflow Command

An operator-facing slash command that launches a guided workflow prompt for the agent.

- Also known as: workflow skill when referring to the prompt pattern inherited from pi terminology.
- Not: a general shell command or a low-level implementation hook.
- Example: `/plan choosing the next UX slice` launches a planning interview.

### `/plan`

The canonical Workflow Command for reaching shared understanding before implementation. It interviews the operator one question at a time, inspects project context when possible, recommends a small vertical slice, and ends with a Plan Card.

- Not: a commitment to implement immediately; the operator still chooses whether to accept the plan.
- Example: `/plan align the workflow prompt with domain documentation` starts a focused grill session about that goal.

### Plan Card

The operator-facing transcript card rendered for a `/plan` response. While the final plan is still streaming, it shows a generating state; when complete, it shows the plan's summary and smallest next slice, opens the full rendered plan when clicked, and offers an Accept Plan action that submits the recommended implementation prompt when Bakery is connected.

- Not: a composer takeover; the normal composer remains available for chat or edits while the Plan Card carries the plan-specific affordance.
- Not: a replacement for the full plan details; the full rendered plan remains available from the ready card.
- Example: an operator finishes a `/plan` interview, sees a generating Plan Card while the final answer streams, clicks the ready Plan Card to inspect the detailed markdown plan, then accepts it to send the implementation prompt in the background. If Bakery is disconnected, Accept Plan preserves that prompt in the composer with a notice so the operator does not lose intent.

### Plan Actions

The machine-readable final marker in a completed `/plan` response that lets Bakery recognize the plan and render the Plan Card affordance.

- Not: part of the natural-language plan itself.
- Example: the final standalone marker `Plan actions: Accept plan` is converted into a Plan Card with an Accept Plan action by Bakery.

### Assistant Streaming Placeholder

The compact transcript card Bakery shows while an assistant response is still streaming, instead of showing raw pre-render markdown or partial final text. The placeholder confirms that Pi is responding, then gives way to the fully rendered assistant message when the response completes.

- Not: a replacement for live tool activity, Question Cards, or the completed assistant response.
- Example: an operator sends a normal prompt, sees a small “Pi is responding…” card while the answer streams, and then sees the final rendered markdown message when streaming finishes.

### Empty Session Landing

The operator-facing start state for a newly created Agent Session before any transcript events exist. It centers the composer as the primary action, shows a small stable-per-session baking/cooking greeting, and offers compact quick-start chips below the composer until the composer needs more space.

- Not: the layout for an Agent Session with existing transcript history.
- Not: a replacement for the normal bottom composer during active transcript work.
- Example: an operator opens a fresh session, sees a centered composer with a playful Bakery quote and compact `/plan`, Screenshot, `@file`, and `!bash` chips, then the helper content disappears when multiline text or attachments make the composer grow.

### Transcript Auto-scroll

The transcript behavior that keeps the latest streamed assistant text, tool activity, and other new session events visible while the operator has not intentionally scrolled away.

- Also known as: follow latest, pin to latest.
- Not: forcing the transcript to jump while the operator is deliberately reading older transcript content.
- Example: during a long run with many tool calls, Bakery keeps the live tool activity pinned at the bottom until the operator scrolls upward, then shows Jump to latest instead of fighting the operator's scroll position.

### Question Card

The transcript card used when the agent asks the operator for a decision through Bakery. A Question Card is a terminal assistant checkpoint: Bakery presents the question in the transcript, returns the session to normal chat input, and lets the operator continue with either a tapped option or a normal composer send.

- Not: a generic composer panel or low-level tool-call receipt.
- Not: duplicate visible tool activity for the underlying `ask_question` tool.
- Not: a long-lived custom-answer form embedded in the transcript; freeform responses belong in the normal composer, including the composer’s usual attachment affordances.
- Not: an Extension Card in the first implementation; extensions may later reuse a similar interactive checkpoint shape, but the built-in operator question flow owns session checkpointing, focus, composer state, and controller/viewer permissions.
- Example: during a `/plan` interview, the agent asks which UX direction to pursue; Bakery shows a compact Question Card with recommended options. The operator can tap an option to send it as the next chat turn, or type a normal response in the composer.

### Bundled Extension

A product-owned extension packaged with Bakery that contributes commands or UI behavior through the extension-shaped interfaces.

- Not: an arbitrary third-party plugin loaded from an untrusted source.
- Example: the bundled workflow extension contributes the `/plan` command.

### Dynamic Bakery Extension

A trusted local extension loaded by Bakery from an operator-configured path, using pi-like file, directory, or package entry conventions for backend code plus Bakery-specific web UI declarations when browser rendering is needed.

- Also known as: local extension, external extension.
- Not: an untrusted marketplace plugin or a browser-only script that bypasses Bakery's extension host.
- Example: an operator configures an additional extension path, reloads resources, and Bakery discovers a command whose result renders in a transcript card.

### Extension Card

A transcript card whose data and browser component are contributed through Bakery's extension UI contract rather than hard-coded in the core transcript renderer.

- Also known as: custom card, transcript custom card.
- Not: arbitrary DOM mutation of the transcript or a terminal TUI renderer copied directly into the browser.
- Example: `/bakery:generate-details` returns session metadata result data, and its bundled extension card renders the title, summary, and skipped-field note.

### Subagent

A focused child pi coding-agent session launched by the parent agent through a runtime extension such as `pi-subagents` to perform delegated work.

- Not: a native Bakery web session or browser tab.
- Not: a replacement for the parent Agent Session; the parent remains responsible for orchestration and summarizing results.
- Example: the parent agent asks a `reviewer` subagent to inspect a diff, then brings the review result back into the main conversation.

### Subagent-assisted Planning

A `/plan` behavior where the parent Agent Session uses an available Subagent for bounded, read-only reconnaissance before asking the operator or finalizing a Plan Card.

- Not: delegating the operator interview to a child session; the parent still owns Question Cards and asks the operator one question at a time.
- Not: native web-managed subagent orchestration or background child-session controls.
- Example: during a non-trivial `/plan` interview, the parent runs a foreground `scout` subagent to inspect code paths and summarize risks, then asks the operator the next decision through a Question Card.

### Subagent Card

A Bakery-owned transcript card that renders an existing foreground `pi-subagents` execution run in Bakery's standalone card style, covering live child-agent progress and concise final child-agent results.

- Running execution calls render as full standalone cards immediately, including before rich progress details arrive; Bakery uses available agent/task/chain arguments as fallback activity until `pi-subagents` reports structured progress.
- Final execution cards prioritize a concise per-child summary: agent status, useful model/tool/token/duration stats when available, a short final-output preview, and compact basename-only output/session path chips.
- Management calls such as list, status, get, doctor, interrupt, and resume remain quiet or compact tool receipts rather than full Subagent Cards.
- The card is non-collapsible, avoids generic tool-row headers, avoids nested internal scrollbars, keeps a compact desktop width while using available narrow/mobile width, and preserves Copy/Fork through an overlaid standalone-card action menu.
- Not: native web-managed subagent orchestration.
- Not: direct reuse of the terminal TUI renderer from `pi-subagents`.
- Not: the full background async widget/status surface; those may become follow-up UI.
- Example: while a foreground reviewer subagent runs, Bakery shows agent status and current activity immediately, then replaces that live progress with a structured summary such as “Reviewer approved,” model/usage stats, and compact output-file labels.

### Session Metadata Generation

An explicit Bakery action that generates and updates an agent session's operator-facing title and summary from the session transcript, optionally steered by operator guidance.

- Also known as: generate details, title/summary generation.
- Not: the whole session Details popover; Details may also show workspace, isolation, preview, and other session information.
- Example: an operator runs `/bakery:generate-details emphasize extension architecture`; Bakery asks the configured metadata model for a title and summary, applies the safe metadata update, and shows a compact command receipt.

### Preview Stack

An operator-started review environment for an isolated agent session that runs the session worktree's Bakery frontend and backend on separate temporary ports and gives the operator an openable URL for dogfooding that branch.

- Not: the primary development server or an automatically merged workspace.
- Example: an operator starts a Preview Stack from an isolated session's Details panel, opens the generated URL, reviews the branch's UI changes with fake-agent data, then stops the stack.

### Event Fork

A new Bakery agent session created from a selected session-tree-backed transcript event, used as Bakery's rollback/go-to behavior without mutating the source session's active leaf.

- Also known as: fork from here, rollback fork.
- Not: guaranteed workspace file restoration; the first behavior forks conversation/session history only.
- Example: an operator forks from an assistant response to continue after that response in a new session, or forks from a user input to reopen that prompt as an editable composer draft in the new session.

### Containerized Development Environment

A Docker-backed way to run and dogfood Bakery development from a container while editing the checked-out Bakery repository through a bind mount.

- Also known as: dev container, Docker dev environment.
- Not: the long-term multi-backend Bakery CLI or per-agent-session container isolation.
- Example: an operator starts Bakery through Docker Compose, opens the Vite UI from the host browser, and the server inside the container runs agent sessions against the mounted Bakery repository.

### Context Document

A `CONTEXT.md` file that records the domain vocabulary for a product area so operators and agents use terms consistently.

- Not: a project log, implementation checklist, or API reference.
- Example: this file defines Workflow Command so future `/plan` discussions do not confuse product language with implementation details.

### Architecture Decision Record

A short document that records a hard-to-reverse, surprising, tradeoff-driven decision and its consequences.

- Also known as: ADR.
- Not: a place for routine notes or every small implementation choice.
- Example: an ADR explains why `/plan` may update domain documentation inline during a planning interview.

## Open terminology questions

- Should “Workflow Command” remain the canonical operator-facing term if Bakery later supports non-slash workflow launches?
