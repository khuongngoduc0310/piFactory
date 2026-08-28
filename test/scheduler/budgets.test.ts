import { describe, expect, it } from "vitest";

import {
  canRetryNode,
  canStartExecutorCall,
  getSchedulerBudgetUsage,
} from "../../src/scheduler/index.js";
import {
  createFactoryRun,
  startFactoryRun,
  updateRunGraph,
} from "../../src/domain/factory-run.js";
import {
  createWorkGraph,
  markNodeFailed,
  markNodeReady,
  markNodeRunning,
} from "../../src/domain/work-graph.js";
import { createWorkNode } from "../../src/domain/work-node.js";

const T0 = "2026-08-25T10:00:00.000Z";
const T1 = "2026-08-25T10:01:00.000Z";
const T2 = "2026-08-25T10:02:00.000Z";
const T3 = "2026-08-25T10:03:00.000Z";

function makeRun(maxAgentCalls = 2, maxRetriesPerNode = 1) {
  const node = createWorkNode(
    {
      id: "build",
      objective: "Build the change",
      role: "builder",
      builderMode: "implement",
      dependsOn: [],
      scope: {},
      acceptanceCriteria: ["The change is complete"],
      risk: "low",
      complexity: "small",
      parallelSafe: false,
    },
    T0,
  );
  return createFactoryRun({
    id: "run-1",
    request: "Build",
    tier: "fast",
    graph: createWorkGraph([node]),
    budget: {
      maxParallelAgents: 4,
      maxAgentCalls,
      maxRetriesPerNode,
    },
    createdAt: T0,
  });
}

describe("scheduler budget accounting", () => {
  it("derives calls from durable running history and retries from retryCount", () => {
    const created = makeRun();
    const started = startFactoryRun(created, T1);
    let graph = markNodeReady(started.graph, "build", T1);
    graph = markNodeRunning(graph, "build", T2);
    graph = markNodeFailed(graph, "build", T3, "Safe failure");
    const run = updateRunGraph(started, graph, T3);

    expect(getSchedulerBudgetUsage(run)).toEqual({ executorCalls: 1, retries: 0 });
    expect(canStartExecutorCall(run)).toBe(true);
    expect(canRetryNode(run, graph.nodes[0]!)).toBe(true);
  });

  it("rejects another attempt when the global call budget is exhausted", () => {
    const created = makeRun(1, 3);
    const started = startFactoryRun(created, T1);
    let graph = markNodeReady(started.graph, "build", T1);
    graph = markNodeRunning(graph, "build", T2);
    graph = markNodeFailed(graph, "build", T3, "Safe failure");
    const run = updateRunGraph(started, graph, T3);

    expect(canStartExecutorCall(run)).toBe(false);
    expect(canRetryNode(run, graph.nodes[0]!)).toBe(false);
  });
});
