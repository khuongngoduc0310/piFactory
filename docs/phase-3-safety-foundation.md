# Phase 3 Safety Foundation

## Purpose

Phase 3 provides deterministic safety primitives for later worker execution. It
defines canonical digests, validates repository-relative paths, captures the
actual workspace defensively, derives final-state deltas, and evaluates those
deltas against an explicit mutation scope.

It does not execute agents or commands, schedule work, mutate the workspace,
persist snapshots, roll back changes, create worktrees, or prevent operating
system side effects. Builder wiring belongs to Phase 5.

For a plain-language implementation walkthrough with API examples, see the
[Phase 3 implementation deep dive](./phase-3-safety-foundation-deep-dive.md).

## Package Layout

```text
src/workspace/
  digest.ts
  path-validation.ts
  text-validation.ts
  workspace-snapshot.ts
  workspace-delta.ts
  mutation-scope.ts
  workspace-error.ts
  workspace-fs.ts
  index.ts

test/workspace/
  digest.test.ts
  path-validation.test.ts
  workspace-snapshot.test.ts
  workspace-snapshot-race.test.ts
  workspace-delta.test.ts
  mutation-scope.test.ts
```

All public exports are available from `src/workspace/index.ts`; text validation
and filesystem adapters remain internal implementation details.

## Digest Contract

### Raw bytes

`sha256Bytes()` hashes a `Uint8Array`. `sha256Utf8()` hashes a well-formed
Unicode string as UTF-8. `sha256ByteStream()` hashes an async sequence of byte
chunks. Every function returns:

```text
sha256:<64 lowercase hexadecimal characters>
```

Workspace files are hashed as raw bytes. Binary files are never decoded as
text.

### Canonical values

`canonicalStringify()` and `canonicalSha256()` accept only bounded JSON-like
values:

- `null`, booleans, finite numbers, strings, arrays, and plain objects;
- object keys sorted by deterministic UTF-16 code-unit order;
- array order preserved;
- `-0` represented as `0`;
- absent object properties distinct from explicit `null`;
- no `undefined`, `bigint`, functions, symbols, accessors, sparse arrays,
  cycles, Dates, Maps, class instances, symbol keys, or malformed Unicode.

Set-like data must be passed through `canonicalizeSet()` explicitly. The
serializer does not guess that an array is a set. Set entries are sorted by
their canonical representation and duplicate canonical values are removed.

Canonicalization writes through a byte-budgeted writer. It rejects an output
before appending a token that would exceed `maxOutputBytes`, including escaped
string output. Canonicalization is bounded by `DEFAULT_CANONICALIZATION_LIMITS`.
Callers may provide smaller or larger positive limits when the surrounding
safety policy allows it, up to the hard recursion-safe depth cap.

## Repository Paths

`parseRepositoryPath()` returns a branded `RepositoryPath` only after validation.
The canonical path syntax is repository-relative and uses `/` separators. The
validator does not normalize unsafe input first, because doing so could erase a
traversal attempt.

Rejected forms include:

- absolute, drive-qualified, drive-relative, UNC, device, and URL paths;
- backslashes, leading/trailing/repeated separators, and empty paths;
- `.` and `..` segments;
- NUL, C0/C1 controls, malformed Unicode, and oversized components;
- Windows-reserved characters, alternate-data-stream colons, device names,
  and trailing spaces or dots.

`isPathEqualOrWithin()` is segment-aware. A scope of `src/auth` matches
`src/auth` and `src/auth/login.ts`, but not `src/authentication.ts`.
Comparison can be explicitly case-sensitive or case-insensitive. Filesystem
capture defaults to case-insensitive on Windows and case-sensitive elsewhere.

Paths are not URL-decoded or Unicode-normalized. This avoids converting an
untrusted spelling into a different path silently.

## Snapshot Contract

### Shape

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

Entries are sorted by repository path using deterministic case-sensitive order.
The case policy is retained for collision checks and later diffing; it is not
part of the content digest.

Regular files contain a raw-byte content digest and one normalized mode:

```text
100644  non-executable regular file
100755  executable regular file on POSIX
```

Windows regular files use `100644` because POSIX executable-bit semantics are
not portable there. Symlinks contain mode `120000` and their raw target text.
Directories are traversal containers and do not appear as entries. Empty
directory creation or removal is therefore outside this snapshot model.

The snapshot digest is the canonical SHA-256 of a domain-separated object:

```ts
{
  kind: "pifactory.workspace-snapshot",
  schemaVersion: 1,
  entries,
}
```

It excludes absolute workspace roots, timestamps, inode numbers, ownership,
and capture timing.

### Defensive capture

`captureWorkspaceSnapshot(root)`:

1. Requires an existing, non-symlink directory root.
2. Enumerates directories through bounded `opendir` iteration.
3. Decodes and validates every repository entry name.
4. Rejects special files and hard-linked regular files.
5. Records symlink target text without descending through links.
6. Resolves symlink targets and requires them to remain physically inside the
   workspace; dangling and looping targets fail closed.
7. Hashes regular files through bounded streaming reads.
8. Checks `lstat` identity before opening, after opening, after hashing, and in
   a complete final revalidation pass.
9. Records every traversed directory and revalidates its identity and exact
   child-name set before and after leaf verification.
10. Verifies directory metadata before and after each enumeration.
11. Returns only after all observed entries remain stable.

POSIX opens use `O_NOFOLLOW` in addition to path and handle identity checks.
Windows uses `lstat`, real-path containment checks, and repeated identity checks;
reparse-point behavior remains dependent on the host filesystem APIs. Node's
standard cross-platform APIs are path-based and do not provide `openat`,
`fstatat`, or `readlinkat`, so these checks detect and reject observed races but
cannot make parent-directory resolution atomic against an adversarial concurrent
rename.

Defaults bound entry count, per-directory entries, traversal depth, per-file
bytes, total hashed bytes, symlink target bytes, path sizes, and canonical
serialization size. Unstable or over-limit workspaces return a `WorkspaceError`
instead of a partial snapshot.

`maxDepth` counts repository path segments below the workspace root. The root is
depth `0`; a root-level file is depth `1`; a child of a root-level directory is
depth `2`. Directory containers at the configured depth may be inspected, but
their children are rejected when they would exceed the limit.

Both canonicalization and filesystem capture reject a configured depth above
their supported recursion-safe cap of 1024 rather than allowing stack exhaustion.

## Delta Contract

`diffWorkspaceSnapshots(before, after)` independently derives final-state
changes:

- `added`: only in `after`;
- `deleted`: only in `before`;
- `modified`: same path but different kind, mode, content digest, or symlink
  target.

The single `changes` array is path-sorted and frozen. A rename is represented as
one deletion and one addition. A file changed and was restored before the final
snapshot is unchanged by definition; snapshots are not an operation audit log.

Snapshots retain their effective case policy. On case-insensitive filesystems,
case-only spellings refer to the same path during diffing. Before and after
snapshots must use the same policy.

## Mutation Scope Contract

`createMutationScope()` compiles the path portions of a `WorkNode.scope`-shaped
object. It does not import or mutate domain types.

Rules:

- missing or empty `allowedMutationPaths` authorizes no mutation;
- a no-change before/after pair is accepted even with no allowed paths;
- exact paths and all descendants can be authorized;
- `forbiddenPaths` always wins over allowed paths;
- `relevantPaths` is metadata only and never grants write authority;
- every actual addition, modification, and deletion is checked;
- any violation rejects the complete assessment;
- all violations are returned in deterministic order.

`MutationScopeOptions.pathLimits` can widen path validation consistently with a
snapshot's custom path limits. Assessment uses paths from normalized snapshots
and does not silently reapply default path limits.

The assessment API is intentionally snapshot-based:

```ts
const scope = createMutationScope(workNode.scope);
const assessment = assessMutationScope(before, after, scope);
```

It computes its own delta. A worker-reported changed-file list or caller-
supplied delta cannot be used as the mutation authority. `WorkspaceError` is
returned for invalid snapshots or scopes before assessment can succeed.

## Later-Phase Integration

Phase 5 can place the primitives around a Builder session:

```text
persist node-running state
        |
        v
capture before snapshot
        |
execute one authorized Builder
        |
capture after snapshot
        |
assess before/after against compiled mutation scope
        |
accept or reject result using actual delta evidence
```

The persistence directory must not be written into the observed workspace
between the two captures, or piFactory's own files will appear as worker
changes. Worker changed-file reports may be retained as claims for diagnostics,
but actual snapshot deltas remain authoritative.

Phase 3 does not decide retry, rollback, rebase, scheduler state, artifact
acceptance, or human escalation. Those are later application-layer policies.

Phase 3 is an attestation layer, not a prevention or rollback mechanism. It
cannot observe transient changes that are restored before the final snapshot,
external side effects, or changes made after the final revalidation. Portable
Node path-based capture also cannot prevent a parent path from redirecting
between checks; it fails closed when the replacement remains observable. Strict
anchored traversal would require a platform-specific native helper or an
operational exclusive-access policy. Phase 5 will place these primitives around
Builder execution; Phase 3 does not execute workers, commands, schedulers, or
agents.

## Verification

The Phase 3 tests cover digest vectors and rejection cases, path traversal and
prefix confusion, binary and executable files, deterministic ordering, bounded
enumeration, canonical output limits, array-shape validation, depth boundaries,
hard-link rejection, symlink metadata and containment where the host permits
link creation, mode/type changes, case-aware deltas, normalized untrusted
snapshots and scopes, scope precedence, no-op behavior, and deterministic
temporary-workspace race attestation.

Run the complete verification suite with:

```text
pnpm typecheck
pnpm test
```

On hosts that deny symlink creation, the link-specific tests are skipped by the
test harness. The non-link path, digest, snapshot, delta, and scope tests still
run and must pass.
