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

The operator-facing transcript card rendered for a `/plan` response. While the final plan is still streaming, it shows a generating state; when complete, it shows the plan's summary and smallest next slice, opens the full rendered plan when clicked, and offers an Accept Plan action that prepares the composer instead of immediately starting work.

- Not: a composer takeover; the normal composer remains available for chat or edits while the Plan Card carries the plan-specific affordance.
- Not: a replacement for the full plan details; the full rendered plan remains available from the ready card.
- Example: an operator finishes a `/plan` interview, sees a generating Plan Card while the final answer streams, clicks the ready Plan Card to inspect the detailed markdown plan, then accepts it to prefill the composer with the implementation prompt.

### Plan Actions

The machine-readable final marker in a completed `/plan` response that lets Bakery recognize the plan and render the Plan Card affordance.

- Not: part of the natural-language plan itself.
- Example: the final standalone marker `Plan actions: Accept plan` is converted into a Plan Card with an Accept Plan action by Bakery.

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

### Session Metadata Generation

An explicit Bakery action that generates and updates an agent session's operator-facing title and summary from the session transcript, optionally steered by operator guidance.

- Also known as: generate details, title/summary generation.
- Not: the whole session Details popover; Details may also show workspace, isolation, preview, and other session information.
- Example: an operator runs `/bakery:generate-details emphasize extension architecture`; Bakery asks the configured metadata model for a title and summary, applies the safe metadata update, and shows a compact command receipt.

### Preview Stack

An operator-started review environment for an isolated agent session that runs the session worktree's Bakery frontend and backend on separate temporary ports and gives the operator an openable URL for dogfooding that branch.

- Not: the primary development server or an automatically merged workspace.
- Example: an operator starts a Preview Stack from an isolated session's Details panel, opens the generated URL, reviews the branch's UI changes with fake-agent data, then stops the stack.

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
