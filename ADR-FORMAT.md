# Architecture Decision Record Format

Use ADRs for decisions that future contributors are likely to question unless the tradeoff is recorded.

## When to create an ADR

Create an ADR only when all three are true:

1. **Hard to reverse** — changing direction later has meaningful cost.
2. **Surprising without context** — a future reader may ask why the team chose this path.
3. **Tradeoff-driven** — there were real alternatives with different benefits and costs.

If any condition is missing, prefer updating `CONTEXT.md`, `DESIGN.md`, or the project log instead.

## File location and naming

- System-wide decisions: `docs/adr/NNNN-short-title.md`.
- Context-specific decisions: place under that context's `docs/adr/` directory when a `CONTEXT-MAP.md` identifies multiple contexts.
- Use a zero-padded sequence number and kebab-case title.

## Template

```md
# NNNN. <Decision title>

Date: YYYY-MM-DD

## Status

Accepted | Proposed | Superseded by ADR-NNNN

## Context

What problem or uncertainty forced a decision? Include constraints and forces that made the choice non-obvious.

## Decision

State the chosen direction clearly.

## Alternatives considered

- **Option A** — key benefit and cost.
- **Option B** — key benefit and cost.

## Consequences

- Positive consequence.
- Negative or limiting consequence.
- Follow-up work or review trigger, if any.
```

## Writing guidance

- Link to relevant context terms where useful.
- Capture why, not just what.
- Keep implementation details only when they are essential to the decision.
- Prefer one decision per ADR.
