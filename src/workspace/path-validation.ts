import { WorkspaceError } from "./workspace-error.js";
import { hasControlCharacter, isWellFormedString } from "./text-validation.js";

export type RepositoryPath = string & { readonly __repositoryPath: unique symbol };
export type PathCaseSensitivity = "sensitive" | "insensitive";

export interface PathValidationLimits {
  readonly maxPathBytes: number;
  readonly maxSegmentBytes: number;
}

export const DEFAULT_PATH_VALIDATION_LIMITS: PathValidationLimits = Object.freeze({
  maxPathBytes: 4 * 1_024,
  maxSegmentBytes: 255,
});

export interface PathValidationOptions {
  readonly limits?: Partial<PathValidationLimits>;
}

export type PathValidationIssueCode =
  | "not_string"
  | "empty"
  | "malformed_unicode"
  | "control_character"
  | "backslash"
  | "separator"
  | "dot_segment"
  | "absolute_path"
  | "reserved_character"
  | "reserved_name"
  | "trailing_space_or_dot"
  | "too_long";

export interface PathValidationIssue {
  readonly code: PathValidationIssueCode;
  readonly message: string;
}

function issue(code: PathValidationIssueCode, message: string): PathValidationIssue {
  return Object.freeze({ code, message });
}

function resolveLimits(options: PathValidationOptions | undefined): PathValidationLimits {
  const custom = options?.limits;
  if (custom !== undefined) {
    if (
      typeof custom !== "object" ||
      custom === null ||
      Array.isArray(custom) ||
      (Object.getPrototypeOf(custom) !== Object.prototype && Object.getPrototypeOf(custom) !== null)
    ) {
      throw new WorkspaceError("invalid_argument", "Path limits must be a plain object");
    }
    const allowed = new Set(["maxPathBytes", "maxSegmentBytes"]);
    for (const key of Reflect.ownKeys(custom)) {
      const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(custom, key) : undefined;
      if (
        typeof key !== "string" ||
        !allowed.has(key) ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        throw new WorkspaceError("invalid_argument", "Path limits contain unsupported fields");
      }
    }
  }
  const limits = Object.freeze({
    ...DEFAULT_PATH_VALIDATION_LIMITS,
    ...(custom ?? {}),
  });
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new WorkspaceError("invalid_argument", `Path limit ${field} is invalid`);
    }
  }
  return limits;
}

export function resolvePathValidationLimits(
  options?: PathValidationOptions,
): PathValidationLimits {
  return resolveLimits(options);
}

function isReservedDeviceName(segment: string): boolean {
  const baseName = segment.split(".", 1)[0]?.toUpperCase();
  return (
    baseName === "CON" ||
    baseName === "PRN" ||
    baseName === "AUX" ||
    baseName === "NUL" ||
    /^COM[1-9]$/.test(baseName ?? "") ||
    /^LPT[1-9]$/.test(baseName ?? "") ||
    /^COM[¹²³]$/.test(baseName ?? "") ||
    /^LPT[¹²³]$/.test(baseName ?? "")
  );
}

export function validateRepositoryPath(
  value: unknown,
  options?: PathValidationOptions,
): readonly PathValidationIssue[] {
  const limits = resolveLimits(options);
  if (typeof value !== "string") {
    return Object.freeze([issue("not_string", "Repository path must be a string")]);
  }
  if (value.length === 0) {
    return Object.freeze([issue("empty", "Repository path must not be empty")]);
  }
  const issues: PathValidationIssue[] = [];
  if (!isWellFormedString(value)) {
    issues.push(issue("malformed_unicode", "Repository path contains malformed Unicode"));
  }
  if (hasControlCharacter(value)) {
    issues.push(issue("control_character", "Repository path contains a control character"));
  }
  if (value.includes("\\")) {
    issues.push(issue("backslash", "Repository paths must use forward slashes only"));
  }
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    issues.push(issue("separator", "Repository path contains an invalid separator"));
  }
  if (value.includes(":")) {
    issues.push(issue("absolute_path", "Repository path contains a drive, URL, or stream qualifier"));
  }
  if (Buffer.byteLength(value, "utf8") > limits.maxPathBytes) {
    issues.push(issue("too_long", "Repository path exceeds its size limit"));
  }

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      issues.push(issue("dot_segment", "Repository path contains a dot segment"));
    }
    if (segment.length === 0) {
      issues.push(issue("separator", "Repository path contains an empty segment"));
    }
    if (Buffer.byteLength(segment, "utf8") > limits.maxSegmentBytes) {
      issues.push(issue("too_long", "Repository path contains an oversized segment"));
    }
    if (/[<>:"|?*]/u.test(segment)) {
      issues.push(issue("reserved_character", "Repository path contains a Windows-reserved character"));
    }
    if (/[ .]$/u.test(segment)) {
      issues.push(issue("trailing_space_or_dot", "Repository path segments may not end in a space or dot"));
    }
    if (isReservedDeviceName(segment)) {
      issues.push(issue("reserved_name", "Repository path contains a Windows device name"));
    }
  }
  return Object.freeze(issues);
}

export function parseRepositoryPath(
  value: unknown,
  options?: PathValidationOptions,
): RepositoryPath {
  const issues = validateRepositoryPath(value, options);
  if (issues.length > 0) {
    throw new WorkspaceError(
      "invalid_path",
      issues.map(({ message }) => message).join("; "),
    );
  }
  return value as RepositoryPath;
}

export function isPathEqualOrWithin(
  candidate: RepositoryPath,
  scopePath: RepositoryPath,
  caseSensitivity: PathCaseSensitivity = "sensitive",
): boolean {
  const candidateValue = String(candidate);
  const scopeValue = String(scopePath);
  const normalizedCandidate =
    caseSensitivity === "insensitive" ? candidateValue.toLowerCase() : candidateValue;
  const normalizedScope = caseSensitivity === "insensitive" ? scopeValue.toLowerCase() : scopeValue;
  return normalizedCandidate === normalizedScope || normalizedCandidate.startsWith(`${normalizedScope}/`);
}
