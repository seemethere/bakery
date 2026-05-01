# 0001. Plan updates domain documentation during grilling

Date: 2026-05-01

## Status

Accepted

## Context

Bakery's `/plan` Workflow Command exists to reach shared understanding before implementation. A planning interview often resolves product language, bounded-context assumptions, and architectural tradeoffs. If those decisions stay only in the transcript, future sessions can lose the vocabulary and repeat the same debate.

The behavior is non-obvious because a planning workflow sounds like it should only ask questions and summarize a recommendation. Allowing it to edit `CONTEXT.md` and ADR files during the interview changes the expected boundary between planning and documentation.

## Decision

`/plan` may update domain documentation inline while it interviews the operator, when the update captures a resolved term or a qualifying architecture decision.

Specifically:

- It should discover existing `CONTEXT.md`, `CONTEXT-MAP.md`, and ADR locations before asking documentation-related questions.
- It should challenge operator language against the existing glossary and codebase evidence.
- It should update `CONTEXT.md` when a term is resolved, using `CONTEXT-FORMAT.md`.
- It should offer/create ADRs sparingly, using `ADR-FORMAT.md`, only when the decision is hard to reverse, surprising without context, and tradeoff-driven.
- It should create documentation files lazily when there is something concrete to write.

## Alternatives considered

- **Keep `/plan` interview-only** — simpler and safer because planning never edits files, but resolved domain language remains trapped in transcripts and future agents may repeat terminology questions.
- **Create a separate `/grill-with-docs` command** — preserves a narrower `/plan` meaning, but fragments the planning path and makes the documentation-aware behavior harder to discover.
- **Batch documentation changes at the end** — reduces edit interruptions, but increases the chance that resolved terms and decision rationale are lost or softened before capture.

## Consequences

- Future `/plan` sessions can accumulate shared product language instead of rediscovering it.
- Operators must expect `/plan` to make documentation edits before implementation code changes.
- The workflow prompt needs strong guardrails so it does not write implementation trivia into `CONTEXT.md` or create low-value ADRs.
- Validation for `/plan` changes should include prompt assertions and focused slash-command coverage when selected by the iteration report.
