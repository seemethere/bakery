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

The canonical Workflow Command for reaching shared understanding before implementation. It interviews the operator one question at a time, inspects project context when possible, recommends a small vertical slice, and ends with Plan Actions.

- Not: a commitment to implement immediately; the operator still chooses whether to accept the plan.
- Example: `/plan align the workflow prompt with domain documentation` starts a focused grill session about that goal.

### Plan Actions

The inline actions rendered at the end of a completed `/plan` response so the operator can accept the plan or return to chat.

- Not: part of the natural-language plan itself.
- Example: the final standalone marker `Plan actions: Accept plan · Back to chat` is converted into mobile-friendly action buttons by Bakery.

### Bundled Extension

A product-owned extension packaged with Bakery that contributes commands or UI behavior through the extension-shaped interfaces.

- Not: an arbitrary third-party plugin loaded from an untrusted source.
- Example: the bundled workflow extension contributes the `/plan` command.

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
