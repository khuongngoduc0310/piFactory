import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/domain-error.js";
import {
  addDependency,
  addNode,
  createWorkGraph,
  detectCycles,
  getBlockedNodes,
  getDependents,
  getNode,
  getReadyNodes,
  markNodeCompleted,
  markNodeBlocked,
  markNodeFailed,
  markNodeReady,
  markNodeRunning,
  markNodeWaitingHuman,
  retryNode,
  unblockNode,
  validateDependencies,
} from "../../src/domain/work-graph.js";
import { createWorkNode, type WorkNode } from "../../src/domain/work-node.js";

const T0 = "2026-08-25T10:00:00.000Z";
const T1 = "2026-08-25T10:01:00.000Z";
const T2 = "2026-08-25T10:02:00.000Z";
const T3 = "2026-08-25T10:03:00.000Z";
const T4 = "2026-08-25T10:04:00.000Z";
const T5 = "2026-08-25T10:05:00.000Z";

function makeNode(id: string, dependsOn: readonly string[] = []): WorkNode {
  return createWorkNode(
    {
      id,
      objective: `Complete ${id}`,
      role: "builder",
      builderMode: "implement",
      dependsOn,
      scope: {},
      acceptanceCriteria: [`${id} is complete`],
      risk: "low",
      complexity: "small",
      parallelSafe: true,
    },
    T0,
  );
}

describe("DAG validation", () => {
  it("reports structural problems as structured issues", () => {
    const a = makeNode("a");
    const invalidA = {
      ...a,
      dependsOn: ["a", "missing", "missing"],
    } as WorkNode;
    const duplicateA = { ...a } as WorkNode;

    const issues = validateDependencies([invalidA, duplicateA]);

    expect(issues.map(({ code }) => code)).toEqual([
      "duplicate_node_id",
      "duplicate_dependency",
      "self_dependency",
      "missing_dependency",
      "cycle",
    ]);
    expect(() => createWorkGraph([invalidA, duplicateA])).toThrow(DomainError);
  });

  it("detects cycles deterministically", () => {
    const a = { ...makeNode("a"), dependsOn: ["b"] } as WorkNode;
    const b = { ...makeNode("b"), dependsOn: ["c"] } as WorkNode;
    const c = { ...makeNode("c"), dependsOn: ["a"] } as WorkNode;

    expect(detectCycles([c, a, b])).toEqual([["a", "b", "c", "a"]]);
    expect(validateDependencies([c, a, b]).map(({ code }) => code)).toContain("cycle");
  });

  it("rejects active state whose dependencies are incomplete", () => {
    const dependency = makeNode("dependency");
    const ready = markNodeReady(createWorkGraph([dependency, makeNode("work", ["dependency"])]), "dependency", T1);
    const running = markNodeRunning(ready, "dependency", T2);
    const completed = markNodeCompleted(running, "dependency", T3);
    const workReady = markNodeReady(completed, "work", T4);
    const invalidDependency = makeNode("dependency");

    const issues = validateDependencies([invalidDependency, getNode(workReady, "work")]);

    expect(issues.map(({ code }) => code)).toContain("dependency_not_completed");
  });

  it("rejects a dependent that became ready before its dependency completed", () => {
    let graph = createWorkGraph([makeNode("dependency"), makeNode("work", ["dependency"])]);
    graph = markNodeReady(graph, "dependency", T1);
    graph = markNodeRunning(graph, "dependency", T2);
    graph = markNodeCompleted(graph, "dependency", T4);

    expect(() => markNodeReady(graph, "work", T3)).toThrow(DomainError);

    const impossibleWork = {
      ...getNode(graph, "work"),
      status: "ready",
      executionHistory: [
        { status: "pending", at: T0 },
        { status: "ready", at: T3 },
      ],
    } as WorkNode;
    expect(
      validateDependencies([getNode(graph, "dependency"), impossibleWork]).map(
        ({ code }) => code,
      ),
    ).toContain("dependency_completed_too_late");

    const impossibleBlockedWork = {
      ...getNode(graph, "work"),
      status: "blocked",
      executionHistory: [
        { status: "pending", at: T0 },
        { status: "ready", at: T3 },
        { status: "blocked", at: T5, reason: "External blocker" },
      ],
    } as WorkNode;
    expect(
      validateDependencies([getNode(graph, "dependency"), impossibleBlockedWork]).map(
        ({ code }) => code,
      ),
    ).toContain("dependency_completed_too_late");

    const incompleteDependency = makeNode("dependency");
    expect(
      validateDependencies([incompleteDependency, impossibleBlockedWork]).map(
        ({ code }) => code,
      ),
    ).toContain("dependency_not_completed");
  });

  it("rejects reconstructed nodes with invalid state history", () => {
    const invalid = {
      ...makeNode("invalid"),
      status: "completed",
      retryCount: -1,
    } as WorkNode;

    expect(validateDependencies([invalid]).map(({ code }) => code)).toEqual([
      "invalid_node",
      "invalid_node",
    ]);
    expect(() => createWorkGraph([invalid])).toThrow(DomainError);
  });

  it("returns structured issues for malformed nested reconstruction data", () => {
    const malformed = {
      ...makeNode("malformed"),
      dependsOn: undefined,
      scope: null,
      failure: null,
      executionHistory: [null],
    } as unknown as WorkNode;

    const issues = validateDependencies([malformed]);

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every(({ code }) => code === "invalid_node")).toBe(true);
    expect(() => createWorkGraph([malformed])).toThrow(DomainError);
  });

  it("rejects reconstructed retry history that lost its failure reason", () => {
    const retryWithoutFailureReason = {
      ...makeNode("retry"),
      status: "ready",
      retryCount: 1,
      executionHistory: [
        { status: "pending", at: T0 },
        { status: "ready", at: T1 },
        { status: "running", at: T2 },
        { status: "failed", at: T3 },
        { status: "ready", at: T4, reason: "Retry" },
      ],
    } as WorkNode;

    expect(validateDependencies([retryWithoutFailureReason]).map(({ code }) => code)).toContain(
      "invalid_node",
    );
    expect(() => createWorkGraph([retryWithoutFailureReason])).toThrow(DomainError);
  });
});

describe("WorkGraph", () => {
  it("stores nodes immutably in deterministic order", () => {
    const nodes = [makeNode("z"), makeNode("a")];
    const graph = createWorkGraph(nodes);

    nodes.push(makeNode("m"));

    expect(graph.nodes.map(({ id }) => id)).toEqual(["a", "z"]);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
  });

  it("derives ready nodes and direct or transitive dependents", () => {
    const graph = createWorkGraph([
      makeNode("d", ["b", "c"]),
      makeNode("c", ["a"]),
      makeNode("a"),
      makeNode("b", ["a"]),
    ]);

    expect(getReadyNodes(graph).map(({ id }) => id)).toEqual(["a"]);
    expect(getDependents(graph, "a").map(({ id }) => id)).toEqual(["b", "c"]);
    expect(
      getDependents(graph, "a", { transitive: true }).map(({ id }) => id),
    ).toEqual(["b", "c", "d"]);
  });

  it("advances nodes without mutating previous graph versions", () => {
    const initial = createWorkGraph([makeNode("a"), makeNode("b", ["a"])]);
    const ready = markNodeReady(initial, "a", T1);
    const running = markNodeRunning(ready, "a", T2);
    const completed = markNodeCompleted(running, "a", T3, {
      artifactRefs: ["artifact-a"],
    });

    expect(getNode(initial, "a").status).toBe("pending");
    expect(getNode(completed, "a").status).toBe("completed");
    expect(getReadyNodes(completed).map(({ id }) => id)).toEqual(["b"]);
  });

  it("derives blocked dependents and permits dependency retry", () => {
    let graph = createWorkGraph([makeNode("a"), makeNode("b", ["a"])]);
    graph = markNodeReady(graph, "a", T1);
    graph = markNodeRunning(graph, "a", T2);
    graph = markNodeFailed(graph, "a", T3, "Build failed");

    expect(getBlockedNodes(graph).map(({ id }) => id)).toEqual(["b"]);

    graph = retryNode(graph, "a", T4, "Try again");
    expect(getNode(graph, "a").retryCount).toBe(1);
  });

  it("records waiting, blocking, and unblocking transitions", () => {
    let waitingGraph = createWorkGraph([makeNode("waiting")]);
    waitingGraph = markNodeReady(waitingGraph, "waiting", T1);
    waitingGraph = markNodeRunning(waitingGraph, "waiting", T2);
    waitingGraph = markNodeWaitingHuman(
      waitingGraph,
      "waiting",
      T3,
      "Need a decision",
    );
    waitingGraph = markNodeReady(waitingGraph, "waiting", T4, "Decision recorded");

    let blockedGraph = createWorkGraph([makeNode("blocked")]);
    blockedGraph = markNodeBlocked(blockedGraph, "blocked", T1, "External blocker");
    blockedGraph = unblockNode(blockedGraph, "blocked", T2, "Blocker cleared");

    expect(getNode(waitingGraph, "waiting").status).toBe("ready");
    expect(getNode(blockedGraph, "blocked").status).toBe("pending");
  });

  it("rejects unblocking while a dependency remains failed", () => {
    let graph = createWorkGraph([makeNode("a"), makeNode("b", ["a"])]);
    graph = markNodeReady(graph, "a", T1);
    graph = markNodeRunning(graph, "a", T2);
    graph = markNodeFailed(graph, "a", T3, "Build failed");
    graph = markNodeBlocked(graph, "b", T4, "Dependency failed");

    expect(() => unblockNode(graph, "b", T5, "Not actually cleared")).toThrow(
      DomainError,
    );
  });

  it("adds pending nodes and dependencies while preserving acyclicity", () => {
    const withNodes = addNode(addNode(createWorkGraph(), makeNode("a")), makeNode("b"));
    const graph = addDependency(withNodes, "b", "a");

    expect(getNode(graph, "b").dependsOn).toEqual(["a"]);
    expect(() => addDependency(graph, "a", "b")).toThrow(DomainError);
    expect(() => addNode(graph, makeNode("a"))).toThrow(DomainError);
  });

  it("rejects running work before it is explicitly ready", () => {
    const graph = createWorkGraph([makeNode("a")]);

    expect(() => markNodeRunning(graph, "a", T1)).toThrow(DomainError);
    expect(() => getNode(graph, "missing")).toThrow(DomainError);
  });

  it("rejects adding a dependency to work that is already ready", () => {
    let graph = createWorkGraph([makeNode("a"), makeNode("b")]);
    graph = markNodeReady(graph, "b", T1);

    expect(() => addDependency(graph, "b", "a")).toThrow(DomainError);
    expect(() => addNode(graph, getNode(graph, "b"))).toThrow(DomainError);
  });

  it("rejects marking work ready before its dependencies complete", () => {
    const graph = createWorkGraph([makeNode("a"), makeNode("b", ["a"])]);

    expect(() => markNodeReady(graph, "b", T1)).toThrow(DomainError);
  });

  it("blocks work that was already marked ready", () => {
    let graph = createWorkGraph([makeNode("a")]);
    graph = markNodeReady(graph, "a", T1);
    graph = markNodeBlocked(graph, "a", T2, "External blocker");

    expect(getNode(graph, "a").status).toBe("blocked");
  });

  it("rejects retry when a dependency is no longer completed", () => {
    const dependency = makeNode("dependency");
    const failedWork = {
      ...makeNode("work", ["dependency"]),
      status: "failed",
      failure: { reason: "Failed", at: T4 },
      executionHistory: [
        { status: "pending", at: T0 },
        { status: "ready", at: T1 },
        { status: "running", at: T2 },
        { status: "failed", at: T4, reason: "Failed" },
      ],
    } as WorkNode;

    expect(validateDependencies([dependency, failedWork]).map(({ code }) => code)).toContain(
      "dependency_not_completed",
    );
    expect(() => createWorkGraph([dependency, failedWork])).toThrow(DomainError);
  });

  it("keeps deterministic ordering after multiple transitions", () => {
    let graph = createWorkGraph([makeNode("c"), makeNode("a"), makeNode("b")]);
    graph = markNodeReady(graph, "b", T1);
    graph = markNodeRunning(graph, "b", T2);
    graph = markNodeCompleted(graph, "b", T5);

    expect(graph.nodes.map(({ id }) => id)).toEqual(["a", "b", "c"]);
  });
});
