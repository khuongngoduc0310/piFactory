import type { WorkNode } from "../domain/work-node.js";

export const SEQUENTIAL_WORKER_LIMIT = 1 as const;

function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodeUnit = left.charCodeAt(index);
    const rightCodeUnit = right.charCodeAt(index);
    if (leftCodeUnit < rightCodeUnit) {
      return -1;
    }
    if (leftCodeUnit > rightCodeUnit) {
      return 1;
    }
  }
  return left.length - right.length;
}

export function compareWorkNodeIds(left: string, right: string): number {
  return compareCodeUnits(left, right);
}

export function selectNextRunnableNode(
  nodes: readonly WorkNode[],
): WorkNode | undefined {
  const candidates = nodes.filter(
    ({ status }) => status === "pending" || status === "ready",
  );
  candidates.sort((left, right) => {
    if (left.status === "ready" && right.status !== "ready") {
      return -1;
    }
    if (left.status !== "ready" && right.status === "ready") {
      return 1;
    }
    return compareWorkNodeIds(left.id, right.id);
  });
  return candidates[0];
}
