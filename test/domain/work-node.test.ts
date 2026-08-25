import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/domain-error.js";
import {
  canTransitionWorkNode,
  createWorkNode,
  markWorkNodeBlocked,
  markWorkNodeCompleted,
  markWorkNodeFailed,
  markWorkNodeReady,
  markWorkNodeRunning,
  markWorkNodeWaitingHuman,
  retryWorkNode,
  unblockWorkNode,
  type WorkNode,
  type WorkNodeStatus,
} from "../../src/domain/work-node.js";

const T0 = "2026-08-25T10:00:00.000Z";
const T1 = "2026-08-25T10:01:00.000Z";
const T2 = "2026-08-25T10:02:00.000Z";
const T3 = "2026-08-25T10:03:00.000Z";
const T4 = "2026-08-25T10:04:00.000Z";
const T5 = "2026-08-25T10:05:00.000Z";
const T6 = "2026-08-25T10:06:00.000Z";
const T7 = "2026-08-25T10:07:00.000Z";
const T8 = "2026-08-25T10:08:00.000Z";

function makeNode(): WorkNode {
  return createWorkNode(
    {
      id: "build-domain",
      objective: "Implement the domain core",
      role: "builder",
      builderMode: "implement",
      dependsOn: [],
      scope: { relevantPaths: ["src/domain"] },
      acceptanceCriteria: ["Domain tests pass"],
      risk: "medium",
      complexity: "medium",
      parallelSafe: false,
    },
    T0,
  );
}

describe("createWorkNode", () => {
  it("creates a pending immutable node with normalized dependencies", () => {
    const dependsOn = ["node-z", "node-a", "node-z"];
    const relevantPaths = ["src/domain"];

    const node = createWorkNode(
      {
        id: "node-b",
        objective: "Build B",
        role: "builder",
        builderMode: "test",
        dependsOn,
        scope: { relevantPaths },
        acceptanceCriteria: ["Tests pass"],
        risk: "low",
        complexity: "small",
        parallelSafe: true,
      },
      T0,
    );

    dependsOn.push("node-c");
    relevantPaths.push("package.json");

    expect(node.status).toBe("pending");
    expect(node.dependsOn).toEqual(["node-a", "node-z"]);
    expect(node.scope.relevantPaths).toEqual(["src/domain"]);
    expect(node.retryCount).toBe(0);
    expect(node.executionHistory).toEqual([{ status: "pending", at: T0 }]);
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.scope)).toBe(true);
    expect(Object.isFrozen(node.executionHistory)).toBe(true);
  });

  it("requires a Builder mode for Builder nodes", () => {
    expect(() => {
      createWorkNode(
        {
          id: "builder",
          objective: "Build",
          role: "builder",
          dependsOn: [],
          scope: {},
          acceptanceCriteria: ["Done"],
          risk: "low",
          complexity: "small",
          parallelSafe: false,
        },
        T0,
      );
    }).toThrow(DomainError);
  });

  it("forbids a Builder mode for non-Builder nodes", () => {
    expect(() =>
      createWorkNode(
        {
          id: "planner",
          objective: "Plan",
          role: "planner",
          builderMode: "implement",
          dependsOn: [],
          scope: {},
          acceptanceCriteria: ["Plan exists"],
          risk: "low",
          complexity: "small",
          parallelSafe: false,
        },
        T0,
      ),
    ).toThrow(DomainError);
  });

  it("rejects missing acceptance criteria", () => {
    expect(() =>
      createWorkNode(
        {
          id: "review",
          objective: "Review",
          role: "reviewer",
          dependsOn: [],
          scope: {},
          acceptanceCriteria: [],
          risk: "low",
          complexity: "small",
          parallelSafe: false,
        },
        T0,
      ),
    ).toThrow(DomainError);
  });

  it.each(["not-a-date", "August 25, 2026", "2026-02-30T10:00:00.000Z"])(
    "rejects non-canonical or impossible timestamp %s",
    (timestamp) => {
      expect(() =>
        createWorkNode(
          {
            id: "review",
            objective: "Review",
            role: "reviewer",
            dependsOn: [],
            scope: {},
            acceptanceCriteria: ["Review complete"],
            risk: "low",
            complexity: "small",
            parallelSafe: false,
          },
          timestamp,
        ),
      ).toThrow(DomainError);
    },
  );

  it.each([
    ["role", { role: "invalid" }],
    ["builder mode", { builderMode: "invalid" }],
    ["risk", { risk: "critical" }],
    ["complexity", { complexity: "huge" }],
    ["parallel safety", { parallelSafe: "yes" }],
  ])("rejects invalid runtime %s values", (_field, override) => {
    expect(() =>
      createWorkNode(
        {
          id: "builder",
          objective: "Build",
          role: "builder",
          builderMode: "implement",
          dependsOn: [],
          scope: {},
          acceptanceCriteria: ["Done"],
          risk: "low",
          complexity: "small",
          parallelSafe: false,
          ...override,
        } as unknown as Parameters<typeof createWorkNode>[0],
        T0,
      ),
    ).toThrow(DomainError);
  });
});

describe("WorkNode state machine", () => {
  const statuses: readonly WorkNodeStatus[] = [
    "pending",
    "ready",
    "running",
    "blocked",
    "waiting_human",
    "completed",
    "failed",
  ];
  const allowed = new Set([
    "pending:ready",
    "pending:blocked",
    "ready:running",
    "ready:blocked",
    "running:waiting_human",
    "running:completed",
    "running:failed",
    "blocked:pending",
    "waiting_human:ready",
    "failed:ready",
  ]);

  it("defines every allowed and rejected status pair", () => {
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransitionWorkNode(from, to), `${from} -> ${to}`).toBe(
          allowed.has(`${from}:${to}`),
        );
      }
    }
  });

  it("runs through waiting, retry, and completion while retaining history", () => {
    const ready = markWorkNodeReady(makeNode(), T1);
    const running = markWorkNodeRunning(ready, T2);
    const waiting = markWorkNodeWaitingHuman(running, T3, "Choose an API");
    const resumed = markWorkNodeReady(waiting, T4, "Decision recorded");
    const runningAgain = markWorkNodeRunning(resumed, T5);
    const failed = markWorkNodeFailed(runningAgain, T6, "Tests failed");
    const retried = retryWorkNode(failed, T7, "Failure diagnosed");
    const finalRunning = markWorkNodeRunning(retried, T8);
    const completed = markWorkNodeCompleted(
      finalRunning,
      "2026-08-25T10:09:00.000Z",
      { artifactRefs: ["artifact-1"], outputDigest: "output-1" },
    );

    expect(failed.failure).toEqual({ reason: "Tests failed", at: T6 });
    expect(retried.failure).toBeUndefined();
    expect(retried.retryCount).toBe(1);
    expect(completed.status).toBe("completed");
    expect(completed.artifactRefs).toEqual(["artifact-1"]);
    expect(completed.outputDigest).toBe("output-1");
    expect(completed.executionHistory.map(({ status }) => status)).toEqual([
      "pending",
      "ready",
      "running",
      "waiting_human",
      "ready",
      "running",
      "failed",
      "ready",
      "running",
      "completed",
    ]);
  });

  it("blocks and unblocks pending work", () => {
    const blocked = markWorkNodeBlocked(makeNode(), T1, "Dependency failed");
    const pending = unblockWorkNode(blocked, T2, "Dependency retried");

    expect(blocked.status).toBe("blocked");
    expect(pending.status).toBe("pending");
  });

  it("rejects commands from an illegal state", () => {
    expect(() => markWorkNodeRunning(makeNode(), T1)).toThrow(DomainError);
    expect(() => markWorkNodeCompleted(makeNode(), T1)).toThrow(DomainError);
    expect(() => retryWorkNode(makeNode(), T1, "No failure")).toThrow(DomainError);
  });

  it("rejects a timestamp earlier than the latest history entry", () => {
    const ready = markWorkNodeReady(makeNode(), T2);

    expect(() => markWorkNodeRunning(ready, T1)).toThrow(DomainError);
  });
});
