import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/domain-error.js";
import {
  canTransitionFactoryRun,
  cancelFactoryRun,
  completeFactoryRun,
  createFactoryRun,
  failFactoryRun,
  markFactoryRunWaitingHuman,
  resumeFactoryRun,
  snapshotFactoryRun,
  startFactoryRun,
  updateRunGraph,
  validateFactoryRun,
  type FactoryRun,
  type FactoryRunStatus,
} from "../../src/domain/factory-run.js";
import {
  createWorkGraph,
  markNodeCompleted,
  markNodeReady,
  markNodeRunning,
} from "../../src/domain/work-graph.js";
import { createWorkNode } from "../../src/domain/work-node.js";

const T0 = "2026-08-25T10:00:00.000Z";
const T1 = "2026-08-25T10:01:00.000Z";
const T2 = "2026-08-25T10:02:00.000Z";
const T3 = "2026-08-25T10:03:00.000Z";
const T4 = "2026-08-25T10:04:00.000Z";
const T5 = "2026-08-25T10:05:00.000Z";

function initialGraph() {
  return createWorkGraph([
    createWorkNode(
      {
        id: "build",
        objective: "Implement the request",
        role: "builder",
        builderMode: "implement",
        dependsOn: [],
        scope: {},
        acceptanceCriteria: ["Implementation passes targeted checks"],
        risk: "low",
        complexity: "small",
        parallelSafe: false,
      },
      T0,
    ),
  ]);
}

function makeRun(): FactoryRun {
  return createFactoryRun({
    id: "run-1",
    request: "Implement the domain core",
    tier: "fast",
    graph: initialGraph(),
    budget: {
      maxParallelAgents: 1,
      maxAgentCalls: 1,
      maxRetriesPerNode: 0,
      maxTokens: 0,
      maxCostUsd: 0,
    },
    createdAt: T0,
  });
}

describe("createFactoryRun", () => {
  it("creates an immutable run and budget", () => {
    const run = makeRun();

    expect(run.status).toBe("created");
    expect(run.updatedAt).toBe(T0);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.budget)).toBe(true);
    expect(Object.isFrozen(run.graph)).toBe(true);
  });

  it.each([
    ["parallelism", { maxParallelAgents: 0, maxAgentCalls: 1, maxRetriesPerNode: 0 }],
    ["agent calls", { maxParallelAgents: 1, maxAgentCalls: -1, maxRetriesPerNode: 0 }],
    ["retries", { maxParallelAgents: 1, maxAgentCalls: 1, maxRetriesPerNode: -1 }],
    [
      "tokens",
      { maxParallelAgents: 1, maxAgentCalls: 1, maxRetriesPerNode: 0, maxTokens: 1.5 },
    ],
    [
      "cost",
      { maxParallelAgents: 1, maxAgentCalls: 1, maxRetriesPerNode: 0, maxCostUsd: -1 },
    ],
  ])("rejects an invalid %s budget", (_field, budget) => {
    expect(() =>
      createFactoryRun({
        id: "run-1",
        request: "Build",
        tier: "fast",
        graph: initialGraph(),
        budget,
        createdAt: T0,
      }),
    ).toThrow(DomainError);
  });

  it("rejects a creation timestamp older than graph state", () => {
    let graph = markNodeReady(initialGraph(), "build", T2);

    expect(() =>
      createFactoryRun({
        id: "run-1",
        request: "Build",
        tier: "fast",
        graph,
        budget: { maxParallelAgents: 1, maxAgentCalls: 1, maxRetriesPerNode: 0 },
        createdAt: T1,
      }),
    ).toThrow(DomainError);
  });

  it("rejects unsupported execution tiers at runtime", () => {
    expect(() =>
      createFactoryRun({
        id: "run-1",
        request: "Build",
        tier: "urgent",
        graph: initialGraph(),
        budget: { maxParallelAgents: 1, maxAgentCalls: 1, maxRetriesPerNode: 0 },
        createdAt: T0,
      } as unknown as Parameters<typeof createFactoryRun>[0]),
    ).toThrow(DomainError);
  });
});

describe("FactoryRun reconstruction", () => {
  it("validates and deeply snapshots every non-created run state", () => {
    const running = startFactoryRun(makeRun(), T1);
    const waiting = markFactoryRunWaitingHuman(running, T2);
    const failed = failFactoryRun(running, T2, "Execution failed");
    const cancelled = cancelFactoryRun(makeRun(), T1);
    let completedGraph = markNodeReady(running.graph, "build", T2);
    completedGraph = markNodeRunning(completedGraph, "build", T3);
    completedGraph = markNodeCompleted(completedGraph, "build", T4, {
      artifactRefs: ["artifact-build"],
      outputDigest: "opaque-output",
    });
    const completed = completeFactoryRun(updateRunGraph(running, completedGraph, T4), T5);

    for (const run of [running, waiting, failed, cancelled, completed]) {
      const restored = snapshotFactoryRun(JSON.parse(JSON.stringify(run)) as unknown);
      expect(restored).toEqual(run);
      expect(Object.isFrozen(restored)).toBe(true);
      expect(Object.isFrozen(restored.graph)).toBe(true);
      expect(Object.isFrozen(restored.graph.nodes[0]?.executionHistory)).toBe(true);
    }
  });

  it("reports invalid persisted run state without trusting its cast", () => {
    const run = JSON.parse(JSON.stringify(makeRun())) as Record<string, unknown>;
    run.status = "completed";

    const issues = validateFactoryRun(run);

    expect(issues.some(({ code }) => code === "incomplete_run")).toBe(true);
    expect(() => snapshotFactoryRun(run)).toThrow(DomainError);
  });
});

describe("FactoryRun state machine", () => {
  const statuses: readonly FactoryRunStatus[] = [
    "created",
    "running",
    "waiting_human",
    "completed",
    "failed",
    "cancelled",
  ];
  const allowed = new Set([
    "created:running",
    "created:cancelled",
    "running:waiting_human",
    "running:completed",
    "running:failed",
    "running:cancelled",
    "waiting_human:running",
    "waiting_human:failed",
    "waiting_human:cancelled",
  ]);

  it("defines every allowed and rejected status pair", () => {
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransitionFactoryRun(from, to), `${from} -> ${to}`).toBe(
          allowed.has(`${from}:${to}`),
        );
      }
    }
  });

  it("waits for a human and resumes", () => {
    const running = startFactoryRun(makeRun(), T1);
    const waiting = markFactoryRunWaitingHuman(running, T2);
    const resumed = resumeFactoryRun(waiting, T3);

    expect(waiting.status).toBe("waiting_human");
    expect(resumed.status).toBe("running");
    expect(running.status).toBe("running");
  });

  it("updates its immutable graph and completes only after all work completes", () => {
    const running = startFactoryRun(makeRun(), T1);
    let graph = markNodeReady(running.graph, "build", T2);
    graph = markNodeRunning(graph, "build", T3);
    graph = markNodeCompleted(graph, "build", T4, {
      artifactRefs: ["artifact-build"],
    });
    const updated = updateRunGraph(running, graph, T4);
    const completed = completeFactoryRun(updated, T5);

    expect(running.graph.nodes[0]?.status).toBe("pending");
    expect(updated.graph.nodes[0]?.status).toBe("completed");
    expect(completed.status).toBe("completed");
  });

  it("rejects completion of an empty or incomplete graph", () => {
    const incomplete = startFactoryRun(makeRun(), T1);
    const empty = startFactoryRun(
      createFactoryRun({
        id: "empty",
        request: "Nothing yet",
        tier: "standard",
        graph: createWorkGraph(),
        budget: { maxParallelAgents: 1, maxAgentCalls: 0, maxRetriesPerNode: 0 },
        createdAt: T0,
      }),
      T1,
    );

    expect(() => completeFactoryRun(incomplete, T2)).toThrow(DomainError);
    expect(() => completeFactoryRun(empty, T2)).toThrow(DomainError);
  });

  it("records failures and supports cancellation from non-terminal states", () => {
    const running = startFactoryRun(makeRun(), T1);
    const failed = failFactoryRun(running, T2, "Execution failed");
    const cancelled = cancelFactoryRun(makeRun(), T1);

    expect(failed.failure).toEqual({ reason: "Execution failed", at: T2 });
    expect(cancelled.status).toBe("cancelled");
    expect(() => cancelFactoryRun(failed, T3)).toThrow(DomainError);
  });

  it("fails or cancels while waiting and cancels while running", () => {
    const running = startFactoryRun(makeRun(), T1);
    const waiting = markFactoryRunWaitingHuman(running, T2);

    expect(failFactoryRun(waiting, T3, "Decision failed").status).toBe("failed");
    expect(cancelFactoryRun(waiting, T3).status).toBe("cancelled");
    expect(cancelFactoryRun(running, T2).status).toBe("cancelled");
  });

  it("rejects graph replacement on terminal runs and backwards time", () => {
    const running = startFactoryRun(makeRun(), T2);
    const failed = failFactoryRun(running, T3, "Execution failed");

    expect(() => updateRunGraph(failed, failed.graph, T4)).toThrow(DomainError);
    expect(() => markFactoryRunWaitingHuman(running, T1)).toThrow(DomainError);
  });
});
