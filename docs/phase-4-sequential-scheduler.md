# Phase 4 Sequential Scheduler

## Purpose

Phase 4 adds the first deterministic application-layer scheduler. It operates on
an already-created, validated `FactoryRun`, selects one WorkNode at a time, and
persists every scheduler-owned transition through the atomic persistence API.

Phase 4 does not execute an LLM, mutate a workspace, persist artifacts, run
targeted checks, create worktrees, recover interrupted work, or coordinate more
than one worker. Those responsibilities remain in later phases.

For a developer-oriented walkthrough with examples, timelines, failure matrices,
and troubleshooting, see the [Phase 4 implementation deep dive](./phase-4-sequential-scheduler-deep-dive.md).

## Execution Boundary

The scheduler accepts an injected executor so its state machine can be tested
without introducing a Builder or an agent provider:

```ts
interface SequentialNodeExecutor {
  execute(input: {
    readonly runId: string;
    readonly request: string;
    readonly tier: ExecutionTier;
    readonly node: WorkNode;
    readonly attempt: number;
  }): Promise<NodeExecutionOutcome>;
}

type NodeExecutionOutcome =
  | { readonly kind: "succeeded" }
  | {
      readonly kind: "failed";
      readonly reason: string;
    };

interface RetrySafetyPolicy {
  isSafeToRetry(input: {
    readonly node: WorkNode;
    readonly reason: string;
  }): boolean;
}
```

The executor result is validated at runtime. An invalid result or thrown error
is normalized to a failure. Retry eligibility is decided separately by trusted
adapter code through `RetrySafetyPolicy`; the executor cannot request its own
retry. The executor cannot modify FactoryRun or WorkGraph state directly.

The scheduler also receives an injected clock and event-ID source. Production
adapters must provide canonical, non-decreasing timestamps and unique event
IDs; tests provide deterministic values.

## Accepted Input

Phase 4 accepts only a `created` run whose graph contains at least one pending
WorkNode. Every node must have its initial pending-only history, zero retries,
no artifacts, and no output digest. It rejects pre-existing ready, running,
waiting-human, failed, blocked, or completed nodes rather than attempting
recovery or reuse. Reuse belongs to Phase 9, and interrupted execution recovery
belongs to Phase 19.

The Phase 4 executor seam is reserved for Builder WorkNodes in `implement` mode.
Planner, Reviewer, and other Builder modes are rejected until their respective
phases add their execution behavior.

Runs with `maxTokens` or `maxCostUsd` are rejected because Phase 4 has no
provider usage accounting. Phase 4 enforces only call count, per-node retries,
and sequential capacity.

A run already in `running` state returns `recovery_required` without changing
the saved state. It is never re-executed automatically.

## Scheduling Algorithm

1. Persist `created -> running` with `factory_run_started`.
2. Query `getReadyNodes()` from the immutable graph.
3. Select an existing `ready` node before a `pending` node so a retry keeps
   priority; select the lowest ID within each group using UTF-16 code-unit order.
4. Check the global call budget before changing the node or invoking work.
5. Persist `pending -> ready` with `node_ready` when needed.
6. Persist `ready -> running` with `node_started`.
7. Invoke the executor only after the running state is current.
8. Persist `running -> completed` with `node_completed` on success.
9. If all nodes are complete, persist `factory_run_completed`.
10. Persist `running -> failed` with `node_failed` on failure.
11. Retry only when trusted retry policy marks the failure safe and both retry
    and call budgets remain.
12. Persist `failed -> ready` with `node_retried` before another attempt.
13. Fail the FactoryRun immediately for an unsafe or exhausted failure.

The scheduler awaits every executor call and has an effective worker limit of
one even when `maxParallelAgents` is greater than one. This is a per-invocation,
single-process guarantee. Cross-process ownership requires Phase 19 leases.

## Budget Accounting

No separate mutable budget ledger is introduced. Usage is derived from the
authoritative WorkGraph:

- an executor call is one `running` history entry;
- a retry is the existing durable `retryCount`;
- a call is reserved when the `running` transition is atomically persisted;
- a crash or executor exception therefore cannot make a reserved call free;
- a retry is an additional attempt after the initial attempt;
- an exhausted global call budget prevents another dispatch.

Token, cost, aggregate budget, and no-progress-loop enforcement are Phase 18
work.

## Failure and Persistence Rules

State transitions and their events are committed together through
`SchedulerRunStore.save()`, which preserves the existing `FileRunStore`
state-version check and atomic publication.

The scheduler never retries a stale save or invokes an executor after a failed
dispatch commit. A persistence error after executor invocation is surfaced
without re-invoking the executor; the durable state may remain `running` and
requires Phase 19 recovery.

Failure is fail-fast. Independent nodes are left pending when another node
fails unsafely or exhausts its retry budget. The scheduler does not create
blocked descendants or automatically unblock externally blocked nodes in this
phase.

## Event Sequence

The scheduler uses the existing event vocabulary:

```text
factory_run_started
node_ready
node_started
node_completed
node_failed
node_retried
factory_run_completed
factory_run_failed
```

The event log remains append-only and state snapshots remain authoritative.

## Verification

Scheduler unit tests cover deterministic selection, dependency ordering,
serial execution, call and retry budgets, trusted retry safety, malformed
outcomes, executor exceptions, fail-fast behavior, and recovery-required state.

Persistence integration tests cover atomic dispatch publication, prevention of
execution after a failed commit, final state reload, state versions, and event
sequence preservation.

The complete Phase 4 gate is:

```text
pnpm typecheck
pnpm test
```
