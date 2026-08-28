import type { FactoryRun } from "../domain/factory-run.js";
import type { WorkGraph } from "../domain/work-graph.js";
import type { WorkNode } from "../domain/work-node.js";

export interface SchedulerBudgetUsage {
  readonly executorCalls: number;
  readonly retries: number;
}

export function countExecutorCalls(graph: WorkGraph): number {
  let calls = 0;
  for (const node of graph.nodes) {
    for (const entry of node.executionHistory) {
      if (entry.status === "running") {
        calls += 1;
      }
    }
  }
  return calls;
}

export function countRetries(graph: WorkGraph): number {
  return graph.nodes.reduce((total, node) => total + node.retryCount, 0);
}

export function getSchedulerBudgetUsage(run: FactoryRun): SchedulerBudgetUsage {
  return Object.freeze({
    executorCalls: countExecutorCalls(run.graph),
    retries: countRetries(run.graph),
  });
}

export function canStartExecutorCall(run: FactoryRun): boolean {
  return countExecutorCalls(run.graph) < run.budget.maxAgentCalls;
}

export function canRetryNode(run: FactoryRun, node: WorkNode): boolean {
  return node.retryCount < run.budget.maxRetriesPerNode && canStartExecutorCall(run);
}
