# Architecture Decision Records

Use this directory for durable decisions that future agents should not rediscover from scratch.

## When To Add An ADR

Add an ADR when a decision affects module shape, data contracts, storage, Git command strategy, desktop/web responsibilities, performance budgets, or library choices.

Do not add an ADR for routine implementation details that are obvious from code.

## Format

Use short markdown files named:

```text
0001-short-title.md
```

Suggested sections:

```markdown
# <Title>

## Status

Accepted | Superseded | Proposed

## Context

What forced the decision.

## Decision

What the repo will do.

## Consequences

Tradeoffs, follow-up work, and verification expectations.
```
