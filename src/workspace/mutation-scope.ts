import {
  isPathEqualOrWithin,
  parseRepositoryPath,
  resolvePathValidationLimits,
  type PathValidationLimits,
  type PathCaseSensitivity,
  type RepositoryPath,
} from "./path-validation.js";
import type { WorkspaceChange } from "./workspace-delta.js";
import { diffWorkspaceSnapshots } from "./workspace-delta.js";
import type { WorkspaceSnapshot } from "./workspace-snapshot.js";
import { WorkspaceError } from "./workspace-error.js";

export interface MutationScopeInput {
  readonly relevantPaths?: readonly string[];
  readonly allowedMutationPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
}

export interface MutationScopeOptions {
  readonly caseSensitivity?: PathCaseSensitivity;
  readonly pathLimits?: Partial<PathValidationLimits>;
}

export interface MutationScope {
  readonly relevantPaths: readonly RepositoryPath[];
  readonly allowedMutationPaths: readonly RepositoryPath[];
  readonly forbiddenPaths: readonly RepositoryPath[];
  readonly caseSensitivity: PathCaseSensitivity;
  readonly pathLimits: PathValidationLimits;
}

export type MutationViolationReason = "outside_allowed_scope" | "explicitly_forbidden";

export interface MutationViolation {
  readonly path: RepositoryPath;
  readonly changeKind: WorkspaceChange["kind"];
  readonly reason: MutationViolationReason;
}

export interface MutationScopeAssessment {
  readonly accepted: boolean;
  readonly violations: readonly MutationViolation[];
}

function defaultCaseSensitivity(): PathCaseSensitivity {
  return process.platform === "win32" ? "insensitive" : "sensitive";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function comparePaths(
  left: RepositoryPath,
  right: RepositoryPath,
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
  return left < right ? -1 : left > right ? 1 : 0;
}

function compilePaths(
  paths: readonly string[] | undefined,
  label: string,
  pathLimits: PathValidationLimits,
): readonly RepositoryPath[] {
  if (paths === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(paths)) {
    throw new WorkspaceError("invalid_scope", `${label} must be an array`);
  }
  if (Object.getPrototypeOf(paths) !== Array.prototype) {
    throw new WorkspaceError("invalid_scope", `${label} must use the standard array prototype`);
  }
  const ownNames = Object.getOwnPropertyNames(paths);
  const expectedNames = new Set<string>(["length"]);
  for (let index = 0; index < paths.length; index += 1) {
    expectedNames.add(String(index));
  }
  if (
    ownNames.length !== expectedNames.size ||
    ownNames.some((name) => !expectedNames.has(name)) ||
    Object.getOwnPropertySymbols(paths).length > 0
  ) {
    throw new WorkspaceError("invalid_scope", `${label} must be dense`);
  }
  const compiled: RepositoryPath[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(paths, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw new WorkspaceError("invalid_scope", `${label} must contain data values`);
    }
    const path = descriptor.value;
    try {
      compiled.push(parseRepositoryPath(path, { limits: pathLimits }));
    } catch (error) {
      throw new WorkspaceError("invalid_scope", `${label} contains an invalid path`, {
        cause: error,
      });
    }
  }
  return Object.freeze(compiled);
}

function deduplicatePaths(
  paths: readonly RepositoryPath[],
  caseSensitivity: PathCaseSensitivity,
): readonly RepositoryPath[] {
  const seen = new Set<string>();
  const result: RepositoryPath[] = [];
  for (const path of [...paths].sort((left, right) => comparePaths(left, right, caseSensitivity))) {
    const key = caseSensitivity === "insensitive" ? path.toLowerCase() : path;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(path);
    }
  }
  return Object.freeze(result);
}

function assertCompletePathLimits(value: Record<string, unknown>): void {
  const keys = ["maxPathBytes", "maxSegmentBytes"];
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw new WorkspaceError("invalid_scope", "Mutation scope path limits are invalid");
    }
  }
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new WorkspaceError("invalid_scope", "Mutation scope path limits are incomplete");
  }
}

function readOptionalDataField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, "value")
  ) {
    throw new WorkspaceError("invalid_scope", `${label} contains an accessor or hidden property`);
  }
  return descriptor.value;
}

export function createMutationScope(
  input: MutationScopeInput,
  options: MutationScopeOptions = {},
): MutationScope {
  if (!isPlainRecord(input)) {
    throw new WorkspaceError("invalid_scope", "Mutation scope must be an object");
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new WorkspaceError("invalid_argument", "Mutation scope options must be an object");
  }
  const inputRecord = input as Record<string, unknown>;
  const optionsRecord = options as Record<string, unknown>;
  const caseSensitivityValue = readOptionalDataField(optionsRecord, "caseSensitivity", "Mutation scope options");
  const pathLimitsValue = readOptionalDataField(optionsRecord, "pathLimits", "Mutation scope options");
  const caseSensitivity = caseSensitivityValue ?? defaultCaseSensitivity();
  if (caseSensitivity !== "sensitive" && caseSensitivity !== "insensitive") {
    throw new WorkspaceError("invalid_argument", "Mutation case sensitivity is invalid");
  }
  const inputRelevantPaths = readOptionalDataField(inputRecord, "relevantPaths", "Mutation scope") as
    | readonly string[]
    | undefined;
  const inputAllowedMutationPaths = readOptionalDataField(
    inputRecord,
    "allowedMutationPaths",
    "Mutation scope",
  ) as readonly string[] | undefined;
  const inputForbiddenPaths = readOptionalDataField(inputRecord, "forbiddenPaths", "Mutation scope") as
    | readonly string[]
    | undefined;
  const scopeInput = {
    ...(inputRelevantPaths === undefined ? {} : { relevantPaths: inputRelevantPaths }),
    ...(inputAllowedMutationPaths === undefined ? {} : { allowedMutationPaths: inputAllowedMutationPaths }),
    ...(inputForbiddenPaths === undefined ? {} : { forbiddenPaths: inputForbiddenPaths }),
  } satisfies MutationScopeInput;
  const pathLimits = resolvePathValidationLimits(
    pathLimitsValue === undefined
      ? undefined
      : { limits: pathLimitsValue as Partial<PathValidationLimits> },
  );
  const relevantPaths = compilePaths(scopeInput.relevantPaths, "relevantPaths", pathLimits);
  const allowedMutationPaths = compilePaths(scopeInput.allowedMutationPaths, "allowedMutationPaths", pathLimits);
  const forbiddenPaths = compilePaths(scopeInput.forbiddenPaths, "forbiddenPaths", pathLimits);
  return Object.freeze({
    relevantPaths: deduplicatePaths(relevantPaths, caseSensitivity),
    allowedMutationPaths: deduplicatePaths(allowedMutationPaths, caseSensitivity),
    forbiddenPaths: deduplicatePaths(forbiddenPaths, caseSensitivity),
    caseSensitivity: caseSensitivity as PathCaseSensitivity,
    pathLimits,
  });
}

function normalizeScope(scope: MutationScope): MutationScope {
  if (
    typeof scope !== "object" ||
    scope === null ||
    Array.isArray(scope) ||
    (Object.getPrototypeOf(scope) !== Object.prototype && Object.getPrototypeOf(scope) !== null)
  ) {
    throw new WorkspaceError("invalid_scope", "Mutation scope is invalid");
  }
  const expectedKeys = new Set([
    "relevantPaths",
    "allowedMutationPaths",
    "forbiddenPaths",
    "caseSensitivity",
    "pathLimits",
  ]);
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(scope)) {
    if (typeof key !== "string" || !expectedKeys.has(key)) {
      throw new WorkspaceError("invalid_scope", "Mutation scope contains unsupported fields");
    }
    const descriptor = Object.getOwnPropertyDescriptor(scope, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw new WorkspaceError("invalid_scope", "Mutation scope contains an accessor or hidden property");
    }
    fields[key] = descriptor.value;
  }
  if ([...expectedKeys].some((key) => !Object.prototype.hasOwnProperty.call(fields, key))) {
    throw new WorkspaceError("invalid_scope", "Mutation scope is missing required fields");
  }
  if (
    !Array.isArray(fields.relevantPaths) ||
    !Array.isArray(fields.allowedMutationPaths) ||
    !Array.isArray(fields.forbiddenPaths) ||
    (fields.caseSensitivity !== "sensitive" && fields.caseSensitivity !== "insensitive") ||
    !isPlainRecord(fields.pathLimits)
  ) {
    throw new WorkspaceError("invalid_scope", "Mutation scope is invalid");
  }
  assertCompletePathLimits(fields.pathLimits);
  const relevantPaths = fields.relevantPaths as readonly string[];
  const allowedMutationPaths = fields.allowedMutationPaths as readonly string[];
  const forbiddenPaths = fields.forbiddenPaths as readonly string[];
  return createMutationScope(
    {
      relevantPaths,
      allowedMutationPaths,
      forbiddenPaths,
    },
    {
      caseSensitivity: fields.caseSensitivity as PathCaseSensitivity,
      pathLimits: fields.pathLimits as Partial<PathValidationLimits>,
    },
  );
}

export function assessMutationScope(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  scope: MutationScope,
): MutationScopeAssessment {
  const normalizedScope = normalizeScope(scope);
  const delta = diffWorkspaceSnapshots(before, after);
  const violations: MutationViolation[] = [];
  for (const change of [...delta.changes].sort((left, right) =>
    comparePaths(left.path, right.path, normalizedScope.caseSensitivity),
  )) {
    const path = change.path;
    const forbidden = normalizedScope.forbiddenPaths.some((scopePath) =>
      isPathEqualOrWithin(path, scopePath, normalizedScope.caseSensitivity),
    );
    if (forbidden) {
      violations.push(
        Object.freeze({ path, changeKind: change.kind, reason: "explicitly_forbidden" }),
      );
      continue;
    }
    const allowed = normalizedScope.allowedMutationPaths.some((scopePath) =>
      isPathEqualOrWithin(path, scopePath, normalizedScope.caseSensitivity),
    );
    if (!allowed) {
      violations.push(
        Object.freeze({ path, changeKind: change.kind, reason: "outside_allowed_scope" }),
      );
    }
  }
  return Object.freeze({
    accepted: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
