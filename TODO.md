# piFactory Progress

This checklist tracks implementation progress against the phases defined in
`AGENTS.md`. Mark an item complete only after its implementation and required
verification have passed.

## Status

- Current phase: Phase 1 - Domain Core (complete; awaiting Phase 2 authorization)
- Completed phases: 1 / 20
- First vertical slice: Not started

## Before Coding

- [x] Proposed directory tree
- [x] `FactoryRun` interface
- [x] `WorkNode` interface
- [x] `WorkGraph` API
- [x] WorkNode state machine
- [x] FactoryRun state machine
- [x] Scheduler responsibilities
- [x] `RoleResult` protocol
- [x] Artifact model
- [x] Persistence model
- [x] Digest strategy
- [x] Mutation-security model
- [x] First vertical-slice architecture
- [x] Initial unit, integration, and system testing strategy

## Implementation Phases

- [x] Phase 1 - Domain Core
  - [x] Implement `FactoryRun`
  - [x] Implement `WorkNode`
  - [x] Implement `WorkGraph`
  - [x] Implement Artifact types
  - [x] Implement DAG validation
  - [x] Add and pass Phase 1 unit tests
- [ ] Phase 2 - Persistence
  - [ ] Implement run storage
  - [ ] Implement event log
  - [ ] Implement atomic writes
  - [ ] Implement state reload
  - [ ] Prove completed nodes survive restart
- [ ] Phase 3 - Safety Foundation
  - [ ] Implement canonical SHA-256 hashing
  - [ ] Implement workspace snapshots and deltas
  - [ ] Implement path validation
  - [ ] Implement mutation boundaries
- [ ] Phase 4 - Sequential Scheduler
  - [ ] Implement dependency scheduling
  - [ ] Implement state transitions
  - [ ] Implement retry policy
  - [ ] Implement budget tracking
  - [ ] Enforce one worker at a time
- [ ] Phase 5 - Builder
  - [ ] Add the first LLM integration
  - [ ] Validate actual workspace mutations
  - [ ] Run targeted validation
  - [ ] Persist implementation artifacts
- [ ] Phase 6 - FAST Vertical Slice
  - [ ] Complete trivial tasks with one Builder call where possible
  - [ ] Skip Planner, Reviewer, human input, and worktrees by default
  - [ ] Verify the first vertical slice end to end
- [ ] Phase 7 - Durable Context
  - [ ] Implement Artifact Store
  - [ ] Implement `TaskPacket`
  - [ ] Implement structured cross-session context
- [ ] Phase 8 - Builder Modes
  - [ ] Add `debug` mode
  - [ ] Add `test` mode
  - [ ] Add `integrate` mode
  - [ ] Add `document` mode
- [ ] Phase 9 - Idempotent Execution
  - [ ] Reuse valid completed nodes after interruption
- [ ] Phase 10 - Planner
  - [ ] Add Planner decomposition
  - [ ] Add WorkGraph generation
- [ ] Phase 11 - Planner Validation
  - [ ] Validate generated DAGs as untrusted input
- [ ] Phase 12 - Parallel Scheduler
  - [ ] Run independent nodes concurrently
  - [ ] Enforce capacity, budget, dependency, and scope constraints
- [ ] Phase 13 - Worktree Isolation
  - [ ] Isolate concurrent mutation workers in Git worktrees
- [ ] Phase 14 - Integration
  - [ ] Add `Builder(integrate)` fan-in handling
- [ ] Phase 15 - Differential Baseline
  - [ ] Record initial validation baselines
  - [ ] Detect new regressions relative to the baseline
- [ ] Phase 16 - Reviewer
  - [ ] Add conditional independent review
- [ ] Phase 17 - Human Decisions
  - [ ] Persist structured decision requests and responses
  - [ ] Continue scheduling automatically after a response
- [ ] Phase 18 - Budgets and Loop Detection
  - [ ] Enforce execution budgets
  - [ ] Detect and stop no-progress loops
- [ ] Phase 19 - Crash Recovery
  - [ ] Implement checkpoints
  - [ ] Implement run leases and stale-lease recovery
  - [ ] Implement safe scheduler recovery
- [ ] Phase 20 - Observability
  - [ ] Expose run, node, worker, budget, retry, and decision status
  - [ ] Expose tier escalations and their reasons

## First Milestone Gate

- [ ] User request creates a `FactoryRun`
- [ ] The run contains a Builder `WorkNode`
- [ ] The deterministic scheduler invokes the Builder
- [ ] Workspace mutations are independently validated
- [ ] Targeted checks run
- [ ] An Artifact is persisted
- [ ] The WorkNode completes
- [ ] The FactoryRun completes
- [ ] The vertical slice is reliable before Planner, Reviewer, parallelism, or
      worktrees are introduced
