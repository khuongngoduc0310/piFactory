import { describe, expect, it } from "vitest";

import {
  appendRunEvents,
  PersistenceError,
  type LoadedRun,
  type NewRunEvent,
  type RunEvent,
} from "../../src/persistence/index.js";
import {
  createFactoryRun,
  startFactoryRun,
  updateRunGraph,
} from "../../src/domain/factory-run.js";
import {
  createWorkGraph,
  markNodeBlocked,
  markNodeReady,
  markNodeRunning,
  unblockNode,
} from "../../src/domain/work-graph.js";
import { createWorkNode, type WorkNode } from "../../src/domain/work-node.js";
import {
  executeCreatedRun,
  SchedulerError,
  type RetrySafetyPolicy,
  type SchedulerRunStore,
  type SequentialNodeExecutor,
} from "../../src/scheduler/index.js";
import { snapshotFactoryRun } from "../../src/domain/factory-run.js";

const T0 = "2026-08-25T10:00:00.000Z";

class MemoryRunStore implements SchedulerRunStore {
  current: LoadedRun;

  constructor(initial: LoadedRun) {
    this.current = initial;
  }

  async save(
    run: LoadedRun["run"],
    expectedStateVersion: number,
    newEvents: readonly NewRunEvent[] = [],
  ): Promise<LoadedRun> {
    if (expectedStateVersion !== this.current.stateVersion) {
      throw new PersistenceError("stale_state_version", "The in-memory state is stale");
    }
    const events = appendRunEvents(run.id, this.current.events, newEvents);
    this.current = Object.freeze({
      run: snapshotFactoryRun(run),
      events,
      stateVersion: this.current.stateVersion + 1,
    });
    return this.current;
  }
}

function makeClock(): () => string {
  let next = Date.parse(T0) + 60_000;
  return () => {
    const result = new Date(next).toISOString();
    next += 60_000;
    return result;
  };
}

function makeEventIds(): () => string {
  let next = 1;
  return () => `event-${next++}`;
}

function makeNode(id: string, dependsOn: readonly string[] = []): WorkNode {
  return createWorkNode(
    {
      id,
      objective: `Complete ${id}`,
      role: "builder",
      builderMode: "implement",
      dependsOn,
      scope: {},
      acceptanceCriteria: ["The work is complete"],
      risk: "low",
      complexity: "small",
      parallelSafe: true,
    },
    T0,
  );
}

function makeRun(
  nodes: readonly WorkNode[],
  budget: { maxAgentCalls: number; maxRetriesPerNode: number } = {
    maxAgentCalls: 10,
    maxRetriesPerNode: 1,
  },
) {
  return createFactoryRun({
    id: "run-1",
    request: "Complete the requested work",
    tier: "fast",
    graph: createWorkGraph(nodes),
    budget: {
      maxParallelAgents: 4,
      ...budget,
    },
    createdAt: T0,
  });
}

function loaded(run: LoadedRun["run"]): LoadedRun {
  return Object.freeze({ run, events: Object.freeze([] as RunEvent[]), stateVersion: 1 });
}

function dependencies(
  store: SchedulerRunStore,
  executor: SequentialNodeExecutor,
  retrySafety: RetrySafetyPolicy = { isSafeToRetry: () => false },
) {
  return {
    store,
    executor,
    retrySafety,
    now: makeClock(),
    nextEventId: makeEventIds(),
  };
}

describe("executeCreatedRun", () => {
  it("runs a dependency graph in deterministic order and completes the run", async () => {
    const store = new MemoryRunStore(loaded(makeRun([makeNode("b", ["a"]), makeNode("a")])));
    const calls: string[] = [];
    const executor: SequentialNodeExecutor = {
      execute: async ({ node }) => {
        calls.push(node.id);
        return { kind: "succeeded" };
      },
    };

    const result = await executeCreatedRun(store.current, dependencies(store, executor));

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["a", "b"]);
    expect(result.loaded.run.status).toBe("completed");
    expect(result.loaded.run.graph.nodes.every(({ status }) => status === "completed")).toBe(true);
    expect(result.loaded.events.map(({ type }) => type)).toEqual([
      "factory_run_started",
      "node_ready",
      "node_started",
      "node_completed",
      "node_ready",
      "node_started",
      "node_completed",
      "factory_run_completed",
    ]);
    expect(result.usage.maximumConcurrentExecutors).toBe(1);
  });

  it("never overlaps executor calls", async () => {
    const store = new MemoryRunStore(loaded(makeRun([makeNode("a"), makeNode("b")])));
    let active = 0;
    let maximumActive = 0;
    const executor: SequentialNodeExecutor = {
      execute: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return { kind: "succeeded" };
      },
    };

    await executeCreatedRun(store.current, dependencies(store, executor));

    expect(maximumActive).toBe(1);
  });

  it("retries only a trusted retry-safe failure", async () => {
    const store = new MemoryRunStore(loaded(makeRun([makeNode("build")] )));
    let attempts = 0;
    const executor: SequentialNodeExecutor = {
      execute: async () => {
        attempts += 1;
        return attempts === 1
          ? {
              kind: "failed" as const,
              reason: "Transient setup failure",
            }
          : { kind: "succeeded" as const };
      },
    };

    const result = await executeCreatedRun(store.current, dependencies(store, executor, {
      isSafeToRetry: () => true,
    }));
    const node = result.loaded.run.graph.nodes[0];

    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(node?.retryCount).toBe(1);
    expect(node?.executionHistory.map(({ status }) => status)).toEqual([
      "pending",
      "ready",
      "running",
      "failed",
      "ready",
      "running",
      "completed",
    ]);
    expect(result.loaded.events.map(({ type }) => type)).toContain("node_retried");
  });

  it("fails after safe retries are exhausted", async () => {
    const store = new MemoryRunStore(
      loaded(makeRun([makeNode("build")], { maxAgentCalls: 3, maxRetriesPerNode: 1 })),
    );
    let attempts = 0;
    const executor: SequentialNodeExecutor = {
      execute: async () => {
        attempts += 1;
        return {
          kind: "failed" as const,
          reason: "Still unavailable",
        };
      },
    };

    const result = await executeCreatedRun(store.current, dependencies(store, executor, {
      isSafeToRetry: () => true,
    }));

    expect(result.status).toBe("failed");
    expect(attempts).toBe(2);
    expect(result.loaded.run.graph.nodes[0]?.retryCount).toBe(1);
    expect(result.loaded.run.failure?.reason).toBe("Still unavailable");
  });

  it("rejects roles and Builder modes reserved for later phases", async () => {
    const planner = createWorkNode(
      {
        id: "planner",
        objective: "Plan the work",
        role: "planner",
        dependsOn: [],
        scope: {},
        acceptanceCriteria: ["A plan exists"],
        risk: "low",
        complexity: "small",
        parallelSafe: false,
      },
      T0,
    );
    const store = new MemoryRunStore(loaded(makeRun([planner])));

    await expect(
      executeCreatedRun(
        store.current,
        dependencies(store, { execute: async () => ({ kind: "succeeded" }) }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_run_state" });
    expect(store.current.stateVersion).toBe(1);
  });

  it("rejects an empty graph before changing the saved run", async () => {
    const run = createFactoryRun({
      id: "run-1",
      request: "Build",
      tier: "fast",
      graph: createWorkGraph(),
      budget: { maxParallelAgents: 1, maxAgentCalls: 1, maxRetriesPerNode: 0 },
      createdAt: T0,
    });
    const store = new MemoryRunStore(loaded(run));

    await expect(
      executeCreatedRun(
        store.current,
        dependencies(store, { execute: async () => ({ kind: "succeeded" }) }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_run_state" });
    expect(store.current.stateVersion).toBe(1);
    expect(store.current.run.status).toBe("created");
  });

  it("rejects a pending node that contains a previous blocked attempt", async () => {
    let graph = createWorkGraph([makeNode("build")]);
    graph = markNodeBlocked(graph, "build", "2026-08-25T10:01:00.000Z", "External blocker");
    graph = unblockNode(graph, "build", "2026-08-25T10:02:00.000Z", "Blocker cleared");
    const run = createFactoryRun({
      id: "run-1",
      request: "Build",
      tier: "fast",
      graph,
      budget: { maxParallelAgents: 1, maxAgentCalls: 1, maxRetriesPerNode: 0 },
      createdAt: "2026-08-25T10:02:00.000Z",
    });
    const store = new MemoryRunStore(loaded(run));

    await expect(
      executeCreatedRun(
        store.current,
        dependencies(store, { execute: async () => ({ kind: "succeeded" }) }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_run_state" });
    expect(store.current.stateVersion).toBe(1);
  });

  it("fails fast on an unsafe failure and does not run independent work", async () => {
    const store = new MemoryRunStore(loaded(makeRun([makeNode("a"), makeNode("b")] )));
    const calls: string[] = [];
    const executor: SequentialNodeExecutor = {
      execute: async ({ node }) => {
        calls.push(node.id);
        return {
          kind: "failed",
          reason: "Partial mutation is possible",
        };
      },
    };

    const result = await executeCreatedRun(store.current, dependencies(store, executor));

    expect(result.status).toBe("failed");
    expect(calls).toEqual(["a"]);
    expect(result.loaded.run.failure?.reason).toBe("Partial mutation is possible");
    expect(result.loaded.run.graph.nodes.find(({ id }) => id === "b")?.status).toBe("pending");
  });

  it("does not invoke an executor when the call budget is zero", async () => {
    const store = new MemoryRunStore(
      loaded(makeRun([makeNode("build")], { maxAgentCalls: 0, maxRetriesPerNode: 0 })),
    );
    let calls = 0;
    const executor: SequentialNodeExecutor = {
      execute: async () => {
        calls += 1;
        return { kind: "succeeded" };
      },
    };

    const result = await executeCreatedRun(store.current, dependencies(store, executor));

    expect(result.status).toBe("failed");
    expect(calls).toBe(0);
    expect(result.loaded.run.graph.nodes[0]?.status).toBe("pending");
    expect(result.loaded.run.failure?.reason).toBe(
      "FactoryRun agent-call budget is exhausted",
    );
  });

  it("normalizes executor exceptions as unsafe failures", async () => {
    const store = new MemoryRunStore(loaded(makeRun([makeNode("build")] )));
    const executor: SequentialNodeExecutor = {
      execute: async () => {
        throw new Error("provider disconnected");
      },
    };

    const result = await executeCreatedRun(store.current, dependencies(store, executor));

    expect(result.status).toBe("failed");
    expect(result.loaded.run.failure?.reason).toContain("provider disconnected");
  });

  it("fails closed on a malformed executor outcome", async () => {
    const store = new MemoryRunStore(loaded(makeRun([makeNode("build")] )));
    const executor: SequentialNodeExecutor = {
      execute: async () => ({ kind: "succeeded", unexpected: true } as never),
    };

    const result = await executeCreatedRun(store.current, dependencies(store, executor));

    expect(result.status).toBe("failed");
    expect(result.loaded.run.failure?.reason).toBe("Executor returned an invalid outcome");
  });

  it("returns recovery_required without changing a running run", async () => {
    const created = makeRun([makeNode("build")]);
    const started = startFactoryRun(created, "2026-08-25T10:01:00.000Z");
    let graph = markNodeReady(started.graph, "build", "2026-08-25T10:02:00.000Z");
    graph = markNodeRunning(graph, "build", "2026-08-25T10:03:00.000Z");
    const running = updateRunGraph(started, graph, "2026-08-25T10:03:00.000Z");
    const store = new MemoryRunStore(loaded(running));

    const result = await executeCreatedRun(
      store.current,
      dependencies(store, { execute: async () => ({ kind: "succeeded" }) }),
    );

    expect(result.status).toBe("recovery_required");
    expect(result.loaded).toEqual(store.current);
    expect(store.current.stateVersion).toBe(1);
  });

  it("rejects token and cost budgets until usage accounting exists", async () => {
    const run = createFactoryRun({
      id: "run-1",
      request: "Build",
      tier: "fast",
      graph: createWorkGraph([makeNode("build")]),
      budget: {
        maxParallelAgents: 1,
        maxAgentCalls: 1,
        maxRetriesPerNode: 0,
        maxCostUsd: 1,
      },
      createdAt: T0,
    });
    const store = new MemoryRunStore(loaded(run));

    await expect(
      executeCreatedRun(
        store.current,
        dependencies(store, { execute: async () => ({ kind: "succeeded" }) }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_budget" } satisfies Partial<SchedulerError>);
    expect(store.current.stateVersion).toBe(1);
  });
});
