import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  rename,
  rm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";

import {
  snapshotFactoryRun,
  type FactoryRun,
} from "../domain/factory-run.js";
import { atomicWriteFile, flushDirectory } from "./atomic-write.js";
import { decodeEventLog, appendRunEvents, encodeEventLog } from "./event-log.js";
import { PersistenceError } from "./persistence-error.js";
import {
  DEFAULT_PERSISTENCE_LIMITS,
  PERSISTENCE_SCHEMA_VERSION,
  type CurrentStateDocument,
  type GraphDocument,
  type LoadedRun,
  type NewRunEvent,
  type PersistenceLimits,
  type PersistedRunMetadata,
  type RunDocument,
  type RunEvent,
} from "./persistence-types.js";

const STATE_DIRECTORY_PATTERN =
  /^state-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const writeTails = new Map<string, Promise<void>>();

export interface RunStoreHooks {
  readonly beforeStatePublish?: () => void | Promise<void>;
  readonly beforeCurrentPublish?: () => void | Promise<void>;
}

export interface RunStoreOptions {
  readonly storageRoot: string;
  readonly limits?: Partial<PersistenceLimits>;
  readonly hooks?: RunStoreHooks;
}

interface StoragePaths {
  readonly runDirectory: string;
  readonly statesDirectory: string;
  readonly currentFile: string;
}

async function withRunWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeTails.get(key);
  let release!: () => void;
  const lock = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  writeTails.set(key, lock);
  try {
    await previous;
    return await operation();
  } finally {
    release();
    if (writeTails.get(key) === lock) {
      writeTails.delete(key);
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new PersistenceError("corrupt_state", `${label} contains unsupported fields`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PersistenceError("invalid_argument", `${field} must be a positive safe integer`);
  }
}

function mergeLimits(custom: Partial<PersistenceLimits> | undefined): PersistenceLimits {
  const limits = Object.freeze({ ...DEFAULT_PERSISTENCE_LIMITS, ...(custom ?? {}) });
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PersistenceError("invalid_argument", `Persistence limit ${field} is invalid`);
    }
  }
  return limits;
}

function assertStorageRunId(runId: unknown, limits: PersistenceLimits): asserts runId is string {
  if (
    typeof runId !== "string" ||
    runId.trim().length === 0 ||
    Buffer.byteLength(runId, "utf8") > limits.maxRunIdBytes
  ) {
    throw new PersistenceError("invalid_argument", "FactoryRun ID is invalid for storage");
  }
}

export function getRunStorageKey(runId: string): string {
  return createHash("sha256").update(runId, "utf8").digest("hex");
}

function assertWithin(parent: string, candidate: string): void {
  const path = relative(parent, candidate);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) {
    throw new PersistenceError("unsafe_storage_entry", "Storage path escapes its configured root");
  }
}

async function ensureDirectory(directoryPath: string, recursive: boolean): Promise<void> {
  try {
    const stats = await lstat(directoryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new PersistenceError(
        "unsafe_storage_entry",
        `Storage entry ${directoryPath} is not a regular directory`,
      );
    }
  } catch (error) {
    if (error instanceof PersistenceError) {
      throw error;
    }
    if (errorCode(error) !== "ENOENT") {
      throw new PersistenceError("io_failure", `Could not inspect directory ${directoryPath}`, {
        cause: error,
      });
    }
    try {
      await mkdir(directoryPath, { recursive, mode: 0o700 });
    } catch (mkdirError) {
      throw new PersistenceError("io_failure", `Could not create directory ${directoryPath}`, {
        cause: mkdirError,
      });
    }
    const stats = await lstat(directoryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new PersistenceError(
        "unsafe_storage_entry",
        `Storage entry ${directoryPath} is not a regular directory`,
      );
    }
  }
}

async function requireDirectory(directoryPath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(directoryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new PersistenceError("corrupt_state", `Required directory is missing: ${directoryPath}`);
    }
    throw new PersistenceError("io_failure", `Could not inspect directory ${directoryPath}`, {
      cause: error,
    });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new PersistenceError(
      "unsafe_storage_entry",
      `Storage entry ${directoryPath} is not a regular directory`,
    );
  }
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
  missingCode: "not_found" | "corrupt_state",
): Promise<string> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new PersistenceError(missingCode, `Required persistence file is missing: ${filePath}`);
    }
    throw new PersistenceError("io_failure", `Could not inspect ${filePath}`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PersistenceError("unsafe_storage_entry", `Persistence entry ${filePath} is unsafe`);
  }
  if (stats.size > maxBytes) {
    throw new PersistenceError("size_limit_exceeded", `Persistence file ${filePath} is too large`);
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, "r");
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== stats.dev ||
      openedStats.ino !== stats.ino ||
      openedStats.size !== stats.size
    ) {
      throw new PersistenceError("unsafe_storage_entry", `Persistence entry ${filePath} changed while opening`);
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = maxBytes + 1 - totalBytes;
      if (remaining <= 0) {
        throw new PersistenceError("size_limit_exceeded", `Persistence file ${filePath} is too large`);
      }
      const chunk = Buffer.alloc(Math.min(64 * 1_024, remaining));
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) {
        break;
      }
      totalBytes += result.bytesRead;
      chunks.push(chunk.subarray(0, result.bytesRead));
      if (totalBytes > maxBytes) {
        throw new PersistenceError("size_limit_exceeded", `Persistence file ${filePath} is too large`);
      }
    }
    const contents = Buffer.concat(chunks, totalBytes);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch (error) {
      throw new PersistenceError("corrupt_state", `Persistence file ${filePath} is not valid UTF-8`, {
        cause: error,
      });
    }
  } catch (error) {
    if (error instanceof PersistenceError) {
      throw error;
    }
    if (errorCode(error) === "ENOENT") {
      throw new PersistenceError("corrupt_state", `Persistence file ${filePath} disappeared while reading`, {
        cause: error,
      });
    }
    throw new PersistenceError("io_failure", `Could not read ${filePath}`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readJsonFile(
  filePath: string,
  maxBytes: number,
  missingCode: "not_found" | "corrupt_state",
): Promise<unknown> {
  const contents = await readBoundedFile(filePath, maxBytes, missingCode);
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new PersistenceError("corrupt_state", `Persistence file ${filePath} contains malformed JSON`, {
      cause: error,
    });
  }
}

function parseCurrentDocument(value: unknown, runId: string): CurrentStateDocument {
  if (!isRecord(value)) {
    throw new PersistenceError("corrupt_state", "current.json must contain an object");
  }
  assertAllowedKeys(value, ["schemaVersion", "runId", "stateVersion", "stateDirectory"], "current.json");
  if (value.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
    throw new PersistenceError("unsupported_schema", "current.json schema is unsupported");
  }
  if (value.runId !== runId) {
    throw new PersistenceError("identity_mismatch", "current.json run ID does not match");
  }
  assertPositiveSafeInteger(value.stateVersion, "current.json stateVersion");
  if (typeof value.stateDirectory !== "string") {
    throw new PersistenceError("corrupt_state", "current.json stateDirectory is invalid");
  }
  const match = STATE_DIRECTORY_PATTERN.exec(value.stateDirectory);
  if (match === null || Number(match[1]) !== value.stateVersion) {
    throw new PersistenceError("unsafe_storage_entry", "current.json points to an invalid saved state");
  }
  return Object.freeze({
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    runId,
    stateVersion: value.stateVersion,
    stateDirectory: value.stateDirectory,
  });
}

function parseRunDocument(value: unknown, runId: string, stateVersion: number): RunDocument {
  if (!isRecord(value)) {
    throw new PersistenceError("corrupt_state", "run.json must contain an object");
  }
  assertAllowedKeys(value, ["schemaVersion", "runId", "stateVersion", "state"], "run.json");
  if (value.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
    throw new PersistenceError("unsupported_schema", "run.json schema is unsupported");
  }
  if (value.runId !== runId || value.stateVersion !== stateVersion) {
    throw new PersistenceError("identity_mismatch", "run.json identity or state version does not match");
  }
  if (!isRecord(value.state)) {
    throw new PersistenceError("corrupt_state", "run.json state must contain an object");
  }
  assertAllowedKeys(
    value.state,
    ["id", "request", "tier", "status", "budget", "createdAt", "updatedAt", "failure"],
    "run.json state",
  );
  if (value.state.id !== runId) {
    throw new PersistenceError("identity_mismatch", "run.json state ID does not match");
  }
  if (isRecord(value.state.budget)) {
    assertAllowedKeys(
      value.state.budget,
      ["maxParallelAgents", "maxAgentCalls", "maxRetriesPerNode", "maxTokens", "maxCostUsd"],
      "run.json budget",
    );
  }
  if (value.state.failure !== undefined && isRecord(value.state.failure)) {
    assertAllowedKeys(value.state.failure, ["reason", "at"], "run.json failure");
  }
  return Object.freeze({
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    runId,
    stateVersion,
    state: value.state as unknown as PersistedRunMetadata,
  });
}

function parseGraphDocument(value: unknown, runId: string, stateVersion: number): GraphDocument {
  if (!isRecord(value)) {
    throw new PersistenceError("corrupt_state", "graph.json must contain an object");
  }
  assertAllowedKeys(value, ["schemaVersion", "runId", "stateVersion", "graph"], "graph.json");
  if (value.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
    throw new PersistenceError("unsupported_schema", "graph.json schema is unsupported");
  }
  if (value.runId !== runId || value.stateVersion !== stateVersion) {
    throw new PersistenceError("identity_mismatch", "graph.json identity or state version does not match");
  }
  if (!isRecord(value.graph) || !Array.isArray(value.graph.nodes)) {
    throw new PersistenceError("corrupt_state", "graph.json graph is invalid");
  }
  assertAllowedKeys(value.graph, ["nodes"], "graph.json graph");
  for (const node of value.graph.nodes) {
    if (!isRecord(node)) {
      throw new PersistenceError("corrupt_state", "graph.json contains an invalid WorkNode");
    }
    assertAllowedKeys(
      node,
      [
        "id",
        "objective",
        "role",
        "builderMode",
        "status",
        "dependsOn",
        "scope",
        "acceptanceCriteria",
        "risk",
        "complexity",
        "parallelSafe",
        "inputDigest",
        "outputDigest",
        "artifactRefs",
        "retryCount",
        "failure",
        "executionHistory",
      ],
      "graph.json WorkNode",
    );
    if (isRecord(node.scope)) {
      assertAllowedKeys(
        node.scope,
        ["relevantPaths", "allowedMutationPaths", "forbiddenPaths", "subsystems"],
        "graph.json WorkNode scope",
      );
    }
    if (isRecord(node.failure)) {
      assertAllowedKeys(node.failure, ["reason", "at"], "graph.json WorkNode failure");
    }
    if (Array.isArray(node.executionHistory)) {
      for (const entry of node.executionHistory) {
        if (isRecord(entry)) {
          assertAllowedKeys(entry, ["status", "at", "reason"], "graph.json history entry");
        }
      }
    }
  }
  return Object.freeze({
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    runId,
    stateVersion,
    graph: value.graph as unknown as GraphDocument["graph"],
  });
}

function metadataFromRun(run: FactoryRun): PersistedRunMetadata {
  return Object.freeze({
    id: run.id,
    request: run.request,
    tier: run.tier,
    status: run.status,
    budget: Object.freeze({ ...run.budget }),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.failure === undefined
      ? {}
      : { failure: Object.freeze({ ...run.failure }) }),
  });
}

function serializeDocument(value: object, maxBytes: number, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new PersistenceError("corrupt_state", "Persistence document cannot be serialized");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new PersistenceError("size_limit_exceeded", `${label} exceeds its size limit`);
  }
  return serialized;
}

function snapshotRunForStorage(run: FactoryRun): FactoryRun {
  try {
    return snapshotFactoryRun(run);
  } catch (error) {
    throw new PersistenceError("corrupt_state", "FactoryRun is not valid for persistence", {
      cause: error,
    });
  }
}

export class FileRunStore {
  readonly storageRoot: string;
  readonly limits: PersistenceLimits;
  readonly hooks: RunStoreHooks;

  constructor(options: RunStoreOptions) {
    if (typeof options.storageRoot !== "string" || options.storageRoot.trim().length === 0) {
      throw new PersistenceError("invalid_argument", "Persistence storageRoot is required");
    }
    this.storageRoot = resolve(options.storageRoot);
    this.limits = mergeLimits(options.limits);
    this.hooks = options.hooks ?? {};
  }

  private pathsFor(runId: string): StoragePaths {
    assertStorageRunId(runId, this.limits);
    const runsDirectory = join(this.storageRoot, "runs");
    const runDirectory = join(runsDirectory, getRunStorageKey(runId));
    const statesDirectory = join(runDirectory, "states");
    const currentFile = join(runDirectory, "current.json");
    assertWithin(this.storageRoot, runDirectory);
    assertWithin(runDirectory, statesDirectory);
    assertWithin(runDirectory, currentFile);
    return Object.freeze({ runDirectory, statesDirectory, currentFile });
  }

  private async ensureBaseDirectories(): Promise<void> {
    await ensureDirectory(this.storageRoot, true);
    await ensureDirectory(join(this.storageRoot, "runs"), true);
  }

  private async readCurrent(runId: string, paths: StoragePaths): Promise<CurrentStateDocument> {
    const value = await readJsonFile(paths.currentFile, this.limits.maxCurrentFileBytes, "corrupt_state");
    return parseCurrentDocument(value, runId);
  }

  private async loadFromPaths(runId: string, paths: StoragePaths): Promise<LoadedRun> {
    const current = await this.readCurrent(runId, paths);
    await requireDirectory(paths.statesDirectory);
    const stateDirectory = join(paths.statesDirectory, current.stateDirectory);
    assertWithin(paths.statesDirectory, stateDirectory);
    await requireDirectory(stateDirectory);
    const runFile = join(stateDirectory, "run.json");
    const graphFile = join(stateDirectory, "graph.json");
    const eventFile = join(stateDirectory, "events.jsonl");
    assertWithin(stateDirectory, runFile);
    assertWithin(stateDirectory, graphFile);
    assertWithin(stateDirectory, eventFile);
    const [runValue, graphValue, eventContents] = await Promise.all([
      readJsonFile(runFile, this.limits.maxRunFileBytes, "corrupt_state"),
      readJsonFile(graphFile, this.limits.maxGraphFileBytes, "corrupt_state"),
      readBoundedFile(eventFile, this.limits.maxEventLogBytes, "corrupt_state"),
    ]);
    const runDocument = parseRunDocument(runValue, runId, current.stateVersion);
    const graphDocument = parseGraphDocument(graphValue, runId, current.stateVersion);
    const events = decodeEventLog(eventContents, runId, current.stateVersion, this.limits);
    let run: FactoryRun;
    try {
      run = snapshotFactoryRun({
        ...runDocument.state,
        graph: graphDocument.graph,
      });
    } catch (error) {
      throw new PersistenceError("corrupt_state", "Persisted FactoryRun state is invalid", {
        cause: error,
      });
    }
    return Object.freeze({ run, events, stateVersion: current.stateVersion });
  }

  private async publish(
    run: FactoryRun,
    stateVersion: number,
    events: readonly RunEvent[],
    paths: StoragePaths,
  ): Promise<void> {
    const stateDirectoryName = `state-${stateVersion.toString().padStart(8, "0")}-${randomUUID()}`;
    const stagingDirectoryName = `.pending-${randomUUID()}`;
    const stateDirectory = join(paths.statesDirectory, stateDirectoryName);
    const stagingDirectory = join(paths.statesDirectory, stagingDirectoryName);
    assertWithin(paths.statesDirectory, stateDirectory);
    assertWithin(paths.statesDirectory, stagingDirectory);
    await ensureDirectory(paths.statesDirectory, false);
    try {
      await mkdir(stagingDirectory, { mode: 0o700 });
      const runDocument: RunDocument = {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        runId: run.id,
        stateVersion,
        state: metadataFromRun(run),
      };
      const graphDocument: GraphDocument = {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        runId: run.id,
        stateVersion,
        graph: run.graph,
      };
      const runContents = serializeDocument(runDocument, this.limits.maxRunFileBytes, "run.json");
      const graphContents = serializeDocument(
        graphDocument,
        this.limits.maxGraphFileBytes,
        "graph.json",
      );
      const eventContents = encodeEventLog(events, run.id, stateVersion, this.limits);
      const current: CurrentStateDocument = {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        runId: run.id,
        stateVersion,
        stateDirectory: stateDirectoryName,
      };
      const currentContents = serializeDocument(
        current,
        this.limits.maxCurrentFileBytes,
        "current.json",
      );
      await atomicWriteFile(join(stagingDirectory, "run.json"), runContents);
      await atomicWriteFile(join(stagingDirectory, "graph.json"), graphContents);
      await atomicWriteFile(
        join(stagingDirectory, "events.jsonl"),
        eventContents,
      );
      await flushDirectory(stagingDirectory);
      await this.hooks.beforeStatePublish?.();
      await rename(stagingDirectory, stateDirectory);
      await flushDirectory(paths.statesDirectory);
      await this.hooks.beforeCurrentPublish?.();
      try {
        await atomicWriteFile(paths.currentFile, currentContents);
      } catch (error) {
        try {
          const published = await this.readCurrent(run.id, paths);
          if (
            published.stateVersion === stateVersion &&
            published.stateDirectory === stateDirectoryName
          ) {
            return;
          }
        } catch {
          // The pointer was not durably published, so preserve the original error.
        }
        throw error;
      }
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof PersistenceError) {
        throw error;
      }
      throw new PersistenceError("io_failure", "Could not publish saved state", { cause: error });
    }
  }

  async create(
    run: FactoryRun,
    initialEvents: readonly NewRunEvent[] = [],
  ): Promise<LoadedRun> {
    const snapshot = snapshotRunForStorage(run);
    const paths = this.pathsFor(snapshot.id);
    return withRunWriteLock(paths.runDirectory, async () => {
      await this.ensureBaseDirectories();
      try {
        await mkdir(paths.runDirectory, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          const stats = await lstat(paths.runDirectory);
          if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new PersistenceError("unsafe_storage_entry", "Run storage directory is unsafe");
          }
          throw new PersistenceError("already_exists", `FactoryRun ${snapshot.id} already exists`);
        }
        throw new PersistenceError("io_failure", `Could not create FactoryRun ${snapshot.id}`, {
          cause: error,
        });
      }
      try {
        await mkdir(paths.statesDirectory, { mode: 0o700 });
        const events = appendRunEvents(snapshot.id, [], initialEvents, this.limits);
        await this.publish(snapshot, 1, events, paths);
        return await this.loadFromPaths(snapshot.id, paths);
      } catch (error) {
        let currentExists = false;
        try {
          await lstat(paths.currentFile);
          currentExists = true;
        } catch {
          // No pointer means the newly created run has not been committed.
        }
        if (!currentExists) {
          await rm(paths.runDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
        if (error instanceof PersistenceError) {
          throw error;
        }
        throw new PersistenceError("io_failure", `Could not create FactoryRun ${snapshot.id}`, {
          cause: error,
        });
      }
    });
  }

  async load(runId: string): Promise<LoadedRun> {
    const paths = this.pathsFor(runId);
    try {
      const stats = await lstat(paths.runDirectory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new PersistenceError("unsafe_storage_entry", "Run storage directory is unsafe");
      }
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      if (errorCode(error) === "ENOENT") {
        throw new PersistenceError("not_found", `FactoryRun ${runId} was not found`);
      }
      throw new PersistenceError("io_failure", `Could not inspect FactoryRun ${runId}`, {
        cause: error,
      });
    }
    return this.loadFromPaths(runId, paths);
  }

  async save(
    run: FactoryRun,
    expectedStateVersion: number,
    newEvents: readonly NewRunEvent[] = [],
  ): Promise<LoadedRun> {
    assertPositiveSafeInteger(expectedStateVersion, "expectedStateVersion");
    const snapshot = snapshotRunForStorage(run);
    const paths = this.pathsFor(snapshot.id);
    return withRunWriteLock(paths.runDirectory, async () => {
      const current = await this.load(snapshot.id);
      if (current.stateVersion !== expectedStateVersion) {
        throw new PersistenceError(
          "stale_state_version",
          `Expected saved state ${expectedStateVersion}, found ${current.stateVersion}`,
        );
      }
      if (current.stateVersion === Number.MAX_SAFE_INTEGER) {
        throw new PersistenceError("size_limit_exceeded", "State version cannot be incremented safely");
      }
      const events = appendRunEvents(snapshot.id, current.events, newEvents, this.limits);
      await this.publish(snapshot, current.stateVersion + 1, events, paths);
      return await this.loadFromPaths(snapshot.id, paths);
    });
  }

  async readEvents(runId: string): Promise<readonly RunEvent[]> {
    return (await this.load(runId)).events;
  }
}
