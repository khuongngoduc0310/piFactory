# Agent Instructions

These instructions govern how agents work on piFactory. They intentionally stay
short; the complete product and architecture specification is in `PROJECT.md`.

## Required Reading

Read these files before making project changes:

1. `AGENTS.md` for execution rules.
2. `PROJECT.md` for product architecture and requirements.
3. `TODO.md` for verified implementation progress.
4. `docs/architecture.md` for accepted implementation design once it exists.

## Document Authority

- `AGENTS.md` controls agent execution and project workflow.
- `PROJECT.md` controls product architecture and requirements.
- `TODO.md` is the authoritative progress tracker.
- `docs/architecture.md` records accepted implementation design decisions.
- Surface conflicts between these documents instead of guessing which behavior
  was intended.

## Current Scope

- The current authorized implementation scope is Phase 1: Domain Core.
- Do not begin Phase 2 or any later phase without explicit user authorization.
- Phase 1 includes `FactoryRun`, `WorkNode`, `WorkGraph`, Artifact types, DAG
  validation, and their unit tests.
- Do not add agents, persistence, schedulers, LLM integrations, parallelism,
  worktrees, runtime orchestration, or a dashboard during Phase 1.

## Pre-Coding Gate

Before Phase 1 implementation, create `docs/architecture.md` and document:

1. Proposed directory tree.
2. `FactoryRun` interface.
3. `WorkNode` interface.
4. `WorkGraph` API.
5. WorkNode state machine.
6. FactoryRun state machine.
7. Scheduler responsibilities.
8. `RoleResult` protocol.
9. Artifact model.
10. Persistence model.
11. Digest strategy.
12. Mutation-security model.
13. First vertical-slice architecture.
14. Initial unit, integration, and system testing strategy.

Do not start implementation until this design is present and internally
consistent.

## Critical Invariants

- Deterministic application code owns workflow state, scheduling, permissions,
  budgets, retries, checkpoints, escalation, and result acceptance.
- Agents recommend actions; piFactory authorizes them.
- A WorkNode is durable logical work, not an agent session.
- Agent sessions are disposable and must not hold required workflow state.
- WorkNodes retain objectives, dependencies, status, scope, criteria, digests,
  artifacts, retries, failures, and execution history.
- Agents never directly spawn other agents; they request capabilities from the
  scheduler.
- Treat all LLM output as untrusted and validate it deterministically.
- Human attention is reserved for consequential decisions, not routine flow.
- Persisted human decisions continue execution automatically; `/resume` is for
  recovery or an explicit pause.
- Use the minimum practical number of LLM calls.
- Concurrent mutation requires isolation, normally through Git worktrees.
- Existing repository failures are not regressions unless the new work caused
  them.
- Independently inspect every workspace mutation; never trust a worker's own
  changed-files report.

## Toolchain

- Target Node.js 22 or newer.
- Use pnpm for package management.
- Use strict TypeScript with ESM modules.
- Use Vitest for unit tests.
- Prefer no runtime dependencies for the Phase 1 domain core.

## Engineering Rules

- Prefer strong types, pure deterministic functions, explicit state machines,
  immutable artifacts, structured validation, and fail-closed behavior.
- Keep modules small and avoid giant orchestration functions.
- Do not introduce backward compatibility without a concrete requirement.
- Keep nondeterministic inputs such as clocks outside the domain core; accept
  them as explicit arguments where required.
- Add tests for every state transition, graph invariant, and failure path.
- Run the relevant type checks and tests before marking work complete.
- Update `TODO.md` only after implementation and verification have succeeded.
