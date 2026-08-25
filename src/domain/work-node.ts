import { DomainError } from "./domain-error.js";
import {
  assertIsoTimestamp,
  assertNonEmptyString,
  assertTimestampNotBefore,
  freezeStrings,
  freezeUniqueSortedStrings,
  isIsoTimestamp,
} from "./validation.js";

export const AGENT_ROLES = ["planner", "builder", "reviewer"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const BUILDER_MODES = [
  "implement",
  "debug",
  "test",
  "integrate",
  "document",
] as const;
export type BuilderMode = (typeof BUILDER_MODES)[number];

export const WORK_NODE_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "waiting_human",
  "completed",
  "failed",
] as const;
export type WorkNodeStatus = (typeof WORK_NODE_STATUSES)[number];

export const WORK_RISKS = ["low", "medium", "high"] as const;
export type WorkRisk = (typeof WORK_RISKS)[number];
export const WORK_COMPLEXITIES = ["small", "medium", "large"] as const;
export type WorkComplexity = (typeof WORK_COMPLEXITIES)[number];

export interface WorkScope {
  readonly relevantPaths?: readonly string[];
  readonly allowedMutationPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly subsystems?: readonly string[];
}

export interface FailureInfo {
  readonly reason: string;
  readonly at: string;
}

export interface WorkNodeHistoryEntry {
  readonly status: WorkNodeStatus;
  readonly at: string;
  readonly reason?: string;
}

export interface WorkNode {
  readonly id: string;
  readonly objective: string;
  readonly role: AgentRole;
  readonly builderMode?: BuilderMode;
  readonly status: WorkNodeStatus;
  readonly dependsOn: readonly string[];
  readonly scope: WorkScope;
  readonly acceptanceCriteria: readonly string[];
  readonly risk: WorkRisk;
  readonly complexity: WorkComplexity;
  readonly parallelSafe: boolean;
  readonly inputDigest?: string;
  readonly outputDigest?: string;
  readonly artifactRefs: readonly string[];
  readonly retryCount: number;
  readonly failure?: FailureInfo;
  readonly executionHistory: readonly WorkNodeHistoryEntry[];
}

export interface CreateWorkNodeInput {
  readonly id: string;
  readonly objective: string;
  readonly role: AgentRole;
  readonly builderMode?: BuilderMode;
  readonly dependsOn: readonly string[];
  readonly scope: WorkScope;
  readonly acceptanceCriteria: readonly string[];
  readonly risk: WorkRisk;
  readonly complexity: WorkComplexity;
  readonly parallelSafe: boolean;
  readonly inputDigest?: string;
}

export interface WorkNodeCompletion {
  readonly artifactRefs?: readonly string[];
  readonly outputDigest?: string;
}

export type WorkNodeValidationIssueCode =
  | "invalid_identity"
  | "invalid_role"
  | "invalid_status"
  | "invalid_dependencies"
  | "invalid_scope"
  | "invalid_acceptance_criteria"
  | "invalid_classification"
  | "invalid_digest"
  | "invalid_artifact_refs"
  | "invalid_retry_count"
  | "invalid_failure"
  | "invalid_history";

export interface WorkNodeValidationIssue {
  readonly code: WorkNodeValidationIssueCode;
  readonly message: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<WorkNodeStatus, readonly WorkNodeStatus[]>> = {
  pending: ["ready", "blocked"],
  ready: ["running", "blocked"],
  running: ["waiting_human", "completed", "failed"],
  blocked: ["pending"],
  waiting_human: ["ready"],
  completed: [],
  failed: ["ready"],
};

function validationIssue(
  code: WorkNodeValidationIssueCode,
  message: string,
): WorkNodeValidationIssue {
  return Object.freeze({ code, message });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateWorkNode(value: unknown): readonly WorkNodeValidationIssue[] {
  const issues: WorkNodeValidationIssue[] = [];
  if (!isRecord(value)) {
    return Object.freeze([
      validationIssue("invalid_identity", "WorkNode must be an object"),
    ]);
  }
  const node = value;
  const nodeLabel = isNonEmptyString(node.id) ? node.id : "<unknown>";

  if (!isNonEmptyString(node.id) || !isNonEmptyString(node.objective)) {
    issues.push(
      validationIssue(
        "invalid_identity",
        "WorkNode id and objective must be non-empty strings",
      ),
    );
  }

  const roleValid =
    typeof node.role === "string" &&
    (AGENT_ROLES as readonly string[]).includes(node.role);
  const builderModeValid =
    typeof node.builderMode === "string" &&
    (BUILDER_MODES as readonly string[]).includes(node.builderMode);
  if (!roleValid) {
    issues.push(
      validationIssue("invalid_role", `WorkNode ${nodeLabel} has an invalid role`),
    );
  } else if (
    (node.role === "builder" &&
      (node.builderMode === undefined || !builderModeValid)) ||
    (node.role !== "builder" && node.builderMode !== undefined)
  ) {
    issues.push(
      validationIssue(
        "invalid_role",
        `WorkNode ${nodeLabel} has an invalid role and builderMode combination`,
      ),
    );
  }

  const statusValid =
    typeof node.status === "string" &&
    (WORK_NODE_STATUSES as readonly string[]).includes(node.status);
  if (!statusValid) {
    issues.push(
      validationIssue("invalid_status", `WorkNode ${nodeLabel} has an invalid status`),
    );
  }

  if (!isNonEmptyStringArray(node.dependsOn)) {
    issues.push(
      validationIssue(
        "invalid_dependencies",
        `WorkNode ${nodeLabel} dependencies must be non-empty strings`,
      ),
    );
  }

  const scopeValues = isRecord(node.scope)
    ? [
        node.scope.relevantPaths,
        node.scope.allowedMutationPaths,
        node.scope.forbiddenPaths,
        node.scope.subsystems,
      ]
    : [];
  if (
    !isRecord(node.scope) ||
    scopeValues.some(
      (values) =>
        values !== undefined &&
        (!isNonEmptyStringArray(values) || hasDuplicates(values)),
    )
  ) {
    issues.push(
      validationIssue("invalid_scope", `WorkNode ${nodeLabel} has an invalid scope`),
    );
  }

  if (
    !isNonEmptyStringArray(node.acceptanceCriteria) ||
    node.acceptanceCriteria.length === 0
  ) {
    issues.push(
      validationIssue(
        "invalid_acceptance_criteria",
        `WorkNode ${nodeLabel} requires non-empty acceptance criteria`,
      ),
    );
  }

  if (
    typeof node.risk !== "string" ||
    !(WORK_RISKS as readonly string[]).includes(node.risk) ||
    typeof node.complexity !== "string" ||
    !(WORK_COMPLEXITIES as readonly string[]).includes(node.complexity) ||
    typeof node.parallelSafe !== "boolean"
  ) {
    issues.push(
      validationIssue(
        "invalid_classification",
        `WorkNode ${nodeLabel} has invalid risk, complexity, or parallel safety`,
      ),
    );
  }

  if (
    (node.inputDigest !== undefined && !isNonEmptyString(node.inputDigest)) ||
    (node.outputDigest !== undefined && !isNonEmptyString(node.outputDigest))
  ) {
    issues.push(
      validationIssue("invalid_digest", `WorkNode ${nodeLabel} has an invalid digest`),
    );
  }

  if (
    !isNonEmptyStringArray(node.artifactRefs) ||
    (isNonEmptyStringArray(node.artifactRefs) && hasDuplicates(node.artifactRefs))
  ) {
    issues.push(
      validationIssue(
        "invalid_artifact_refs",
        `WorkNode ${nodeLabel} has invalid artifact references`,
      ),
    );
  }

  if (
    typeof node.retryCount !== "number" ||
    !Number.isInteger(node.retryCount) ||
    node.retryCount < 0
  ) {
    issues.push(
      validationIssue(
        "invalid_retry_count",
        `WorkNode ${nodeLabel} has an invalid retry count`,
      ),
    );
  }

  const failure = isRecord(node.failure) ? node.failure : undefined;
  const failureValid =
    failure !== undefined &&
    isNonEmptyString(failure.reason) &&
    isIsoTimestamp(failure.at);
  if (
    (node.status === "failed" && !failureValid) ||
    (node.status !== "failed" && node.failure !== undefined)
  ) {
    issues.push(
      validationIssue(
        "invalid_failure",
        `WorkNode ${nodeLabel} has failure data inconsistent with its status`,
      ),
    );
  }

  if (!Array.isArray(node.executionHistory) || node.executionHistory.length === 0) {
    issues.push(
      validationIssue(
        "invalid_history",
        `WorkNode ${nodeLabel} requires execution history`,
      ),
    );
  } else {
    const firstEntry = node.executionHistory[0];
    let historyInvalid = !isRecord(firstEntry) || firstEntry.status !== "pending";
    let retryTransitions = 0;
    let previousStatus: WorkNodeStatus | undefined;
    let previousAt: string | undefined;
    for (let index = 0; index < node.executionHistory.length; index += 1) {
      const entry = node.executionHistory[index];
      if (
        !isRecord(entry) ||
        typeof entry.status !== "string" ||
        !(WORK_NODE_STATUSES as readonly string[]).includes(entry.status) ||
        !isIsoTimestamp(entry.at) ||
        (entry.reason !== undefined && !isNonEmptyString(entry.reason))
      ) {
        historyInvalid = true;
        previousStatus = undefined;
        previousAt = undefined;
        continue;
      }
      const currentStatus = entry.status as WorkNodeStatus;
      if (
        (["blocked", "waiting_human", "failed"] as readonly WorkNodeStatus[]).includes(
          currentStatus,
        ) &&
        !isNonEmptyString(entry.reason)
      ) {
        historyInvalid = true;
      }
      if (previousStatus !== undefined && previousAt !== undefined) {
        if (
          Date.parse(entry.at) < Date.parse(previousAt) ||
          !canTransitionWorkNode(previousStatus, currentStatus)
        ) {
          historyInvalid = true;
        }
        if (previousStatus === "failed" && currentStatus === "ready") {
          retryTransitions += 1;
        }
        if (
          ((previousStatus === "failed" && currentStatus === "ready") ||
            (previousStatus === "blocked" && currentStatus === "pending") ||
            (previousStatus === "waiting_human" && currentStatus === "ready")) &&
          !isNonEmptyString(entry.reason)
        ) {
          historyInvalid = true;
        }
      }
      previousStatus = currentStatus;
      previousAt = entry.at;
    }
    const latest = node.executionHistory.at(-1);
    if (
      !isRecord(latest) ||
      latest.status !== node.status ||
      retryTransitions !== node.retryCount ||
      (failureValid &&
        failure !== undefined &&
        (latest.at !== failure.at || latest.reason !== failure.reason))
    ) {
      historyInvalid = true;
    }
    if (historyInvalid) {
      issues.push(
        validationIssue(
          "invalid_history",
          `WorkNode ${nodeLabel} has inconsistent execution history`,
        ),
      );
    }
  }

  return Object.freeze(issues);
}

function freezeScope(scope: WorkScope): WorkScope {
  return Object.freeze({
    ...(scope.relevantPaths === undefined
      ? {}
      : {
          relevantPaths: freezeUniqueSortedStrings(
            scope.relevantPaths,
            "WorkNode scope.relevantPaths",
          ),
        }),
    ...(scope.allowedMutationPaths === undefined
      ? {}
      : {
          allowedMutationPaths: freezeUniqueSortedStrings(
            scope.allowedMutationPaths,
            "WorkNode scope.allowedMutationPaths",
          ),
        }),
    ...(scope.forbiddenPaths === undefined
      ? {}
      : {
          forbiddenPaths: freezeUniqueSortedStrings(
            scope.forbiddenPaths,
            "WorkNode scope.forbiddenPaths",
          ),
        }),
    ...(scope.subsystems === undefined
      ? {}
      : {
          subsystems: freezeUniqueSortedStrings(
            scope.subsystems,
            "WorkNode scope.subsystems",
          ),
        }),
  });
}

function freezeHistoryEntry(
  status: WorkNodeStatus,
  at: string,
  reason?: string,
): WorkNodeHistoryEntry {
  if (reason !== undefined) {
    assertNonEmptyString(reason, "WorkNode transition reason");
  }
  return Object.freeze({
    status,
    at,
    ...(reason === undefined ? {} : { reason }),
  });
}

function transitionWorkNode(
  node: WorkNode,
  status: WorkNodeStatus,
  at: string,
  reason?: string,
): WorkNode {
  if (!canTransitionWorkNode(node.status, status)) {
    throw new DomainError(
      "invalid_state_transition",
      `WorkNode ${node.id} cannot transition from ${node.status} to ${status}`,
    );
  }

  const latest = node.executionHistory.at(-1);
  if (latest === undefined) {
    throw new DomainError("invalid_argument", `WorkNode ${node.id} has no execution history`);
  }
  assertTimestampNotBefore(at, latest.at, "WorkNode transition timestamp");

  const { failure: _failure, ...withoutFailure } = node;
  return Object.freeze({
    ...withoutFailure,
    status,
    executionHistory: Object.freeze([
      ...node.executionHistory,
      freezeHistoryEntry(status, at, reason),
    ]),
  });
}

export function canTransitionWorkNode(
  from: WorkNodeStatus,
  to: WorkNodeStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function createWorkNode(input: CreateWorkNodeInput, at: string): WorkNode {
  assertNonEmptyString(input.id, "WorkNode id");
  assertNonEmptyString(input.objective, "WorkNode objective");
  assertIsoTimestamp(at, "WorkNode creation timestamp");
  if (!(AGENT_ROLES as readonly string[]).includes(input.role)) {
    throw new DomainError("invalid_argument", "WorkNode role is not supported");
  }
  if (
    input.builderMode !== undefined &&
    !(BUILDER_MODES as readonly string[]).includes(input.builderMode)
  ) {
    throw new DomainError("invalid_argument", "WorkNode builderMode is not supported");
  }
  if (!(WORK_RISKS as readonly string[]).includes(input.risk)) {
    throw new DomainError("invalid_argument", "WorkNode risk is not supported");
  }
  if (!(WORK_COMPLEXITIES as readonly string[]).includes(input.complexity)) {
    throw new DomainError("invalid_argument", "WorkNode complexity is not supported");
  }
  if (typeof input.parallelSafe !== "boolean") {
    throw new DomainError("invalid_argument", "WorkNode parallelSafe must be boolean");
  }
  if (
    typeof input.scope !== "object" ||
    input.scope === null ||
    Array.isArray(input.scope)
  ) {
    throw new DomainError("invalid_argument", "WorkNode scope must be an object");
  }
  if (input.acceptanceCriteria.length === 0) {
    throw new DomainError(
      "invalid_argument",
      "WorkNode acceptanceCriteria must contain at least one entry",
    );
  }
  if (input.role === "builder" && input.builderMode === undefined) {
    throw new DomainError("invalid_argument", "Builder WorkNodes require a builderMode");
  }
  if (input.role !== "builder" && input.builderMode !== undefined) {
    throw new DomainError(
      "invalid_argument",
      "Only Builder WorkNodes may declare a builderMode",
    );
  }
  if (input.inputDigest !== undefined) {
    assertNonEmptyString(input.inputDigest, "WorkNode inputDigest");
  }

  const dependsOn = freezeUniqueSortedStrings(input.dependsOn, "WorkNode dependsOn");
  if (dependsOn.includes(input.id)) {
    throw new DomainError("invalid_graph", `WorkNode ${input.id} cannot depend on itself`);
  }

  return Object.freeze({
    id: input.id,
    objective: input.objective,
    role: input.role,
    ...(input.builderMode === undefined ? {} : { builderMode: input.builderMode }),
    status: "pending" as const,
    dependsOn,
    scope: freezeScope(input.scope),
    acceptanceCriteria: freezeStrings(
      input.acceptanceCriteria,
      "WorkNode acceptanceCriteria",
    ),
    risk: input.risk,
    complexity: input.complexity,
    parallelSafe: input.parallelSafe,
    ...(input.inputDigest === undefined ? {} : { inputDigest: input.inputDigest }),
    artifactRefs: Object.freeze([]),
    retryCount: 0,
    executionHistory: Object.freeze([freezeHistoryEntry("pending", at)]),
  });
}

export function snapshotWorkNode(node: WorkNode): WorkNode {
  const issues = validateWorkNode(node);
  if (issues.length > 0) {
    throw new DomainError(
      "invalid_argument",
      issues.map(({ message }) => message).join("; "),
    );
  }

  return Object.freeze({
    id: node.id,
    objective: node.objective,
    role: node.role,
    ...(node.builderMode === undefined ? {} : { builderMode: node.builderMode }),
    status: node.status,
    dependsOn: Object.freeze([...node.dependsOn].sort()),
    scope: freezeScope(node.scope),
    acceptanceCriteria: Object.freeze([...node.acceptanceCriteria]),
    risk: node.risk,
    complexity: node.complexity,
    parallelSafe: node.parallelSafe,
    ...(node.inputDigest === undefined ? {} : { inputDigest: node.inputDigest }),
    ...(node.outputDigest === undefined ? {} : { outputDigest: node.outputDigest }),
    artifactRefs: Object.freeze([...node.artifactRefs].sort()),
    retryCount: node.retryCount,
    ...(node.failure === undefined
      ? {}
      : { failure: Object.freeze({ ...node.failure }) }),
    executionHistory: Object.freeze(
      node.executionHistory.map((entry) =>
        Object.freeze({
          status: entry.status,
          at: entry.at,
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        }),
      ),
    ),
  });
}

export function markWorkNodeReady(
  node: WorkNode,
  at: string,
  reason?: string,
): WorkNode {
  if (node.status !== "pending" && node.status !== "waiting_human") {
    throw new DomainError(
      "invalid_state_transition",
      `WorkNode ${node.id} cannot be marked ready from ${node.status}`,
    );
  }
  if (node.status === "waiting_human" && reason === undefined) {
    throw new DomainError(
      "invalid_argument",
      `WorkNode ${node.id} requires a reason when returning from human input`,
    );
  }
  return transitionWorkNode(node, "ready", at, reason);
}

export function markWorkNodeRunning(node: WorkNode, at: string): WorkNode {
  return transitionWorkNode(node, "running", at);
}

export function markWorkNodeWaitingHuman(
  node: WorkNode,
  at: string,
  reason: string,
): WorkNode {
  assertNonEmptyString(reason, "WorkNode waiting reason");
  return transitionWorkNode(node, "waiting_human", at, reason);
}

export function markWorkNodeCompleted(
  node: WorkNode,
  at: string,
  completion: WorkNodeCompletion = {},
): WorkNode {
  if (completion.outputDigest !== undefined) {
    assertNonEmptyString(completion.outputDigest, "WorkNode outputDigest");
  }
  const transitioned = transitionWorkNode(node, "completed", at);
  const artifactRefs = freezeUniqueSortedStrings(
    [...node.artifactRefs, ...(completion.artifactRefs ?? [])],
    "WorkNode artifactRefs",
  );

  return Object.freeze({
    ...transitioned,
    artifactRefs,
    ...(completion.outputDigest === undefined
      ? {}
      : { outputDigest: completion.outputDigest }),
  });
}

export function markWorkNodeFailed(
  node: WorkNode,
  at: string,
  reason: string,
): WorkNode {
  assertNonEmptyString(reason, "WorkNode failure reason");
  const transitioned = transitionWorkNode(node, "failed", at, reason);
  return Object.freeze({
    ...transitioned,
    failure: Object.freeze({ reason, at }),
  });
}

export function markWorkNodeBlocked(
  node: WorkNode,
  at: string,
  reason: string,
): WorkNode {
  assertNonEmptyString(reason, "WorkNode blocked reason");
  return transitionWorkNode(node, "blocked", at, reason);
}

export function retryWorkNode(node: WorkNode, at: string, reason: string): WorkNode {
  assertNonEmptyString(reason, "WorkNode retry reason");
  if (node.status !== "failed") {
    throw new DomainError(
      "invalid_state_transition",
      `WorkNode ${node.id} cannot be retried from ${node.status}`,
    );
  }
  const transitioned = transitionWorkNode(node, "ready", at, reason);
  return Object.freeze({
    ...transitioned,
    retryCount: node.retryCount + 1,
  });
}

export function unblockWorkNode(
  node: WorkNode,
  at: string,
  reason: string,
): WorkNode {
  assertNonEmptyString(reason, "WorkNode unblock reason");
  return transitionWorkNode(node, "pending", at, reason);
}
