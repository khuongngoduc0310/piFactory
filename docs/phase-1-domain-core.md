# Phase 1 Domain Core Developer Guide

## Purpose

Phase 1 implements piFactory's deterministic domain kernel. It defines the
durable workflow values, legal state transitions, graph invariants, and runtime
validation that later phases will persist and orchestrate.

Phase 1 answers questions such as:

- What state must a unit of work retain?
- Which WorkNode and FactoryRun transitions are legal?
- When are dependencies ready or blocked?
- Is a proposed workflow a valid directed acyclic graph (DAG)?
- Can reconstructed state be trusted by the rest of the application?

It does not run agents, access repositories, persist state, or schedule work.
Those responsibilities remain in later phases. See
[Architecture](./architecture.md) for the accepted system-wide design and
phase boundaries.

## Domain Map

```text
FactoryRun
├── request, tier, status, budget, timestamps
└── WorkGraph
    ├── WorkNode A
    ├── WorkNode B (depends on A)
    └── WorkNode C (depends on B)

WorkNode ── references ──> Artifact IDs
```

A `FactoryRun` represents one complete user request. Its `WorkGraph` contains
durable `WorkNode` values. A WorkNode represents logical work, not an agent
session. Disposable agent attempts will eventually operate on WorkNodes, while
Artifacts carry durable conclusions and evidence between attempts.

Created Artifacts, WorkNodes, WorkGraphs, and FactoryRuns are immutable.
Commands return new values instead of modifying their inputs.

## Quick Start

The following example exercises the primary Phase 1 lifecycle. It assumes the
example file is at the repository root.

```ts
import {
  completeFactoryRun,
  createArtifact,
  createFactoryRun,
  createWorkGraph,
  createWorkNode,
  markNodeCompleted,
  markNodeReady,
  markNodeRunning,
  startFactoryRun,
  updateRunGraph,
} from "./src/domain/index.js";

const t0 = "2026-08-25T10:00:00.000Z";
const t1 = "2026-08-25T10:01:00.000Z";
const t2 = "2026-08-25T10:02:00.000Z";
const t3 = "2026-08-25T10:03:00.000Z";
const t4 = "2026-08-25T10:04:00.000Z";
const t5 = "2026-08-25T10:05:00.000Z";

const buildNode = createWorkNode(
  {
    id: "build-auth",
    objective: "Implement authentication",
    role: "builder",
    builderMode: "implement",
    dependsOn: [],
    scope: {
      relevantPaths: ["src/auth"],
      allowedMutationPaths: ["src/auth"],
    },
    acceptanceCriteria: ["Authentication tests pass"],
    risk: "medium",
    complexity: "medium",
    parallelSafe: false,
  },
  t0,
);

let graph = createWorkGraph([buildNode]);

let run = createFactoryRun({
  id: "run-1",
  request: "Implement authentication",
  tier: "fast",
  graph,
  budget: {
    maxParallelAgents: 1,
    maxAgentCalls: 1,
    maxRetriesPerNode: 0,
  },
  createdAt: t0,
});

run = startFactoryRun(run, t1);
graph = markNodeReady(graph, "build-auth", t2);
graph = markNodeRunning(graph, "build-auth", t3);

const artifact = createArtifact({
  id: "artifact-auth-implementation",
  type: "implementation",
  workNodeId: "build-auth",
  summary: "Authentication implementation completed",
  facts: ["Targeted authentication tests passed"],
  assumptions: [],
  unresolvedQuestions: [],
  evidenceRefs: ["test:auth"],
  changedFiles: ["src/auth/index.ts"],
  digest: "opaque-phase-1-digest",
});

graph = markNodeCompleted(graph, "build-auth", t4, {
  artifactRefs: [artifact.id],
  outputDigest: artifact.digest,
});

run = updateRunGraph(run, graph, t4);
run = completeFactoryRun(run, t5);

console.log(run.status); // completed
```

The Artifact digest is opaque in Phase 1. Canonical SHA-256 calculation begins
in Phase 3. Artifact persistence begins in a later phase.

## WorkNode

[`src/domain/work-node.ts`](../src/domain/work-node.ts) defines the durable unit
of logical work.

### Durable State

| Category | Fields |
| --- | --- |
| Identity | `id`, `objective` |
| Assignment | `role`, `builderMode` |
| Workflow | `status`, `dependsOn`, `parallelSafe` |
| Authority declaration | `scope` |
| Acceptance | `acceptanceCriteria` |
| Classification | `risk`, `complexity` |
| Reuse metadata | `inputDigest`, `outputDigest` |
| Results | `artifactRefs` |
| Recovery | `retryCount`, `failure`, `executionHistory` |

Roles are `planner`, `builder`, and `reviewer`. Builder nodes must declare one
of these modes:

```text
implement | debug | test | integrate | document
```

Phase 1 defines these modes as domain vocabulary. Only `implement` participates
in the planned first vertical slice; executable support for the other modes is
scheduled for Phase 8.

### State Machine

```text
pending ─────────> ready ─────────> running ─────────> completed
   │                  │                 │
   │                  │                 ├─────────────> failed
   │                  │                 │                  │
   └────> blocked <───┘                 └──> waiting_human │
              │                                  │         │
              └────> pending                     └──> ready│
                                                           │
                                             retry ────────┘
```

Allowed transitions are:

| From | To |
| --- | --- |
| `pending` | `ready`, `blocked` |
| `ready` | `running`, `blocked` |
| `running` | `waiting_human`, `completed`, `failed` |
| `waiting_human` | `ready` |
| `failed` | `ready` through the retry operation |
| `blocked` | `pending` through the unblock operation |
| `completed` | No transitions; terminal |

Every successful transition appends an immutable execution-history entry.
Failures, blockers, human waits, retries, unblocks, and returns from human input
retain reasons. Retry is a distinct operation so callers cannot move
`failed -> ready` without incrementing `retryCount`.

### Public Operations

```ts
createWorkNode(input, at)
validateWorkNode(value)
snapshotWorkNode(node)
canTransitionWorkNode(from, to)
markWorkNodeReady(node, at, reason?)
markWorkNodeRunning(node, at)
markWorkNodeWaitingHuman(node, at, reason)
markWorkNodeCompleted(node, at, completion?)
markWorkNodeFailed(node, at, reason)
markWorkNodeBlocked(node, at, reason)
retryWorkNode(node, at, reason)
unblockWorkNode(node, at, reason)
```

`validateWorkNode` accepts `unknown` so reconstructed JSON or other untrusted
input can be checked before it enters the domain. It validates field shapes,
role and mode combinations, classifications, history transitions, retry
accounting, timestamps, and failure consistency.

`snapshotWorkNode` validates a complete WorkNode and returns a defensive frozen
copy suitable for inclusion in a graph.

## WorkGraph

[`src/domain/work-graph.ts`](../src/domain/work-graph.ts) is an immutable,
serializable DAG of WorkNodes. Dependency edges exist only in
`WorkNode.dependsOn`, avoiding a second edge store that could diverge.

### Construction Commands

```ts
createWorkGraph(nodes?)
addNode(graph, node)
addDependency(graph, nodeId, dependencyId)
```

Nodes are stored in deterministic ID order. `addNode` accepts pending nodes, and
`addDependency` accepts only a pending dependent node. Invalid commands throw a
typed `DomainError`.

### Queries

```ts
getNode(graph, nodeId)
getReadyNodes(graph)
getBlockedNodes(graph)
getDependents(graph, nodeId)
getDependents(graph, nodeId, { transitive: true })
```

`getReadyNodes` returns pending or ready nodes whose dependencies are complete.
It does not change node status. A future scheduler will query candidates and
then explicitly authorize `markNodeReady`.

`getBlockedNodes` returns explicitly blocked nodes and pending or ready nodes
whose dependencies have failed or become blocked.

`getDependents` returns direct dependents by default. The transitive option
returns every downstream dependent.

### State Commands

```ts
markNodeReady(graph, nodeId, at, reason?)
markNodeRunning(graph, nodeId, at)
markNodeWaitingHuman(graph, nodeId, at, reason)
markNodeCompleted(graph, nodeId, at, completion?)
markNodeFailed(graph, nodeId, at, reason)
markNodeBlocked(graph, nodeId, at, reason)
retryNode(graph, nodeId, at, reason)
unblockNode(graph, nodeId, at, reason)
```

These operations combine WorkNode state rules with graph-level dependency
preconditions. Each returns a new WorkGraph; previous graph versions remain
unchanged.

### DAG Validation

```ts
validateDependencies(nodes)
detectCycles(nodes)
```

Validation reports structured issues for:

- invalid WorkNode snapshots;
- duplicate node IDs;
- duplicate dependency edges;
- self-dependencies;
- missing dependencies;
- cycles;
- active or historically ready nodes with incomplete dependencies;
- nodes that became ready before a dependency's recorded completion time.

The temporal check is significant for reconstructed state. If B depends on A,
this history is invalid even when both nodes currently look complete:

```text
10:03  B became ready
10:04  A completed
```

`createWorkGraph` rejects any validation issue. It does not construct a
partially trusted graph.

## FactoryRun

[`src/domain/factory-run.ts`](../src/domain/factory-run.ts) represents one user
request and owns the current immutable WorkGraph snapshot.

### Durable State

```ts
interface FactoryRun {
  readonly id: string;
  readonly request: string;
  readonly tier: "fast" | "standard" | "deep";
  readonly status: FactoryRunStatus;
  readonly graph: WorkGraph;
  readonly budget: ExecutionBudget;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failure?: FailureInfo;
}
```

Budgets are durable input in Phase 1, but consumption and enforcement belong to
the sequential scheduler in Phase 4.

### State Machine

```text
created ─────> running ─────> completed
   │              │
   │              ├────────> failed
   │              ├────────> cancelled
   │              └────────> waiting_human ─────> running
   │                                     ├──────> failed
   └────────────> cancelled              └──────> cancelled
```

`completed`, `failed`, and `cancelled` are terminal. Completion requires a
non-empty graph in which every WorkNode is completed.

### Public Operations

```ts
createFactoryRun(input)
canTransitionFactoryRun(from, to)
startFactoryRun(run, at)
markFactoryRunWaitingHuman(run, at)
resumeFactoryRun(run, at)
completeFactoryRun(run, at)
failFactoryRun(run, at, reason)
cancelFactoryRun(run, at)
updateRunGraph(run, graph, at)
```

Because both FactoryRun and WorkGraph are immutable, graph commands do not
silently mutate the run. `updateRunGraph` explicitly installs a validated graph
snapshot and advances `updatedAt`. Terminal runs reject graph replacement.

## Artifacts

[`src/domain/artifact.ts`](../src/domain/artifact.ts) defines immutable durable
conclusions and evidence.

Supported types are:

```text
plan | exploration | implementation | diagnosis | test
integration | review | baseline | human_decision
```

An Artifact contains a summary, facts, assumptions, unresolved questions,
evidence references, optional changed files, and a digest. It must not contain
hidden chain-of-thought.

`createArtifact` validates runtime vocabulary and required strings, freezes all
collections, and creates a defensive copy. WorkNodes retain Artifact IDs rather
than embedding Artifact objects.

Phase 1 does not independently attest `changedFiles`, compute the digest, or
persist the Artifact. Those trust boundaries are deliberately left to later
phases.

## Validation and Errors

[`src/domain/domain-error.ts`](../src/domain/domain-error.ts) defines
`DomainError` and stable error categories such as:

```text
invalid_argument
invalid_state_transition
invalid_graph
node_not_found
dependency_not_completed
run_incomplete
```

TypeScript types protect ordinary application code during compilation, but
types are erased from the emitted JavaScript. Persisted JSON, JavaScript
callers, type assertions, and future agent output can therefore contain values
that violate TypeScript declarations.

Phase 1 validates both at construction and reconstruction boundaries:

```text
External or persisted input
        ↓
Unknown and untrusted
        ↓
Runtime validation
        ↓
Frozen domain value
        ↓
Trusted internal operations
```

[`src/domain/validation.ts`](../src/domain/validation.ts) centralizes primitive
checks and defensive collection copying. Timestamps use canonical UTC ISO-8601
format with milliseconds:

```text
2026-08-25T10:00:00.000Z
```

Transitions reject timestamps that move backwards.

## Determinism and Immutability

Phase 1 keeps nondeterminism outside the domain:

- callers provide IDs and timestamps;
- no module reads the system clock;
- no module accesses the filesystem or network;
- commands return new frozen values;
- set-like collections are normalized and sorted;
- graph nodes and query results use deterministic ordering;
- validation rejects inconsistent reconstructed state.

This design provides stable inputs for persistence, event replay, crash
recovery, and result reuse in later phases.

## Testing

Phase 1 has four Vitest suites under [`test/domain`](../test/domain):

| Suite | Coverage focus |
| --- | --- |
| `artifact.test.ts` | Artifact validation and defensive immutability |
| `work-node.test.ts` | Construction, all transition pairs, retries, history, timestamps |
| `work-graph.test.ts` | DAG operations, dependencies, cycles, reconstruction, temporal order |
| `factory-run.test.ts` | Budgets, run transitions, graph replacement, completion guards |

The verified Phase 1 baseline is 58 passing unit tests plus strict TypeScript
checking:

```text
pnpm typecheck
pnpm test
```

## Phase Boundaries

Phase 1 intentionally does not implement:

| Deferred capability | Planned phase |
| --- | --- |
| Run storage, event log, atomic writes, reload | Phase 2 |
| SHA-256 calculation, workspace snapshots, path and mutation enforcement | Phase 3 |
| Sequential scheduling, budget enforcement, retry policy | Phase 4 |
| Builder and first LLM integration | Phase 5 |
| FAST end-to-end vertical slice | Phase 6 |
| Artifact Store and durable TaskPacket context | Phase 7 |
| Executable Builder modes beyond the initial path | Phase 8 |
| Planner, parallelism, worktrees, review, recovery, observability | Later phases |

Scope fields, budget values, digest strings, Builder modes, and Artifact types
appear in Phase 1 because they are part of durable domain contracts. Their
runtime behavior is implemented only in their authorized phases.

## Source Map

| File | Responsibility |
| --- | --- |
| [`artifact.ts`](../src/domain/artifact.ts) | Artifact vocabulary and immutable construction |
| [`domain-error.ts`](../src/domain/domain-error.ts) | Typed domain failure categories |
| [`factory-run.ts`](../src/domain/factory-run.ts) | FactoryRun aggregate and state machine |
| [`work-node.ts`](../src/domain/work-node.ts) | WorkNode model, validation, history, transitions |
| [`work-graph.ts`](../src/domain/work-graph.ts) | DAG validation, queries, and graph commands |
| [`validation.ts`](../src/domain/validation.ts) | Shared primitive and timestamp validation |
| [`index.ts`](../src/domain/index.ts) | Public Phase 1 domain exports |

Progress is recorded in [`TODO.md`](../TODO.md). Phase 1 is complete; Phase 2
remains unstarted until explicitly authorized.
