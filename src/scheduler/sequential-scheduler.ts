import type {
  ExecutionTier,
  FactoryRun,
} from "../domain/factory-run.js";
import {
  completeFactoryRun,
  failFactoryRun,
  startFactoryRun,
  updateRunGraph,
} from "../domain/factory-run.js";
import {
  getNode,
  getReadyNodes,
  markNodeCompleted,
  markNodeFailed,
  markNodeReady,
  markNodeRunning,
  retryNode,
} from "../domain/work-graph.js";
import type { WorkNode } from "../domain/work-node.js";
import type {
  LoadedRun,
  NewRunEvent,
  RunEventType,
} from "../persistence/persistence-types.js";
import {
  canRetryNode,
  canStartExecutorCall,
  getSchedulerBudgetUsage,
  type SchedulerBudgetUsage,
} from "./budgets.js";
import {
  selectNextRunnableNode,
} from "./execution-policy.js";
import { SchedulerError } from "./scheduler-error.js";

export interface SchedulerRunStore {
  save(
    run: FactoryRun,
    expectedStateVersion: number,
    newEvents?: readonly NewRunEvent[],
  ): Promise<LoadedRun>;
}

export interface SequentialNodeExecutor {
  execute(input: {
    readonly runId: string;
    readonly request: string;
    readonly tier: ExecutionTier;
    readonly node: WorkNode;
    readonly attempt: number;
  }): Promise<NodeExecutionOutcome>;
}

export type NodeExecutionOutcome =
  | { readonly kind: "succeeded" }
  | {
      readonly kind: "failed";
      readonly reason: string;
    };

export interface RetrySafetyPolicy {
  isSafeToRetry(input: {
    readonly node: WorkNode;
    readonly reason: string;
  }): boolean;
}

export interface SequentialSchedulerDependencies {
  readonly store: SchedulerRunStore;
  readonly executor: SequentialNodeExecutor;
  readonly retrySafety: RetrySafetyPolicy;
  readonly now: () => string;
  readonly nextEventId: () => string;
}

export interface SequentialSchedulerUsage extends SchedulerBudgetUsage {
  readonly maximumConcurrentExecutors: 0 | 1;
}

export type SequentialSchedulerResult =
  | {
      readonly status: "completed";
      readonly loaded: LoadedRun;
      readonly usage: SequentialSchedulerUsage;
    }
  | {
      readonly status: "failed";
      readonly loaded: LoadedRun;
      readonly usage: SequentialSchedulerUsage;
    }
  | {
      readonly status: "recovery_required";
      readonly loaded: LoadedRun;
      readonly reason: string;
      readonly usage: SequentialSchedulerUsage;
    };

const MAX_FAILURE_REASON_LENGTH = 4 * 1_024;
const INVALID_EXECUTOR_OUTCOME_REASON = "Executor returned an invalid outcome";
const EXECUTOR_EXCEPTION_REASON = "Executor failed without a retry-safe result";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function isFailureReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_FAILURE_REASON_LENGTH
  );
}

function normalizeOutcome(value: unknown): NodeExecutionOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return {
      kind: "failed",
      reason: INVALID_EXECUTOR_OUTCOME_REASON,
    };
  }
  if (value.kind === "succeeded" && hasKeys(value, ["kind"])) {
    return { kind: "succeeded" };
  }
  if (
    value.kind === "failed" &&
    hasKeys(value, ["kind", "reason"]) &&
    isFailureReason(value.reason)
  ) {
    return {
      kind: "failed",
      reason: value.reason.trim(),
    };
  }
  return {
    kind: "failed",
    reason: INVALID_EXECUTOR_OUTCOME_REASON,
  };
}

function normalizeExecutorException(error: unknown): NodeExecutionOutcome {
  if (error instanceof Error && isFailureReason(error.message)) {
    return {
      kind: "failed",
      reason: `${EXECUTOR_EXCEPTION_REASON}: ${error.message.trim()}`.slice(
        0,
        MAX_FAILURE_REASON_LENGTH,
      ),
    };
  }
  return {
    kind: "failed",
    reason: EXECUTOR_EXCEPTION_REASON,
  };
}

function event(
  dependencies: SequentialSchedulerDependencies,
  type: RunEventType,
  timestamp: string,
  payload: NewRunEvent["payload"],
): NewRunEvent {
  return Object.freeze({
    id: dependencies.nextEventId(),
    timestamp,
    type,
    payload: Object.freeze({ ...payload }),
  });
}

async function commit(
  current: LoadedRun,
  nextRun: FactoryRun,
  events: readonly NewRunEvent[],
  dependencies: SequentialSchedulerDependencies,
): Promise<LoadedRun> {
  return dependencies.store.save(nextRun, current.stateVersion, events);
}

function usage(
  loaded: LoadedRun,
  maximumConcurrentExecutors: 0 | 1,
): SequentialSchedulerUsage {
  return Object.freeze({
    ...getSchedulerBudgetUsage(loaded.run),
    maximumConcurrentExecutors,
  });
}

function assertSupportedBudget(run: FactoryRun): void {
  if (run.budget.maxTokens !== undefined || run.budget.maxCostUsd !== undefined) {
    throw new SchedulerError(
      "unsupported_budget",
      "Phase 4 cannot enforce token or cost budgets without usage accounting",
    );
  }
}

function assertFreshRun(loaded: LoadedRun): void {
  if (loaded.run.status !== "created") {
    throw new SchedulerError(
      "unsupported_run_state",
      `Sequential scheduling requires a created FactoryRun, found ${loaded.run.status}`,
    );
  }
  if (loaded.run.graph.nodes.some(({ status }) => status !== "pending")) {
    throw new SchedulerError(
      "unsupported_run_state",
      "Phase 4 only schedules graphs containing pending WorkNodes",
    );
  }
  if (loaded.run.graph.nodes.length === 0) {
    throw new SchedulerError(
      "unsupported_run_state",
      "Phase 4 requires at least one WorkNode",
    );
  }
  if (
    loaded.run.graph.nodes.some(
      (node) =>
        node.executionHistory.length !== 1 ||
        node.executionHistory[0]?.status !== "pending" ||
        node.retryCount !== 0 ||
        node.artifactRefs.length !== 0 ||
        node.outputDigest !== undefined,
    )
  ) {
    throw new SchedulerError(
      "unsupported_run_state",
      "Phase 4 requires WorkNodes with no previous execution history",
    );
  }
  if (
    loaded.run.graph.nodes.some(
      ({ role, builderMode }) => role !== "builder" || builderMode !== "implement",
    )
  ) {
    throw new SchedulerError(
      "unsupported_run_state",
      "Phase 4 only schedules Builder WorkNodes in implement mode",
    );
  }
}

function recoveryResult(loaded: LoadedRun): SequentialSchedulerResult {
  return Object.freeze({
    status: "recovery_required" as const,
    loaded,
    reason: "FactoryRun execution state requires Phase 19 recovery",
    usage: usage(loaded, 0),
  });
}

async function failRun(
  current: LoadedRun,
  reason: string,
  dependencies: SequentialSchedulerDependencies,
  maximumConcurrentExecutors: 0 | 1,
): Promise<SequentialSchedulerResult> {
  const timestamp = dependencies.now();
  const failedRun = failFactoryRun(current.run, timestamp, reason);
  const saved = await commit(
    current,
    failedRun,
    [
      event(dependencies, "factory_run_failed", timestamp, {
        reason,
      }),
    ],
    dependencies,
  );
  return Object.freeze({
    status: "failed" as const,
    loaded: saved,
    usage: usage(saved, maximumConcurrentExecutors),
  });
}

async function prepareNodeForExecution(
  current: LoadedRun,
  selected: WorkNode,
  dependencies: SequentialSchedulerDependencies,
): Promise<{ readonly loaded: LoadedRun; readonly node: WorkNode }> {
  let prepared = current;
  if (selected.status === "pending") {
    const readyTimestamp = dependencies.now();
    const readyGraph = markNodeReady(
      prepared.run.graph,
      selected.id,
      readyTimestamp,
    );
    prepared = await commit(
      prepared,
      updateRunGraph(prepared.run, readyGraph, readyTimestamp),
      [
        event(dependencies, "node_ready", readyTimestamp, {
          nodeId: selected.id,
        }),
      ],
      dependencies,
    );
  }

  const readyNode = getNode(prepared.run.graph, selected.id);
  const runningTimestamp = dependencies.now();
  const runningGraph = markNodeRunning(
    prepared.run.graph,
    readyNode.id,
    runningTimestamp,
  );
  prepared = await commit(
    prepared,
    updateRunGraph(prepared.run, runningGraph, runningTimestamp),
    [
      event(dependencies, "node_started", runningTimestamp, {
        nodeId: readyNode.id,
        attempt: readyNode.retryCount + 1,
      }),
    ],
    dependencies,
  );
  return Object.freeze({
    loaded: prepared,
    node: getNode(prepared.run.graph, readyNode.id),
  });
}

async function executeNode(
  loaded: LoadedRun,
  node: WorkNode,
  dependencies: SequentialSchedulerDependencies,
): Promise<NodeExecutionOutcome> {
  try {
    const rawOutcome = await dependencies.executor.execute({
      runId: loaded.run.id,
      request: loaded.run.request,
      tier: loaded.run.tier,
      node,
      attempt: node.retryCount + 1,
    });
    return normalizeOutcome(rawOutcome);
  } catch (error: unknown) {
    return normalizeExecutorException(error);
  }
}

async function completeNode(
  current: LoadedRun,
  nodeId: string,
  dependencies: SequentialSchedulerDependencies,
): Promise<LoadedRun> {
  const timestamp = dependencies.now();
  const completedGraph = markNodeCompleted(current.run.graph, nodeId, timestamp);
  return commit(
    current,
    updateRunGraph(current.run, completedGraph, timestamp),
    [
      event(dependencies, "node_completed", timestamp, {
        nodeId,
      }),
    ],
    dependencies,
  );
}

async function failNode(
  current: LoadedRun,
  nodeId: string,
  reason: string,
  dependencies: SequentialSchedulerDependencies,
): Promise<LoadedRun> {
  const timestamp = dependencies.now();
  const failedGraph = markNodeFailed(current.run.graph, nodeId, timestamp, reason);
  return commit(
    current,
    updateRunGraph(current.run, failedGraph, timestamp),
    [
      event(dependencies, "node_failed", timestamp, {
        nodeId,
        reason,
      }),
    ],
    dependencies,
  );
}

async function retryFailedNode(
  current: LoadedRun,
  node: WorkNode,
  dependencies: SequentialSchedulerDependencies,
): Promise<LoadedRun> {
  const reason = "Executor failure was independently classified as retry-safe";
  const timestamp = dependencies.now();
  const retriedGraph = retryNode(current.run.graph, node.id, timestamp, reason);
  return commit(
    current,
    updateRunGraph(current.run, retriedGraph, timestamp),
    [
      event(dependencies, "node_retried", timestamp, {
        nodeId: node.id,
        retryCount: node.retryCount + 1,
        reason,
      }),
    ],
    dependencies,
  );
}

export async function executeCreatedRun(
  loaded: LoadedRun,
  dependencies: SequentialSchedulerDependencies,
): Promise<SequentialSchedulerResult> {
  if (loaded.run.status === "running") {
    return recoveryResult(loaded);
  }
  assertFreshRun(loaded);
  assertSupportedBudget(loaded.run);

  let current = loaded;
  let maximumConcurrentExecutors: 0 | 1 = 0;

  const startTimestamp = dependencies.now();
  const startedRun = startFactoryRun(current.run, startTimestamp);
  current = await commit(
    current,
    startedRun,
    [event(dependencies, "factory_run_started", startTimestamp, {})],
    dependencies,
  );

  while (true) {
    const readyNodes = getReadyNodes(current.run.graph);
    const selected = selectNextRunnableNode(readyNodes);
    if (selected === undefined) {
      return failRun(
        current,
        "FactoryRun has no runnable WorkNodes",
        dependencies,
        maximumConcurrentExecutors,
      );
    }
    if (!canStartExecutorCall(current.run)) {
      return failRun(
        current,
        "FactoryRun agent-call budget is exhausted",
        dependencies,
        maximumConcurrentExecutors,
      );
    }

    const prepared = await prepareNodeForExecution(current, selected, dependencies);
    current = prepared.loaded;
    const runningNode = prepared.node;
    maximumConcurrentExecutors = 1;
    const outcome = await executeNode(current, runningNode, dependencies);

    if (outcome.kind === "succeeded") {
      current = await completeNode(current, runningNode.id, dependencies);
      if (current.run.graph.nodes.every(({ status }) => status === "completed")) {
        const runCompletedTimestamp = dependencies.now();
        const completedRun = completeFactoryRun(current.run, runCompletedTimestamp);
        current = await commit(
          current,
          completedRun,
          [
            event(dependencies, "factory_run_completed", runCompletedTimestamp, {}),
          ],
          dependencies,
        );
        return Object.freeze({
          status: "completed" as const,
          loaded: current,
          usage: usage(current, maximumConcurrentExecutors),
        });
      }
      continue;
    }

    current = await failNode(current, runningNode.id, outcome.reason, dependencies);

    const failedNode = getNode(current.run.graph, runningNode.id);
    if (
      dependencies.retrySafety.isSafeToRetry({
        node: failedNode,
        reason: outcome.reason,
      }) &&
      canRetryNode(current.run, failedNode)
    ) {
      current = await retryFailedNode(current, failedNode, dependencies);
      continue;
    }

    return failRun(
      current,
      outcome.reason,
      dependencies,
      maximumConcurrentExecutors,
    );
  }
}
