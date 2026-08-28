import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFactoryRun,
  createWorkGraph,
  createWorkNode,
} from "../../src/domain/index.js";
import { FileRunStore, PersistenceError } from "../../src/persistence/index.js";
import {
  executeCreatedRun,
  type RetrySafetyPolicy,
  type SequentialNodeExecutor,
} from "../../src/scheduler/index.js";

const T0 = "2026-08-25T10:00:00.000Z";

const directories: string[] = [];

function makeRun() {
  const first = createWorkNode(
    {
      id: "first",
      objective: "Complete the first step",
      role: "builder",
      builderMode: "implement",
      dependsOn: [],
      scope: {},
      acceptanceCriteria: ["The first step is complete"],
      risk: "low",
      complexity: "small",
      parallelSafe: false,
    },
    T0,
  );
  const second = createWorkNode(
    {
      id: "second",
      objective: "Complete the second step",
      role: "builder",
      builderMode: "implement",
      dependsOn: ["first"],
      scope: {},
      acceptanceCriteria: ["The second step is complete"],
      risk: "low",
      complexity: "small",
      parallelSafe: false,
    },
    T0,
  );
  return createFactoryRun({
    id: "integration-run",
    request: "Complete both steps",
    tier: "standard",
    graph: createWorkGraph([second, first]),
    budget: {
      maxParallelAgents: 4,
      maxAgentCalls: 2,
      maxRetriesPerNode: 0,
    },
    createdAt: T0,
  });
}

function makeClock(): () => string {
  let next = Date.parse(T0) + 60_000;
  return () => {
    const timestamp = new Date(next).toISOString();
    next += 60_000;
    return timestamp;
  };
}

function makeExecutor(calls: string[]): SequentialNodeExecutor {
  return {
    execute: async ({ node }) => {
      calls.push(node.id);
      return { kind: "succeeded" };
    },
  };
}

const noRetryPolicy: RetrySafetyPolicy = Object.freeze({
  isSafeToRetry: () => false,
});

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("sequential scheduler persistence integration", () => {
  it("persists every transition and round-trips the completed run", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifactory-phase4-"));
    directories.push(root);
    const store = new FileRunStore({ storageRoot: root });
    const created = await store.create(makeRun());
    const calls: string[] = [];

    const result = await executeCreatedRun(created, {
      store,
      executor: makeExecutor(calls),
      retrySafety: noRetryPolicy,
      now: makeClock(),
      nextEventId: (() => {
        let next = 1;
        return () => `event-${next++}`;
      })(),
    });
    const restored = await new FileRunStore({ storageRoot: root }).load("integration-run");

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["first", "second"]);
    expect(result.loaded.stateVersion).toBe(9);
    expect(restored).toEqual(result.loaded);
    expect(restored.events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 8 }, (_, index) => index + 1),
    );
    expect(restored.events.at(-1)?.type).toBe("factory_run_completed");
  });

  it("does not invoke work when the dispatch commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifactory-phase4-failure-"));
    directories.push(root);
    let currentPublishes = 0;
    const store = new FileRunStore({
      storageRoot: root,
      hooks: {
        beforeCurrentPublish: () => {
          currentPublishes += 1;
          if (currentPublishes === 4) {
            throw new PersistenceError("io_failure", "Injected dispatch publication failure");
          }
        },
      },
    });
    const created = await store.create(makeRun());
    let calls = 0;
    const executor: SequentialNodeExecutor = {
      execute: async () => {
        calls += 1;
        return { kind: "succeeded" };
      },
    };

    await expect(
      executeCreatedRun(created, {
        store,
        executor,
        retrySafety: noRetryPolicy,
        now: makeClock(),
        nextEventId: (() => {
          let next = 1;
          return () => `event-${next++}`;
        })(),
      }),
    ).rejects.toMatchObject({ code: "io_failure" });

    expect(calls).toBe(0);
    const preDispatch = await new FileRunStore({ storageRoot: root }).load("integration-run");
    expect(preDispatch.run.status).toBe("running");
    expect(preDispatch.run.graph.nodes[0]?.status).toBe("ready");
    expect(preDispatch.stateVersion).toBe(3);
    expect(preDispatch.events.map(({ type }) => type)).toEqual([
      "factory_run_started",
      "node_ready",
    ]);
  });

  it("does not invoke work again when the outcome commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifactory-phase4-outcome-"));
    directories.push(root);
    let currentPublishes = 0;
    const store = new FileRunStore({
      storageRoot: root,
      hooks: {
        beforeCurrentPublish: () => {
          currentPublishes += 1;
          if (currentPublishes === 5) {
            throw new PersistenceError("io_failure", "Injected outcome publication failure");
          }
        },
      },
    });
    const created = await store.create(makeRun());
    let calls = 0;
    const executor: SequentialNodeExecutor = {
      execute: async () => {
        calls += 1;
        return { kind: "succeeded" };
      },
    };

    await expect(
      executeCreatedRun(created, {
        store,
        executor,
        retrySafety: noRetryPolicy,
        now: makeClock(),
        nextEventId: (() => {
          let next = 1;
          return () => `event-${next++}`;
        })(),
      }),
    ).rejects.toMatchObject({ code: "io_failure" });

    expect(calls).toBe(1);
    const uncertain = await new FileRunStore({ storageRoot: root }).load("integration-run");
    expect(uncertain.run.status).toBe("running");
    expect(uncertain.run.graph.nodes[0]?.status).toBe("running");
  });
});
