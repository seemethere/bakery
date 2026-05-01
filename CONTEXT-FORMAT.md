# Context Document Format

Use `CONTEXT.md` to capture domain language that should be meaningful to project/domain experts, not implementation trivia.

## Purpose

A context document defines the shared vocabulary for a bounded area of the product. It should help future humans and agents use the same terms when discussing plans, tradeoffs, and behavior.

## Rules

- Prefer domain terms over file names, classes, functions, or framework details.
- Add a term only when the team has resolved what it means.
- Call out aliases or rejected terms when they prevent recurring confusion.
- Keep examples concrete and behavior-oriented.
- Do not record temporary implementation notes, task lists, or verification history here.
- Update the document inline during planning when terminology is clarified.

## Suggested structure

```md
# <Context Name> Context

## Scope

Short description of what this context covers and what it intentionally does not cover.

## Glossary

### <Canonical Term>

Definition in domain language.

- Also known as: <optional aliases>
- Not: <optional rejected/conflicting meanings>
- Example: <optional concrete scenario>

## Open terminology questions

- <Question whose answer would change planning or implementation language.>
```

## Term entry checklist

Before adding or editing a glossary term, confirm:

1. The term is meaningful outside a single source file.
2. The definition distinguishes it from nearby terms.
3. Any important alias/conflict is explicit.
4. The wording would still make sense if the implementation moved files.
