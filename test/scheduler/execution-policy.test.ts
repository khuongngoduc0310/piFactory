import { describe, expect, it } from "vitest";

import {
  compareWorkNodeIds,
  SEQUENTIAL_WORKER_LIMIT,
  selectNextRunnableNode,
} from "../../src/scheduler/index.js";
import { markWorkNodeReady, createWorkNode } from "../../src/domain/work-node.js";

const T0 = "2026-08-25T10:00:00.000Z";
const T1 = "2026-08-25T10:01:00.000Z";

function makeNode(id: string) {
  return createWorkNode(
    {
      id,
      objective: `Complete ${id}`,
      role: "builder",
      builderMode: "implement",
      dependsOn: [],
      scope: {},
      acceptanceCriteria: ["The work is complete"],
      risk: "low",
      complexity: "small",
      parallelSafe: true,
    },
    T0,
  );
}

describe("sequential execution policy", () => {
  it("uses an explicit UTF-16 code-unit comparison", () => {
    expect(compareWorkNodeIds("a", "b")).toBeLessThan(0);
    expect(compareWorkNodeIds("b", "a")).toBeGreaterThan(0);
    expect(compareWorkNodeIds("a", "a")).toBe(0);
    expect(compareWorkNodeIds("a", "aa")).toBeLessThan(0);
  });

  it("prioritizes an already-ready retry and then sorts by node ID", () => {
    const pending = makeNode("a");
    const ready = markWorkNodeReady(makeNode("z"), T1);

    expect(selectNextRunnableNode([pending, ready])?.id).toBe("z");
    expect(selectNextRunnableNode([makeNode("z"), makeNode("a")])?.id).toBe("a");
  });

  it("has exactly one effective worker slot", () => {
    expect(SEQUENTIAL_WORKER_LIMIT).toBe(1);
  });
});
