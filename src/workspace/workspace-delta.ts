import { isSha256Digest, type Sha256Digest } from "./digest.js";
import {
  createWorkspaceSnapshot,
  type WorkspaceEntry,
  type WorkspaceSnapshot,
} from "./workspace-snapshot.js";
import { WorkspaceError } from "./workspace-error.js";

export type WorkspaceChange =
  | {
      readonly kind: "added";
      readonly path: WorkspaceEntry["path"];
      readonly after: WorkspaceEntry;
    }
  | {
      readonly kind: "modified";
      readonly path: WorkspaceEntry["path"];
      readonly before: WorkspaceEntry;
      readonly after: WorkspaceEntry;
    }
  | {
      readonly kind: "deleted";
      readonly path: WorkspaceEntry["path"];
      readonly before: WorkspaceEntry;
    };

export interface WorkspaceDelta {
  readonly beforeDigest: Sha256Digest;
  readonly afterDigest: Sha256Digest;
  readonly changes: readonly WorkspaceChange[];
}

function entriesEqual(left: WorkspaceEntry, right: WorkspaceEntry): boolean {
  if (left.kind !== right.kind || left.mode !== right.mode) {
    return false;
  }
  return left.kind === "file"
    ? right.kind === "file" && left.contentDigest === right.contentDigest
    : right.kind === "symlink" && left.target === right.target;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function materializeSnapshotFields(
  snapshot: WorkspaceSnapshot,
  label: string,
): Record<string, unknown> {
  if (
    !isPlainRecord(snapshot)
  ) {
    throw new WorkspaceError("invalid_snapshot", `${label} is not a valid workspace snapshot`);
  }
  const expectedKeys = new Set(["schemaVersion", "entries", "digest", "caseSensitivity", "limits"]);
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(snapshot)) {
    if (typeof key !== "string" || !expectedKeys.has(key)) {
      throw new WorkspaceError("invalid_snapshot", `${label} contains unsupported fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(snapshot, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw new WorkspaceError("invalid_snapshot", `${label} contains an accessor or hidden property`);
    }
    fields[key] = descriptor.value;
  }
  if ([...expectedKeys].some((key) => !Object.prototype.hasOwnProperty.call(fields, key))) {
    throw new WorkspaceError("invalid_snapshot", `${label} is missing required fields`);
  }
  return fields;
}

function normalizeSnapshot(snapshot: WorkspaceSnapshot, label: string): WorkspaceSnapshot {
  const fields = materializeSnapshotFields(snapshot, label);
  if (
    fields.schemaVersion !== 1 ||
    !Array.isArray(fields.entries) ||
    !isSha256Digest(fields.digest) ||
    (fields.caseSensitivity !== "sensitive" && fields.caseSensitivity !== "insensitive") ||
    !isPlainRecord(fields.limits)
  ) {
    throw new WorkspaceError("invalid_snapshot", `${label} is not a valid workspace snapshot`);
  }
  const limitKeys = [
    "maxEntries",
    "maxDirectoryEntries",
    "maxDepth",
    "maxFileBytes",
    "maxTotalBytes",
    "maxSymlinkTargetBytes",
    "maxCanonicalBytes",
    "maxPathBytes",
    "maxSegmentBytes",
  ];
  const limitKeySet = new Set(limitKeys);
  for (const key of Reflect.ownKeys(fields.limits)) {
    if (typeof key !== "string" || !limitKeySet.has(key)) {
      throw new WorkspaceError("invalid_snapshot", `${label} contains unsupported limit fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(fields.limits, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw new WorkspaceError("invalid_snapshot", `${label} contains invalid limit fields`);
    }
  }
  if (limitKeys.some((key) => !Object.prototype.hasOwnProperty.call(fields.limits, key))) {
    throw new WorkspaceError("invalid_snapshot", `${label} is missing required limit fields`);
  }
  let rebuilt: WorkspaceSnapshot;
  try {
    rebuilt = createWorkspaceSnapshot(fields.entries, {
      caseSensitivity: fields.caseSensitivity,
      limits: fields.limits,
    });
  } catch (error) {
    throw new WorkspaceError("invalid_snapshot", `${label} is not a valid workspace snapshot`, {
      cause: error,
    });
  }
  if (rebuilt.digest !== fields.digest) {
    throw new WorkspaceError("invalid_snapshot", `${label} digest does not match its entries`);
  }
  return rebuilt;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceDelta {
  const normalizedBefore = normalizeSnapshot(before, "Before snapshot");
  const normalizedAfter = normalizeSnapshot(after, "After snapshot");
  if (normalizedBefore.caseSensitivity !== normalizedAfter.caseSensitivity) {
    throw new WorkspaceError("invalid_snapshot", "Workspace snapshots use different case policies");
  }
  const pathKey = (path: string): string =>
    normalizedBefore.caseSensitivity === "insensitive" ? path.toLowerCase() : path;
  const beforeByPath = new Map(normalizedBefore.entries.map((entry) => [pathKey(entry.path), entry]));
  const afterByPath = new Map(normalizedAfter.entries.map((entry) => [pathKey(entry.path), entry]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort(comparePaths);
  const changes: WorkspaceChange[] = [];
  for (const key of paths) {
    const beforeEntry = beforeByPath.get(key);
    const afterEntry = afterByPath.get(key);
    const path = afterEntry?.path ?? beforeEntry?.path;
    if (path === undefined) {
      throw new WorkspaceError("invalid_snapshot", "Workspace delta contains an unresolvable path");
    }
    if (beforeEntry === undefined && afterEntry !== undefined) {
      changes.push(Object.freeze({ kind: "added", path, after: afterEntry }));
    } else if (beforeEntry !== undefined && afterEntry === undefined) {
      changes.push(Object.freeze({ kind: "deleted", path, before: beforeEntry }));
    } else if (
      beforeEntry !== undefined &&
      afterEntry !== undefined &&
      !entriesEqual(beforeEntry, afterEntry)
    ) {
      changes.push(Object.freeze({ kind: "modified", path, before: beforeEntry, after: afterEntry }));
    }
  }
  return Object.freeze({
    beforeDigest: normalizedBefore.digest,
    afterDigest: normalizedAfter.digest,
    changes: Object.freeze(changes),
  });
}
