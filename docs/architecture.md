# piFactory Architecture

## Status and Scope

This document records the accepted architecture for the initial piFactory
implementation. Phases 1: Domain Core, 2: Persistence, 3: Safety Foundation,
and 4: Sequential Scheduler are complete. Later-phase sections define contracts
and boundaries only; they do not authorize implementation of checkpoints,
leases, agents, workspace mutation, parallelism, worktrees, runtime
orchestration, or a user interface.

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
  workspace/                 # Phase 3
    digest.ts
    path-validation.ts
    text-validation.ts       # internal shared text checks
    workspace-snapshot.ts
    workspace-delta.ts
    mutation-scope.ts
    workspace-error.ts
    workspace-fs.ts           # internal filesystem seam
    index.ts
  persistence/               # Phase 2
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
  workspace/
    digest.test.ts
    path-validation.test.ts
    workspace-snapshot.test.ts
    workspace-snapshot-race.test.ts
    workspace-delta.test.ts
    mutation-scope.test.ts
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
non-negative. Zero means no allowance. Phase 4 enforces call count, retry count,
and a sequential worker limit. Token, cost, aggregate budget, and
no-progress-loop enforcement belong to Phase 18.

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

The scheduler is deterministic application code, not an agent. Phase 4 provides
the sequential foundation:

- query ready WorkNodes through the immutable graph API;
- select one node in deterministic ID order;
- enforce dependency completion, call budgets, and retry budgets;
- persist ready, running, completed, failed, and retry transitions;
- invoke an injected executor only after the running state is current;
- retry only failures independently classified as safe by trusted adapter code;
- fail fast on unsafe or exhausted failures;
- complete the FactoryRun only after every WorkNode completes.

The effective Phase 4 worker capacity is one, even when the stored budget allows
more. An already-running run returns `recovery_required`; Phase 4 does not reset
or re-invoke uncertain work. Cross-process ownership, role authorization,
mutation conflicts, worktrees, checkpoints, human decisions, tier escalation,
parallelism, and broader budget policy remain later-phase responsibilities.
Phase 4 accepts only Builder WorkNodes in `implement` mode; Planner, Reviewer,
and other Builder modes are enabled in their later phases.

The scheduler commits `running` before invoking the executor and commits the
outcome afterward. It uses an injected executor seam rather than an LLM or a
real agent provider. See the [Phase 4 scheduler guide](./phase-4-sequential-scheduler.md)
and its [implementation deep dive](./phase-4-sequential-scheduler-deep-dive.md).

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

Phase 2 stores each run under a safe storage key derived from the run ID:

```text
.pifactory/
  runs/
    <sha256-run-id>/
      current.json
      states/
        state-00000001-<uuid>/
          run.json
          graph.json
          events.jsonl
```

The plain-language term **saved state** means one complete stored copy of the
run metadata, graph, and event history. A **state version** identifies a saved
state. `current.json` selects the current saved state; it is the only commit
pointer. A saved state becomes current only after all files in its state
directory are written, flushed, and published before `current.json` is atomically
replaced.

Run metadata and the graph are stored separately within the same saved-state
directory so the persisted representation remains explicit even though the
domain FactoryRun embeds its graph. `run.json`, `graph.json`, and
`events.jsonl` carry matching run IDs and state versions. Events are append-only
through the public API and carry a unique ID, contiguous run-local sequence,
timestamp, type, and bounded structured JSON payload. Each saved state contains
the complete event history; snapshots remain authoritative and Phase 2 does not
replay events to rebuild a run.

State publication uses same-directory temporary files, file flushes, atomic
renames, and directory flushes where supported. A crash before the pointer is
published leaves the previous current saved state loadable; a crash after
publication exposes the complete new saved state. Unpublished state directories
are ignored. Phase 2 supports one writer per run; run leases and stale-owner
recovery belong to Phase 19.

Reload parses persisted JSON as `unknown`, validates schema versions, identities,
state versions, graph invariants, event sequences, size limits, and FactoryRun
state consistency before returning a frozen domain value. Persistence adapters
translate plain domain values without placing I/O in domain modules.

## 11. Digest Strategy

Phase 3 implements SHA-256 over canonical UTF-8 serialization. Canonical
serialization sorts object keys by UTF-16 code units, preserves ordered arrays,
and requires callers to explicitly canonicalize set-like collections. It rejects
unsupported values, accessors, cycles, malformed Unicode, non-finite numbers,
and non-plain objects. Absent object properties remain distinct from explicit
`null` values. Digest strings use the explicit `sha256:<64 lowercase hex>` form.

Raw file bytes use the same prefixed SHA-256 representation without text
decoding. `canonicalizeSet()` is the only set-like collection operation; the
serializer never guesses whether an array is ordered or set-like. Canonical
serialization and snapshot limits are enforced while values are being written
or accepted; oversized canonical output is rejected before it is appended.

The [Phase 3 implementation deep dive](./phase-3-safety-foundation-deep-dive.md)
explains these contracts with examples and test references.

Digest categories include workspace, configuration, WorkNode input and output,
artifact, and checkpoint digests. A WorkNode input digest covers its objective,
relevant file identities and content digests, dependency artifact digests, and
applicable human decisions. It does not hash the whole repository unless the
scope genuinely requires it. Phase 1 continues to store opaque digest fields
for its domain boundary. Phase 3 supplies validated digest values; it does not
migrate existing persistence documents or change the Phase 2 storage-key hash.

## 12. Mutation-Security Model

All agent-provided paths and mutation reports are untrusted. Phase 3 implements:

- repository-relative paths using forward slashes only;
- rejection of absolute paths, drive paths, URLs, dot segments, empty
  segments, control characters, Windows-reserved characters and names, and
  traversal;
- exact-or-descendant matching with segment-aware boundaries;
- configurable case comparison, defaulting to insensitive on Windows and
  sensitive elsewhere;
- symlink target recording without traversal and physical containment checks;
- bounded directory enumeration, file reads, total snapshot bytes, path sizes,
  and canonical serialization;
- maximum repository path depth, with the root at depth zero;
- file identity checks at open, after hashing, and during final revalidation;
- POSIX no-follow file opens and rejection of hard-linked regular files;
- normalized immutable snapshot and mutation-scope inputs at trust boundaries;
- independent added, modified, and deleted deltas from before/after snapshots;
- whole-result rejection when any path is outside the allowed scope or matches a
  forbidden scope.

Canonicalization and filesystem traversal also enforce a recursion-safe maximum
depth instead of accepting arbitrarily large depth settings that could exhaust
the JavaScript call stack.

Mutation scopes compile `WorkNode.scope`-compatible path declarations. Missing
or empty `allowedMutationPaths` grants no mutation authority; a no-op remains
acceptable. Forbidden paths always win, and `relevantPaths` never grants write
permission. Phase 3's `assessMutationScope(before, after, scope)` computes its
own delta, so callers do not submit a worker-reported delta as authority. A
scope may provide `pathLimits` when it is used with snapshots that allow larger
repository path components; assessment uses the normalized snapshot paths
without silently applying a second default limit.

Snapshots include regular files and symlinks, not directories. Regular files
use normalized Git-like modes (`100644` or `100755`); symlinks use `120000` and
record their raw target text. Renames are represented as a deletion plus an
addition. Special files, escaping/dangling/looping links, unstable entries, and
unsupported hard links fail closed.

Phase 3 is an attestation layer, not a prevention or rollback mechanism. It
cannot observe transient changes that are restored before the final snapshot,
external side effects, or changes made after the final revalidation. Node 22's
standard cross-platform filesystem APIs are path-based, so portable checks can
detect and reject many parent-directory races but cannot make parent resolution
atomic. Strict anchored traversal requires a platform-specific native helper or
an operational exclusive-access policy. Phase 5 will place these primitives
around Builder execution; Phase 3 does not execute workers, commands, schedulers,
or agents.

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

Phase 1 supplies the run, node, graph, artifact, transition, and validation
primitives. Phase 4 supplies the deterministic scheduler seam; Phase 5 supplies
the real Builder, workspace attestation, targeted validation, and implementation
result handling.

## 14. Initial Testing Strategy

Phase 1 unit tests are fast and deterministic. They cover every allowed and
rejected state transition, construction invariant, retry and history behavior,
completion guard, graph operation, dependency failure, missing reference,
duplicate edge, self-edge, and cycle. They also verify stable query ordering and
that caller-owned arrays cannot mutate created domain values.

Phase 2 integration tests cover atomic saved-state publication, event ordering,
reload, malformed-data rejection, stale state-version rejection, and
completed-node survival after restart. Phase 3 tests cover canonical digest
fixtures, path rejection, bounded and defensive workspace capture, file-mode
and symlink metadata, deterministic deltas, case policy, and fail-closed
mutation scopes. Checkpoints, leases, and scheduler recovery are Phase 19
concerns. Later integration tests cover artifact storage, human continuation,
idempotency, Builder execution, and differential validation.

System tests use temporary real Git repositories and are reserved for the small
number of behaviors that require them: worktree creation and cleanup, parallel
isolation, actual mutation enforcement, integration conflicts, crash recovery,
and the complete FAST vertical slice. Existing repository failures are recorded
as a baseline and are not classified as regressions unless the new execution
introduces them.

Every phase must pass its relevant TypeScript type check and Vitest suite before
`TODO.md` is marked complete.
