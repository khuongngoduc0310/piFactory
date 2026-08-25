import { DomainError } from "./domain-error.js";
import { createWorkGraph, type WorkGraph } from "./work-graph.js";
import type { FailureInfo } from "./work-node.js";
import {
  assertIsoTimestamp,
  assertNonEmptyString,
  assertTimestampNotBefore,
} from "./validation.js";

export const EXECUTION_TIERS = ["fast", "standard", "deep"] as const;
export type ExecutionTier = (typeof EXECUTION_TIERS)[number];

export const FACTORY_RUN_STATUSES = [
  "created",
  "running",
  "waiting_human",
  "completed",
  "failed",
  "cancelled",
] as const;
export type FactoryRunStatus = (typeof FACTORY_RUN_STATUSES)[number];

export interface ExecutionBudget {
  readonly maxParallelAgents: number;
  readonly maxAgentCalls: number;
  readonly maxRetriesPerNode: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
}

export interface FactoryRun {
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

export interface CreateFactoryRunInput {
  readonly id: string;
  readonly request: string;
  readonly tier: ExecutionTier;
  readonly graph: WorkGraph;
  readonly budget: ExecutionBudget;
  readonly createdAt: string;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<FactoryRunStatus, readonly FactoryRunStatus[]>
> = {
  created: ["running", "cancelled"],
  running: ["waiting_human", "completed", "failed", "cancelled"],
  waiting_human: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError("invalid_argument", `${field} must be a non-negative integer`);
  }
}

function freezeBudget(budget: ExecutionBudget): ExecutionBudget {
  if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
    throw new DomainError("invalid_argument", "ExecutionBudget must be an object");
  }
  if (!Number.isInteger(budget.maxParallelAgents) || budget.maxParallelAgents <= 0) {
    throw new DomainError(
      "invalid_argument",
      "ExecutionBudget maxParallelAgents must be a positive integer",
    );
  }
  assertNonNegativeInteger(budget.maxAgentCalls, "ExecutionBudget maxAgentCalls");
  assertNonNegativeInteger(
    budget.maxRetriesPerNode,
    "ExecutionBudget maxRetriesPerNode",
  );
  if (budget.maxTokens !== undefined) {
    assertNonNegativeInteger(budget.maxTokens, "ExecutionBudget maxTokens");
  }
  if (
    budget.maxCostUsd !== undefined &&
    (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0)
  ) {
    throw new DomainError(
      "invalid_argument",
      "ExecutionBudget maxCostUsd must be finite and non-negative",
    );
  }

  return Object.freeze({
    maxParallelAgents: budget.maxParallelAgents,
    maxAgentCalls: budget.maxAgentCalls,
    maxRetriesPerNode: budget.maxRetriesPerNode,
    ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
    ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd }),
  });
}

function latestGraphTimestamp(graph: WorkGraph): string | undefined {
  let latest: string | undefined;
  for (const node of graph.nodes) {
    const entry = node.executionHistory.at(-1);
    if (entry !== undefined && (latest === undefined || Date.parse(entry.at) > Date.parse(latest))) {
      latest = entry.at;
    }
  }
  return latest;
}

function assertGraphNotNewerThan(graph: WorkGraph, at: string): void {
  const latest = latestGraphTimestamp(graph);
  if (latest !== undefined && Date.parse(latest) > Date.parse(at)) {
    throw new DomainError(
      "invalid_argument",
      "FactoryRun timestamp cannot precede its latest WorkGraph state",
    );
  }
}

function transitionFactoryRun(
  run: FactoryRun,
  status: FactoryRunStatus,
  at: string,
): FactoryRun {
  if (!canTransitionFactoryRun(run.status, status)) {
    throw new DomainError(
      "invalid_state_transition",
      `FactoryRun ${run.id} cannot transition from ${run.status} to ${status}`,
    );
  }
  assertTimestampNotBefore(at, run.updatedAt, "FactoryRun transition timestamp");
  const { failure: _failure, ...withoutFailure } = run;
  return Object.freeze({ ...withoutFailure, status, updatedAt: at });
}

export function canTransitionFactoryRun(
  from: FactoryRunStatus,
  to: FactoryRunStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function createFactoryRun(input: CreateFactoryRunInput): FactoryRun {
  assertNonEmptyString(input.id, "FactoryRun id");
  assertNonEmptyString(input.request, "FactoryRun request");
  assertIsoTimestamp(input.createdAt, "FactoryRun createdAt");
  if (!(EXECUTION_TIERS as readonly string[]).includes(input.tier)) {
    throw new DomainError("invalid_argument", "FactoryRun tier is not supported");
  }
  if (
    typeof input.graph !== "object" ||
    input.graph === null ||
    !Array.isArray(input.graph.nodes)
  ) {
    throw new DomainError("invalid_argument", "FactoryRun graph is invalid");
  }
  const graph = createWorkGraph(input.graph.nodes);
  assertGraphNotNewerThan(graph, input.createdAt);

  return Object.freeze({
    id: input.id,
    request: input.request,
    tier: input.tier,
    status: "created" as const,
    graph,
    budget: freezeBudget(input.budget),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

export function updateRunGraph(
  run: FactoryRun,
  graph: WorkGraph,
  at: string,
): FactoryRun {
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    throw new DomainError(
      "invalid_state_transition",
      `FactoryRun ${run.id} cannot update its graph while ${run.status}`,
    );
  }
  assertTimestampNotBefore(at, run.updatedAt, "FactoryRun graph update timestamp");
  const snapshot = createWorkGraph(graph.nodes);
  assertGraphNotNewerThan(snapshot, at);
  return Object.freeze({ ...run, graph: snapshot, updatedAt: at });
}

export function startFactoryRun(run: FactoryRun, at: string): FactoryRun {
  return transitionFactoryRun(run, "running", at);
}

export function markFactoryRunWaitingHuman(run: FactoryRun, at: string): FactoryRun {
  return transitionFactoryRun(run, "waiting_human", at);
}

export function resumeFactoryRun(run: FactoryRun, at: string): FactoryRun {
  return transitionFactoryRun(run, "running", at);
}

export function completeFactoryRun(run: FactoryRun, at: string): FactoryRun {
  if (run.graph.nodes.length === 0) {
    throw new DomainError("run_incomplete", `FactoryRun ${run.id} has no WorkNodes`);
  }
  if (run.graph.nodes.some(({ status }) => status !== "completed")) {
    throw new DomainError(
      "run_incomplete",
      `FactoryRun ${run.id} has incomplete WorkNodes`,
    );
  }
  return transitionFactoryRun(run, "completed", at);
}

export function failFactoryRun(
  run: FactoryRun,
  at: string,
  reason: string,
): FactoryRun {
  assertNonEmptyString(reason, "FactoryRun failure reason");
  const transitioned = transitionFactoryRun(run, "failed", at);
  return Object.freeze({
    ...transitioned,
    failure: Object.freeze({ reason, at }),
  });
}

export function cancelFactoryRun(run: FactoryRun, at: string): FactoryRun {
  return transitionFactoryRun(run, "cancelled", at);
}
