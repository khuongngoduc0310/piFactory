import { constants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  canonicalSha256,
  DEFAULT_CANONICALIZATION_LIMITS,
  isSha256Digest,
  sha256ByteStream,
  type CanonicalizationLimits,
  type Sha256Digest,
} from "./digest.js";
import {
  DEFAULT_PATH_VALIDATION_LIMITS,
  parseRepositoryPath,
  type PathCaseSensitivity,
  type PathValidationOptions,
  type RepositoryPath,
} from "./path-validation.js";
import {
  NODE_WORKSPACE_FILE_SYSTEM,
  type WorkspaceFileSystem,
} from "./workspace-fs.js";
import { WorkspaceError } from "./workspace-error.js";
import { hasControlCharacter, isWellFormedString } from "./text-validation.js";

export const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type WorkspaceFileMode = "100644" | "100755" | "120000";

export type WorkspaceEntry =
  | {
      readonly path: RepositoryPath;
      readonly kind: "file";
      readonly mode: "100644" | "100755";
      readonly contentDigest: Sha256Digest;
    }
  | {
      readonly path: RepositoryPath;
      readonly kind: "symlink";
      readonly mode: "120000";
      readonly target: string;
    };

export interface WorkspaceSnapshot {
  readonly schemaVersion: typeof WORKSPACE_SNAPSHOT_SCHEMA_VERSION;
  readonly entries: readonly WorkspaceEntry[];
  readonly digest: Sha256Digest;
  readonly caseSensitivity: PathCaseSensitivity;
  readonly limits: WorkspaceSnapshotLimits;
}

export interface WorkspaceSnapshotLimits {
  readonly maxEntries: number;
  readonly maxDirectoryEntries: number;
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxSymlinkTargetBytes: number;
  readonly maxCanonicalBytes: number;
  readonly maxPathBytes: number;
  readonly maxSegmentBytes: number;
}

export const DEFAULT_WORKSPACE_SNAPSHOT_LIMITS: WorkspaceSnapshotLimits = Object.freeze({
  maxEntries: 100_000,
  maxDirectoryEntries: 10_000,
  maxDepth: 64,
  maxFileBytes: 128 * 1_024 * 1_024,
  maxTotalBytes: 512 * 1_024 * 1_024,
  maxSymlinkTargetBytes: 4 * 1_024,
  maxCanonicalBytes: 64 * 1_024 * 1_024,
  maxPathBytes: DEFAULT_PATH_VALIDATION_LIMITS.maxPathBytes,
  maxSegmentBytes: DEFAULT_PATH_VALIDATION_LIMITS.maxSegmentBytes,
});

const MAX_WORKSPACE_SNAPSHOT_DEPTH = 1_024;

export interface WorkspaceSnapshotOptions {
  readonly limits?: Partial<WorkspaceSnapshotLimits>;
  readonly caseSensitivity?: PathCaseSensitivity;
}

interface SnapshotContext {
  readonly root: string;
  readonly limits: WorkspaceSnapshotLimits;
  readonly pathOptions: PathValidationOptions;
  readonly fileSystem: WorkspaceFileSystem;
  readonly entries: WorkspaceEntry[];
  readonly observed: ObservedEntry[];
  totalBytes: number;
  visitedEntryCount: number;
}

type ObservedEntry =
  | {
      readonly kind: "directory";
      readonly absolutePath: string;
      readonly stats: Stats;
      readonly names: readonly string[];
    }
  | {
      readonly path: RepositoryPath;
      readonly absolutePath: string;
      readonly kind: "file";
      readonly stats: Stats;
      readonly contentDigest: Sha256Digest;
    }
  | {
      readonly path: RepositoryPath;
      readonly absolutePath: string;
      readonly kind: "symlink";
      readonly stats: Stats;
      readonly target: string;
    };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isWorkspaceChangedError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  errorCode: "invalid_snapshot" | "invalid_argument" = "invalid_snapshot",
): void {
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new WorkspaceError(errorCode, `${label} contains unsupported fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new WorkspaceError(errorCode, `${label} contains an accessor or hidden property`);
    }
  }
}

function assertRequiredKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  assertAllowedKeys(value, keys, label);
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new WorkspaceError("invalid_snapshot", `${label} is missing required fields`);
  }
}

function assertSupportedLimitKeys(
  value: Partial<WorkspaceSnapshotLimits> | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new WorkspaceError("invalid_argument", "Workspace limits must be a plain object");
  }
  assertAllowedKeys(
    value,
    [
      "maxEntries",
      "maxDirectoryEntries",
      "maxDepth",
      "maxFileBytes",
      "maxTotalBytes",
      "maxSymlinkTargetBytes",
      "maxCanonicalBytes",
      "maxPathBytes",
      "maxSegmentBytes",
    ],
    "Workspace limits",
    "invalid_argument",
  );
}

function readSnapshotOptions(options: WorkspaceSnapshotOptions): {
  readonly limits: Partial<WorkspaceSnapshotLimits> | undefined;
  readonly caseSensitivity: unknown;
} {
  if (!isRecord(options)) {
    throw new WorkspaceError("invalid_argument", "Workspace snapshot options must be a plain object");
  }
  const allowed = new Set(["limits", "caseSensitivity"]);
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(options, key) : undefined;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw new WorkspaceError("invalid_argument", "Workspace snapshot options contain unsupported fields");
    }
  }
  const record = options as unknown as Record<string, unknown>;
  return {
    limits: record.limits as Partial<WorkspaceSnapshotLimits> | undefined,
    caseSensitivity: record.caseSensitivity,
  };
}

function mergeLimits(custom: Partial<WorkspaceSnapshotLimits> | undefined): WorkspaceSnapshotLimits {
  assertSupportedLimitKeys(custom);
  const limits = Object.freeze({
    ...DEFAULT_WORKSPACE_SNAPSHOT_LIMITS,
    ...(custom ?? {}),
  });
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new WorkspaceError("invalid_argument", `Workspace limit ${field} is invalid`);
    }
  }
  if (limits.maxDepth > MAX_WORKSPACE_SNAPSHOT_DEPTH) {
    throw new WorkspaceError("invalid_argument", "Workspace maxDepth exceeds its supported limit");
  }
  return limits;
}

function defaultCaseSensitivity(): PathCaseSensitivity {
  return process.platform === "win32" ? "insensitive" : "sensitive";
}

function comparePaths(
  left: string,
  right: string,
  caseSensitivity: PathCaseSensitivity,
): number {
  const normalizedLeft = caseSensitivity === "insensitive" ? left.toLowerCase() : left;
  const normalizedRight = caseSensitivity === "insensitive" ? right.toLowerCase() : right;
  if (normalizedLeft < normalizedRight) {
    return -1;
  }
  if (normalizedLeft > normalizedRight) {
    return 1;
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalizationLimits(
  limits: WorkspaceSnapshotLimits,
): Partial<CanonicalizationLimits> {
  return {
    maxEntries: Math.max(DEFAULT_CANONICALIZATION_LIMITS.maxEntries, limits.maxEntries * 8),
    maxArrayLength: Math.max(DEFAULT_CANONICALIZATION_LIMITS.maxArrayLength, limits.maxEntries),
    maxStringBytes: Math.max(
      DEFAULT_CANONICALIZATION_LIMITS.maxStringBytes,
      limits.maxPathBytes,
      limits.maxSegmentBytes,
      limits.maxSymlinkTargetBytes,
    ),
    maxOutputBytes: limits.maxCanonicalBytes,
  };
}

function pathOptions(limits: WorkspaceSnapshotLimits): PathValidationOptions {
  return {
    limits: {
      maxPathBytes: limits.maxPathBytes,
      maxSegmentBytes: limits.maxSegmentBytes,
    },
  };
}

function assertSymlinkTarget(target: string, limits: WorkspaceSnapshotLimits): void {
  if (
    target.length === 0 ||
    !isWellFormedString(target) ||
    hasControlCharacter(target) ||
    Buffer.byteLength(target, "utf8") > limits.maxSymlinkTargetBytes
  ) {
    throw new WorkspaceError("unsafe_entry", "Symlink target is invalid or exceeds its size limit");
  }
}

function freezeEntry(entry: WorkspaceEntry): WorkspaceEntry {
  return Object.freeze(entry);
}

function validateEntry(
  value: unknown,
  limits: WorkspaceSnapshotLimits,
): WorkspaceEntry {
  if (!isRecord(value)) {
    throw new WorkspaceError("invalid_snapshot", "Workspace snapshot entry must be an object");
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    kindDescriptor === undefined ||
    !kindDescriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(kindDescriptor, "value")
  ) {
    throw new WorkspaceError("invalid_snapshot", "Workspace snapshot entry kind is invalid");
  }
  if (kindDescriptor.value === "file") {
    assertRequiredKeys(value, ["path", "kind", "mode", "contentDigest"], "File snapshot entry");
    const path = parseRepositoryPath(value.path, pathOptions(limits));
    if (
      (value.mode !== "100644" && value.mode !== "100755") ||
      !isSha256Digest(value.contentDigest)
    ) {
      throw new WorkspaceError("invalid_snapshot", "File snapshot entry has invalid metadata");
    }
    return freezeEntry({
      path,
      kind: "file",
      mode: value.mode,
      contentDigest: value.contentDigest,
    });
  }
  if (kindDescriptor.value === "symlink") {
    assertRequiredKeys(value, ["path", "kind", "mode", "target"], "Symlink snapshot entry");
    const path = parseRepositoryPath(value.path, pathOptions(limits));
    if (value.mode !== "120000" || typeof value.target !== "string") {
      throw new WorkspaceError("invalid_snapshot", "Symlink snapshot entry has invalid metadata");
    }
    assertSymlinkTarget(value.target, limits);
    return freezeEntry({ path, kind: "symlink", mode: "120000", target: value.target });
  }
  throw new WorkspaceError("invalid_snapshot", "Workspace snapshot entry kind is unsupported");
}

function assertNoDuplicatePaths(
  entries: readonly WorkspaceEntry[],
  caseSensitivity: PathCaseSensitivity,
): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    const key = caseSensitivity === "insensitive" ? entry.path.toLowerCase() : entry.path;
    if (paths.has(key)) {
      throw new WorkspaceError("invalid_snapshot", `Duplicate workspace path ${entry.path}`);
    }
    paths.add(key);
  }
}

function createSnapshotWithLimits(
  entries: readonly WorkspaceEntry[],
  limits: WorkspaceSnapshotLimits,
  caseSensitivity: PathCaseSensitivity,
): WorkspaceSnapshot {
  if (Object.getPrototypeOf(entries) !== Array.prototype) {
    throw new WorkspaceError("invalid_snapshot", "Workspace snapshot entries must use the standard array prototype");
  }
  if (entries.length > limits.maxEntries) {
    throw new WorkspaceError("size_limit_exceeded", "Workspace snapshot contains too many entries");
  }
  const ownNames = Object.getOwnPropertyNames(entries);
  const expectedNames = new Set<string>(["length"]);
  for (let index = 0; index < entries.length; index += 1) {
    expectedNames.add(String(index));
  }
  if (
    ownNames.length !== expectedNames.size ||
    ownNames.some((name) => !expectedNames.has(name)) ||
    Object.getOwnPropertySymbols(entries).length > 0
  ) {
    throw new WorkspaceError("invalid_snapshot", "Workspace snapshot entries must be dense");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw new WorkspaceError("invalid_snapshot", "Workspace snapshot entries must be data values");
    }
  }
  const validated = entries.map((entry) => validateEntry(entry, limits));
  for (const entry of validated) {
    if (entry.path.split("/").length > limits.maxDepth) {
      throw new WorkspaceError("size_limit_exceeded", `Workspace path exceeds its depth limit: ${entry.path}`);
    }
  }
  assertNoDuplicatePaths(validated, caseSensitivity);
  // Snapshot bytes must be portable; case policy only affects collision checks.
  validated.sort((left, right) => comparePaths(left.path, right.path, "sensitive"));
  const frozenEntries = Object.freeze(validated);
  const digest = canonicalSha256(
    {
      kind: "pifactory.workspace-snapshot",
      schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
      entries: frozenEntries,
    },
    canonicalizationLimits(limits),
  );
  return Object.freeze({
    schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
    entries: frozenEntries,
    digest,
    caseSensitivity,
    limits,
  });
}

export function createWorkspaceSnapshot(
  entries: readonly WorkspaceEntry[],
  options: WorkspaceSnapshotOptions = {},
): WorkspaceSnapshot {
  if (!Array.isArray(entries)) {
    throw new WorkspaceError("invalid_argument", "Workspace snapshot entries must be an array");
  }
  const snapshotOptions = readSnapshotOptions(options);
  const limits = mergeLimits(snapshotOptions.limits);
  if (
    snapshotOptions.caseSensitivity !== undefined &&
    snapshotOptions.caseSensitivity !== "sensitive" &&
    snapshotOptions.caseSensitivity !== "insensitive"
  ) {
    throw new WorkspaceError("invalid_argument", "Workspace case sensitivity is invalid");
  }
  return createSnapshotWithLimits(
    entries,
    limits,
    snapshotOptions.caseSensitivity === undefined
      ? defaultCaseSensitivity()
      : snapshotOptions.caseSensitivity,
  );
}

function statFingerprint(stats: Stats): string {
  return [stats.dev, stats.ino, stats.nlink, stats.mode, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

function assertStableStats(before: Stats, after: Stats, path: string): void {
  if (statFingerprint(before) !== statFingerprint(after)) {
    throw new WorkspaceError("workspace_changed", `Workspace entry changed while being inspected: ${path}`);
  }
}

async function inspectStats(
  fileSystem: WorkspaceFileSystem,
  path: string,
  label: string,
): Promise<Stats> {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isWorkspaceChangedError(error)) {
      throw new WorkspaceError("workspace_changed", `${label} disappeared while being inspected`, {
        cause: error,
      });
    }
    throw new WorkspaceError("io_failure", `Could not inspect ${label}`, { cause: error });
  }
}

function assertDirectory(stats: Stats, path: string): void {
  if (stats.isSymbolicLink()) {
    throw new WorkspaceError("unsafe_entry", `Directory symlink traversal is not allowed: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceError("unsafe_entry", `Workspace root is not a directory: ${path}`);
  }
}

function assertContained(root: string, candidate: string): void {
  const containment = relative(resolve(root), resolve(candidate));
  if (containment !== "" && (containment.startsWith("..") || isAbsolute(containment))) {
    throw new WorkspaceError("unsafe_entry", `Workspace entry escapes its root: ${candidate}`);
  }
}

async function assertRealPathContained(
  fileSystem: WorkspaceFileSystem,
  root: string,
  candidate: string,
  missingCode: "unsafe_entry" | "workspace_changed" = "unsafe_entry",
): Promise<void> {
  let resolvedCandidate: string;
  try {
    resolvedCandidate = await fileSystem.realpath(candidate);
  } catch (error) {
    if (missingCode === "workspace_changed" && isWorkspaceChangedError(error)) {
      throw new WorkspaceError("workspace_changed", `Workspace entry disappeared while being resolved: ${candidate}`, {
        cause: error,
      });
    }
    if (isWorkspaceChangedError(error) || errorCode(error) === "ELOOP") {
      throw new WorkspaceError("unsafe_entry", `Workspace entry target cannot be resolved: ${candidate}`, {
        cause: error,
      });
    }
    throw new WorkspaceError("io_failure", `Could not resolve workspace entry: ${candidate}`, { cause: error });
  }
  assertContained(root, resolvedCandidate);
}

function decodeUtf8(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new WorkspaceError("unsafe_entry", `${label} is not valid UTF-8`, { cause: error });
  }
}

async function readDirectoryNames(
  fileSystem: WorkspaceFileSystem,
  path: string,
  maxEntries: number,
): Promise<string[]> {
  let directory;
  try {
    directory = await fileSystem.opendir(path, { bufferSize: 32, encoding: "buffer" });
  } catch (error) {
    if (isWorkspaceChangedError(error)) {
      throw new WorkspaceError("workspace_changed", `Directory disappeared while being read: ${path}`, {
        cause: error,
      });
    }
    throw new WorkspaceError("io_failure", `Could not read workspace directory ${path}`, { cause: error });
  }
  try {
    const names: string[] = [];
    for await (const entry of directory) {
      if (names.length >= maxEntries) {
        throw new WorkspaceError(
          "size_limit_exceeded",
          `Workspace directory contains too many entries: ${path}`,
        );
      }
      const name = Buffer.isBuffer(entry.name)
        ? decodeUtf8(entry.name, `Directory entry in ${path}`)
        : entry.name;
      names.push(name);
    }
    names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return names;
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    if (isWorkspaceChangedError(error)) {
      throw new WorkspaceError("workspace_changed", `Workspace directory changed while being read: ${path}`, {
        cause: error,
      });
    }
    throw new WorkspaceError("io_failure", `Could not read workspace directory ${path}`, { cause: error });
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function readStableDirectoryNames(
  fileSystem: WorkspaceFileSystem,
  path: string,
  maxEntries: number,
): Promise<{ names: readonly string[]; stats: Stats }> {
  const before = await inspectStats(fileSystem, path, path);
  assertDirectory(before, path);
  const first = await readDirectoryNames(fileSystem, path, maxEntries);
  const afterFirst = await inspectStats(fileSystem, path, path);
  assertStableStats(before, afterFirst, path);
  const second = await readDirectoryNames(fileSystem, path, maxEntries);
  const afterSecond = await inspectStats(fileSystem, path, path);
  assertStableStats(afterFirst, afterSecond, path);
  if (first.length !== second.length || first.some((name, index) => name !== second[index])) {
    throw new WorkspaceError("workspace_changed", `Directory changed while being read: ${path}`);
  }
  return { names: first, stats: before };
}

async function hashFile(
  path: string,
  initialStats: Stats,
  context: SnapshotContext,
): Promise<Sha256Digest> {
  if (initialStats.size > context.limits.maxFileBytes) {
    throw new WorkspaceError("size_limit_exceeded", `Workspace file is too large: ${path}`);
  }
  if (context.totalBytes + initialStats.size > context.limits.maxTotalBytes) {
    throw new WorkspaceError("size_limit_exceeded", "Workspace snapshot exceeds its total byte limit");
  }
  let handle: FileHandle | undefined;
  let fileBytes = 0;
  try {
    const flags =
      process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await context.fileSystem.open(path, flags);
    const openedStats = await handle.stat();
    const openedPathStats = await inspectStats(context.fileSystem, path, path);
    if (
      !openedStats.isFile() ||
      openedPathStats.isSymbolicLink() ||
      statFingerprint(openedStats) !== statFingerprint(initialStats) ||
      statFingerprint(openedPathStats) !== statFingerprint(initialStats)
    ) {
      throw new WorkspaceError("workspace_changed", `Workspace file changed while opening: ${path}`);
    }
    await assertRealPathContained(context.fileSystem, context.root, path, "workspace_changed");
    const digest = await sha256ByteStream((async function* (): AsyncGenerator<Uint8Array> {
      while (true) {
        const remaining = context.limits.maxFileBytes + 1 - fileBytes;
        if (remaining <= 0) {
          throw new WorkspaceError("size_limit_exceeded", `Workspace file is too large: ${path}`);
        }
        const buffer = Buffer.alloc(Math.min(64 * 1_024, remaining));
        const result = await handle.read(buffer, 0, buffer.byteLength, null);
        if (result.bytesRead === 0) {
          return;
        }
        fileBytes += result.bytesRead;
        context.totalBytes += result.bytesRead;
        if (context.totalBytes > context.limits.maxTotalBytes) {
          throw new WorkspaceError("size_limit_exceeded", "Workspace snapshot exceeds its total byte limit");
        }
        yield buffer.subarray(0, result.bytesRead);
      }
    })());
    const finalStats = await handle.stat();
    const finalPathStats = await inspectStats(context.fileSystem, path, path);
    if (
      !finalStats.isFile() ||
      finalPathStats.isSymbolicLink() ||
      !finalPathStats.isFile() ||
      statFingerprint(finalStats) !== statFingerprint(initialStats) ||
      statFingerprint(finalPathStats) !== statFingerprint(initialStats)
    ) {
      throw new WorkspaceError("workspace_changed", `Workspace file changed while being hashed: ${path}`);
    }
    await assertRealPathContained(context.fileSystem, context.root, path, "workspace_changed");
    return digest;
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    if (isWorkspaceChangedError(error)) {
      throw new WorkspaceError("workspace_changed", `Workspace file disappeared while being hashed: ${path}`, {
        cause: error,
      });
    }
    throw new WorkspaceError("io_failure", `Could not hash workspace file ${path}`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function captureSymlink(
  fileSystem: WorkspaceFileSystem,
  path: string,
  initialStats: Stats,
  context: SnapshotContext,
  repositoryPath: RepositoryPath,
): Promise<void> {
  let targetBuffer: Buffer;
  try {
    targetBuffer = await fileSystem.readlink(path, { encoding: "buffer" });
  } catch (error) {
    if (isWorkspaceChangedError(error)) {
      throw new WorkspaceError("workspace_changed", `Symlink disappeared while being read: ${path}`, { cause: error });
    }
    throw new WorkspaceError("io_failure", `Could not read symlink target: ${path}`, { cause: error });
  }
  const target = decodeUtf8(targetBuffer, `Symlink target ${path}`);
  assertSymlinkTarget(target, context.limits);
  await assertRealPathContained(fileSystem, context.root, path);
  const finalStats = await inspectStats(fileSystem, path, path);
  assertStableStats(initialStats, finalStats, path);
  context.entries.push(
    freezeEntry({ path: repositoryPath, kind: "symlink", mode: "120000", target }),
  );
  context.observed.push({
    path: repositoryPath,
    absolutePath: path,
    kind: "symlink",
    stats: initialStats,
    target,
  });
}

async function scanDirectory(
  path: string,
  relativeSegments: readonly string[],
  context: SnapshotContext,
): Promise<void> {
  if (relativeSegments.length > context.limits.maxDepth) {
    throw new WorkspaceError("size_limit_exceeded", `Workspace path exceeds its depth limit: ${path}`);
  }
  await assertRealPathContained(context.fileSystem, context.root, path, "workspace_changed");
  const directory = await readStableDirectoryNames(
    context.fileSystem,
    path,
    context.limits.maxDirectoryEntries,
  );
  context.observed.push({
    kind: "directory",
    absolutePath: path,
    stats: directory.stats,
    names: Object.freeze([...directory.names]),
  });
  for (const name of directory.names) {
    const nextSegments = [...relativeSegments, name];
    if (nextSegments.length > context.limits.maxDepth) {
      throw new WorkspaceError("size_limit_exceeded", `Workspace path exceeds its depth limit: ${join(path, name)}`);
    }
    const repositoryPath = parseRepositoryPath(nextSegments.join("/"), context.pathOptions);
    const entryPath = join(path, name);
    assertContained(context.root, entryPath);
    context.visitedEntryCount += 1;
    if (context.visitedEntryCount > context.limits.maxEntries) {
      throw new WorkspaceError("size_limit_exceeded", "Workspace snapshot contains too many entries");
    }
    const stats = await inspectStats(context.fileSystem, entryPath, entryPath);
    if (stats.isDirectory()) {
      await assertRealPathContained(context.fileSystem, context.root, entryPath, "workspace_changed");
      await scanDirectory(entryPath, nextSegments, context);
      const finalStats = await inspectStats(context.fileSystem, entryPath, entryPath);
      assertStableStats(stats, finalStats, entryPath);
      continue;
    }
    if (stats.isSymbolicLink()) {
      await captureSymlink(context.fileSystem, entryPath, stats, context, repositoryPath);
      continue;
    }
    if (stats.isFile()) {
      if (stats.nlink > 1) {
        throw new WorkspaceError("unsafe_entry", `Hard-linked workspace files are not supported: ${entryPath}`);
      }
      await assertRealPathContained(context.fileSystem, context.root, entryPath, "workspace_changed");
      const contentDigest = await hashFile(entryPath, stats, context);
      const mode: "100644" | "100755" =
        process.platform !== "win32" && (stats.mode & 0o111) !== 0 ? "100755" : "100644";
      context.entries.push(freezeEntry({ path: repositoryPath, kind: "file", mode, contentDigest }));
      context.observed.push({
        path: repositoryPath,
        absolutePath: entryPath,
        kind: "file",
        stats,
        contentDigest,
      });
      continue;
    }
    throw new WorkspaceError("unsafe_entry", `Unsupported workspace entry type: ${entryPath}`);
  }
  const finalDirectoryStats = await inspectStats(context.fileSystem, path, path);
  assertStableStats(directory.stats, finalDirectoryStats, path);
}

function namesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

async function revalidateObservedDirectories(context: SnapshotContext): Promise<void> {
  for (const observed of context.observed) {
    if (observed.kind !== "directory") {
      continue;
    }
    await assertRealPathContained(context.fileSystem, context.root, observed.absolutePath, "workspace_changed");
    const current = await readStableDirectoryNames(
      context.fileSystem,
      observed.absolutePath,
      context.limits.maxDirectoryEntries,
    );
    assertStableStats(observed.stats, current.stats, observed.absolutePath);
    if (!namesEqual(observed.names, current.names)) {
      throw new WorkspaceError(
        "workspace_changed",
        `Directory contents changed after inspection: ${observed.absolutePath}`,
      );
    }
  }
}

async function revalidateObservedLeaves(context: SnapshotContext): Promise<void> {
  const verificationContext: SnapshotContext = {
    root: context.root,
    limits: context.limits,
    pathOptions: context.pathOptions,
    fileSystem: context.fileSystem,
    entries: [],
    observed: [],
    totalBytes: 0,
    visitedEntryCount: 0,
  };
  for (const observed of context.observed) {
    if (observed.kind === "directory") {
      continue;
    }
    const currentStats = await inspectStats(context.fileSystem, observed.absolutePath, observed.absolutePath);
    if (
      (observed.kind === "file" && (currentStats.isSymbolicLink() || !currentStats.isFile())) ||
      (observed.kind === "symlink" && !currentStats.isSymbolicLink()) ||
      statFingerprint(currentStats) !== statFingerprint(observed.stats)
    ) {
      throw new WorkspaceError(
        "workspace_changed",
        `Workspace entry changed after inspection: ${observed.absolutePath}`,
      );
    }
    if (observed.kind === "file") {
      if (currentStats.nlink > 1) {
        throw new WorkspaceError("unsafe_entry", `Hard-linked workspace files are not supported: ${observed.absolutePath}`);
      }
      await assertRealPathContained(context.fileSystem, context.root, observed.absolutePath, "workspace_changed");
      const currentDigest = await hashFile(observed.absolutePath, currentStats, verificationContext);
      if (currentDigest !== observed.contentDigest) {
        throw new WorkspaceError(
          "workspace_changed",
          `Workspace file changed after inspection: ${observed.absolutePath}`,
        );
      }
    } else {
      let targetBuffer: Buffer;
      try {
        targetBuffer = await context.fileSystem.readlink(observed.absolutePath, { encoding: "buffer" });
      } catch (error) {
        if (isWorkspaceChangedError(error)) {
          throw new WorkspaceError(
            "workspace_changed",
            `Symlink changed after inspection: ${observed.absolutePath}`,
            { cause: error },
          );
        }
        throw new WorkspaceError(
          "io_failure",
          `Could not reread symlink target: ${observed.absolutePath}`,
          { cause: error },
        );
      }
      const target = decodeUtf8(targetBuffer, `Symlink target ${observed.absolutePath}`);
      assertSymlinkTarget(target, context.limits);
      await assertRealPathContained(context.fileSystem, context.root, observed.absolutePath);
      const finalStats = await inspectStats(context.fileSystem, observed.absolutePath, observed.absolutePath);
      assertStableStats(observed.stats, finalStats, observed.absolutePath);
      if (target !== observed.target) {
        throw new WorkspaceError(
          "workspace_changed",
          `Symlink target changed after inspection: ${observed.absolutePath}`,
        );
      }
    }
  }
}

export async function captureWorkspaceSnapshotWithFileSystem(
  workspaceRoot: string,
  options: WorkspaceSnapshotOptions = {},
  fileSystem: WorkspaceFileSystem = NODE_WORKSPACE_FILE_SYSTEM,
): Promise<WorkspaceSnapshot> {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
    throw new WorkspaceError("invalid_argument", "Workspace root is required");
  }
  const snapshotOptions = readSnapshotOptions(options);
  const limits = mergeLimits(snapshotOptions.limits);
  const caseSensitivity = snapshotOptions.caseSensitivity ?? defaultCaseSensitivity();
  if (caseSensitivity !== "sensitive" && caseSensitivity !== "insensitive") {
    throw new WorkspaceError("invalid_argument", "Workspace case sensitivity is invalid");
  }
  const root = resolve(workspaceRoot);
  const rootStats = await inspectStats(fileSystem, root, root);
  assertDirectory(rootStats, root);
  let realRoot: string;
  try {
    realRoot = await fileSystem.realpath(root);
  } catch (error) {
    if (isWorkspaceChangedError(error)) {
      throw new WorkspaceError("workspace_changed", `Workspace root disappeared while being resolved: ${root}`, {
        cause: error,
      });
    }
    throw new WorkspaceError("io_failure", `Could not resolve workspace root ${root}`, { cause: error });
  }
  const context: SnapshotContext = {
    root: realRoot,
    limits,
    pathOptions: pathOptions(limits),
    fileSystem,
    entries: [],
    observed: [],
    totalBytes: 0,
    visitedEntryCount: 0,
  };
  await scanDirectory(realRoot, [], context);
  const finalRootStats = await inspectStats(fileSystem, root, root);
  assertStableStats(rootStats, finalRootStats, root);
  await revalidateObservedDirectories(context);
  await revalidateObservedLeaves(context);
  await revalidateObservedDirectories(context);
  const finalVerificationRootStats = await inspectStats(fileSystem, root, root);
  assertStableStats(finalRootStats, finalVerificationRootStats, root);
  return createSnapshotWithLimits(context.entries, limits, caseSensitivity);
}

export async function captureWorkspaceSnapshot(
  workspaceRoot: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  return captureWorkspaceSnapshotWithFileSystem(workspaceRoot, options, NODE_WORKSPACE_FILE_SYSTEM);
}
