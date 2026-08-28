# Phase 4 Sequential Scheduler: Implementation Deep Dive

## Who This Is For

This document explains the Phase 4 scheduler for developers who understand basic
TypeScript but are new to durable workflow orchestration. The formal contract is
in [`phase-4-sequential-scheduler.md`](./phase-4-sequential-scheduler.md). If
this document and the formal contract appear to disagree, the formal contract
and source code are authoritative.

## What Phase 4 Does

Phase 4 adds the first application-layer control loop for piFactory. It takes an
already-created `FactoryRun` and deterministically:

- finds WorkNodes whose dependencies are complete;
- selects one node at a time;
- records durable state before and after execution;
- enforces call and retry limits;
- retries only when a trusted policy says repetition is safe; and
- completes or fails the run without asking an agent to control workflow state.

The scheduler is application code. It does not make an LLM the orchestrator.

## What Phase 4 Does Not Do

Phase 4 does not:

- call an LLM or provide a real Builder;
- mutate a workspace or inspect workspace deltas;
- run targeted checks;
- create or persist artifacts;
- execute Planner, Reviewer, or non-`implement` Builder modes;
- account for tokens or cost;
- run multiple workers in parallel;
- create worktrees;
- recover interrupted execution;
- create leases or coordinate multiple processes; or
- roll back partial workspace mutations.

The partial-mutation recovery decision must be made before Phase 5 enables real
workspace mutation. See the [Phase 5 gate in TODO.md](../TODO.md#implementation-phases).

## The Mental Model

Think of the scheduler as a durable state machine around a disposable executor:

```text
created FactoryRun
        |
        v
validate fresh input
        |
        v
persist run started
        |
        v
select dependency-ready WorkNode
        |
        v
persist node ready
        |
        v
persist node running and reserve call
        |
        v
invoke injected executor
        |
        +--> succeeded --> persist node completed
        |                         |
        |                         +--> all complete --> persist run completed
        |
        +--> failed --> persist node failed
                              |
                              +--> trusted safe + budget --> retry
                              |
                              +--> unsafe or exhausted --> fail run
```

The executor never receives graph mutation methods or persistence authority. It
returns a recommendation about the attempt. The scheduler decides what that
recommendation means for durable workflow state.

## Package Map

| Module | Responsibility |
| --- | --- |
| [`sequential-scheduler.ts`](../src/scheduler/sequential-scheduler.ts) | Orchestrates run and node transitions, executor dispatch, and terminal outcomes |
| [`execution-policy.ts`](../src/scheduler/execution-policy.ts) | Selects the next node and defines deterministic ordering |
| [`budgets.ts`](../src/scheduler/budgets.ts) | Derives calls and retries from durable graph history |
| [`scheduler-error.ts`](../src/scheduler/scheduler-error.ts) | Defines preflight scheduler errors |
| [`index.ts`](../src/scheduler/index.ts) | Exposes the scheduler API |

The scheduler uses the immutable domain operations in
[`work-graph.ts`](../src/domain/work-graph.ts) and
[`factory-run.ts`](../src/domain/factory-run.ts). It uses the narrow save
contract provided by [`FileRunStore`](../src/persistence/run-store.ts).

## 1. Injected Boundaries

### Store

The scheduler needs only an atomic save operation:

```ts
interface SchedulerRunStore {
  save(
    run: FactoryRun,
    expectedStateVersion: number,
    newEvents?: readonly NewRunEvent[],
  ): Promise<LoadedRun>;
}
```

`FileRunStore.save()` validates the run, appends events, publishes the complete
saved state atomically, and returns the new state version. The scheduler must
always continue with that returned `LoadedRun`.

There is no separate scheduler-state file, event writer, or budget writer. The
run, graph, events, and version advance together.

### Executor

Phase 4 uses a minimal executor seam:

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
  | { readonly kind: "failed"; readonly reason: string };
```

The result is checked at runtime even though TypeScript describes its type. A
malformed result is treated as a failure, never as success.

### Retry Safety

The executor cannot authorize its own retry. A separate trusted policy receives
the failed node and normalized reason:

```ts
interface RetrySafetyPolicy {
  isSafeToRetry(input: {
    readonly node: WorkNode;
    readonly reason: string;
  }): boolean;
}
```

This separation is important. An agent or provider may report that an attempt
failed, but piFactory must independently decide whether repeating it is safe.
The Phase 4 tests inject a deterministic policy. Phase 5 must connect this
decision to actual mutation and execution evidence.

### Time and Event IDs

The scheduler receives `now()` and `nextEventId()` functions. The domain does not
read the system clock, and the persistence layer assigns event sequence numbers
but does not create event IDs. Tests therefore control both values explicitly.

Production clocks must return canonical UTC ISO-8601 timestamps that do not move
backward. Event IDs must be unique within the run.

## 2. Accepted Input

The scheduler intentionally accepts a narrow input until reuse and recovery are
implemented:

| Input | Result |
| --- | --- |
| `created` run with one or more pending Builder/`implement` nodes | Accepted |
| Empty graph | `unsupported_run_state`, unchanged |
| Ready, failed, blocked, waiting, running, or completed node | `unsupported_run_state`, unchanged |
| Previous execution history or retry count | `unsupported_run_state`, unchanged |
| Planner, Reviewer, or other Builder mode | `unsupported_run_state`, unchanged |
| `maxTokens` or `maxCostUsd` | `unsupported_budget`, unchanged |
| Already-running run | `recovery_required`, unchanged |
| Failed or cancelled run | Unsupported terminal state |

Rejecting non-pristine input prevents Phase 4 from accidentally implementing
completed-work reuse or crash recovery. Those policies require their own
durability and idempotency contracts.

## 3. Deterministic Selection

`getReadyNodes()` is the domain source of truth for dependency readiness. It
returns pending or ready nodes whose dependencies are completed.

The execution policy then applies two deterministic rules:

1. A node already in `ready` state has priority over a pending node. This makes
   a permitted retry take priority over new work.
2. Nodes within the same state are ordered by ID using UTF-16 code-unit order.

For this graph:

```text
       a
      / \
     b   c
      \ /
       d
```

The execution order is `a`, then `b` or `c` by ID, then `d`. `d` cannot become
ready until both predecessors are completed.

The scheduler never uses `parallelSafe` to start concurrent work in Phase 4.
That field is reserved for the later parallel scheduler.

## 4. Commit Before Dispatch

The `running` transition is a durable reservation, not merely an in-memory
flag. A one-node run with no initial events has this progression:

| State version | Durable state | Event |
| ---: | --- | --- |
| 1 | Run created, node pending | Initial saved state |
| 2 | Run running, node pending | `factory_run_started` |
| 3 | Run running, node ready | `node_ready` |
| 4 | Run running, node running | `node_started` |
| 5 | Run running, node completed | `node_completed` |
| 6 | Run completed, node completed | `factory_run_completed` |

The executor is called only after version 4 is current. This ordering gives the
scheduler an authoritative record that the attempt was authorized and charges
the call even if execution later throws or the process stops.

The outcome is committed after execution. If that save fails, the current saved
state remains the running state and the scheduler must not invoke the executor
again automatically.

## 5. Budget Accounting

Phase 4 does not add a mutable usage ledger. It derives usage from the immutable
graph:

```ts
executorCalls = count of execution-history entries with status "running"
retries       = sum of WorkNode.retryCount values
```

Consequences:

- the call reservation survives reload;
- an uncertain or interrupted dispatch remains charged;
- `maxAgentCalls` applies across the whole run;
- `maxRetriesPerNode` applies independently to each node; and
- `maxParallelAgents` does not raise the Phase 4 capacity above one.

For example, with `maxAgentCalls: 2` and `maxRetriesPerNode: 1`, one initial
attempt and one retry are possible. A third dispatch is rejected even if the
node retry limit has not been reached.

Token, cost, aggregate budgets, and no-progress-loop detection require additional
usage data and belong to Phase 18.

## 6. Success, Failure, and Retry

### Success

The scheduler applies `running -> completed` and persists `node_completed`. If
all graph nodes are then completed, it applies `running -> completed` to the
FactoryRun and persists `factory_run_completed`.

### Safe failure

The scheduler first persists `running -> failed` with `node_failed`. It then
asks `RetrySafetyPolicy` whether the failure is safe to repeat. If the answer is
yes and both budgets permit another attempt, it applies `failed -> ready` through
`retryNode()` and persists `node_retried`.

The retry increments `retryCount` and preserves the original failure in
execution history. The ready node is selected before new pending work.

### Unsafe or exhausted failure

An unsafe failure, an exhausted retry budget, or an exhausted global call budget
causes fail-fast behavior:

```text
persist node_failed
        |
        v
persist factory_run_failed
```

Independent nodes remain pending. The scheduler does not spend more calls after
the run has an unrecoverable failure.

## 7. Persistence Failure Matrix

| Failure point | Current durable state | Executor behavior |
| --- | --- | --- |
| Run-start save | Run remains `created` | Not called |
| Ready save | Run is `running`, node remains `pending` | Not called |
| Running save | Run is `running`, node remains `ready` | Not called |
| Executor throws | Node is still `running` until failure save | Failure is normalized |
| Outcome save | Node may remain `running` | Never re-invoked automatically |
| Stale state version | Newer state remains authoritative | Stop without retrying stale state |
| Existing `running` input | State remains unchanged | Return `recovery_required` |

The scheduler does not retry a failed persistence operation with the same
executor call. A pointer publication failure can be ambiguous, so the safe
response is to stop and require later recovery logic.

## 8. Recovery Boundary

The dangerous window is between durable dispatch and durable outcome:

```text
node_started committed
        |
        +--> process stops before executor starts
        |
        +--> executor starts and partially acts
        |
        +--> executor completes but outcome save fails
```

Phase 4 cannot distinguish these cases. It therefore leaves `running` state
unchanged and returns `recovery_required` when that state is encountered. Phase
19 will add leases, checkpoints, and an explicit recovery policy.

## 9. Partial Mutation Boundary

Phase 4 does not mutate a workspace, so it cannot roll back one. Phase 3
snapshots can attest final added, modified, and deleted paths, but they do not
retain original file contents and are not a restoration mechanism.

Before Phase 5 enables a real Builder, choose and document one of these policies:

1. Preserve the failed workspace and evidence for human inspection.
2. Execute mutations in an isolated Git worktree and discard failed work.
3. Capture original bytes and metadata and restore transactionally.

Until that decision exists, a possibly partially mutating attempt must be
classified as unsafe to retry. The reminder is tracked in
[`TODO.md`](../TODO.md).

## 10. Public API Walkthrough

The following example uses a deterministic executor rather than an LLM:

```ts
import {
  createFactoryRun,
  createWorkGraph,
  createWorkNode,
} from "../src/domain/index.js";
import { FileRunStore } from "../src/persistence/index.js";
import {
  executeCreatedRun,
  type RetrySafetyPolicy,
  type SequentialNodeExecutor,
} from "../src/scheduler/index.js";

const createdAt = "2026-08-25T10:00:00.000Z";
const node = createWorkNode(
  {
    id: "build",
    objective: "Implement the requested change",
    role: "builder",
    builderMode: "implement",
    dependsOn: [],
    scope: {},
    acceptanceCriteria: ["The change is complete"],
    risk: "low",
    complexity: "small",
    parallelSafe: false,
  },
  createdAt,
);
const run = createFactoryRun({
  id: "run-1",
  request: "Implement the requested change",
  tier: "fast",
  graph: createWorkGraph([node]),
  budget: {
    maxParallelAgents: 1,
    maxAgentCalls: 1,
    maxRetriesPerNode: 0,
  },
  createdAt,
});

const store = new FileRunStore({ storageRoot: ".pifactory" });
const loaded = await store.create(run);
const executor: SequentialNodeExecutor = {
  execute: async () => ({ kind: "succeeded" }),
};
const retrySafety: RetrySafetyPolicy = {
  isSafeToRetry: () => false,
};

const result = await executeCreatedRun(loaded, {
  store,
  executor,
  retrySafety,
  now: () => new Date().toISOString(),
  nextEventId: (() => {
    let sequence = 0;
    return () => `event-${++sequence}`;
  })(),
});

console.log(result.status); // completed
console.log(result.loaded.run.graph.nodes[0]?.status); // completed
```

The real Phase 5 adapter will replace the fake executor and will not be allowed
to report success until its own workspace, validation, and result-acceptance
steps have completed.

## 11. Result and Error Handling

`executeCreatedRun()` returns one of three result statuses:

| Status | Meaning |
| --- | --- |
| `completed` | Every WorkNode and the FactoryRun completed |
| `failed` | The scheduler persisted a terminal FactoryRun failure |
| `recovery_required` | An existing running state needs later recovery |

`SchedulerError` is used for unsupported input that remains unchanged, such as
an empty graph or unsupported budget dimension. A persisted `failed` result is
used when scheduling began but work could not safely finish.

Persistence errors are propagated. They are not converted into executor retries.

## 12. Event History

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

Events are appended through the same `FileRunStore.save()` call as their state
transition. Event sequences are assigned by persistence; event IDs and event
timestamps come from the scheduler's injected providers.

Snapshots remain authoritative. The scheduler does not replay events to rebuild
the graph.

## 13. Testing Map

| Requirement | Test |
| --- | --- |
| Deterministic node selection | [`execution-policy.test.ts`](../test/scheduler/execution-policy.test.ts) |
| Durable call and retry accounting | [`budgets.test.ts`](../test/scheduler/budgets.test.ts) |
| Dependency ordering and completion | [`sequential-scheduler.test.ts`](../test/scheduler/sequential-scheduler.test.ts) |
| Safe retry and retry exhaustion | [`sequential-scheduler.test.ts`](../test/scheduler/sequential-scheduler.test.ts) |
| Serial executor behavior | [`sequential-scheduler.test.ts`](../test/scheduler/sequential-scheduler.test.ts) |
| Unsupported and recovery input | [`sequential-scheduler.test.ts`](../test/scheduler/sequential-scheduler.test.ts) |
| Atomic dispatch publication | [`sequential-scheduler.integration.test.ts`](../test/scheduler/sequential-scheduler.integration.test.ts) |
| Outcome publication failure | [`sequential-scheduler.integration.test.ts`](../test/scheduler/sequential-scheduler.integration.test.ts) |
| Final reload and event sequence | [`sequential-scheduler.integration.test.ts`](../test/scheduler/sequential-scheduler.integration.test.ts) |
| Headerless event rejection | [`event-log.test.ts`](../test/persistence/event-log.test.ts) |

Run the complete verification suite from the repository root:

```text
pnpm typecheck
pnpm test
```

## 14. Troubleshooting

### `unsupported_run_state`

The input is not a fresh Phase 4 run. Inspect the run status and every node's
status, history, role, and Builder mode. Do not reset the state manually;
completed-work reuse and recovery are later-phase policies.

### `unsupported_budget`

The run declares token or cost limits, but Phase 4 cannot measure provider usage.
Use only call and retry limits until Phase 18 adds usage accounting.

### `recovery_required`

The saved run contains an in-progress execution. Phase 4 cannot determine
whether that executor started, partially acted, or completed. Leave the state
unchanged and use the future Phase 19 recovery process.

### The executor was not called

Confirm that the run-start, node-ready, and node-running saves succeeded. The
scheduler deliberately refuses to invoke work until the running state is
current.

### The run is failed but another node is pending

This is expected fail-fast behavior after an unsafe or exhausted failure. The
pending node was not executed after the run became unsafe to continue.

## Phase 5 Handoff

Phase 5 can provide a Builder adapter at the existing executor seam. Before that
adapter is enabled, it must define:

- how workspace snapshots surround execution;
- how actual deltas are assessed against mutation scopes;
- how targeted checks affect success;
- how implementation artifacts are persisted; and
- how partial mutations are preserved, isolated, or restored.

The Phase 4 scheduler intentionally does not answer those questions.

## Glossary

| Term | Meaning |
| --- | --- |
| Attempt | One executor invocation for a WorkNode |
| Dispatch | Authorization represented by persisting `node_started` |
| Reserved call | An agent call charged when `node_started` becomes current |
| Retry | A later attempt created through `retryNode()` |
| Retry safety policy | Trusted application decision about whether repetition is safe |
| Current saved state | The state selected by the persistence `current.json` pointer |
| Recovery required | Durable execution state is ambiguous and must not be re-invoked |
