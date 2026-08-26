# Phase 2 Persistence

## Purpose

Phase 2 gives piFactory a durable filesystem boundary for FactoryRun state. It
stores a complete saved state, preserves ordered event history, publishes state
atomically, and validates all data before it returns to the domain.

It does not run a scheduler, agents, workspace mutations, or recovery policy.

## Terminology

- **Saved state**: one complete stored copy of FactoryRun metadata, its
  WorkGraph, and its event history.
- **State version**: the positive sequential number assigned to a saved state.
- **Current saved state**: the saved state selected by `current.json`.
- **Expected state version**: the version a writer expects before saving. It
  rejects a stale in-memory writer.
- **Checkpoint**: a Phase 19 recovery concept, not a Phase 2 file.

A saved state becomes current only when `current.json` points to it. The state
directory is complete before that pointer changes.

## Quick Reference

| Question | Answer |
| --- | --- |
| Where is a run stored? | `storageRoot/runs/<sha256-run-id>/` |
| Which saved state is current? | Read `current.json` |
| Where is run metadata? | `states/<state-directory>/run.json` |
| Where is the WorkGraph? | `states/<state-directory>/graph.json` |
| Where is event history? | `states/<state-directory>/events.jsonl` |
| How do I create a run? | `FileRunStore.create()` |
| How do I save a run? | `FileRunStore.save()` |
| How do I reload a run? | `FileRunStore.load()` |
| What detects stale saves? | `expectedStateVersion` |
| What validates FactoryRun JSON? | `snapshotFactoryRun()` |
| What validates event JSON? | `decodeEventLog()` |
| Where are default limits? | `DEFAULT_PERSISTENCE_LIMITS` |
| Where are persistence errors defined? | `persistence-error.ts` |

When investigating a problem, start with `current.json`, follow its
`stateDirectory`, and then inspect the three files in that directory. Do not
choose the newest-looking directory by hand: only `current.json` identifies the
authoritative saved state.

## Storage Layout

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

The raw run ID is never used as a directory name. A lowercase SHA-256 hash of
the UTF-8 ID is used as the storage key. The original ID is persisted and is
checked against the requested ID during reload. This storage key is separate
from the canonical digest system planned for Phase 3.

## Persisted Files

`current.json` is the commit pointer:

```json
{
  "schemaVersion": 1,
  "runId": "run-123",
  "stateVersion": 2,
  "stateDirectory": "state-00000002-..."
}
```

`run.json` stores the FactoryRun metadata without the graph. `graph.json` stores
the WorkGraph and all WorkNodes. Both documents contain the run ID and state
version. `events.jsonl` begins with a versioned event-log header containing the
run ID and state version, followed by one versioned event object per line for
the complete history of that saved state.

Snapshots are authoritative. Phase 2 does not replay events to reconstruct the
run, and it does not persist artifacts themselves. Artifact references remain
durable strings inside WorkNodes.

### `current.json`

`current.json` is the commit pointer for the run. It contains no workflow state;
it only selects the saved state that should be loaded.

```json
{
  "schemaVersion": 1,
  "runId": "run-123",
  "stateVersion": 2,
  "stateDirectory": "state-00000002-550e8400-e29b-41d4-a716-446655440000"
}
```

The state directory name is checked against the numeric `stateVersion`. A
pointer to a path containing separators, dot segments, or an unexpected name is
rejected before it is joined to the storage path.

### `run.json`

`run.json` contains FactoryRun metadata. The graph is intentionally not repeated
here because `graph.json` is its separate persisted representation.

```json
{
  "schemaVersion": 1,
  "runId": "run-123",
  "stateVersion": 2,
  "state": {
    "id": "run-123",
    "request": "Implement authentication",
    "tier": "fast",
    "status": "running",
    "budget": {
      "maxParallelAgents": 1,
      "maxAgentCalls": 1,
      "maxRetriesPerNode": 0
    },
    "createdAt": "2026-08-25T10:00:00.000Z",
    "updatedAt": "2026-08-25T10:01:00.000Z"
  }
}
```

The `state` object is converted back into a FactoryRun only after its graph has
been read from `graph.json` and both parts have passed validation.

### `graph.json`

`graph.json` contains the WorkGraph and complete WorkNode snapshots, including
dependencies, execution history, retry counts, digests, failures, and artifact
references.

```json
{
  "schemaVersion": 1,
  "runId": "run-123",
  "stateVersion": 2,
  "graph": {
    "nodes": [
      {
        "id": "build-auth",
        "objective": "Implement authentication",
        "role": "builder",
        "builderMode": "implement",
        "status": "completed",
        "dependsOn": [],
        "scope": {},
        "acceptanceCriteria": ["Authentication tests pass"],
        "risk": "medium",
        "complexity": "medium",
        "parallelSafe": false,
        "outputDigest": "opaque-output",
        "artifactRefs": ["artifact-auth"],
        "retryCount": 0,
        "executionHistory": [
          { "status": "pending", "at": "2026-08-25T10:00:00.000Z" },
          { "status": "ready", "at": "2026-08-25T10:01:00.000Z" },
          { "status": "running", "at": "2026-08-25T10:02:00.000Z" },
          { "status": "completed", "at": "2026-08-25T10:03:00.000Z" }
        ]
      }
    ]
  }
}
```

The domain graph is reconstructed through `createWorkGraph()`. That rechecks
WorkNode shape, dependency references, cycles, dependency timing, and state
transition history.

### `events.jsonl`

`events.jsonl` begins with a stream header. Every following line is one event:

```jsonl
{"schemaVersion":1,"kind":"event_log","runId":"run-123","stateVersion":2}
{"schemaVersion":1,"runId":"run-123","id":"event-1","sequence":1,"timestamp":"2026-08-25T10:00:00.000Z","type":"factory_run_created","payload":{}}
{"schemaVersion":1,"runId":"run-123","id":"event-2","sequence":2,"timestamp":"2026-08-25T10:01:00.000Z","type":"factory_run_started","payload":{}}
```

The header binds the event file to the saved state version. Event records keep
their original sequence numbers when copied into a later saved state.

## Publication Protocol

`FileRunStore` writes a new state into a uniquely named unpublished directory.
Each file is written through `atomicWriteFile`, which writes and flushes a
same-directory temporary file before renaming it. The completed directory is
then renamed into `states`, and `current.json` is atomically replaced as the
commit point.

```text
write files to .pending-<uuid>
        |
        v
flush files and directory
        |
        v
rename to state-<version>-<uuid>
        |
        v
atomically replace current.json
```

If a process fails before replacing `current.json`, the previous current saved
state remains loadable. If it fails after replacement, the new state is
complete. Unpublished or orphaned state directories are ignored and are not
automatically deleted in Phase 2.

Directory flushing is attempted where the platform supports it. The guarantee
is atomic visibility and best-effort local-filesystem durability; network and
platform-specific filesystem guarantees are outside this phase.

## Domain Boundary

`validateFactoryRun` accepts `unknown` and returns structured validation issues.
`snapshotFactoryRun` accepts `unknown` and returns a deeply defensive domain
value or throws a `DomainError`.

Reload validates:

- persisted schema versions and exact document fields;
- run identity and state versions;
- FactoryRun status, tier, budget, timestamps, and failure consistency;
- WorkGraph, WorkNode, dependency, and execution-history invariants;
- completed-run completion requirements;
- event IDs, timestamps, event types, payloads, and contiguous sequences;
- file identity, symlink safety, UTF-8 validity, and size limits.

Persistence never casts parsed JSON directly to a domain value.

## Event History

The public persistence API accepts `NewRunEvent` values. The store assigns
sequences beginning at 1 and rejects duplicate event IDs. Event payloads are
bounded JSON objects. Existing events remain an exact prefix of every later
saved state. A save publishes the run, graph, and complete event history
together, so state and event files cannot commit independently.

Phase 2 supports one writer per run. `expectedStateVersion` protects against
ordinary stale in-memory writers. Multi-process ownership, leases, and stale
lease recovery belong to Phase 19.

## Public API

```ts
const store = new FileRunStore({ storageRoot: ".pifactory" });

const created = await store.create(run, initialEvents);
const saved = await store.save(nextRun, created.stateVersion, newEvents);
const loaded = await store.load(run.id);
const events = await store.readEvents(run.id);
```

### `create()`

`create()` accepts a valid Phase 1 FactoryRun and optional initial events. It
creates state version 1. The operation is exclusive: creating the same run ID
again returns `already_exists`.

```ts
const created = await store.create(run, [
  {
    id: "event-run-created",
    timestamp: "2026-08-25T10:00:00.000Z",
    type: "factory_run_created",
    payload: { tier: run.tier },
  },
]);

console.log(created.stateVersion); // 1
```

Initial events are validated before the state is published. If creation fails
before the pointer is published, the newly created run directory is removed.

### `save()`

`save()` accepts the next immutable FactoryRun, the caller's expected state
version, and optional new events. It creates the next state version and
publishes the run, graph, and event history together.

```ts
const saved = await store.save(
  nextRun,
  loaded.stateVersion,
  [
    {
      id: "event-node-started",
      timestamp: "2026-08-25T10:02:00.000Z",
      type: "node_started",
      payload: { nodeId: "build-auth" },
    },
  ],
);
```

If `loaded.stateVersion` is no longer current, the operation fails with
`stale_state_version`. Reload first, then decide whether the intended domain
change should be applied to the newer state.

### `load()`

`load()` follows the current pointer and returns a validated `LoadedRun`. It does
not search for the highest state directory and does not repair damaged files.

```ts
const loaded = await store.load("run-123");

console.log(loaded.run.status);
console.log(loaded.stateVersion);
console.log(loaded.events.length);
```

### `readEvents()`

`readEvents()` is a convenience method that loads the current saved state and
returns its validated event history. It does not read an independent event
stream, because events are committed as part of the saved state.

### Test Hooks

`RunStoreHooks` exposes `beforeStatePublish` and `beforeCurrentPublish` for
deterministic fault-injection tests. Application code should not use these hooks
to change normal persistence behavior.

Persistence failures use `PersistenceError` with stable categories including
`not_found`, `already_exists`, `stale_state_version`, `corrupt_state`,
`unsupported_schema`, `identity_mismatch`, `unsafe_storage_entry`,
`size_limit_exceeded`, and `io_failure`.

## Module Map

```text
FileRunStore
    |
    +--> atomic-write.ts
    |      +--> temporary file
    |      +--> file sync
    |      +--> atomic rename
    |      +--> directory flush
    |
    +--> event-log.ts
    |      +--> event validation
    |      +--> sequence assignment
    |      +--> JSONL encoding/decoding
    |
    +--> persistence-types.ts
    |      +--> persisted document shapes
    |      +--> JSON types
    |      +--> size limits
    |
    +--> persistence-error.ts
    |
    +--> domain/snapshotFactoryRun()
```

Responsibilities stay separated:

| Module | Responsibility | Does not do |
| --- | --- | --- |
| `run-store.ts` | Coordinates saved-state creation, loading, and publication | Schedule work or run agents |
| `atomic-write.ts` | Replaces one file safely | Validate FactoryRun meaning |
| `event-log.ts` | Validates, sequences, encodes, and decodes events | Rebuild the run from events |
| `persistence-types.ts` | Defines persistence data and limits | Perform filesystem I/O |
| `persistence-error.ts` | Defines typed persistence failures | Decide how a workflow should recover |
| `factory-run.ts` | Validates and freezes the domain aggregate | Read files |

## Save Flow

`FileRunStore.save()` at
[`run-store.ts`](../src/persistence/run-store.ts) follows this sequence:

```text
Caller has nextRun and expectedStateVersion
        |
        v
Load the current saved state
        |
        v
Reject if the expected state version is stale
        |
        v
Validate and freeze nextRun
        |
        v
Validate new events and append their sequences
        |
        v
Serialize run, graph, events, and pointer
        |
        v
Check serialized byte limits
        |
        v
Create .pending-<uuid>
        |
        v
Write and flush all state files
        |
        v
Rename pending directory to state-<version>-<uuid>
        |
        v
Atomically replace current.json
        |
        v
Reload and validate the newly current state
```

There are three useful levels of “complete”:

1. A file is complete when its full contents were written, synced, closed, and
   atomically renamed into place.
2. A saved state is complete when `run.json`, `graph.json`, and `events.jsonl`
   all exist in the final state directory with matching identity and state
   information.
3. A saved state is current when `current.json` points to its directory.

Only the third condition makes the state authoritative.

## Atomic File Flow

`atomicWriteFile()` writes a temporary sibling file rather than writing
directly to the destination:

```text
state.json.tmp-<uuid>
        |
        +--> write UTF-8 contents
        +--> fileHandle.sync()
        +--> close handle
        +--> rename to state.json
        +--> flush parent directory where supported
```

The `wx` open mode requires the temporary path not to already exist. A failed
write removes the temporary file and leaves an existing destination unchanged.

Atomic visibility and durable storage are related but different:

- Atomic visibility means readers see old or new complete contents.
- File sync requests that file contents reach the storage layer.
- Directory flush requests that the rename itself reaches the storage layer.
- Some platforms do not support directory sync, so directory durability is
  best effort there.

## Buffer and Byte Flow

Persistence crosses between JavaScript values, text, and bytes:

```text
JSON on disk
    |
    v
Buffer chunks
    |
    v
strict UTF-8 string
    |
    v
JSON.parse() as unknown
    |
    v
validated frozen domain value
```

`run-store.ts` reads at most the configured file limit using 64 KiB Buffer
chunks. It checks the file identity after opening, detects growth beyond the
limit, and then decodes the collected bytes with a fatal UTF-8 decoder.

`Buffer.byteLength(value, "utf8")` is used instead of `value.length` because
JavaScript character count is not the same as the number of bytes stored on
disk. For example, one accented character may require two UTF-8 bytes.

## Load and Trust Flow

Reload crosses the persistence trust boundary in stages:

```text
Requested run ID
        |
        v
SHA-256 storage key
        |
        v
Read current.json
        |
        v
Validate pointer and state directory name
        |
        v
Read bounded regular files
        |
        v
Decode strict UTF-8 and parse JSON as unknown
        |
        v
Validate persistence envelopes
        |
        v
Validate event header and event sequence
        |
        v
Combine run metadata and graph
        |
        v
snapshotFactoryRun()
        |
        v
Return deeply frozen LoadedRun
```

Never replace this with:

```ts
const run = JSON.parse(contents) as FactoryRun;
```

That cast changes only the TypeScript compiler's belief. It does not validate
the runtime data.

## Validation Checklist

| Check | Why it matters |
| --- | --- |
| Schema version | Prevents newer or incompatible formats being interpreted incorrectly |
| Run ID | Prevents files from different runs being combined |
| State version | Prevents files from different saved states being combined |
| State directory pattern | Prevents pointer path traversal |
| Regular-file check | Prevents unexpected devices, directories, or links |
| File identity check | Detects replacement between inspection and opening |
| UTF-8 check | Prevents malformed text from being silently repaired |
| JSON shape | Prevents missing or unsupported persistence fields |
| Event sequence | Prevents gaps, duplicates, and reordering |
| FactoryRun validation | Re-establishes Phase 1 domain invariants |
| Deep freezing | Prevents accidental mutation after reload |
| Size limits | Bounds memory and disk input |

The persistence layer rejects invalid data rather than repairing it. A corrupt
state must be investigated instead of being treated as a new run.

## Event Model

`NewRunEvent` is the caller-facing shape:

```ts
interface NewRunEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly type: RunEventType;
  readonly payload: JsonObject;
}
```

The store adds:

```ts
interface RunEvent extends NewRunEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sequence: number;
}
```

Sequences are assigned from the current event count. If two events are added
to a history ending at sequence 4, they receive sequences 5 and 6. The caller
does not choose those numbers.

The event-log header carries the saved-state version because the event records
retain their original event sequences when copied into later saved states.

Events describe history, but Phase 2 snapshots remain authoritative. Event
replay and projections are intentionally deferred.

## Concurrency Model

Phase 2 has two protections:

1. `expectedStateVersion` rejects a writer that started from an older saved
   state.
2. A process-local write queue serializes overlapping saves for the same run,
   including saves made through separate `FileRunStore` instances in that
   process.

Example:

```text
Writer A expects state 4
Writer B expects state 4

A publishes state 5
B loads the current state and receives stale_state_version
```

Phase 2 does not coordinate separate Node.js processes. Only one process may
own a run at a time. Run leases and stale-owner recovery belong to Phase 19.

## Size Limits

`DEFAULT_PERSISTENCE_LIMITS` in
[`persistence-types.ts`](../src/persistence/persistence-types.ts) currently
sets:

| Limit | Default |
| --- | ---: |
| Run ID | 1 KiB |
| `current.json` | 16 KiB |
| `run.json` | 1 MiB |
| `graph.json` | 10 MiB |
| Complete event log | 10 MiB |
| One event line | 256 KiB |
| One event payload | 128 KiB |
| JSON nesting depth | 20 |
| JSON object entries | 1,000 |
| JSON array length | 1,000 |
| JSON string length | 128 KiB |

Limits are checked before publication and again during reload. Callers can
provide smaller limits through `FileRunStore` options for tests or deployment
constraints.

## Error Reference

| Code | Meaning | Typical response |
| --- | --- | --- |
| `not_found` | The requested run directory does not exist | Check the run ID |
| `already_exists` | A run with that ID already has storage | Load the existing run |
| `stale_state_version` | The caller is behind the current state | Reload and reconsider the change |
| `corrupt_state` | Persisted data is malformed or inconsistent | Stop and investigate; do not recreate silently |
| `unsupported_schema` | A document uses an unknown schema version | Use compatible code or migrate deliberately |
| `identity_mismatch` | Run IDs or state versions disagree | Reject the mixed state |
| `unsafe_storage_entry` | A path, symlink, or file type is unsafe | Inspect the storage entry |
| `size_limit_exceeded` | Input exceeds a configured bound | Reduce data or adjust policy deliberately |
| `invalid_argument` | An API option is invalid | Correct the caller input |
| `invalid_event` | A proposed event is invalid | Correct its ID, timestamp, type, or payload |
| `io_failure` | The filesystem operation failed | Check permissions, disk, and platform behavior |

## Failure Matrix

| Failure point | Expected result |
| --- | --- |
| Before the pending directory is created | No new state is visible |
| While writing a pending file | Pending state is ignored; current state is unchanged |
| During event encoding or size checks | Pending state is not published |
| After pending directory is renamed | A complete orphan may remain; current state is unchanged |
| Before `current.json` replacement | Previous saved state remains current |
| During pointer replacement | The pointer resolves to the old or new complete state |
| Current state directory is missing | Load fails with `corrupt_state` |
| One state file is malformed | Load fails with `corrupt_state` |
| Event log has a gap or truncated line | Load fails with `corrupt_state` |
| Save expects an old state version | Save fails with `stale_state_version` |

The loader never selects a state merely because its directory has the largest
number. The pointer is authoritative.

## Troubleshooting

### `stale_state_version`

Another save won the state transition, or the caller reused an old
`LoadedRun`. Load the run again and apply the intended domain operation to the
new state. Do not blindly retry the old object.

### A state directory exists but is not loaded

This is expected if it is not named by `current.json`. It may be an orphan from
a failed publication or an older retained state. Inspect `current.json` first.

### `identity_mismatch`

At least two persistence documents disagree about the run ID or state version.
This usually indicates manual file mixing, an incomplete migration, or storage
corruption. Do not combine files from different state directories.

### `corrupt_state`

The data is syntactically malformed or violates domain invariants. Check the
specific file named in the error, but do not edit it automatically. Phase 2
fails closed because guessing can destroy workflow correctness.

### `size_limit_exceeded`

The data was too large either before writing or during reload. Check whether a
WorkGraph, event payload, event line, or complete event log exceeded its limit.

### A running run does not resume automatically

That behavior is intentionally not in Phase 2. Phase 2 reloads the saved
FactoryRun. Scheduler recovery, checkpoints, leases, and incomplete-node
handling belong to Phase 19.

## Testing Map

Phase 2 tests use real temporary directories and deterministic fault hooks:

| Requirement | Test |
| --- | --- |
| Atomic create and replacement | [`atomic-write.test.ts`](../test/persistence/atomic-write.test.ts) |
| Temporary-file cleanup | [`atomic-write.test.ts`](../test/persistence/atomic-write.test.ts) |
| Event ordering and prefix preservation | [`event-log.test.ts`](../test/persistence/event-log.test.ts) |
| Duplicate, malformed, and invalid events | [`event-log.test.ts`](../test/persistence/event-log.test.ts) |
| FactoryRun reconstruction | [`factory-run.test.ts`](../test/domain/factory-run.test.ts) |
| Every FactoryRun status round-trip | [`run-store.test.ts`](../test/persistence/run-store.test.ts) |
| Completed WorkNode survival | [`run-store.test.ts`](../test/persistence/run-store.test.ts) |
| Failed pointer publication | [`run-store.test.ts`](../test/persistence/run-store.test.ts) |
| Stale writers | [`run-store.test.ts`](../test/persistence/run-store.test.ts) |
| Corrupt and unsupported persisted data | [`run-store.test.ts`](../test/persistence/run-store.test.ts) |
| Symlink and storage-key protection | [`run-store.test.ts`](../test/persistence/run-store.test.ts) |

Run the checks from the repository root:

```text
pnpm test test/persistence
pnpm typecheck
pnpm test
```

## Source Map

| File | Responsibility |
| --- | --- |
| [`atomic-write.ts`](../src/persistence/atomic-write.ts) | Temporary-file writes, file sync, rename, and directory flush |
| [`event-log.ts`](../src/persistence/event-log.ts) | Event validation, sequence assignment, JSONL encoding, and decoding |
| [`persistence-types.ts`](../src/persistence/persistence-types.ts) | Versioned document types, JSON types, event vocabulary, and limits |
| [`persistence-error.ts`](../src/persistence/persistence-error.ts) | Typed persistence error codes and class |
| [`run-store.ts`](../src/persistence/run-store.ts) | Saved-state create, load, save, pointer publication, and write serialization |
| [`factory-run.ts`](../src/domain/factory-run.ts) | FactoryRun validation and defensive reconstruction |
| [`run-store.test.ts`](../test/persistence/run-store.test.ts) | Filesystem integration behavior |
| [`event-log.test.ts`](../test/persistence/event-log.test.ts) | Event-log behavior |
| [`atomic-write.test.ts`](../test/persistence/atomic-write.test.ts) | Atomic file behavior |

## Phase Boundaries

Phase 2 does not prove or implement:

| Deferred capability | Phase |
| --- | --- |
| Canonical SHA-256 domain digests | Phase 3 |
| Workspace snapshots and mutation enforcement | Phase 3 |
| Sequential scheduling and retry policy | Phase 4 |
| Builder execution and LLM integration | Phase 5 |
| Artifact Store and TaskPacket context | Phase 7 |
| Idempotent completed-work reuse | Phase 9 |
| Event replay and projections | Later phase |
| Checkpoints, run leases, and scheduler recovery | Phase 19 |

Phase 2 proves durable saved-state publication and validated reload. It does not
decide whether a running workflow is safe to resume or whether an artifact is
still available.
