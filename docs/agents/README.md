# Agent Workflow Notes

This directory records workflow conventions for future agents.

## Work Tracking

No project issue tracker or label convention is recorded yet. Until one is chosen, keep implementation plans in the conversation or in `.context/` for temporary collaboration notes.

If tracker conventions are introduced, record:

- where work items live
- ready/blocked/done states
- labels used for bugs, features, performance, documentation, and architecture
- when an agent should ask before changing scope

## Verification Expectations

- For type-only or narrow UI changes, run `bun run check-types`.
- For dependency, build, route, or desktop integration changes, run `bun run build`.
- For behavior fixes, prefer a small regression test or fixture before patching when the repo has a relevant test harness.
- For performance work, capture a baseline, state the workload, and rerun the same workload after changes.

## Temporary Collaboration Notes

Use `.context/` for local, gitignored notes shared between Conductor agents in the same workspace. Do not treat `.context/` as durable project documentation.
