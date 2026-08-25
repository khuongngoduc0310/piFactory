# piFactory Architecture

## Status and Scope

This document records the accepted architecture for the initial piFactory
implementation. The current implementation scope is Phase 1: Domain Core.
Later-phase sections define contracts and boundaries only; they do not authorize
implementation of persistence, schedulers, agents, workspace mutation,
parallelism, worktrees, runtime orchestration, or a user interface.

The domain core is deterministic. Identifiers, timestamps, filesystem state,
and other nondeterministic inputs are supplied by callers.
Timestamps use canonical UTC ISO-8601 form with milliseconds, such as
`2026-08-25T10:00:00.000Z`.

## 1. Proposed Directory Tree

```text
src/
  domain/
    artifact.ts
    domain-error.ts
    factory-run.ts
    index.ts
    validation.ts
    work-graph.ts
    work-node.ts
  scheduler/                 # Phase 4+
  agents/                    # Phase 5+
  context/                   # Phase 7+
  workspace/                 # Phase 3+
  persistence/               # Phase 2+
  validation/                # Phase 5+
  decisions/                 # Phase 17+
  runtime/                   # Phase 4+
  ui/                        # Phase 20+
test/
  domain/
    artifact.test.ts
    factory-run.test.ts
    work-graph.test.ts
    work-node.test.ts
```

Only `src/domain` and `test/domain` are created in Phase 1. Domain values use
readonly properties and frozen collections. Domain operations return new values
instead of mutating existing ones. This keeps persistence and replay possible
without coupling the domain to a storage mechanism.

## 2. FactoryRun Interface

```ts
type ExecutionTier = "fast" | "standard" | "deep";

type FactoryRunStatus =
  | "created"
  | "running"
  | "waiting_human"
  | "completed"
  | "failed"
  | "cancelled";

interface ExecutionBudget {
  readonly maxParallelAgents: number;
  readonly maxAgentCalls: number;
  readonly maxRetriesPerNode: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
}

interface FactoryRun {
  readonly id: string;
  readonly request: string;
  readonly tier: ExecutionTier;
  readonly status: FactoryRunStatus;
  readonly graph: WorkGraph;
  readonly budget: ExecutionBudget;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failure?: FailureInfo;
}
```

FactoryRun construction validates non-empty identifiers and requests, a valid
ISO-8601 timestamp, a valid graph, and non-negative or positive budget limits
as appropriate. Phase 1 exposes pure functions to start, wait, resume, complete,
fail, and cancel a run. A run can complete only when its graph is non-empty and
every node is completed. Run timestamps cannot move backwards.

`updateRunGraph(run, graph, at)` replaces the immutable graph and advances
`updatedAt` while a run is created, running, or waiting for a human. It rejects
invalid graphs and terminal runs. This is the only way Phase 1 reflects graph
commands in the owning FactoryRun.

Execution budgets are stored in Phase 1 because they are durable FactoryRun
input. `maxParallelAgents` must be a positive integer. `maxAgentCalls` and
`maxRetriesPerNode` must be non-negative integers. Optional `maxTokens` must be
a non-negative integer and optional `maxCostUsd` must be finite and
non-negative. Zero means no allowance. Budget consumption and enforcement
belong to Phase 4.

## 3. WorkNode Interface

```ts
type AgentRole = "planner" | "builder" | "reviewer";

type BuilderMode =
  | "implement"
  | "debug"
  | "test"
  | "integrate"
  | "document";

type WorkNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "waiting_human"
  | "completed"
  | "failed";

interface WorkScope {
  readonly relevantPaths?: readonly string[];
  readonly allowedMutationPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly subsystems?: readonly string[];
}

interface FailureInfo {
  readonly reason: string;
  readonly at: string;
}

interface WorkNodeHistoryEntry {
  readonly status: WorkNodeStatus;
  readonly at: string;
  readonly reason?: string;
}

interface WorkNode {
  readonly id: string;
  readonly objective: string;
  readonly role: AgentRole;
  readonly builderMode?: BuilderMode;
  readonly status: WorkNodeStatus;
  readonly dependsOn: readonly string[];
  readonly scope: WorkScope;
  readonly acceptanceCriteria: readonly string[];
  readonly risk: "low" | "medium" | "high";
  readonly complexity: "small" | "medium" | "large";
  readonly parallelSafe: boolean;
  readonly inputDigest?: string;
  readonly outputDigest?: string;
  readonly artifactRefs: readonly string[];
  readonly retryCount: number;
  readonly failure?: FailureInfo;
  readonly executionHistory: readonly WorkNodeHistoryEntry[];
}
```

A builder node must declare a Builder mode. Planner and Reviewer nodes must not
declare one. IDs, objectives, acceptance criteria, references, and history are
durable logical-work state; no agent session identity is stored. Dependency IDs
are unique and sorted. Retry increments are explicit and never inferred from an
agent response.

Phase 1 defines Builder modes as domain vocabulary because WorkNode and
RoleResult contracts refer to them. Phase 8 adds executable behavior for the
`debug`, `test`, `integrate`, and `document` modes; Phase 1 does not implement
those workers.

Phase 1 scope strings are domain data, not proof that paths are safe. Path and
mutation-scope security is implemented in Phase 3.

## 4. WorkGraph API

`WorkGraph` is a frozen, serializable collection of WorkNodes sorted by ID.
Dependency edges are represented only by each node's `dependsOn`; there is no
second edge store that could diverge.

Phase 1 provides these pure operations:

```ts
createWorkGraph(nodes?)
addNode(graph, node)
addDependency(graph, nodeId, dependencyId)
getNode(graph, nodeId)
getReadyNodes(graph)
getBlockedNodes(graph)
getDependents(graph, nodeId, { transitive? })
markNodeReady(graph, nodeId, at, reason?)
markNodeRunning(graph, nodeId, at)
markNodeWaitingHuman(graph, nodeId, at, reason)
markNodeCompleted(graph, nodeId, at, { artifactRefs?, outputDigest? }?)
markNodeFailed(graph, nodeId, at, reason)
markNodeBlocked(graph, nodeId, at, reason)
retryNode(graph, nodeId, at, reason)
unblockNode(graph, nodeId, at, reason)
validateDependencies(nodes)
detectCycles(nodes)
```

Commands fail closed with a typed `DomainError`. Validation of reconstructed or
untrusted node collections returns all detectable structured issues so callers
can reject the collection with actionable diagnostics.

`getReadyNodes` returns pending or ready nodes whose dependencies are all
completed. `getBlockedNodes` returns explicitly blocked nodes and pending or
ready nodes with a failed or blocked dependency. Results are sorted by node ID.
The queries do not alter statuses; a future scheduler explicitly records ready
or blocked transitions before execution.

`markNodeRunning` requires a ready node and completed dependencies. Graph
commands reject missing nodes, duplicate nodes or edges, self-dependencies,
missing dependency targets, cycles, and dependency-inconsistent transitions.
Dependency validation includes history ordering: every transition into `ready`
must be at or after each dependency's recorded completion.
`addNode` accepts only a pending node, and `addDependency` accepts only a pending
dependent node. Dependencies cannot be retrofitted onto ready, active, or
terminal work. Bulk reconstruction uses `createWorkGraph`, which validates each
complete WorkNode snapshot, including state history and failure invariants, as
well as the complete graph rather than replaying graph-building commands.

## 5. WorkNode State Machine

Allowed transitions are:

```text
pending       -> ready
pending       -> blocked
ready         -> running
ready         -> blocked
running       -> waiting_human
running       -> completed
running       -> failed
waiting_human -> ready
failed        -> ready       (retryCount increments)
blocked       -> pending     (dependency or external blocker cleared)
```

All other transitions are rejected. `completed` is terminal. `failed` remains
retryable only through the explicit retry operation. Transition timestamps must
be valid ISO-8601 timestamps and cannot precede the most recent history entry.
Each successful transition appends an execution-history entry. Completion
clears failure data and can attach output artifacts and an output digest.
Only a failed node carries current `failure` data. Retrying clears that field;
the prior reason remains durable in execution history.
Entries for failed, blocked, and waiting-human states require reasons. Retry,
unblock, and return-from-human transitions also require reasons so reconstruction
cannot discard why work stopped or resumed.

The graph enforces dependency preconditions around these node-level
transitions. The WorkNode module itself enforces only the state machine and node
invariants, allowing it to remain independent of graph storage.

Phase 1 implements the pure legality rules and value transformations that make
the state machines domain concepts. The Phase 4 “state transitions” milestone
means scheduler orchestration: deciding when to invoke these functions,
persisting their results, emitting events, and sequencing external execution.
It does not redefine transition legality.

## 6. FactoryRun State Machine

Allowed transitions are:

```text
created       -> running
created       -> cancelled
running       -> waiting_human
running       -> completed
running       -> failed
running       -> cancelled
waiting_human -> running
waiting_human -> failed
waiting_human -> cancelled
```

`completed`, `failed`, and `cancelled` are terminal. Completing a run requires a
non-empty graph with every WorkNode completed. Failure records structured
failure information. Waiting and resuming are explicit domain transitions;
automatic continuation after a persisted human decision belongs to the future
scheduler.

## 7. Scheduler Responsibilities

The scheduler is deterministic application code, not an agent. Beginning in
Phase 4 it will:

- query and record ready or blocked nodes;
- enforce dependency, concurrency, budget, retry, and role limits;
- authorize role requests and reject unsupported recommendations;
- detect predicted and actual mutation conflicts;
- select sequentially runnable work before parallel execution exists;
- invoke disposable worker sessions through an adapter;
- validate and accept or reject worker results;
- persist transitions and coordinate checkpoints;
- continue after recorded human decisions;
- decide terminal FactoryRun outcomes.

No scheduler code exists in Phase 1. The domain does not call agents, access the
filesystem, persist itself, or make scheduling decisions.

## 8. RoleResult Protocol

All future roles return one validated discriminated union:

```ts
type RoleResult =
  | { readonly status: "done"; readonly artifactRefs: readonly string[] }
  | { readonly status: "need_context"; readonly requests: readonly ContextRequest[] }
  | {
      readonly status: "request_role";
      readonly role: AgentRole;
      readonly builderMode?: BuilderMode;
      readonly reason: string;
      readonly evidenceRefs?: readonly string[];
    }
  | { readonly status: "need_human"; readonly decision: HumanDecisionRequest }
  | { readonly status: "escalate"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };
```

RoleResult is an untrusted recommendation. The scheduler validates its shape,
references, requested role and Builder mode, evidence, budget, and authority
before changing domain state. It is documented now and implemented with agent
integration in a later phase.

## 9. Artifact Model

Phase 1 supports these artifact types:

```text
plan
exploration
implementation
diagnosis
test
integration
review
baseline
human_decision
```

```ts
interface Artifact {
  readonly id: string;
  readonly type: ArtifactType;
  readonly workNodeId?: string;
  readonly summary: string;
  readonly facts: readonly string[];
  readonly assumptions: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly digest: string;
}
```

Artifacts are immutable durable conclusions and evidence, never hidden
chain-of-thought. Phase 1 validates required values and creates frozen copies.
It treats the digest and changed-file list as assertions supplied by a trusted
application boundary. Phase 3 computes digests and independently attests actual
workspace changes; Phase 7 persists and retrieves artifacts.

## 10. Persistence Model

Phase 2 will store each run under:

```text
.pifactory/
  runs/
    <run-id>/
      run.json
      graph.json
      events.jsonl
      checkpoint-latest.json
      nodes/
      artifacts/
      decisions/
      worktrees/
```

JSON snapshots use explicit schema versions. Events are append-only and carry a
unique ID, monotonically increasing run-local sequence, timestamp, type, and
structured payload. Snapshot and checkpoint replacement uses same-directory
temporary files, flushes where supported, and atomic rename. Reload validates
schemas, graph invariants, event sequence, and checkpoint integrity before the
run can resume. Persistence adapters translate plain domain values without
placing I/O in domain modules.

## 11. Digest Strategy

Phase 3 will use SHA-256 over canonical UTF-8 serialization. Canonical
serialization sorts object keys, preserves semantically ordered arrays, sorts
set-like collections before serialization, rejects unsupported values, and
distinguishes absent values consistently.

Digest categories include workspace, configuration, WorkNode input and output,
artifact, and checkpoint digests. A WorkNode input digest covers its objective,
relevant file identities and content digests, dependency artifact digests, and
applicable human decisions. It does not hash the whole repository unless the
scope genuinely requires it. Digest strings use an explicit `sha256:<hex>`
format. Phase 1 stores opaque digest fields but does not compute or trust them.

## 12. Mutation-Security Model

All agent-provided paths and mutation reports are untrusted. Phase 3 will:

- accept repository-relative normalized paths only;
- reject absolute paths, drive paths, URLs, dot segments, empty segments,
  control characters, and traversal;
- compare normalized paths against explicit allowed and forbidden scopes;
- validate symlinks and ensure resolved targets remain in the workspace;
- use bounded reads and defensive identity checks where necessary;
- snapshot the real workspace before and after mutation;
- independently derive added, modified, and deleted paths;
- reject actual changes outside the authorized mutation scope.

Role capabilities have hard-coded maxima. Configuration may reduce but never
silently expand them. Parallel mutation will eventually require isolated Git
worktrees plus pre-execution and post-execution conflict checks. Phase 1 merely
stores scope declarations.

## 13. First Vertical-Slice Architecture

The first usable slice spans Phases 1 through 6:

```text
User request
  -> create FactoryRun and one Builder(implement) WorkNode
  -> deterministic sequential scheduler
  -> one disposable Builder session
  -> independently inspect workspace mutation
  -> run targeted checks
  -> persist an implementation Artifact
  -> complete WorkNode
  -> complete FactoryRun
```

The default is one Builder call, no Planner, no Reviewer, no human interaction,
and no worktree. The scheduler owns every transition and validates every agent
recommendation. This slice must be reliable before Planner decomposition,
parallelism, integration workers, review, or worktrees are introduced.

Phase 1 supplies only the run, node, graph, artifact, transition, and validation
primitives required at the beginning and end of that flow.

## 14. Initial Testing Strategy

Phase 1 unit tests are fast and deterministic. They cover every allowed and
rejected state transition, construction invariant, retry and history behavior,
completion guard, graph operation, dependency failure, missing reference,
duplicate edge, self-edge, and cycle. They also verify stable query ordering and
that caller-owned arrays cannot mutate created domain values.

Phase 2 integration tests will cover atomic persistence, event ordering, reload,
checkpoint validation, and completed-node survival after restart. Later
integration tests cover artifact storage, human continuation, idempotency,
Builder execution, mutation attestation, and differential validation.

System tests use temporary real Git repositories and are reserved for the small
number of behaviors that require them: worktree creation and cleanup, parallel
isolation, actual mutation enforcement, integration conflicts, crash recovery,
and the complete FAST vertical slice. Existing repository failures are recorded
as a baseline and are not classified as regressions unless the new execution
introduces them.

Every phase must pass its relevant TypeScript type check and Vitest suite before
`TODO.md` is marked complete.
