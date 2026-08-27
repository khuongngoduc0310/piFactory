# Phase 3 Safety Foundation: Implementation Deep Dive

## Who This Is For

This document explains the Phase 3 workspace safety code for a developer who
knows basic TypeScript but is new to filesystem security and attestation.

The formal contracts are in
[`phase-3-safety-foundation.md`](./phase-3-safety-foundation.md). This document
explains why those contracts exist and how the implementation follows them. If
the two documents ever appear to disagree, the formal contract and the source
code are authoritative.

## What Phase 3 Does

Phase 3 answers two questions:

1. What did the workspace look like at a particular point in time?
2. Are the changes between two observations inside the authorized scope?

It does this without trusting a worker's report about which files it changed.
The workspace itself is inspected and becomes the source of truth.

Phase 3 does not yet:

- start an AI worker;
- execute a command;
- modify a workspace;
- schedule a WorkNode;
- save a snapshot in the run store;
- roll back a change;
- create a Git worktree; or
- prevent operating-system side effects.

Those responsibilities belong to later phases. Phase 3 supplies the safety
primitives they will use.

## The Mental Model

Think of a workspace snapshot as a photograph of the repository. The photograph
does not contain the full contents of every file. It contains enough verified
information to identify the observed files and compare a later photograph.

The complete flow is:

```text
workspace before
        |
        v
captureWorkspaceSnapshot()
        |
        v
future worker changes files
        |
        v
captureWorkspaceSnapshot()
        |
        v
diffWorkspaceSnapshots()
        |
        v
assessMutationScope()
        |
        v
accept or reject the observed changes
```

The worker may claim that it changed only `src/app.ts`. piFactory does not use
that claim as permission. It compares the actual before and after snapshots.

## Package Map

| Module | Responsibility |
| --- | --- |
| [`digest.ts`](../src/workspace/digest.ts) | SHA-256 digests and bounded canonical serialization |
| [`path-validation.ts`](../src/workspace/path-validation.ts) | Repository-relative path validation and scope matching |
| [`text-validation.ts`](../src/workspace/text-validation.ts) | Shared Unicode and control-character checks |
| [`workspace-snapshot.ts`](../src/workspace/workspace-snapshot.ts) | Constructed snapshots and defensive filesystem capture |
| [`workspace-delta.ts`](../src/workspace/workspace-delta.ts) | Deterministic comparison of two snapshots |
| [`mutation-scope.ts`](../src/workspace/mutation-scope.ts) | Allowed and forbidden path authorization |
| [`workspace-error.ts`](../src/workspace/workspace-error.ts) | Typed failure codes |
| [`workspace-fs.ts`](../src/workspace/workspace-fs.ts) | Internal filesystem adapter used for deterministic tests |
| [`index.ts`](../src/workspace/index.ts) | Public Phase 3 exports |

The implementation uses Node.js standard `crypto` and filesystem APIs. Phase 3
does not add a runtime dependency.

## 1. Digests: File Fingerprints

A digest is a fingerprint. It is a compact value calculated from input data.
SHA-256 produces a 256-bit value represented here as 64 lowercase hexadecimal
characters with a prefix:

```text
sha256:<64 lowercase hexadecimal characters>
```

The prefix makes the algorithm explicit and prevents an unlabelled hash from
being mistaken for another digest format.

### Raw file bytes

Files are hashed as bytes, not as text. This matters because a binary file is
not necessarily valid text, and decoding it could change the data being
fingerprinted.

```ts
import { sha256Bytes, sha256Utf8 } from "../src/workspace/index.js";

const binaryDigest = sha256Bytes(Uint8Array.from([0, 1, 2, 255]));
const textDigest = sha256Utf8("hello");
```

`sha256ByteStream()` provides the same result for an asynchronous sequence of
byte chunks. Workspace capture uses the streaming form so a large file is not
loaded into memory all at once.

### Canonical values

Sometimes piFactory needs to hash structured data, such as a snapshot. Two
JavaScript objects can contain the same information but serialize differently
if their keys were inserted in a different order:

```ts
{ first: 1, second: 2 }
{ second: 2, first: 1 }
```

Canonical serialization gives both objects the same stable byte representation.
It sorts object keys by UTF-16 code-unit order, preserves array order, and uses
compact JSON-like output.

```ts
import { canonicalSha256, canonicalStringify } from "../src/workspace/index.js";

const value = { second: 2, first: 1 };

canonicalStringify(value); // {"first":1,"second":2}
canonicalSha256(value);    // sha256:<stable digest>
```

Arrays are assumed to be ordered. The serializer does not silently sort an
array because it cannot know whether order has meaning. Callers that truly
have set-like data must opt in:

```ts
import { canonicalizeSet } from "../src/workspace/index.js";

const stableSet = canonicalizeSet(["review", "build", "review"]);
// ["build", "review"]
```

### Rejected input

Canonicalization accepts JSON-like values, but rejects values that could be
ambiguous, unsafe, or difficult to bound:

- `undefined`, `bigint`, functions, and symbols;
- `NaN`, positive infinity, and negative infinity;
- cycles;
- class instances, `Date`, `Map`, and other non-plain objects;
- sparse arrays and unexpected array properties;
- getters, setters, and hidden properties;
- symbol keys; and
- malformed Unicode strings.

`-0` is represented as `0`, so its representation is stable.

### Limits are enforced while writing

Canonicalization has limits for depth, number of entries, array length, string
size, and output size. The writer checks the next token before appending it.
This avoids first building an oversized string and checking its size afterward.

The default limits are defined in
[`DEFAULT_CANONICALIZATION_LIMITS`](../src/workspace/digest.ts). The supported
recursion-safe maximum depth is `1024`.

## 2. Repository Paths

Filesystem APIs accept many path forms. Phase 3 converts untrusted strings into
a branded `RepositoryPath` only after validation.

```ts
import { parseRepositoryPath } from "../src/workspace/index.js";

const path = parseRepositoryPath("src/app.ts");
```

The canonical form is:

- relative to the repository root;
- separated with `/`;
- non-empty; and
- made of valid path segments.

The validator deliberately checks the original string before attempting to
normalize it. Normalizing first could hide an attack such as `../outside`.

### Examples

| Input | Result | Reason |
| --- | --- | --- |
| `src/app.ts` | accepted | Relative path with valid segments |
| `src/auth/login.ts` | accepted | Nested relative path |
| `../outside.txt` | rejected | Dot-segment traversal |
| `/etc/passwd` | rejected | Absolute path |
| `C:/secret.txt` | rejected | Drive-qualified path |
| `src\\app.ts` | rejected | Backslash is not canonical |
| `src//app.ts` | rejected | Empty path segment |
| `src/authentication.ts` under `src/auth` | not a match | Segment-aware comparison |

The validator also rejects control characters, malformed Unicode, Windows
reserved characters and device names, trailing spaces or dots, and paths that
exceed configured byte limits.

### Matching a scope

`isPathEqualOrWithin()` checks complete path segments rather than using a loose
string prefix. Therefore `src/auth` matches `src/auth/login.ts`, but does not
match `src/authentication.ts`.

Case sensitivity is explicit. Filesystem capture defaults to insensitive on
Windows and sensitive elsewhere. A caller can choose the policy when creating a
constructed snapshot or mutation scope.

## 3. Workspace Snapshots

`WorkspaceSnapshot` contains:

```ts
interface WorkspaceSnapshot {
  schemaVersion: 1;
  entries: readonly WorkspaceEntry[];
  digest: Sha256Digest;
  caseSensitivity: "sensitive" | "insensitive";
  limits: WorkspaceSnapshotLimits;
}
```

An entry represents a regular file or symlink. Directories are traversal
containers and are not returned as entries.

Regular files contain:

```ts
{
  path: RepositoryPath;
  kind: "file";
  mode: "100644" | "100755";
  contentDigest: Sha256Digest;
}
```

Symlinks contain:

```ts
{
  path: RepositoryPath;
  kind: "symlink";
  mode: "120000";
  target: string;
}
```

The snapshot digest is calculated from a domain-separated object containing the
schema version and sorted entries. It excludes the absolute root path,
timestamps, ownership, inode numbers, and capture timing. The same workspace
state under two different temporary root directories can therefore have the
same snapshot digest.

### Constructing a snapshot from trusted-looking data

`createWorkspaceSnapshot()` is useful for tests and for data already collected
by another adapter. It still validates all entries, path limits, modes, digest
formats, duplicate paths, and depth.

```ts
import {
  createWorkspaceSnapshot,
  parseRepositoryPath,
  sha256Utf8,
} from "../src/workspace/index.js";

const snapshot = createWorkspaceSnapshot([
  {
    path: parseRepositoryPath("src/app.ts"),
    kind: "file",
    mode: "100644",
    contentDigest: sha256Utf8("console.log('hello');"),
  },
]);
```

The returned snapshot and its entries are frozen. The constructor also rejects
accessor-backed and unexpected object shapes rather than reading arbitrary
properties from untrusted objects.

### Capturing the real workspace

`captureWorkspaceSnapshot(root)` performs the filesystem inspection:

1. It requires an existing, non-symlink directory as the root.
2. It resolves the root and checks physical containment.
3. It enumerates directories using bounded iteration.
4. It decodes and validates every entry name.
5. It rejects special files and unsupported hard-linked regular files.
6. It records symlink target text without following the link for traversal.
7. It verifies that a symlink target resolves inside the workspace.
8. It hashes regular files through bounded byte streaming.
9. It checks file identity before opening, after opening, after hashing, and
   during final revalidation.
10. It records traversed directories and checks their identity and child names
    before and after leaf verification.
11. It returns only when observed entries remain stable.

```ts
import { captureWorkspaceSnapshot } from "../src/workspace/index.js";

const before = await captureWorkspaceSnapshot("C:/work/repository");
```

The capture limits bound entry count, entries per directory, depth, individual
file bytes, total file bytes, symlink target bytes, path sizes, and canonical
snapshot size.

### Symlinks

Symlinks are recorded as entries instead of being traversed. Their raw target
text matters because changing the target text is a workspace change even if two
targets happen to resolve to the same object.

The target is also resolved for a physical containment check. Links that escape
the workspace, are dangling, or loop fail closed. A link that points to an
internal file is recorded but does not cause that file to be visited twice.

### Hard links

A hard link gives two directory names to the same underlying file. This makes
path-based authorization less reliable because changing one name changes the
same bytes reachable through another name. Phase 3 rejects unsupported
hard-linked regular files and includes link-count information in identity
checks.

### Race checks

The filesystem can change while it is being inspected. For example:

```text
1. piFactory sees config.json.
2. Another process replaces config.json.
3. piFactory hashes the replacement.
```

To reduce this risk, capture compares metadata at several points. It also
enumerates directories twice and compares their sorted child-name sets.

If a file or directory disappears, changes identity, changes size, changes
timestamps, or changes link count during the observation, capture returns a
`workspace_changed` error instead of returning a questionable snapshot.

POSIX file opens use `O_NOFOLLOW`. Standard Node.js APIs are still path-based,
so portable capture cannot make parent-directory resolution atomic against an
adversarial concurrent rename. This is an attestation mechanism, not a perfect
filesystem lock.

## 4. Deltas: Comparing Two Snapshots

`diffWorkspaceSnapshots(before, after)` derives changes from the snapshots. A
caller does not provide the changed-file list.

```ts
import { diffWorkspaceSnapshots } from "../src/workspace/index.js";

const delta = diffWorkspaceSnapshots(before, after);

for (const change of delta.changes) {
  console.log(change.kind, change.path);
}
```

The rules are:

- `added`: the path exists only in `after`;
- `deleted`: the path exists only in `before`; and
- `modified`: the path exists in both, but its kind, mode, content digest, or
  symlink target differs.

The result also contains the before and after snapshot digests. Changes are
sorted by path and frozen.

### Renames

A rename is represented as one deletion and one addition. Phase 3 does not
infer intent from matching content digests because a rename is still a change to
two paths.

### Case policy

Snapshots retain their case policy. On an insensitive policy, `Foo.ts` and
`foo.ts` refer to the same comparison key. Before and after snapshots must use
the same policy.

### Snapshot validation

Before diffing, both inputs are normalized and validated again. The function
rebuilds each snapshot and checks that its stored digest matches its entries.
This prevents a forged or later-mutated object from becoming mutation evidence.

## 5. Mutation Scopes: What May Change

A mutation scope is the permission boundary for a future worker. It contains
three path lists:

| Field | Meaning |
| --- | --- |
| `allowedMutationPaths` | Paths the worker may add, modify, or delete |
| `forbiddenPaths` | Paths that are never allowed |
| `relevantPaths` | Context for the task; does not grant write permission |

```ts
import {
  assessMutationScope,
  createMutationScope,
} from "../src/workspace/index.js";

const scope = createMutationScope({
  allowedMutationPaths: ["src"],
  forbiddenPaths: ["src/generated"],
});

const assessment = assessMutationScope(before, after, scope);

if (!assessment.accepted) {
  console.log(assessment.violations);
}
```

The scope is compiled once into validated repository paths. Paths are sorted,
deduplicated according to the selected case policy, and frozen.

The assessment then computes its own delta and checks every actual change:

1. Check whether the path is explicitly forbidden.
2. If it is forbidden, record `explicitly_forbidden`.
3. Otherwise check whether it equals or is below an allowed path.
4. If not, record `outside_allowed_scope`.
5. Accept only when there are no violations.

Forbidden paths always win. A missing or empty allowed-path list grants no
mutation authority. A no-op is still accepted because no actual mutation
occurred.

All violations are returned in deterministic order. This is useful for stable
logs, tests, and later persisted decisions.

## 6. Fail-Closed Errors

All safety failures use `WorkspaceError`, which has a stable `code`:

| Code | Meaning |
| --- | --- |
| `invalid_argument` | A public function received an invalid option or input container |
| `invalid_path` | A repository path failed validation |
| `invalid_digest` | A digest value has the wrong format |
| `unsupported_value` | A value cannot be represented safely |
| `invalid_snapshot` | Snapshot structure or digest evidence is invalid |
| `invalid_delta` | Delta data is invalid |
| `invalid_scope` | Mutation scope structure or paths are invalid |
| `unsafe_entry` | A file type, symlink, or physical target is unsafe |
| `workspace_changed` | The workspace was unstable during inspection |
| `size_limit_exceeded` | A configured count, byte, or depth limit was exceeded |
| `io_failure` | An unexpected filesystem operation failed |

The important behavior is that uncertain evidence does not become an accepted
result. Later orchestration code can decide whether to retry, ask for human
input, or stop, but Phase 3 never silently approves an uncertain snapshot.

## 7. What Phase 3 Guarantees

Under normal filesystem behavior, Phase 3 provides:

- deterministic digest values;
- validated repository-relative paths;
- bounded filesystem reads and traversal;
- stable file and symlink entries;
- detection of many changes during capture;
- independent final-state added, deleted, and modified changes;
- segment-aware scope matching;
- forbidden-path precedence; and
- immutable evidence objects at trust boundaries.

## 8. What Phase 3 Does Not Guarantee

Phase 3 cannot observe:

- a change that happens and is completely restored before the final snapshot;
- operating-system side effects outside the workspace;
- changes made after final revalidation;
- atomic parent-directory protection through standard cross-platform Node APIs;
- rollback of an unauthorized change; or
- that a worker's requested operation itself is safe before it is executed.

The later execution layer must place these primitives around the worker and
must decide how to handle rejection. Strict anchored filesystem traversal would
require a platform-specific native helper or an operational exclusive-access
policy.

## 9. Test Map

Phase 3 behavior is covered by focused Vitest files:

| Test file | Main behaviors |
| --- | --- |
| [`digest.test.ts`](../test/workspace/digest.test.ts) | Hash formats, canonical ordering, rejection rules, limits |
| [`path-validation.test.ts`](../test/workspace/path-validation.test.ts) | Traversal, reserved names, Unicode, limits, scope boundaries |
| [`workspace-snapshot.test.ts`](../test/workspace/workspace-snapshot.test.ts) | Files, binary data, modes, symlinks, hard links, limits, depth |
| [`workspace-snapshot-race.test.ts`](../test/workspace/workspace-snapshot-race.test.ts) | Deterministic filesystem replacement and race attestation |
| [`workspace-delta.test.ts`](../test/workspace/workspace-delta.test.ts) | Additions, deletions, modifications, renames, case policy |
| [`mutation-scope.test.ts`](../test/workspace/mutation-scope.test.ts) | Permission rules, forbidden precedence, no-op behavior, normalization |

Run the complete current verification with:

```text
pnpm typecheck
pnpm test
```

## 10. Handoff to Phase 5

Phase 5 can use the primitives around a Builder session:

```text
persist node-running state
        |
        v
capture before snapshot
        |
        v
execute one authorized Builder
        |
        v
capture after snapshot
        |
        v
compute actual delta
        |
        v
assess mutation scope
        |
        v
run targeted validation
        |
        v
accept or reject the result
```

The persistence directory must not be written inside the observed workspace
between the two captures, or piFactory's own files will appear as worker
changes. A worker-reported file list may be retained for diagnostics, but the
actual snapshot delta remains authoritative.

Phase 5 will also need to decide how to handle `workspace_changed`,
`unsafe_entry`, and scope violations. Phase 3 provides the evidence and stable
failure codes; it does not decide retry, rollback, escalation, or completion.

## Glossary

### Attestation

An observation backed by evidence, such as a before and after snapshot. It is
stronger than accepting a claim but is not the same as preventing every race.

### Canonicalization

Converting equivalent structured data into one deterministic byte representation
before hashing it.

### Delta

The derived difference between two snapshots.

### Digest

A compact fingerprint of bytes or canonical structured data.

### Fail closed

Rejecting an operation when safety cannot be proven instead of guessing that it
is safe.

### Fingerprint

An informal name for a digest.

### Mutation scope

The set of paths a worker is authorized to add, modify, or delete.

### Snapshot

A bounded, validated description of the workspace at one observation point.

### TOCTOU

"Time of check to time of use": a race where something changes between
checking it and using it.
